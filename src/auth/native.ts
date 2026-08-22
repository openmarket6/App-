/**
 * Native email/password authentication.
 *
 * Implements the exact contract the existing React frontend expects, because
 * only that app's BUILT bundle exists and its auth flow cannot be rewritten:
 *
 *   POST /api/auth/login    -> { accessToken, user }  + httpOnly refresh cookie
 *   POST /api/auth/refresh  -> { accessToken, user }
 *   GET  /api/auth/me       -> { user }
 *
 * Design decisions worth stating:
 *
 *   Short access tokens, long refresh tokens. An access token cannot be
 *   revoked once signed, so it lives 15 minutes. The refresh token lives 30
 *   days but is recorded in the database and can be revoked individually.
 *
 *   Refresh tokens are stored HASHED. A database dump must not hand someone a
 *   set of working sessions.
 *
 *   `token_version` on the user is the panic switch: raising it invalidates
 *   every outstanding session for that person at once, which is what makes
 *   "revoke this employee's access now" actually immediate.
 *
 *   Separate signing secrets for access and refresh, so a leak of one does not
 *   let an attacker mint the other.
 */
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import { env, nativeAuthConfigured } from '../config/env.js';
import { withServiceContext } from '../db/tenant.js';
import { unauthorized, serviceUnavailable, badRequest } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { Role } from '../domain/capabilities.js';

export const REFRESH_COOKIE = 'flph_rt';
/** Scoped to the auth endpoints so the cookie is not sent with every API call. */
export const REFRESH_COOKIE_PATH = '/api/auth';

/**
 * bcrypt cost. 10 matches the existing system, so password hashes exported
 * from it verify here unchanged — which is what makes migrating existing
 * accounts possible without forcing everyone to reset.
 */
const BCRYPT_ROUNDS = 10;

export interface AccessClaims {
  userId: string;
  role: Role;
  clientId: string | null;
  email: string;
  /**
   * Whether a second factor was actually presented for THIS session.
   *
   * On the token rather than looked up per request, because the question is
   * not "does this person have MFA enabled" but "did they use it to get this
   * session". Reading the user row would answer the first and let a session
   * created before enrolment inherit the privileges of one created after.
   */
  mfa?: boolean;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  clientId: string | null;
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  hasPassword: boolean;
}

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  app_role: Role;
  client_id: string | null;
  is_active: boolean;
  password_hash: string | null;
  token_version: number;
  created_at: string | Date;
  last_login_at: string | Date | null;
  mfa_enabled?: boolean;
  invite_token?: string | null;
}

const iso = (v: string | Date | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : v;

/** The user shape the frontend expects. Never includes the password hash. */
export function publicUser(u: UserRow): PublicUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.app_role,
    clientId: u.client_id,
    active: u.is_active,
    createdAt: iso(u.created_at) ?? new Date().toISOString(),
    lastLoginAt: iso(u.last_login_at),
    hasPassword: Boolean(u.password_hash),
  };
}

function secrets(): { access: Uint8Array; refresh: Uint8Array } {
  if (!nativeAuthConfigured) {
    throw serviceUnavailable('Email and password sign-in is not configured on this server');
  }
  const encoder = new TextEncoder();
  return {
    access: encoder.encode(env.AUTH_JWT_SECRET),
    refresh: encoder.encode(env.AUTH_REFRESH_SECRET),
  };
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(hash: string | null, password: string): Promise<boolean> {
  if (!hash) return false;
  return bcrypt.compare(password, hash);
}

/**
 * Minimum password length.
 *
 * 12, matching the existing system. Length beats composition rules: it is the
 * only requirement that reliably increases work for an attacker without
 * pushing people toward "Password1!" written on a monitor.
 */
export const MIN_PASSWORD_LENGTH = 12;

export function assertPasswordAcceptable(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw badRequest(`Use at least ${MIN_PASSWORD_LENGTH} characters`);
  }
}

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${env.AUTH_ACCESS_TTL_SECONDS}s`)
    .sign(secrets().access);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, secrets().access, { clockTolerance: 5 });
    if (typeof payload['userId'] !== 'string' || typeof payload['role'] !== 'string') {
      throw new Error('malformed claims');
    }
    return {
      userId: payload['userId'] as string,
      role: payload['role'] as Role,
      clientId: (payload['clientId'] as string | null) ?? null,
      email: (payload['email'] as string) ?? '',
      /*
       * Must be carried through. This function rebuilds the claims field by
       * field rather than casting the payload, which is the safe habit -- but
       * a field omitted here is a field that silently reads as absent, and for
       * this one "absent" means "no second factor was presented". Leaving it
       * out made every MFA-gated endpoint refuse a session that had in fact
       * completed the second step.
       */
      mfa: payload['mfa'] === true,
    };
  } catch {
    throw unauthorized('Invalid or expired session');
  }
}

/** Stored hashed — the raw token exists only in the user's cookie. */
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export interface IssuedRefresh {
  token: string;
  expiresAt: Date;
}

export async function issueRefreshToken(
  user: { id: string; token_version: number },
  context: { ip?: string | null; userAgent?: string | null; mfa?: boolean } = {},
): Promise<IssuedRefresh> {
  const raw = randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + env.AUTH_REFRESH_TTL_SECONDS * 1000);

  await withServiceContext(
    async (tx) => {
      await tx.query(
        `insert into ocs.refresh_tokens
           (user_id, token_hash, token_version, expires_at, ip_address, user_agent, mfa_verified)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          user.id, hashToken(raw), user.token_version, expiresAt,
          context.ip ?? null, context.userAgent ?? null, context.mfa ?? false,
        ],
      );
    },
    { reason: 'issue_refresh_token' },
  );

  return { token: raw, expiresAt };
}

/**
 * How long a just-rotated refresh token stays usable.
 *
 * Rotation revokes the presented token, which is correct: a stolen token is
 * then usable at most once. But it makes concurrent refreshes mutually
 * exclusive, and concurrency here is completely ordinary. Two tabs open on the
 * permit board both wake with no access token and both refresh with the same
 * cookie; one wins, and without this window the other is told its session
 * expired and dumps the user back to a sign-in screen mid-task.
 *
 * A retried request on a flaky phone connection produces the same collision.
 *
 * Sixty seconds is long enough to cover a slow network and short enough that a
 * stolen token is still near-useless, and reuse AFTER the window is treated as
 * theft rather than ignored -- which is a stronger position than before, when a
 * second use was merely refused and nothing was done about it.
 */
const REFRESH_REUSE_GRACE_SECONDS = 60;

/**
 * Exchange a refresh token for the user it belongs to.
 *
 * Rotates: the presented token is revoked and the caller issues a new one, so
 * a stolen refresh token is usable at most once.
 *
 * Reuse is judged by WHEN, not merely whether. Within the grace window above it
 * is a race between the user's own tabs and is allowed. Outside it, the token
 * was replaced long ago and is being presented by someone who should not have
 * it, so every session for that account is destroyed -- including the thief's.
 */
export async function consumeRefreshToken(
  raw: string,
): Promise<{ user: UserRow; mfa: boolean }> {
  const result = await withServiceContext(
    async (tx) => {
      const row = await tx.one<{
        id: string;
        user_id: string;
        token_version: number;
        mfa_verified: boolean;
        expired: boolean;
        revoked_recently: boolean;
        revoked_long_ago: boolean;
      }>(
        `select id, user_id, token_version, mfa_verified,
                (expires_at <= now()) as expired,
                (revoked_at is not null
                  and revoked_at > now() - ($2 || ' seconds')::interval) as revoked_recently,
                (revoked_at is not null
                  and revoked_at <= now() - ($2 || ' seconds')::interval) as revoked_long_ago
           from ocs.refresh_tokens
          where token_hash = $1`,
        [hashToken(raw), String(REFRESH_REUSE_GRACE_SECONDS)],
      );
      if (!row) return null;

      /**
       * Presented well after it was rotated away. The legitimate holder moved
       * on to a newer token, so whoever still has this one copied it. Ending
       * every session is the only response that does not leave them logged in.
       */
      if (row.revoked_long_ago) {
        await tx.query(
          `update ocs.refresh_tokens set revoked_at = now()
            where user_id = $1 and revoked_at is null`,
          [row.user_id],
        );
        await tx.query(
          `update ocs.app_users set token_version = token_version + 1 where id = $1`,
          [row.user_id],
        );
        logger.warn(
          { userId: row.user_id },
          'refresh token reused after rotation; all sessions revoked',
        );
        return null;
      }

      if (row.expired) return null;

      // Within the grace window this is a no-op, which is what makes the second
      // tab's refresh succeed instead of ending its session.
      await tx.query(
        `update ocs.refresh_tokens set revoked_at = now()
          where id = $1 and revoked_at is null`,
        [row.id],
      );

      const found = await tx.one<UserRow>(
        `select id, email, name, app_role, client_id, is_active, password_hash,
                token_version, created_at, last_login_at, mfa_enabled
           from ocs.app_users
          where id = $1 and deleted_at is null`,
        [row.user_id],
      );
      if (!found || !found.is_active) return null;

      // A token minted before token_version was raised is dead, even if it has
      // not expired and was never individually revoked.
      if (found.token_version !== row.token_version) return null;

      return { user: found, mfa: row.mfa_verified };
    },
    { reason: 'consume_refresh_token' },
  );

  if (!result) throw unauthorized('Session expired');
  return result;
}

export async function revokeRefreshToken(raw: string): Promise<void> {
  await withServiceContext(
    async (tx) => {
      await tx.query(
        `update ocs.refresh_tokens set revoked_at = now()
          where token_hash = $1 and revoked_at is null`,
        [hashToken(raw)],
      );
    },
    { reason: 'revoke_refresh_token' },
  );
}

/** Sign a user out everywhere at once. */
export async function revokeAllSessions(userId: string): Promise<void> {
  await withServiceContext(
    async (tx) => {
      await tx.query(
        `update ocs.app_users set token_version = token_version + 1 where id = $1`,
        [userId],
      );
      await tx.query(
        `update ocs.refresh_tokens set revoked_at = now()
          where user_id = $1 and revoked_at is null`,
        [userId],
      );
    },
    { reason: 'revoke_all_sessions' },
  );
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  return withServiceContext(
    async (tx) =>
      tx.one<UserRow>(
        // mfa_enabled is selected here specifically: the login handler branches
        // on it, and omitting it made that branch silently unreachable -- a
        // second factor that was enrolled, stored and never asked for.
        `select id, email, name, app_role, client_id, is_active, password_hash,
                token_version, created_at, last_login_at, mfa_enabled
           from ocs.app_users
          where lower(email) = lower($1) and deleted_at is null`,
        [email],
      ),
    { reason: 'find_user_by_email' },
  );
}

export async function findUserById(id: string): Promise<UserRow | null> {
  return withServiceContext(
    async (tx) =>
      tx.one<UserRow>(
        `select id, email, name, app_role, client_id, is_active, password_hash,
                token_version, created_at, last_login_at
           from ocs.app_users
          where id = $1 and deleted_at is null`,
        [id],
      ),
    { reason: 'find_user_by_id' },
  );
}

export async function recordLogin(userId: string): Promise<void> {
  await withServiceContext(
    async (tx) => {
      await tx.query(
        `update ocs.app_users set last_login_at = now(), last_seen_at = now() where id = $1`,
        [userId],
      );
    },
    { reason: 'record_login' },
  );
}

export function newInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

// -----------------------------------------------------------------------------
// Second factor
// -----------------------------------------------------------------------------

/**
 * How long the ticket between the two sign-in steps lives.
 *
 * Five minutes: long enough to find a phone, unlock it and read a code; short
 * enough that a ticket left in a log or a browser history is worthless by the
 * time anyone finds it.
 */
const MFA_CHALLENGE_TTL_SECONDS = 300;

/** Six digits is a million possibilities. This is what stops a script. */
const MFA_MAX_ATTEMPTS = 6;

export interface IssuedChallenge {
  token: string;
  expiresAt: Date;
}

export async function issueMfaChallenge(
  userId: string,
  context: { ip?: string | null; userAgent?: string | null } = {},
): Promise<IssuedChallenge> {
  const raw = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + MFA_CHALLENGE_TTL_SECONDS * 1000);

  await withServiceContext(
    async (tx) => {
      /*
       * Any earlier unconsumed challenge for this person is dropped. Otherwise
       * signing in twice leaves two live tickets, and the older one keeps
       * working after the newer was used.
       */
      await tx.query(
        `delete from ocs.mfa_challenges where user_id = $1 and consumed_at is null`,
        [userId],
      );
      await tx.query(
        `insert into ocs.mfa_challenges (user_id, token_hash, expires_at, ip_address, user_agent)
         values ($1, $2, $3, $4, $5)`,
        [userId, hashToken(raw), expiresAt, context.ip ?? null, context.userAgent ?? null],
      );
    },
    { reason: 'issue_mfa_challenge' },
  );

  return { token: raw, expiresAt };
}

/**
 * Redeem the ticket with a code from the authenticator, or a recovery code.
 *
 * Every failure answers the same way. Telling someone their code was wrong but
 * their ticket was fine, or the reverse, hands an attacker a way to work out
 * which half they have already got right.
 */
export async function consumeMfaChallenge(rawToken: string, code: string): Promise<UserRow> {
  const generic = () => unauthorized('That code is not right, or the sign-in has expired');

  const user = await withServiceContext(
    async (tx) => {
      const challenge = await tx.one<{
        id: string; user_id: string; attempts: number; expired: boolean; consumed: boolean;
      }>(
        `select id, user_id, attempts,
                (expires_at <= now()) as expired,
                (consumed_at is not null) as consumed
           from ocs.mfa_challenges
          where token_hash = $1
          for update`,
        [hashToken(rawToken)],
      );
      if (!challenge || challenge.expired || challenge.consumed) return null;

      if (challenge.attempts >= MFA_MAX_ATTEMPTS) {
        // Burned, not merely refused. Leaving it open would let a script keep
        // guessing until the five minutes ran out.
        await tx.query(
          `update ocs.mfa_challenges set consumed_at = now() where id = $1`,
          [challenge.id],
        );
        return null;
      }

      const row = await tx.one<UserRow & {
        secret: string | null; mfa_recovery_hashes: string[];
      }>(
        `select id, email, name, app_role, client_id, is_active, password_hash,
                token_version, created_at, last_login_at, mfa_enabled,
                pgp_sym_decrypt(mfa_secret_encrypted, $2) as secret,
                mfa_recovery_hashes
           from ocs.app_users
          where id = $1 and deleted_at is null and is_active`,
        [challenge.user_id, env.INTEGRATION_ENCRYPTION_KEY ?? ''],
      );
      if (!row?.secret) return null;

      const { verifyTotp } = await import('./totp.js');
      const supplied = code.trim().toUpperCase();

      if (verifyTotp(row.secret, supplied)) {
        await tx.query(
          `update ocs.mfa_challenges set consumed_at = now() where id = $1`,
          [challenge.id],
        );
        return row;
      }

      /*
       * Recovery codes are single-use and removed on use, not marked. A code
       * that remains in the row after being used is a code somebody can use
       * twice, and these exist precisely for the moment the authenticator is
       * gone.
       */
      const suppliedHash = hashToken(supplied);
      if (row.mfa_recovery_hashes.includes(suppliedHash)) {
        await tx.query(
          `update ocs.app_users
              set mfa_recovery_hashes = array_remove(mfa_recovery_hashes, $2)
            where id = $1`,
          [row.id, suppliedHash],
        );
        await tx.query(
          `update ocs.mfa_challenges set consumed_at = now() where id = $1`,
          [challenge.id],
        );
        logger.warn({ userId: row.id }, 'signed in with an MFA recovery code');
        return row;
      }

      await tx.query(
        `update ocs.mfa_challenges set attempts = attempts + 1 where id = $1`,
        [challenge.id],
      );
      return null;
    },
    { reason: 'consume_mfa_challenge' },
  );

  if (!user) throw generic();
  return user;
}

/** Hash a recovery code for storage. Same one-way treatment as a token. */
export const hashRecoveryCode = (code: string): string => hashToken(code.trim().toUpperCase());

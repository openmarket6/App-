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
  context: { ip?: string | null; userAgent?: string | null } = {},
): Promise<IssuedRefresh> {
  const raw = randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + env.AUTH_REFRESH_TTL_SECONDS * 1000);

  await withServiceContext(
    async (tx) => {
      await tx.query(
        `insert into ocs.refresh_tokens
           (user_id, token_hash, token_version, expires_at, ip_address, user_agent)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          user.id, hashToken(raw), user.token_version, expiresAt,
          context.ip ?? null, context.userAgent ?? null,
        ],
      );
    },
    { reason: 'issue_refresh_token' },
  );

  return { token: raw, expiresAt };
}

/**
 * Exchange a refresh token for the user it belongs to.
 *
 * Rotates: the presented token is revoked and the caller issues a new one.
 * Rotation means a stolen refresh token is usable at most once, and the
 * legitimate user's next refresh fails visibly rather than the theft going
 * unnoticed.
 */
export async function consumeRefreshToken(raw: string): Promise<UserRow> {
  const user = await withServiceContext(
    async (tx) => {
      const row = await tx.one<{ id: string; user_id: string; token_version: number }>(
        `select id, user_id, token_version
           from ocs.refresh_tokens
          where token_hash = $1
            and revoked_at is null
            and expires_at > now()`,
        [hashToken(raw)],
      );
      if (!row) return null;

      await tx.query(`update ocs.refresh_tokens set revoked_at = now() where id = $1`, [row.id]);

      const found = await tx.one<UserRow>(
        `select id, email, name, app_role, client_id, is_active, password_hash,
                token_version, created_at, last_login_at
           from ocs.app_users
          where id = $1 and deleted_at is null`,
        [row.user_id],
      );
      if (!found || !found.is_active) return null;

      // A token minted before token_version was raised is dead, even if it has
      // not expired and was never individually revoked.
      if (found.token_version !== row.token_version) return null;

      return found;
    },
    { reason: 'consume_refresh_token' },
  );

  if (!user) throw unauthorized('Session expired');
  return user;
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
        `select id, email, name, app_role, client_id, is_active, password_hash,
                token_version, created_at, last_login_at
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

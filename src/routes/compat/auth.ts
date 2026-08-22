/**
 * /api/auth — the contract the existing React frontend already speaks.
 *
 * Endpoint shapes, cookie name, cookie path and token claims all match the
 * previous implementation exactly, so the shipped bundle authenticates against
 * this backend with no changes. Where behaviour differs it is stricter, never
 * looser.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
// Side-effect import: brings in the reply.setCookie / request.cookies type
// augmentation from @fastify/cookie, which is registered in index.ts.
import '@fastify/cookie';
import { z } from 'zod';
import { withServiceContext } from '../../db/tenant.js';
import { parse, clientIp, userAgent } from '../../lib/http-helpers.js';
import { unauthorized, conflict, badRequest, forbidden, serviceUnavailable } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import {
  REFRESH_COOKIE, REFRESH_COOKIE_PATH, publicUser, hashPassword, verifyPassword,
  assertPasswordAcceptable, signAccessToken, issueRefreshToken, consumeRefreshToken,
  revokeRefreshToken, findUserByEmail, findUserById, recordLogin,
  issueMfaChallenge, consumeMfaChallenge, hashRecoveryCode,
  type UserRow, type AccessClaims,
} from '../../auth/native.js';
import type { Role } from '../../domain/capabilities.js';

declare module 'fastify' {
  interface FastifyRequest {
    apiAuth?: AccessClaims;
  }
}

function setRefreshCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    maxAge: env.AUTH_REFRESH_TTL_SECONDS,
  });
}

async function sessionResponse(
  req: FastifyRequest,
  reply: FastifyReply,
  user: UserRow,
  status = 200,
  /**
   * Whether a second factor was presented to create this session.
   *
   * Passed in rather than read from the user row, because it is a fact about
   * how this session was obtained. A refresh carries it forward; a fresh
   * password-only sign-in does not acquire it just because the account has MFA
   * turned on.
   */
  mfa = false,
) {
  const claims: AccessClaims = {
    userId: user.id,
    role: user.app_role,
    clientId: user.client_id,
    email: user.email,
    mfa,
  };

  const refresh = await issueRefreshToken(user, {
    ip: clientIp(req),
    userAgent: userAgent(req),
  });
  setRefreshCookie(reply, refresh.token);

  reply.code(status);
  return { accessToken: await signAccessToken(claims), user: publicUser(user) };
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const setupSchema = z.object({
  email: z.string().email(),
  name: z.string().trim().min(1).max(200),
  password: z.string().min(1),
});

const acceptSchema = z.object({
  token: z.string().min(10),
  password: z.string().min(1),
});

export async function compatAuthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Tells the frontend whether to show a sign-in box or a first-run setup form.
   */
  app.get('/api/auth/setup-state', async () => {
    return withServiceContext(
      async (tx) => {
        const row = await tx.one<{ needs_setup: boolean; pending: string }>(
          `select ocs.needs_setup() as needs_setup,
                  (select count(*) from ocs.app_users
                    where invite_token is not null
                      and (invite_expires_at is null or invite_expires_at > now())
                      and deleted_at is null)::text as pending`,
        );
        return {
          needsSetup: row?.needs_setup ?? true,
          pendingInvites: Number(row?.pending ?? 0),
        };
      },
      { reason: 'setup_state' },
    );
  });

  /**
   * First-run: create the first administrator.
   *
   * Only works while no administrator exists. Once one does, this is a 409 —
   * otherwise it would be an open endpoint for minting admin accounts, which is
   * the single worst hole a system like this can have.
   */
  app.post('/api/auth/setup', async (req, reply) => {
    const body = parse(setupSchema, req.body, 'setup');
    assertPasswordAcceptable(body.password);

    const user = await withServiceContext(
      async (tx) => {
        const state = await tx.one<{ needs_setup: boolean }>(
          `select ocs.needs_setup() as needs_setup`,
        );
        if (!state?.needs_setup) {
          throw conflict('This system already has an administrator. Sign in instead.');
        }

        const passwordHash = await hashPassword(body.password);

        const row = await tx.one<UserRow>(
          `insert into ocs.app_users
             (email, name, app_role, password_hash, is_active, last_login_at)
           values ($1, $2, 'ADMIN', $3, true, now())
           on conflict (lower(email)) do update
             set name = excluded.name,
                 app_role = 'ADMIN',
                 password_hash = excluded.password_hash,
                 is_active = true,
                 invite_token = null,
                 invite_expires_at = null,
                 token_version = ocs.app_users.token_version + 1,
                 last_login_at = now()
           returning id, email, name, app_role, client_id, is_active, password_hash,
                     token_version, created_at, last_login_at`,
          [body.email.trim(), body.name, passwordHash],
        );
        if (!row) throw badRequest('Could not create the administrator account');

        await writeAudit(tx, {
          actorUserId: row.id,
          actorEmail: row.email,
          action: 'auth.setup_completed',
          entityType: 'app_user',
          entityId: row.id,
          summary: 'First administrator account created',
          requestId: req.id,
          ipAddress: clientIp(req),
          userAgent: userAgent(req),
        });

        return row;
      },
      { reason: 'auth_setup' },
    );

    logger.warn({ userId: user.id }, 'first administrator account created');
    return sessionResponse(req, reply, user, 201);
  });

  app.post('/api/auth/login', {
    config: {
      // Tighter than the global limit: this is the endpoint worth guessing at.
      rateLimit: { max: 10, timeWindow: '5 minutes' },
    },
  }, async (req, reply) => {
    const body = parse(loginSchema, req.body, 'credentials');
    const user = await findUserByEmail(body.email);

    // One message for every failure mode — unknown email, wrong password,
    // deactivated account. Distinguishing them turns this into an endpoint for
    // discovering who has an account.
    const generic = () => unauthorized('Email or password is incorrect');

    if (!user || !user.is_active) {
      // Still spend the time a real comparison costs, so response timing does
      // not reveal whether the address exists.
      await verifyPassword('$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv', body.password);
      throw generic();
    }
    if (!(await verifyPassword(user.password_hash, body.password))) {
      logger.info({ email: body.email, ip: clientIp(req) }, 'failed sign-in attempt');
      throw generic();
    }

    /*
     * Password accepted. If this account carries a second factor, that is only
     * half of sign-in: no session is issued here, and the ticket returned
     * grants nothing except the right to present a code.
     */
    if (user.mfa_enabled) {
      const challenge = await issueMfaChallenge(user.id, {
        ip: clientIp(req), userAgent: userAgent(req),
      });
      logger.info({ userId: user.id }, 'password accepted; second factor required');
      reply.code(200);
      return {
        mfaRequired: true,
        challengeToken: challenge.token,
        expiresAt: challenge.expiresAt.toISOString(),
      };
    }

    await recordLogin(user.id);
    logger.info({ userId: user.id, role: user.app_role }, 'sign-in');
    return sessionResponse(req, reply, user);
  });

  /**
   * Second step: the code from the authenticator, or a recovery code.
   *
   * Rate limited harder than the password step. Six digits is a million
   * possibilities, which is a lot for a person and very little for a script.
   */
  app.post('/api/auth/mfa/challenge', {
    config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
  }, async (req, reply) => {
    const body = parse(
      z.object({
        challengeToken: z.string().min(10).max(200),
        code: z.string().trim().min(6).max(20),
      }),
      req.body,
      'verification',
    );

    const user = await consumeMfaChallenge(body.challengeToken, body.code);
    await recordLogin(user.id);
    logger.info({ userId: user.id }, 'sign-in with second factor');
    return sessionResponse(req, reply, user, 200, true);
  });

  app.post('/api/auth/refresh', async (req, reply) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (!token) throw unauthorized('No session');

    // Rotates the token: the presented one is revoked and a fresh one issued.
    const { user, mfa } = await consumeRefreshToken(token);

    /*
     * The second factor carries forward across a refresh, and must.
     *
     * A refresh is the SAME session continuing, not a new sign-in. Dropping
     * the claim would silently demote an administrator fifteen minutes into
     * their work, and they would be told to re-authenticate for something they
     * already had authenticated for.
     */
    return sessionResponse(req, reply, user, 200, mfa);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (token) await revokeRefreshToken(token);
    reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
    return { ok: true };
  });

  /**
   * Begin enrolling a second factor.
   *
   * Issues a secret and returns it once, with the URI an authenticator scans.
   * It is NOT switched on here: the factor only becomes real once a code from
   * it has been verified below. Enabling on issue would lock someone out of
   * their own account the moment they closed the tab before scanning.
   */
  app.post('/api/auth/mfa/setup', { preHandler: requireApiAuth }, async (req) => {
    const auth = req.apiAuth!;

    if (!env.INTEGRATION_ENCRYPTION_KEY) {
      throw serviceUnavailable(
        'Two-factor authentication cannot be set up on this server: there is no ' +
          'encryption key configured, and storing the secret in the clear would be ' +
          'worse than having no second factor at all.',
      );
    }

    const { generateSecret, otpauthUri, generateRecoveryCodes } = await import('../../auth/totp.js');
    const secret = generateSecret();
    const recovery = generateRecoveryCodes();

    return withServiceContext(
      async (tx) => {
        const current = await tx.one<{ mfa_enabled: boolean }>(
          `select mfa_enabled from ocs.app_users where id = $1`, [auth.userId],
        );
        if (current?.mfa_enabled) {
          throw conflict(
            'Two-factor authentication is already on for this account. Turn it off ' +
              'first if you are moving to a new device.',
          );
        }

        await tx.query(
          `update ocs.app_users
              set mfa_secret_encrypted = pgp_sym_encrypt($2, $3),
                  mfa_recovery_hashes = $4::text[],
                  mfa_enabled = false
            where id = $1`,
          [auth.userId, secret, env.INTEGRATION_ENCRYPTION_KEY, recovery.map(hashRecoveryCode)],
        );

        return {
          secret,
          otpauthUri: otpauthUri({
            secret,
            account: auth.email,
            issuer: 'One Contractor Solutions',
          }),
          /*
           * Shown once, now. They are stored hashed, so this is the only moment
           * they can be read -- which is exactly the property that makes them
           * safe to keep and the reason to say so plainly on the screen.
           */
          recoveryCodes: recovery,
          enabled: false,
          next: 'Enter a code from your authenticator to finish turning this on.',
        };
      },
      { reason: 'mfa_setup' },
    );
  });

  /** Verify a code and switch the factor on. */
  app.post('/api/auth/mfa/enable', { preHandler: requireApiAuth }, async (req) => {
    const auth = req.apiAuth!;
    const body = parse(
      z.object({ code: z.string().trim().min(6).max(10) }),
      req.body,
      'verification',
    );

    return withServiceContext(
      async (tx) => {
        const row = await tx.one<{ secret: string | null; mfa_enabled: boolean }>(
          `select pgp_sym_decrypt(mfa_secret_encrypted, $2) as secret, mfa_enabled
             from ocs.app_users where id = $1`,
          [auth.userId, env.INTEGRATION_ENCRYPTION_KEY ?? ''],
        );
        if (!row?.secret) {
          throw badRequest('Start the setup first — there is no secret to verify against.');
        }

        const { verifyTotp } = await import('../../auth/totp.js');
        if (!verifyTotp(row.secret, body.code)) {
          throw badRequest(
            'That code did not match. Check your phone\'s clock is set automatically — ' +
              'a drift of more than a minute is the usual cause.',
          );
        }

        await tx.query(
          `update ocs.app_users
              set mfa_enabled = true, mfa_enrolled_at = now()
            where id = $1`,
          [auth.userId],
        );

        await writeAudit(tx, {
          companyId: auth.clientId,
          actorUserId: auth.userId,
          actorEmail: auth.email,
          action: 'auth.mfa_enabled',
          entityType: 'app_user',
          entityId: auth.userId,
          summary: 'Two-factor authentication turned on',
          requestId: req.id,
          ipAddress: clientIp(req),
        });

        return {
          enabled: true,
          /*
           * The CURRENT session does not retroactively become
           * multi-factor-verified. It was created with a password alone, and
           * saying otherwise would hand full privileges to whoever is holding
           * a session that never presented a code.
           */
          note: 'Sign in again to use anything that requires your authenticator.',
        };
      },
      { reason: 'mfa_enable' },
    );
  });

  /**
   * Turn it off.
   *
   * Requires a current code, not just a session. Otherwise anyone holding a
   * borrowed laptop could remove the protection and the protection was never
   * really there.
   */
  app.post('/api/auth/mfa/disable', { preHandler: requireApiAuth }, async (req) => {
    const auth = req.apiAuth!;
    const body = parse(
      z.object({ code: z.string().trim().min(6).max(20) }),
      req.body,
      'verification',
    );

    return withServiceContext(
      async (tx) => {
        const row = await tx.one<{ secret: string | null; hashes: string[]; mfa_enabled: boolean }>(
          `select pgp_sym_decrypt(mfa_secret_encrypted, $2) as secret,
                  mfa_recovery_hashes as hashes, mfa_enabled
             from ocs.app_users where id = $1`,
          [auth.userId, env.INTEGRATION_ENCRYPTION_KEY ?? ''],
        );
        if (!row?.mfa_enabled) throw conflict('Two-factor authentication is not on');

        const { verifyTotp } = await import('../../auth/totp.js');
        const supplied = body.code.trim().toUpperCase();
        const ok = (row.secret && verifyTotp(row.secret, supplied))
          || row.hashes.includes(hashRecoveryCode(supplied));
        if (!ok) throw badRequest('That code is not right');

        await tx.query(
          `update ocs.app_users
              set mfa_enabled = false, mfa_secret_encrypted = null,
                  mfa_enrolled_at = null, mfa_recovery_hashes = '{}',
                  -- Every existing session loses its verified standing: the
                  -- factor those sessions were checked against no longer exists.
                  token_version = token_version + 1
            where id = $1`,
          [auth.userId],
        );

        await writeAudit(tx, {
          companyId: auth.clientId,
          actorUserId: auth.userId,
          actorEmail: auth.email,
          action: 'auth.mfa_disabled',
          entityType: 'app_user',
          entityId: auth.userId,
          summary: 'Two-factor authentication turned OFF',
          requestId: req.id,
          ipAddress: clientIp(req),
        });

        return { enabled: false };
      },
      { reason: 'mfa_disable' },
    );
  });

  /** Whether this account has a second factor, and whether this session used it. */
  app.get('/api/auth/mfa', { preHandler: requireApiAuth }, async (req) => {
    const auth = req.apiAuth!;
    return withServiceContext(
      async (tx) => {
        const row = await tx.one<{ mfa_enabled: boolean; enrolled_at: string | null; codes: number }>(
          `select mfa_enabled, mfa_enrolled_at as enrolled_at,
                  coalesce(array_length(mfa_recovery_hashes, 1), 0) as codes
             from ocs.app_users where id = $1`,
          [auth.userId],
        );
        return {
          enabled: Boolean(row?.mfa_enabled),
          enrolledAt: row?.enrolled_at ?? null,
          recoveryCodesRemaining: Number(row?.codes ?? 0),
          // The distinction that matters to a screen deciding what to offer.
          sessionVerified: auth.mfa === true,
        };
      },
      { reason: 'mfa_status' },
    );
  });

  app.get('/api/auth/me', { preHandler: requireApiAuth }, async (req) => {
    const user = await findUserById(req.apiAuth!.userId);
    if (!user) throw unauthorized();
    return { user: publicUser(user) };
  });

  /**
   * Accept an invitation and set a password.
   *
   * Bumps token_version so any session created from a leaked invite link dies
   * the moment the real person completes it.
   */
  app.post('/api/auth/accept-invite', async (req, reply) => {
    const body = parse(acceptSchema, req.body, 'invitation');
    assertPasswordAcceptable(body.password);

    const user = await withServiceContext(
      async (tx) => {
        const found = await tx.one<UserRow & { invite_expires_at: string | null }>(
          `select id, email, name, app_role, client_id, is_active, password_hash,
                  token_version, created_at, last_login_at, invite_expires_at
             from ocs.app_users
            where invite_token = $1 and deleted_at is null
            for update`,
          [body.token],
        );
        if (!found) throw unauthorized('That invitation link is not valid');
        if (found.invite_expires_at && Date.parse(found.invite_expires_at) < Date.now()) {
          throw unauthorized('That invitation has expired — ask for a new one');
        }

        const passwordHash = await hashPassword(body.password);
        const updated = await tx.one<UserRow>(
          `update ocs.app_users
              set password_hash = $2,
                  invite_token = null,
                  invite_expires_at = null,
                  is_active = true,
                  token_version = token_version + 1,
                  last_login_at = now()
            where id = $1
            returning id, email, name, app_role, client_id, is_active, password_hash,
                      token_version, created_at, last_login_at`,
          [found.id, passwordHash],
        );
        if (!updated) throw badRequest('Could not accept the invitation');

        await writeAudit(tx, {
          companyId: updated.client_id,
          actorUserId: updated.id,
          actorEmail: updated.email,
          action: 'auth.invite_accepted',
          entityType: 'app_user',
          entityId: updated.id,
          summary: `Invitation accepted as ${updated.app_role}`,
          requestId: req.id,
          ipAddress: clientIp(req),
          userAgent: userAgent(req),
        });

        return updated;
      },
      { reason: 'accept_invite' },
    );

    return sessionResponse(req, reply, user);
  });

  /** Change your own password. Ends every other session. */
  app.post('/api/auth/change-password', { preHandler: requireApiAuth }, async (req) => {
    const body = parse(
      z.object({
        currentPassword: z.string().min(1),
        newPassword: z.string().min(1),
      }),
      req.body,
      'password change',
    );
    assertPasswordAcceptable(body.newPassword);

    const user = await findUserById(req.apiAuth!.userId);
    if (!user) throw unauthorized();
    if (!(await verifyPassword(user.password_hash, body.currentPassword))) {
      throw unauthorized('Your current password is incorrect');
    }

    const passwordHash = await hashPassword(body.newPassword);
    await withServiceContext(
      async (tx) => {
        await tx.query(
          `update ocs.app_users
              set password_hash = $2, token_version = token_version + 1
            where id = $1`,
          [user.id, passwordHash],
        );
        // Changing a password must end sessions elsewhere, or a compromised
        // session survives the very action taken to stop it.
        await tx.query(
          `update ocs.refresh_tokens set revoked_at = now()
            where user_id = $1 and revoked_at is null`,
          [user.id],
        );
        await writeAudit(tx, {
          actorUserId: user.id,
          actorEmail: user.email,
          action: 'auth.password_changed',
          entityType: 'app_user',
          entityId: user.id,
          summary: 'Password changed; all other sessions ended',
          requestId: req.id,
          ipAddress: clientIp(req),
        });
      },
      { reason: 'change_password' },
    );

    return { ok: true, message: 'Password changed. Sign in again on your other devices.' };
  });
}

/**
 * preHandler for /api/* routes.
 *
 * Verifies the bearer access token and confirms the account is still active and
 * the token predates any revocation. Checking the database on each request
 * costs one indexed read and means a deactivated account stops working
 * immediately rather than when its token happens to expire.
 */
export async function requireApiAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  const match = header ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
  if (!match?.[1]) throw unauthorized();

  const { verifyAccessToken } = await import('../../auth/native.js');
  const claims = await verifyAccessToken(match[1]);

  const user = await findUserById(claims.userId);
  if (!user || !user.is_active) throw unauthorized('This account is no longer active');

  // Claims are re-read from the database rather than trusted from the token:
  // a role change or a client reassignment takes effect on the next request,
  // not whenever the token expires.
  req.apiAuth = {
    userId: user.id,
    role: user.app_role,
    clientId: user.client_id,
    email: user.email,
    /*
     * Taken from the TOKEN, not the user row -- the one claim here that is.
     *
     * Everything above is re-read so a role change takes effect on the next
     * request. This cannot be: the question is whether a second factor was
     * presented to obtain THIS session, which is a fact about the session and
     * nothing else. Reading mfa_enabled from the user row would let a session
     * created before enrolment silently gain the privileges of one created
     * after, which is the opposite of what enrolling is for.
     */
    mfa: claims.mfa === true,
  };
}

/**
 * Refuses a caller who did not present a second factor for this session.
 *
 * Applied to what an attacker holding only a stolen password would go for:
 * municipal credentials, moving money, changing who has access.
 */
/*
 * async, and that is load-bearing rather than stylistic.
 *
 * Fastify decides how to run a hook from its shape: a hook that neither
 * returns a promise nor calls `done` is a hook Fastify waits on forever. A
 * synchronous version of this function did not reject the request -- it hung
 * it, which is a far worse failure than a 403 because nothing in the log says
 * anything went wrong.
 */
export async function requireNativeMfa(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.apiAuth) throw unauthorized();
  if (!req.apiAuth.mfa) {
    throw forbidden(
      'This action needs your authenticator code. Sign in again and complete the ' +
        'second step, or turn on two-factor authentication if you have not yet.',
    );
  }
}

/** Refuses a caller whose role lacks any of the required capabilities. */
export function requireCapability(...required: string[]) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!req.apiAuth) throw unauthorized();
    const { missingCapabilities } = await import('../../domain/capabilities.js');
    const missing = missingCapabilities(
      req.apiAuth.role as Role,
      required as never[],
    );
    if (missing.length > 0) {
      throw forbidden(`Your role does not allow: ${missing.join(', ')}`);
    }
  };
}

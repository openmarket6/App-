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
import { unauthorized, conflict, badRequest, forbidden } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import {
  REFRESH_COOKIE, REFRESH_COOKIE_PATH, publicUser, hashPassword, verifyPassword,
  assertPasswordAcceptable, signAccessToken, issueRefreshToken, consumeRefreshToken,
  revokeRefreshToken, findUserByEmail, findUserById, recordLogin,
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
) {
  const claims: AccessClaims = {
    userId: user.id,
    role: user.app_role,
    clientId: user.client_id,
    email: user.email,
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

    await recordLogin(user.id);
    logger.info({ userId: user.id, role: user.app_role }, 'sign-in');
    return sessionResponse(req, reply, user);
  });

  app.post('/api/auth/refresh', async (req, reply) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (!token) throw unauthorized('No session');

    // Rotates the token: the presented one is revoked and a fresh one issued.
    const user = await consumeRefreshToken(token);
    return sessionResponse(req, reply, user);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (token) await revokeRefreshToken(token);
    reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
    return { ok: true };
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
  };
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

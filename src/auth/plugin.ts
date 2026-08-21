/**
 * Request authentication.
 *
 * `authenticate` is attached explicitly as a preHandler on every protected
 * route rather than as a global hook. Explicit is the right default for auth:
 * a global hook plus an exclusion list means a new route is protected only if
 * someone remembers to think about it, and the failure is invisible. Here, an
 * unauthenticated route is unauthenticated because somebody wrote it that way.
 *
 * Resolution order for a request:
 *   1. verify the Supabase access token
 *   2. look up (or just-in-time provision) the ocs.app_users row
 *   3. resolve which company this request acts as
 *   4. confirm the caller may act as that company
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { bearerFrom, verifyAccessToken } from './jwt.js';
import type { CompanyRole, Principal } from './rbac.js';
import { withServiceContext, type PlatformRole, type TenantContext } from '../db/tenant.js';
import { forbidden, unauthorized, conflict, AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
    tenant?: TenantContext;
  }
}

interface IdentityRow {
  user_id: string;
  email: string;
  platform_role: PlatformRole;
  is_active: boolean;
}

interface MembershipRow {
  company_id: string;
  role: CompanyRole;
  company_name: string;
  company_status: string;
}

/**
 * Identity lookup runs in service context because it is inherently pre-tenant:
 * we cannot scope a query by company until we know which companies the caller
 * belongs to. It is deliberately narrow -- two indexed reads keyed by the
 * verified `sub` claim, and a provisioning insert for a first-time login.
 */
async function loadIdentity(
  authUserId: string,
  email: string | undefined,
): Promise<{ identity: IdentityRow; memberships: MembershipRow[] }> {
  return withServiceContext(
    async (tx) => {
      let identity = await tx.one<IdentityRow>(
        `select id as user_id, email, platform_role, is_active
           from ocs.app_users
          where auth_user_id = $1 and deleted_at is null`,
        [authUserId],
      );

      if (!identity) {
        if (!email) {
          throw unauthorized('Account is not provisioned and the token carries no email');
        }

        // Just-in-time provisioning on first login.
        //
        // ON CONFLICT handles the case where the person already exists by email
        // (invited before they ever signed in): we link the auth account to the
        // existing row instead of creating a duplicate human.
        identity = await tx.one<IdentityRow>(
          `insert into ocs.app_users (auth_user_id, email)
                values ($1, $2)
           on conflict (lower(email)) do update
                   set auth_user_id = coalesce(ocs.app_users.auth_user_id, excluded.auth_user_id)
             returning id as user_id, email, platform_role, is_active`,
          [authUserId, email],
        );

        if (!identity) throw unauthorized('Could not provision account');
        logger.info({ userId: identity.user_id }, 'provisioned user on first login');
      }

      if (!identity.is_active) {
        throw forbidden('This account has been deactivated');
      }

      const memberships = await tx.many<MembershipRow>(
        `select m.company_id, m.role, c.name as company_name, c.status as company_status
           from ocs.company_memberships m
           join ocs.companies c on c.id = m.company_id
          where m.user_id = $1
            and m.is_active
            and c.deleted_at is null
          order by c.name`,
        [identity.user_id],
      );

      return { identity, memberships };
    },
    { reason: 'identity_lookup' },
  );
}

/**
 * Decide which company this request acts as.
 *
 * The client names it with the `X-Company-Id` header. That header is a request
 * for context, never a grant of it: the value is checked against the caller's
 * memberships here, and even if this check were wrong, row-level security still
 * filters on the same id. A user who belongs to exactly one company may omit
 * the header entirely.
 */
function resolveCompany(
  requested: string | undefined,
  memberships: MembershipRow[],
  platformRole: PlatformRole,
): { companyId: string; role: CompanyRole; impersonated: boolean } {
  if (requested) {
    const match = memberships.find((m) => m.company_id === requested);
    if (match) {
      if (match.company_status !== 'active') {
        throw forbidden(`This company account is ${match.company_status}`);
      }
      return { companyId: match.company_id, role: match.role, impersonated: false };
    }

    // OCS staff do drafting work inside customer companies they are not members
    // of. Allowed, but recorded: this is the one path that crosses the tenant
    // line, so it must never be silent.
    if (platformRole === 'staff' || platformRole === 'admin') {
      return { companyId: requested, role: 'admin', impersonated: true };
    }

    throw forbidden('You do not have access to this company');
  }

  if (memberships.length === 1) {
    const only = memberships[0]!;
    if (only.company_status !== 'active') {
      throw forbidden(`This company account is ${only.company_status}`);
    }
    return { companyId: only.company_id, role: only.role, impersonated: false };
  }

  if (memberships.length === 0) {
    throw new AppError(
      409,
      'no_company',
      'This account is not associated with a company yet',
    );
  }

  throw new AppError(
    400,
    'company_required',
    'You belong to multiple companies; specify which one with the X-Company-Id header',
    { details: { companies: memberships.map((m) => ({ id: m.company_id, name: m.company_name })) } },
  );
}

export async function authenticate(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = bearerFrom(req.headers.authorization);
  if (!token) throw unauthorized();

  const claims = await verifyAccessToken(token);
  if (!claims.sub) throw unauthorized('Token is missing a subject');

  const { identity, memberships } = await loadIdentity(claims.sub, claims.email);

  const requestedCompany = req.headers['x-company-id'];
  const requested = Array.isArray(requestedCompany) ? requestedCompany[0] : requestedCompany;

  const { companyId, role, impersonated } = resolveCompany(
    requested,
    memberships,
    identity.platform_role,
  );

  const principal: Principal = {
    userId: identity.user_id,
    companyId,
    companyRole: role,
    platformRole: identity.platform_role,
    email: identity.email,
    mfaSatisfied: claims.aal === 'aal2',
    isImpersonatedContext: impersonated,
  };

  req.principal = principal;
  req.tenant = {
    companyId,
    userId: identity.user_id,
    platformRole: identity.platform_role,
    requestId: req.id,
  };

  if (impersonated) {
    logger.warn(
      { userId: identity.user_id, companyId, requestId: req.id, path: req.url },
      'platform staff acting inside a non-member company',
    );
  }
}

/**
 * Authenticate a user who may not have a company yet.
 *
 * Used only by the onboarding endpoints (GET /v1/me, POST /v1/companies), which
 * exist precisely to get someone out of that state.
 */
export async function authenticateWithoutCompany(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  try {
    await authenticate(req, _reply);
  } catch (err) {
    if (err instanceof AppError && (err.code === 'no_company' || err.code === 'company_required')) {
      const token = bearerFrom(req.headers.authorization);
      if (!token) throw unauthorized();
      const claims = await verifyAccessToken(token);
      if (!claims.sub) throw unauthorized('Token is missing a subject');
      const { identity } = await loadIdentity(claims.sub, claims.email);

      req.principal = {
        userId: identity.user_id,
        companyId: '',
        companyRole: 'viewer',
        platformRole: identity.platform_role,
        email: identity.email,
        mfaSatisfied: claims.aal === 'aal2',
        isImpersonatedContext: false,
      };
      return;
    }
    throw err;
  }
}

/** Narrowing accessor: routes past `authenticate` always have these. */
export function principalOf(req: FastifyRequest): Principal {
  if (!req.principal) throw unauthorized();
  return req.principal;
}

export function tenantOf(req: FastifyRequest): TenantContext {
  if (!req.tenant) throw unauthorized();
  return req.tenant;
}

export { conflict };

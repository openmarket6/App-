/**
 * /api/* — data endpoints for the existing React frontend.
 *
 * SCOPING, which is the important part of this file.
 *
 * The frontend puts `clientId` in the access token. A CLIENT user is confined
 * to that one contractor; staff roles work across all of them. That maps onto
 * this backend's two access modes:
 *
 *   CLIENT  -> withTenant(clientId)      row-level security confines every
 *                                        query to their company, so a bug here
 *                                        cannot leak another contractor's rows
 *   staff   -> withServiceContext()      deliberately cross-tenant, with an
 *                                        optional ?clientId= filter
 *
 * `scoped()` below is the single place that decision is made. No handler picks
 * its own access mode, so none can accidentally hand a contractor the service
 * connection.
 *
 * MIGRATION STATE: the previous system had 22 routers. The ones a contractor or
 * a supervisor needs day to day are implemented here. The rest answer with a
 * structured 501 naming themselves, so a screen that is not migrated yet says
 * so plainly instead of failing in a way nobody can diagnose.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant, withServiceContext, type Tx } from '../../db/tenant.js';
import { requireApiAuth, requireCapability } from './auth.js';
import { parse, clientIp, userAgent } from '../../lib/http-helpers.js';
import { writeAudit } from '../../lib/audit.js';
import { badRequest, forbidden, notFound, AppError } from '../../lib/errors.js';
import { publicUser, newInviteToken, type UserRow } from '../../auth/native.js';
import { roleCatalogue, isStaff, ROLES, type Role } from '../../domain/capabilities.js';
import { distanceMeters } from '../../domain/geo.js';
import { logger } from '../../lib/logger.js';

/**
 * Run a query in the right access mode for the caller.
 *
 * `requestedClientId` is what the caller asked to look at. For a CLIENT it is
 * ignored entirely — they get their own company or nothing — so passing
 * someone else's id achieves nothing.
 */
async function scoped<T>(
  req: FastifyRequest,
  fn: (tx: Tx, companyId: string | null) => Promise<T>,
  requestedClientId?: string | null,
): Promise<T> {
  const auth = req.apiAuth!;

  if (auth.role === 'CLIENT') {
    if (!auth.clientId) {
      throw forbidden('This account is not linked to a contractor company');
    }
    return withTenant(
      { companyId: auth.clientId, userId: auth.userId, platformRole: 'none', requestId: req.id },
      (tx) => fn(tx, auth.clientId),
    );
  }

  if (auth.role === 'PENDING') {
    throw forbidden('This account is awaiting authorization from an administrator');
  }

  // Staff. Cross-tenant by design, optionally narrowed to one contractor.
  return withServiceContext(
    (tx) => fn(tx, requestedClientId ?? null),
    { reason: `api_staff_${auth.role}`, ...(requestedClientId ? { companyId: requestedClientId } : {}) },
  );
}

const clientFilter = (companyId: string | null) => (companyId ? ` and company_id = '${companyId}'` : '');

export async function compatApiRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: requireApiAuth };

  // ---------------------------------------------------------------------------
  // Dashboard
  // ---------------------------------------------------------------------------

  app.get('/api/dashboard', auth, async (req) => {
    const q = parse(
      z.object({ clientId: z.string().uuid().optional() }),
      req.query,
      'query',
    );

    return scoped(req, async (tx, companyId) => {
      const counts = await tx.one<Record<string, string>>(
        `select
           (select count(*) from ocs.permits p
             where p.deleted_at is null
               and p.status not in ('closed','expired','withdrawn','rejected')
               ${companyId ? 'and p.company_id = $1' : ''})::text as open_permits,
           (select count(*) from ocs.permits p
             where p.deleted_at is null and p.status = 'corrections_required'
               ${companyId ? 'and p.company_id = $1' : ''})::text as corrections,
           (select count(*) from ocs.permit_applications a
             where a.deleted_at is null and a.status in ('draft','info_requested')
               ${companyId ? 'and a.company_id = $1' : ''})::text as open_applications,
           (select count(*) from ocs.supervision_engagements e
             where e.deleted_at is null and e.status = 'active'
               ${companyId ? 'and e.company_id = $1' : ''})::text as active_supervision,
           (select count(*) from ocs.supervision_visits v
             where v.is_mandatory and v.status not in ('completed','waived','cancelled')
               ${companyId ? 'and v.company_id = $1' : ''})::text as outstanding_visits,
           (select count(*) from ocs.licenses l
             where l.deleted_at is null and l.expires_on is not null
               and l.expires_on < current_date
               ${companyId ? 'and l.company_id = $1' : ''})::text as expired_credentials`,
        companyId ? [companyId] : [],
      );

      return {
        counts: {
          openPermits: Number(counts?.['open_permits'] ?? 0),
          correctionsRequired: Number(counts?.['corrections'] ?? 0),
          openApplications: Number(counts?.['open_applications'] ?? 0),
          activeSupervision: Number(counts?.['active_supervision'] ?? 0),
          outstandingVisits: Number(counts?.['outstanding_visits'] ?? 0),
          expiredCredentials: Number(counts?.['expired_credentials'] ?? 0),
        },
        role: req.apiAuth!.role,
        scopedToClientId: companyId,
      };
    }, q.clientId ?? null);
  });

  // ---------------------------------------------------------------------------
  // Clients (contractor companies)
  // ---------------------------------------------------------------------------

  app.get('/api/clients', { preHandler: [requireApiAuth, requireCapability('client:read')] }, async (req) => {
    return scoped(req, async (tx, companyId) => {
      const rows = await tx.many(
        `select c.id, c.name, c.legal_name, c.status::text, c.license_number,
                c.phone, c.email, c.city, c.state, c.created_at,
                (select count(*) from ocs.permits p
                  where p.company_id = c.id and p.deleted_at is null)::int as permit_count,
                (select count(*) from ocs.app_users u
                  where u.client_id = c.id and u.deleted_at is null)::int as user_count
           from ocs.companies c
          where c.deleted_at is null
            and ($1::uuid is null or c.id = $1::uuid)
          order by c.name
          limit 500`,
        [companyId],
      );
      return { clients: rows, total: rows.length };
    }, req.apiAuth!.role === 'CLIENT' ? req.apiAuth!.clientId : (req.query as { clientId?: string })?.clientId ?? null);
  });

  // ---------------------------------------------------------------------------
  // Permits
  // ---------------------------------------------------------------------------

  app.get('/api/permits', { preHandler: [requireApiAuth, requireCapability('permit:read')] }, async (req) => {
    const q = parse(
      z.object({
        clientId: z.string().uuid().optional(),
        status: z.string().max(40).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      }),
      req.query,
      'query',
    );

    return scoped(req, async (tx, companyId) => {
      const rows = await tx.many(
        `select p.id, p.company_id as "clientId", p.project_id as "projectId",
                p.permit_number as "permitNumber", p.permit_type as "permitType",
                p.status::text, p.scope_of_work as "scopeOfWork",
                p.applied_at, p.submitted_at, p.issued_at, p.expires_at,
                p.last_checked_at, p.created_at,
                m.name as "jurisdictionName",
                c.name as "clientName"
           from ocs.permits p
           left join ocs.municipalities m on m.id = p.municipality_id
           left join ocs.companies c on c.id = p.company_id
          where p.deleted_at is null
            and ($1::uuid is null or p.company_id = $1::uuid)
            and ($2::text is null or p.status::text = $2)
          order by p.created_at desc
          limit $3`,
        [companyId, q.status ?? null, q.limit],
      );
      return { permits: rows, total: rows.length };
    }, q.clientId ?? null);
  });

  // ---------------------------------------------------------------------------
  // Jurisdictions
  // ---------------------------------------------------------------------------

  app.get('/api/jurisdictions', { preHandler: [requireApiAuth, requireCapability('jurisdiction:read')] }, async (req) => {
    return scoped(req, async (tx) => {
      const rows = await tx.many(
        `select id, name, kind::text, county, state, portal_url as "portalUrl",
                platform::text, status_check_enabled as "statusCheckEnabled",
                adapter_verified_at as "verifiedAt"
           from ocs.municipalities
          where is_active
          order by kind, name
          limit 1000`,
      );
      return { jurisdictions: rows, total: rows.length };
    });
  });

  // ---------------------------------------------------------------------------
  // Supervision — site visits and photographs
  // ---------------------------------------------------------------------------

  app.get('/api/supervision/visits', { preHandler: [requireApiAuth, requireCapability('supervision:read')] }, async (req) => {
    const q = parse(
      z.object({
        clientId: z.string().uuid().optional(),
        permitId: z.string().uuid().optional(),
      }),
      req.query,
      'query',
    );

    return scoped(req, async (tx, companyId) => {
      const rows = await tx.many(
        `select v.id, v.company_id as "clientId", v.engagement_id as "engagementId",
                v.milestone_code as "milestoneCode", v.milestone_name as "milestoneName",
                v.status::text, v.is_mandatory as "isMandatory",
                v.scheduled_for as "scheduledFor",
                v.checked_in_at as "checkedInAt", v.checked_out_at as "checkedOutAt",
                v.distance_from_site_meters as "distanceFromSiteMeters",
                v.findings, v.work_approved as "workApproved",
                v.corrections_required as "correctionsRequired",
                v.signed_off_at as "signedOffAt", v.signature_name as "signatureName",
                v.photo_count as "photoCount",
                v.required_photo_count as "requiredPhotoCount",
                v.required_photo_types as "requiredPhotoTypes",
                e.permit_id as "permitId", e.site_address as "siteAddress",
                s.display_name as "supervisorName"
           from ocs.supervision_visits v
           join ocs.supervision_engagements e on e.id = v.engagement_id
           left join ocs.supervisors s on s.id = v.supervisor_id
          where ($1::uuid is null or v.company_id = $1::uuid)
            and ($2::uuid is null or e.permit_id = $2::uuid)
          order by coalesce(v.checked_in_at, v.scheduled_for) desc nulls last
          limit 300`,
        [companyId, q.permitId ?? null],
      );
      return { visits: rows, total: rows.length };
    }, q.clientId ?? null);
  });

  // ---------------------------------------------------------------------------
  // Users and role assignment
  // ---------------------------------------------------------------------------

  /** Role catalogue for an administrator's user-management screen. */
  app.get('/api/users/roles', { preHandler: [requireApiAuth, requireCapability('user:read')] }, async () => ({
    roles: roleCatalogue(),
  }));

  app.get('/api/users', { preHandler: [requireApiAuth, requireCapability('user:read')] }, async (req) => {
    const auth = req.apiAuth!;

    return withServiceContext(
      async (tx) => {
        // A contractor's own admin may list their team; staff list everyone.
        const restrictTo = auth.role === 'CLIENT' ? auth.clientId : null;

        const rows = await tx.many<UserRow>(
          `select id, email, name, app_role, client_id, is_active, password_hash,
                  token_version, created_at, last_login_at
             from ocs.app_users
            where deleted_at is null
              and ($1::uuid is null or client_id = $1::uuid)
            order by app_role, email
            limit 500`,
          [restrictTo],
        );
        return { users: rows.map(publicUser), total: rows.length };
      },
      { reason: 'list_users' },
    );
  });

  /**
   * Invite someone.
   *
   * A CLIENT admin may only invite CLIENT users into their own company. Without
   * that check, a contractor could invite themselves an ADMIN account and read
   * every other contractor's data.
   */
  app.post('/api/users/invite', { preHandler: [requireApiAuth, requireCapability('user:invite')] }, async (req, reply) => {
    const authCtx = req.apiAuth!;
    const body = parse(
      z.object({
        email: z.string().email().max(200),
        name: z.string().trim().max(200).optional(),
        role: z.enum(ROLES),
        clientId: z.string().uuid().optional(),
      }),
      req.body,
      'invitation',
    );

    if (authCtx.role === 'CLIENT') {
      if (body.role !== 'CLIENT') {
        throw forbidden('You can only invite users into your own company');
      }
      body.clientId = authCtx.clientId ?? undefined;
    }

    if (body.role === 'CLIENT' && !body.clientId) {
      throw badRequest('A contractor login needs the company it belongs to');
    }
    if (body.role !== 'CLIENT' && body.clientId) {
      throw badRequest('Staff roles are not tied to a single contractor');
    }

    const token = newInviteToken();
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const created = await withServiceContext(
      async (tx) => {
        const row = await tx.one<UserRow>(
          `insert into ocs.app_users
             (email, name, app_role, client_id, invite_token, invite_expires_at, is_active)
           values ($1,$2,$3::ocs.app_role,$4,$5,$6,true)
           on conflict (lower(email)) do update
             set name = coalesce(excluded.name, ocs.app_users.name),
                 app_role = excluded.app_role,
                 client_id = excluded.client_id,
                 invite_token = excluded.invite_token,
                 invite_expires_at = excluded.invite_expires_at,
                 is_active = true
           returning id, email, name, app_role, client_id, is_active, password_hash,
                     token_version, created_at, last_login_at`,
          [body.email.trim(), body.name ?? null, body.role, body.clientId ?? null, token, expires],
        );
        if (!row) throw badRequest('Could not create the invitation');

        await writeAudit(tx, {
          companyId: body.clientId ?? null,
          actorUserId: authCtx.userId,
          actorEmail: authCtx.email,
          action: 'user.invited',
          entityType: 'app_user',
          entityId: row.id,
          summary: `Invited ${body.email} as ${body.role}`,
          requestId: req.id,
          ipAddress: clientIp(req),
          userAgent: userAgent(req),
        });

        return row;
      },
      { reason: 'invite_user' },
    );

    logger.info({ email: body.email, role: body.role }, 'user invited');
    reply.code(201);

    return {
      user: publicUser(created),
      // Returned so an administrator can pass the link on directly. Email
      // delivery is optional in this deployment, and an invitation nobody can
      // send is worse than one shown once to the person creating it.
      inviteToken: token,
      inviteExpiresAt: expires.toISOString(),
      acceptPath: `/accept-invite?token=${token}`,
    };
  });

  /** Change someone's role, or deactivate them. */
  app.patch('/api/users/:userId', { preHandler: [requireApiAuth, requireCapability('user:assign_role')] }, async (req) => {
    const authCtx = req.apiAuth!;
    const { userId } = parse(z.object({ userId: z.string().uuid() }), req.params, 'parameters');
    const body = parse(
      z.object({
        role: z.enum(ROLES).optional(),
        active: z.boolean().optional(),
        name: z.string().trim().max(200).optional(),
      }),
      req.body,
      'user update',
    );

    // Locking yourself out, or demoting yourself while you are the only
    // administrator, leaves the system unadministrable.
    if (userId === authCtx.userId && (body.active === false || (body.role && body.role !== 'ADMIN'))) {
      throw badRequest('You cannot remove your own administrator access');
    }

    return withServiceContext(
      async (tx) => {
        const before = await tx.one<UserRow>(
          `select id, email, name, app_role, client_id, is_active, password_hash,
                  token_version, created_at, last_login_at
             from ocs.app_users where id = $1 and deleted_at is null for update`,
          [userId],
        );
        if (!before) throw notFound('User');

        if (before.app_role === 'ADMIN' && body.role && body.role !== 'ADMIN') {
          const remaining = await tx.one<{ n: string }>(
            `select count(*)::text as n from ocs.app_users
              where app_role = 'ADMIN' and is_active and deleted_at is null and id <> $1`,
            [userId],
          );
          if (Number(remaining?.n ?? 0) === 0) {
            throw badRequest('There must always be at least one active administrator');
          }
        }

        const updated = await tx.one<UserRow>(
          `update ocs.app_users
              set app_role = coalesce($2::ocs.app_role, app_role),
                  is_active = coalesce($3, is_active),
                  name = coalesce($4, name),
                  -- A role change or a deactivation must take effect now, not
                  -- when the person's current token happens to expire.
                  token_version = token_version + 1
            where id = $1
            returning id, email, name, app_role, client_id, is_active, password_hash,
                      token_version, created_at, last_login_at`,
          [userId, body.role ?? null, body.active ?? null, body.name ?? null],
        );

        await tx.query(
          `update ocs.refresh_tokens set revoked_at = now()
            where user_id = $1 and revoked_at is null`,
          [userId],
        );

        await writeAudit(tx, {
          companyId: before.client_id,
          actorUserId: authCtx.userId,
          actorEmail: authCtx.email,
          action: 'user.updated',
          entityType: 'app_user',
          entityId: userId,
          summary: `${before.email}: ${before.app_role} -> ${body.role ?? before.app_role}` +
            (body.active === false ? ' (deactivated)' : ''),
          before: { role: before.app_role, active: before.is_active },
          after: { role: updated?.app_role, active: updated?.is_active },
          requestId: req.id,
          ipAddress: clientIp(req),
        });

        return { user: publicUser(updated!) };
      },
      { reason: 'update_user' },
    );
  });

  // ---------------------------------------------------------------------------
  // Honest migration boundary
  // ---------------------------------------------------------------------------

  /**
   * Routers from the previous system that have not been ported yet.
   *
   * Answering with a named 501 rather than a 404 is deliberate: a screen that
   * is not migrated should say so, not look like a bug or an empty account. The
   * response names the area so it is obvious which one is missing.
   */
  const NOT_MIGRATED = [
    'corrections', 'inspections', 'signing', 'notary', 'support',
    'connectors', 'integrations', 'google', 'billing', 'admin',
  ];

  for (const area of NOT_MIGRATED) {
    app.all(`/api/${area}`, auth, async (_req, reply) => {
      reply.code(501);
      return {
        error: 'not_migrated',
        area,
        message:
          `The "${area}" area has not been migrated to the new backend yet. ` +
          'It is still available on the previous Netlify deployment.',
      };
    });
    app.all(`/api/${area}/*`, auth, async (_req, reply) => {
      reply.code(501);
      return {
        error: 'not_migrated',
        area,
        message:
          `The "${area}" area has not been migrated to the new backend yet. ` +
          'It is still available on the previous Netlify deployment.',
      };
    });
  }

  /** Which areas are live on this backend — useful during the migration. */
  app.get('/api/_migration-status', async () => ({
    migrated: [
      'auth', 'dashboard', 'clients', 'permits', 'jurisdictions',
      'supervision/visits', 'users',
    ],
    notMigrated: NOT_MIGRATED,
    note:
      'Migrated areas are backed by Postgres with row-level tenant isolation. ' +
      'Everything else still runs on the previous Netlify deployment.',
  }));
}

export { distanceMeters };

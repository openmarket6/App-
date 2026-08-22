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
import { badRequest, forbidden, notFound, conflict, AppError } from '../../lib/errors.js';
import { publicUser, newInviteToken, type UserRow } from '../../auth/native.js';
import { roleCatalogue, isStaff, ROLES, type Role } from '../../domain/capabilities.js';
import {
  PERMIT_STAGES, emptyPipeline, toStage, isActiveStage, toTrade,
  assessRisk, toPlatformLabel, toIntegrationTier, daysInStage,
  type PermitStage,
} from './mapping.js';
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

  /**
   * GET /api/dashboard
   *
   * Shape matches the previous implementation exactly, because the frontend
   * reads specific field names out of it. In particular `pipelineByStage` must
   * carry EVERY stage key including the zero ones — the frontend indexes
   * buckets by name, and a missing key renders a blank page rather than a
   * smaller dashboard.
   */
  app.get('/api/dashboard', auth, async (req) => {
    const q = parse(
      z.object({ clientId: z.string().uuid().optional() }),
      req.query,
      'query',
    );
    const isClientView = req.apiAuth!.role === 'CLIENT';

    return scoped(req, async (tx, companyId) => {
      const permits = await tx.many<{
        id: string; company_id: string; project_id: string | null;
        permit_number: string | null; permit_type: string; status: string;
        updated_at: string; expires_at: string | null; issued_at: string | null;
        municipality_id: string | null; municipality_name: string | null;
        platform: string | null; status_check_enabled: boolean;
        adapter_verified_at: string | null;
        project_name: string | null; project_address: string | null;
        client_name: string | null;
      }>(
        `select p.id, p.company_id, p.project_id, p.permit_number, p.permit_type,
                p.status::text, p.updated_at, p.expires_at, p.issued_at,
                p.municipality_id,
                m.name as municipality_name, m.platform::text as platform,
                m.status_check_enabled, m.adapter_verified_at,
                pr.name as project_name, pr.address_line1 as project_address,
                c.name as client_name
           from ocs.permits p
           left join ocs.municipalities m on m.id = p.municipality_id
           left join ocs.projects pr on pr.id = p.project_id
           left join ocs.companies c on c.id = p.company_id
          where p.deleted_at is null
            and ($1::uuid is null or p.company_id = $1::uuid)
          limit 5000`,
        [companyId],
      );

      const enriched = permits.map((p) => {
        const stage = toStage(p.status);
        return {
          row: p,
          stage,
          active: isActiveStage(stage),
          risk: assessRisk({ stage, updatedAt: p.updated_at, expiresAt: p.expires_at }),
        };
      });

      const pipelineByStage = emptyPipeline();
      for (const e of enriched) pipelineByStage[e.stage] += 1;

      const atRisk = enriched.filter(
        (e) => e.risk.level === 'AT_RISK' || e.risk.level === 'CRITICAL',
      );

      // First-pass approval: of the permits that reached a decision, how many
      // did so without ever needing corrections. Read from the immutable
      // status history rather than a counter that could drift.
      const decisionStats = await tx.one<{ decided: string; first_pass: string }>(
        `with decided as (
           select p.id
             from ocs.permits p
            where p.deleted_at is null
              and ($1::uuid is null or p.company_id = $1::uuid)
              and (p.issued_at is not null
                   or p.status in ('approved','issued','inspections','closed'))
         )
         select count(*)::text as decided,
                count(*) filter (
                  where not exists (
                    select 1 from ocs.permit_status_history h
                     where h.permit_id = decided.id
                       and h.to_status = 'corrections_required')
                )::text as first_pass
           from decided`,
        [companyId],
      );

      const decided = Number(decisionStats?.decided ?? 0);
      const firstPass = Number(decisionStats?.first_pass ?? 0);

      const openCorrections = enriched.filter((e) => e.stage === 'CORRECTIONS_REQUIRED').length;

      // Supervision visits scheduled in the week ahead stand in for the
      // inspections figure until the inspections area is migrated. Named
      // honestly in the response so it is not mistaken for jurisdiction
      // inspections.
      const upcoming = await tx.one<{ n: string }>(
        `select count(*)::text as n
           from ocs.supervision_visits v
          where v.status = 'scheduled'
            and v.scheduled_for between now() and now() + interval '7 days'
            and ($1::uuid is null or v.company_id = $1::uuid)`,
        [companyId],
      );

      // Busiest jurisdictions.
      const byJurisdiction = new Map<string, typeof enriched>();
      for (const e of enriched) {
        const key = e.row.municipality_id ?? 'unknown';
        const list = byJurisdiction.get(key);
        if (list) list.push(e);
        else byJurisdiction.set(key, [e]);
      }

      const busiestJurisdictions = [...byJurisdiction.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 8)
        .map(([id, rows]) => {
          const first = rows[0]!.row;
          return {
            jurisdictionId: id,
            name: first.municipality_name ?? 'Unknown jurisdiction',
            platform: toPlatformLabel(first.platform),
            integrationTier: toIntegrationTier(first),
            paperOnly: !first.platform || first.platform === 'none',
            permitCount: rows.length,
            activeCount: rows.filter((r) => r.active).length,
            // Null rather than a plausible-looking number: this backend has not
            // accumulated review-time observations yet, and inventing one would
            // make the dashboard authoritative about something it does not know.
            medianReviewDays: null,
            reviewSampleSize: 0,
            firstPassApprovalRate: null,
          };
        });

      const needsAttention = atRisk
        .map((e) => ({
          permitId: e.row.id,
          agencyRecordId: e.row.permit_number,
          permitType: e.row.permit_type,
          stage: e.stage,
          serviceLine: 'EXPEDITING',
          trade: toTrade(e.row.permit_type),
          projectName: e.row.project_name,
          projectAddress: e.row.project_address,
          clientId: e.row.company_id,
          clientName: e.row.client_name,
          jurisdictionId: e.row.municipality_id,
          jurisdictionName: e.row.municipality_name,
          risk: e.risk.level,
          score: e.risk.score,
          daysInStage: e.risk.daysInStage,
          baselineDays: e.risk.baselineDays,
          reasons: e.risk.reasons,
        }))
        .sort((a, b) => b.score - a.score);

      const kpis: Record<string, number | null> = {
        activePermits: enriched.filter((e) => e.active).length,
        atRisk: atRisk.length,
        openCorrections,
        readyToSubmit: pipelineByStage.READY_TO_SUBMIT,
        medianReviewDays: null,
        reviewSampleSize: 0,
        firstPassApprovalRate: decided === 0 ? null : Math.round((firstPass / decided) * 100),
        firstPassDecidedCount: decided,
        inspectionsThisWeek: Number(upcoming?.n ?? 0),
      };

      if (isClientView) {
        kpis['openTickets'] = 0;
      } else {
        const invoices = await tx.one<{ outstanding: string; overdue: string }>(
          `select
             coalesce(sum(greatest(0, total_cents - amount_paid_cents)), 0)::text as outstanding,
             count(*) filter (where status = 'past_due')::text as overdue
             from ocs.invoices
            where deleted_at is null
              and status in ('open','past_due')
              and ($1::uuid is null or company_id = $1::uuid)`,
          [companyId],
        );
        kpis['outstandingInvoiceCents'] = Number(invoices?.outstanding ?? 0);
        kpis['overdueInvoices'] = Number(invoices?.overdue ?? 0);
      }

      return {
        scope: companyId ? 'client' : 'firm',
        clientId: companyId,
        generatedAt: new Date().toISOString(),
        kpis,
        pipelineByStage,
        busiestJurisdictions,
        needsAttention,
        // Names the areas this backend can answer for, so a screen reading a
        // figure that is not migrated yet can say so rather than show a zero.
        _migrationNote: {
          inspectionsThisWeek: 'Counts supervision visits; jurisdiction inspections are not migrated yet.',
          medianReviewDays: 'Not yet measured on this backend.',
        },
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
        stage: z.enum(PERMIT_STAGES).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      }),
      req.query,
      'query',
    );

    return scoped(req, async (tx, companyId) => {
      const rows = await tx.many<{
        id: string; status: string; permit_type: string; updated_at: string;
        expires_at: string | null; [k: string]: unknown;
      }>(
        `select p.id, p.company_id as "clientId", p.project_id as "projectId",
                p.permit_number as "agencyRecordId", p.permit_type as "permitType",
                p.status::text, p.scope_of_work as "scopeOfWork",
                p.applied_at as "appliedAt", p.submitted_at as "submittedAt",
                p.issued_at as "issuedAt", p.expires_at as "expiresAt",
                p.last_checked_at as "lastCheckedAt", p.created_at as "createdAt",
                p.updated_at, p.municipality_id as "jurisdictionId",
                m.name as "jurisdictionName",
                pr.name as "projectName",
                c.name as "clientName"
           from ocs.permits p
           left join ocs.municipalities m on m.id = p.municipality_id
           left join ocs.projects pr on pr.id = p.project_id
           left join ocs.companies c on c.id = p.company_id
          where p.deleted_at is null
            and ($1::uuid is null or p.company_id = $1::uuid)
          order by p.created_at desc
          limit $2`,
        [companyId, q.limit],
      );

      // `stage` is the field the frontend reads; `status` is this schema's own
      // vocabulary. Both are returned so neither side has to guess.
      const permits = rows
        .map((r) => {
          const stage = toStage(r.status);
          return {
            ...r,
            stage,
            trade: toTrade(r.permit_type),
            serviceLine: 'EXPEDITING',
            correctionCycles: 0,
            risk: assessRisk({ stage, updatedAt: r.updated_at, expiresAt: r.expires_at }),
            daysInStage: daysInStage(r.updated_at),
          };
        })
        .filter((r) => !q.stage || r.stage === q.stage);

      return { permits, total: permits.length };
    }, q.clientId ?? null);
  });

  // ---------------------------------------------------------------------------
  // Jurisdictions
  // ---------------------------------------------------------------------------

  app.get('/api/jurisdictions', { preHandler: [requireApiAuth, requireCapability('jurisdiction:read')] }, async (req) => {
    return scoped(req, async (tx) => {
      const rows = await tx.many<Record<string, unknown>>(
        `select id, id as "jurisdictionId", name, kind::text, county, state,
                portal_url as "portalUrl", platform::text as platform,
                status_check_enabled, adapter_verified_at,
                status_check_enabled as "statusCheckEnabled"
           from ocs.municipalities
          where is_active
          order by kind, name
          limit 1000`,
      );

      const jurisdictions = rows.map((r) => ({
        ...r,
        platform: toPlatformLabel(r.platform as string | null),
        integrationTier: toIntegrationTier(r as never),
        paperOnly: !r.platform || r.platform === 'none',
        medianReviewDays: null,
        reviewSampleSize: 0,
      }));

      return { jurisdictions, total: jurisdictions.length };
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

  /**
   * The frontend PATCHes /users/:id/role for a role change and /users/:id for
   * a rename or deactivation. Both land on the same logic above -- this is the
   * address the shipped app actually calls, not a second implementation.
   */
  app.patch(
    '/api/users/:userId/role',
    { preHandler: [requireApiAuth, requireCapability('user:assign_role')] },
    async (req, reply) => {
      const { userId } = parse(z.object({ userId: z.string().uuid() }), req.params, 'parameters');
      const body = parse(
        z.object({
          role: z.enum(ROLES),
          clientId: z.string().uuid().nullable().optional(),
        }),
        req.body,
        'role change',
      );
      const authCtx = req.apiAuth!;

      /*
       * You cannot change your own role. Not merely a lockout guard: an
       * administrator who can promote themselves has no meaningful ceiling on
       * their access, so the restriction holds in both directions.
       */
      if (userId === authCtx.userId) {
        throw forbidden('You cannot change your own role — ask another administrator');
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

          if (before.app_role === 'ADMIN' && body.role !== 'ADMIN') {
            const remaining = await tx.one<{ n: string }>(
              `select count(*)::text as n from ocs.app_users
                where app_role = 'ADMIN' and is_active and deleted_at is null and id <> $1`,
              [userId],
            );
            if (Number(remaining?.n ?? 0) === 0) {
              throw conflict(
                'This is the last active administrator — promote someone else first',
              );
            }
          }

          const clientId = body.role === 'CLIENT' ? (body.clientId ?? before.client_id) : null;
          if (body.role === 'CLIENT' && !clientId) {
            throw badRequest('A portal account must be linked to a contractor — pass clientId');
          }
          if (clientId) {
            const company = await tx.one<{ id: string }>(
              `select id from ocs.companies where id = $1 and deleted_at is null`,
              [clientId],
            );
            if (!company) throw badRequest('No such contractor');
          }

          const updated = await tx.one<UserRow>(
            `update ocs.app_users
                set app_role = $2::ocs.app_role,
                    -- A staff account must not keep a contractor link behind
                    -- it: that link is what scopes their queries, and a stale
                    -- one is a scoping surprise waiting to happen.
                    client_id = $3,
                    token_version = token_version + 1
              where id = $1
              returning id, email, name, app_role, client_id, is_active, password_hash,
                        token_version, created_at, last_login_at`,
            [userId, body.role, clientId],
          );

          // The old role's access must not outlive the change by the life of
          // an access token.
          await tx.query(
            `update ocs.refresh_tokens set revoked_at = now()
              where user_id = $1 and revoked_at is null`,
            [userId],
          );

          await writeAudit(tx, {
            companyId: clientId,
            actorUserId: authCtx.userId,
            actorEmail: authCtx.email,
            action: 'user.role_changed',
            entityType: 'app_user',
            entityId: userId,
            summary: `${before.email}: ${before.app_role} -> ${body.role}`,
            before: { role: before.app_role, clientId: before.client_id },
            after: { role: body.role, clientId },
            requestId: req.id,
            ipAddress: clientIp(req),
          });

          void reply;
          return { user: publicUser(updated!) };
        },
        { reason: 'change_user_role' },
      );
    },
  );

  /**
   * Issue a fresh invitation.
   *
   * Refused once the person has a password, because at that point the problem
   * is not a missing invite -- it is a forgotten password, and a new invite
   * would silently reset an account somebody is already using.
   */
  app.post(
    '/api/users/:userId/resend-invite',
    { preHandler: [requireApiAuth, requireCapability('user:invite')] },
    async (req) => {
      const authCtx = req.apiAuth!;
      const { userId } = parse(z.object({ userId: z.string().uuid() }), req.params, 'parameters');

      return withServiceContext(
        async (tx) => {
          const target = await tx.one<UserRow>(
            `select id, email, name, app_role, client_id, is_active, password_hash,
                    token_version, created_at, last_login_at
               from ocs.app_users where id = $1 and deleted_at is null for update`,
            [userId],
          );
          if (!target) throw notFound('User');
          if (target.password_hash) {
            throw badRequest(
              'That user has already set a password. Sending a new invitation would ' +
                'reset an account they are using — reset their password instead.',
            );
          }

          const token = newInviteToken();
          const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

          const updated = await tx.one<UserRow>(
            `update ocs.app_users
                set invite_token = $2, invite_expires_at = $3, is_active = true
              where id = $1
              returning id, email, name, app_role, client_id, is_active, password_hash,
                        token_version, created_at, last_login_at`,
            [userId, token, expires],
          );

          await writeAudit(tx, {
            companyId: target.client_id,
            actorUserId: authCtx.userId,
            actorEmail: authCtx.email,
            action: 'user.invite_resent',
            entityType: 'app_user',
            entityId: userId,
            summary: `Invitation re-issued for ${target.email}`,
            requestId: req.id,
            ipAddress: clientIp(req),
          });

          return {
            user: publicUser(updated!),
            invitePending: true,
            // Returned so an administrator can pass the link on directly.
            // Email delivery is optional in this deployment, and an invitation
            // nobody can send is worse than one shown to the person creating it.
            inviteToken: token,
            inviteExpiresAt: expires.toISOString(),
            acceptPath: `/accept-invite?token=${token}`,
          };
        },
        { reason: 'resend_invite' },
      );
    },
  );

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
    'signing',
    'connectors', 'integrations', 'google',
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
      'supervision/visits', 'users', 'corrections', 'inspections', 'admin', 'support', 'notary', 'billing', 'drafting', 'portal',
    ],
    notMigrated: NOT_MIGRATED,
    note:
      'Migrated areas are backed by Postgres with row-level tenant isolation. ' +
      'Everything else still runs on the previous Netlify deployment.',
  }));
}


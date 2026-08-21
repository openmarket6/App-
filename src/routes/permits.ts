/**
 * Permits.
 *
 * Status changes go through a dedicated endpoint rather than a general PATCH,
 * because a permit's status is not just a field: it drives notifications, the
 * automated check schedule, and the immutable history in
 * ocs.permit_status_history. Allowing it to be set by a generic update would
 * make those side effects easy to bypass by accident.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, principalOf, tenantOf } from '../auth/plugin.js';
import { withTenant } from '../db/tenant.js';
import { requireCompanyRole } from '../auth/rbac.js';
import { parse, clientIp, userAgent, created } from '../lib/http-helpers.js';
import { writeAudit } from '../lib/audit.js';
import { notFound, unprocessable, badRequest } from '../lib/errors.js';
import { paginationQuery, decodeCursor, buildPage } from '../lib/pagination.js';
import { notify } from '../services/notifications.js';

const permitStatus = z.enum([
  'draft', 'ready_to_submit', 'submitted', 'under_review', 'corrections_required',
  'resubmitted', 'approved', 'issued', 'inspections', 'closed', 'expired',
  'rejected', 'withdrawn',
]);

type PermitStatus = z.infer<typeof permitStatus>;

/**
 * Permitted status transitions.
 *
 * Encoded explicitly so the system cannot record an impossible history --
 * a permit going straight from 'draft' to 'issued' means somebody mis-clicked
 * or a bug ran, and either way the record would be wrong. Terminal states have
 * no exits; correcting one is a deliberate admin action, not a normal update.
 */
const TRANSITIONS: Record<PermitStatus, PermitStatus[]> = {
  draft: ['ready_to_submit', 'withdrawn'],
  ready_to_submit: ['submitted', 'draft', 'withdrawn'],
  submitted: ['under_review', 'corrections_required', 'approved', 'rejected', 'withdrawn'],
  under_review: ['corrections_required', 'approved', 'rejected', 'withdrawn'],
  corrections_required: ['resubmitted', 'withdrawn'],
  resubmitted: ['under_review', 'corrections_required', 'approved', 'rejected'],
  approved: ['issued', 'expired', 'withdrawn'],
  issued: ['inspections', 'closed', 'expired'],
  inspections: ['closed', 'expired'],
  closed: [],
  expired: [],
  rejected: [],
  withdrawn: [],
};

const createSchema = z.object({
  projectId: z.string().uuid(),
  permitType: z.string().trim().min(1).max(120),
  municipalityId: z.string().uuid().optional(),
  permitNumber: z.string().trim().max(80).optional(),
  scopeOfWork: z.string().trim().max(5000).optional(),
  valuation: z.number().nonnegative().max(1e12).optional(),
  feeAmount: z.number().nonnegative().max(1e10).optional(),
  externalReference: z.string().trim().max(120).optional(),
  assignedTo: z.string().uuid().optional(),
});

const updateSchema = createSchema.partial().omit({ projectId: true });

const statusSchema = z.object({
  status: permitStatus,
  note: z.string().trim().max(2000).optional(),
  permitNumber: z.string().trim().max(80).optional(),
  /** Bypass the transition table. Admin only, and always audited. */
  force: z.boolean().default(false),
});

const listQuery = paginationQuery.extend({
  status: permitStatus.optional(),
  projectId: z.string().uuid().optional(),
  municipalityId: z.string().uuid().optional(),
  expiringWithinDays: z.coerce.number().int().min(1).max(365).optional(),
});

const SELECT_COLUMNS = `
  id, company_id, project_id, municipality_id, permit_number, permit_type,
  status::text, scope_of_work, valuation, applied_at, submitted_at, approved_at,
  issued_at, expires_at, closed_at, external_reference, last_checked_at,
  last_check_error, next_check_at, fee_amount, fee_paid_at, assigned_to,
  created_by, created_at, updated_at
`;

export async function permitRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/permits', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'viewer');

    const q = parse(listQuery, req.query, 'query');
    const cursor = decodeCursor(q.cursor);

    return withTenant(ctx, async (tx) => {
      const rows = await tx.many<{ id: string; created_at: string }>(
        `select ${SELECT_COLUMNS}
           from ocs.permits
          where company_id = $1
            and deleted_at is null
            and ($2::ocs.permit_status is null or status = $2::ocs.permit_status)
            and ($3::uuid is null or project_id = $3::uuid)
            and ($4::uuid is null or municipality_id = $4::uuid)
            and ($5::int is null
                 or (expires_at is not null
                     and expires_at <= now() + make_interval(days => $5::int)))
            and ($6::timestamptz is null
                 or (created_at, id) < ($6::timestamptz, $7::uuid))
          order by created_at desc, id desc
          limit $8`,
        [
          ctx.companyId,
          q.status ?? null,
          q.projectId ?? null,
          q.municipalityId ?? null,
          q.expiringWithinDays ?? null,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          q.limit + 1,
        ],
      );
      return buildPage(rows, q.limit);
    });
  });

  app.get('/v1/permits/:id', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'viewer');

    const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');

    return withTenant(ctx, async (tx) => {
      const permit = await tx.one<{ status: PermitStatus }>(
        `select ${SELECT_COLUMNS} from ocs.permits
          where id = $1 and company_id = $2 and deleted_at is null`,
        [id, ctx.companyId],
      );
      if (!permit) throw notFound('Permit');

      const history = await tx.many(
        `select from_status::text, to_status::text, source, note, changed_by, created_at
           from ocs.permit_status_history
          where permit_id = $1
          order by created_at desc
          limit 100`,
        [id],
      );

      return {
        ...permit,
        history,
        allowedTransitions: TRANSITIONS[permit.status] ?? [],
      };
    });
  });

  app.post('/v1/permits', { preHandler: authenticate }, async (req, reply) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'member');

    const body = parse(createSchema, req.body, 'permit');

    const permit = await withTenant(ctx, async (tx) => {
      // Confirm the project is visible to this tenant. RLS would reject the
      // insert anyway via the sync_permit_company trigger, but checking here
      // produces a clear 404 instead of a constraint error.
      const project = await tx.one<{ id: string; municipality_id: string | null }>(
        `select id, municipality_id from ocs.projects
          where id = $1 and company_id = $2 and deleted_at is null`,
        [body.projectId, ctx.companyId],
      );
      if (!project) throw notFound('Project');

      const row = await tx.one<{ id: string }>(
        `insert into ocs.permits
           (company_id, project_id, municipality_id, permit_number, permit_type,
            scope_of_work, valuation, fee_amount, external_reference, assigned_to, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         returning ${SELECT_COLUMNS}`,
        [
          ctx.companyId,
          body.projectId,
          body.municipalityId ?? project.municipality_id,
          body.permitNumber ?? null,
          body.permitType,
          body.scopeOfWork ?? null,
          body.valuation ?? null,
          body.feeAmount ?? null,
          body.externalReference ?? null,
          body.assignedTo ?? null,
          p.userId,
        ],
      );

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'permit.created',
        entityType: 'permit',
        entityId: row?.id ?? null,
        summary: `Permit "${body.permitType}" created`,
        after: row,
        requestId: req.id,
        ipAddress: clientIp(req),
        userAgent: userAgent(req),
      });

      return row;
    });

    return created(reply, permit);
  });

  app.patch('/v1/permits/:id', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'member');

    const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
    const body = parse(updateSchema, req.body, 'permit');

    return withTenant(ctx, async (tx) => {
      const before = await tx.one(
        `select ${SELECT_COLUMNS} from ocs.permits
          where id = $1 and company_id = $2 and deleted_at is null`,
        [id, ctx.companyId],
      );
      if (!before) throw notFound('Permit');

      const updated = await tx.one(
        `update ocs.permits
            set permit_type = coalesce($3, permit_type),
                municipality_id = coalesce($4, municipality_id),
                permit_number = coalesce($5, permit_number),
                scope_of_work = coalesce($6, scope_of_work),
                valuation = coalesce($7, valuation),
                fee_amount = coalesce($8, fee_amount),
                external_reference = coalesce($9, external_reference),
                assigned_to = coalesce($10, assigned_to)
          where id = $1 and company_id = $2 and deleted_at is null
          returning ${SELECT_COLUMNS}`,
        [
          id,
          ctx.companyId,
          body.permitType ?? null,
          body.municipalityId ?? null,
          body.permitNumber ?? null,
          body.scopeOfWork ?? null,
          body.valuation ?? null,
          body.feeAmount ?? null,
          body.externalReference ?? null,
          body.assignedTo ?? null,
        ],
      );

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'permit.updated',
        entityType: 'permit',
        entityId: id,
        before,
        after: updated,
        requestId: req.id,
        ipAddress: clientIp(req),
        userAgent: userAgent(req),
      });

      return updated;
    });
  });

  app.post('/v1/permits/:id/status', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'member');

    const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
    const body = parse(statusSchema, req.body, 'status change');

    if (body.force) requireCompanyRole(p, 'admin');

    return withTenant(ctx, async (tx) => {
      // Lock the row: two people advancing the same permit at once would
      // otherwise both read the old status and both pass the transition check.
      const current = await tx.one<{ id: string; status: PermitStatus; permit_number: string | null }>(
        `select id, status::text as status, permit_number
           from ocs.permits
          where id = $1 and company_id = $2 and deleted_at is null
          for update`,
        [id, ctx.companyId],
      );
      if (!current) throw notFound('Permit');

      if (current.status === body.status) {
        return { id, status: body.status, unchanged: true };
      }

      const allowed = TRANSITIONS[current.status] ?? [];
      if (!allowed.includes(body.status) && !body.force) {
        throw unprocessable(
          `A permit cannot move from "${current.status}" to "${body.status}"`,
          { currentStatus: current.status, allowedTransitions: allowed },
        );
      }

      await tx.query(`select set_config('ocs.change_source', 'user', true)`);

      const updated = await tx.one(
        `update ocs.permits
            set status = $3::ocs.permit_status,
                permit_number = coalesce($4, permit_number),
                submitted_at = case when $3 in ('submitted','resubmitted') and submitted_at is null
                                    then now() else submitted_at end,
                approved_at  = case when $3 = 'approved' and approved_at is null
                                    then now() else approved_at end,
                issued_at    = case when $3 = 'issued' and issued_at is null
                                    then now() else issued_at end,
                closed_at    = case when $3 = 'closed' and closed_at is null
                                    then now() else closed_at end
          where id = $1 and company_id = $2
          returning ${SELECT_COLUMNS}`,
        [id, ctx.companyId, body.status, body.permitNumber ?? null],
      );

      if (body.note) {
        await tx.query(
          `update ocs.permit_status_history
              set note = $2
            where id = (select max(id) from ocs.permit_status_history where permit_id = $1)`,
          [id, body.note],
        );
      }

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: body.force ? 'permit.status_forced' : 'permit.status_changed',
        entityType: 'permit',
        entityId: id,
        summary: `Status ${current.status} -> ${body.status}${body.force ? ' (forced)' : ''}`,
        before: { status: current.status },
        after: { status: body.status, note: body.note ?? null },
        requestId: req.id,
        ipAddress: clientIp(req),
        userAgent: userAgent(req),
      });

      if (body.status === 'corrections_required' || body.status === 'issued') {
        const recipients = await tx.many<{ user_id: string; email: string }>(
          `select m.user_id, u.email
             from ocs.company_memberships m
             join ocs.app_users u on u.id = m.user_id
            where m.company_id = $1 and m.is_active
              and u.is_active and u.deleted_at is null
              and m.user_id <> $2`,
          [ctx.companyId, p.userId],
        );
        for (const r of recipients) {
          await notify(tx, {
            companyId: ctx.companyId,
            userId: r.user_id,
            kind: body.status === 'corrections_required' ? 'corrections_required' : 'permit_status_changed',
            title: `Permit ${current.permit_number ?? ''} is now ${body.status}`.trim(),
            body: body.note ?? '',
            entityType: 'permit',
            entityId: id,
            linkPath: `/permits/${id}`,
            email: { to: r.email },
          });
        }
      }

      return updated;
    });
  });

  app.delete('/v1/permits/:id', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'admin');

    const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');

    return withTenant(ctx, async (tx) => {
      const row = await tx.one<{ id: string; status: string }>(
        `select id, status::text from ocs.permits
          where id = $1 and company_id = $2 and deleted_at is null`,
        [id, ctx.companyId],
      );
      if (!row) throw notFound('Permit');

      // An issued permit is a live obligation with the jurisdiction. Removing
      // it from our records does not remove it from theirs, and the contractor
      // still needs the history.
      if (['issued', 'inspections'].includes(row.status)) {
        throw badRequest(
          `A permit in "${row.status}" cannot be deleted. Close or withdraw it first.`,
        );
      }

      await tx.query(`update ocs.permits set deleted_at = now() where id = $1`, [id]);

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'permit.deleted',
        entityType: 'permit',
        entityId: id,
        requestId: req.id,
        ipAddress: clientIp(req),
        userAgent: userAgent(req),
      });

      return { id, deleted: true };
    });
  });

  /** Shared reference data for jurisdiction pickers. */
  app.get('/v1/municipalities', { preHandler: authenticate }, async (req) => {
    const ctx = tenantOf(req);
    const q = parse(
      z.object({
        search: z.string().trim().max(100).optional(),
        kind: z.enum(['city', 'county', 'state', 'special_district']).optional(),
      }),
      req.query,
      'query',
    );

    return withTenant(ctx, async (tx) => ({
      data: await tx.many(
        `select id, name, kind::text, county, state, portal_url,
                integration_method::text, status_check_enabled
           from ocs.municipalities
          where is_active
            and ($1::text is null or name ilike '%' || $1 || '%')
            and ($2::ocs.jurisdiction_kind is null or kind = $2::ocs.jurisdiction_kind)
          order by kind, name
          limit 500`,
        [q.search ?? null, q.kind ?? null],
      ),
    }));
  });
}

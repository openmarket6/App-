/**
 * Drafting orders, revisions and markups.
 *
 * Revisions are append-only. Approving or rejecting a revision never edits it
 * in place and never rewrites an earlier one -- a new revision supersedes the
 * old. Plan approval is the record of what a contractor agreed to build from,
 * and it has to stay reconstructible months later.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, principalOf, tenantOf } from '../auth/plugin.js';
import { withTenant } from '../db/tenant.js';
import { requireCompanyRole, requirePlatformRole } from '../auth/rbac.js';
import { parse, clientIp, userAgent, created } from '../lib/http-helpers.js';
import { writeAudit } from '../lib/audit.js';
import { notFound, unprocessable } from '../lib/errors.js';
import { paginationQuery, decodeCursor, buildPage } from '../lib/pagination.js';
import { notify } from '../services/notifications.js';

const draftingStatus = z.enum([
  'requested', 'accepted', 'in_progress', 'in_review', 'client_review',
  'revision_requested', 'approved', 'delivered', 'cancelled',
]);

const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional(),
  projectId: z.string().uuid().optional(),
  permitId: z.string().uuid().optional(),
  priority: z.enum(['low', 'normal', 'high', 'rush']).default('normal'),
  dueDate: z.string().date().optional(),
});

const ORDER_COLUMNS = `
  id, company_id, project_id, permit_id, order_number, title, description,
  status::text, priority::text, assigned_to, assigned_at, requested_by,
  due_date, delivered_at, current_revision, created_at, updated_at
`;

export async function draftingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/drafting-orders', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'viewer');

    const q = parse(
      paginationQuery.extend({
        status: draftingStatus.optional(),
        projectId: z.string().uuid().optional(),
        assignedToMe: z.coerce.boolean().default(false),
      }),
      req.query,
      'query',
    );
    const cursor = decodeCursor(q.cursor);

    return withTenant(ctx, async (tx) => {
      const rows = await tx.many<{ id: string; created_at: string }>(
        `select ${ORDER_COLUMNS} from ocs.drafting_orders
          where company_id = $1
            and deleted_at is null
            and ($2::ocs.drafting_status is null or status = $2::ocs.drafting_status)
            and ($3::uuid is null or project_id = $3::uuid)
            and ($4::boolean is false or assigned_to = $5::uuid)
            and ($6::timestamptz is null
                 or (created_at, id) < ($6::timestamptz, $7::uuid))
          order by created_at desc, id desc
          limit $8`,
        [
          ctx.companyId,
          q.status ?? null,
          q.projectId ?? null,
          q.assignedToMe,
          p.userId,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          q.limit + 1,
        ],
      );
      return buildPage(rows, q.limit);
    });
  });

  app.get('/v1/drafting-orders/:id', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'viewer');

    const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');

    return withTenant(ctx, async (tx) => {
      const order = await tx.one(
        `select ${ORDER_COLUMNS} from ocs.drafting_orders
          where id = $1 and company_id = $2 and deleted_at is null`,
        [id, ctx.companyId],
      );
      if (!order) throw notFound('Drafting order');

      const revisions = await tx.many(
        `select id, revision_number, status::text, notes, submitted_by, submitted_at,
                reviewed_by, reviewed_at, rejection_reason, created_at
           from ocs.drafting_revisions
          where drafting_order_id = $1
          order by revision_number desc`,
        [id],
      );

      return { ...order, revisions };
    });
  });

  app.post('/v1/drafting-orders', { preHandler: authenticate }, async (req, reply) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'member');

    const body = parse(createSchema, req.body, 'drafting order');

    const order = await withTenant(ctx, async (tx) => {
      const row = await tx.one<{ id: string; order_number: number; title: string }>(
        `insert into ocs.drafting_orders
           (company_id, project_id, permit_id, title, description, priority, due_date, requested_by)
         values ($1,$2,$3,$4,$5,$6::ocs.drafting_priority,$7,$8)
         returning ${ORDER_COLUMNS}`,
        [
          ctx.companyId,
          body.projectId ?? null,
          body.permitId ?? null,
          body.title,
          body.description ?? null,
          body.priority,
          body.dueDate ?? null,
          p.userId,
        ],
      );

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'drafting_order.created',
        entityType: 'drafting_order',
        entityId: row?.id ?? null,
        summary: `Drafting order "${body.title}" requested`,
        after: row,
        requestId: req.id,
        ipAddress: clientIp(req),
        userAgent: userAgent(req),
      });

      return row;
    });

    return created(reply, order);
  });

  /** Assignment is OCS's own scheduling decision, so it is staff-only. */
  app.post('/v1/drafting-orders/:id/assign', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requirePlatformRole(p, 'staff');

    const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
    const body = parse(z.object({ assignedTo: z.string().uuid() }), req.body, 'assignment');

    return withTenant(ctx, async (tx) => {
      const updated = await tx.one(
        `update ocs.drafting_orders
            set assigned_to = $3,
                assigned_at = now(),
                status = case when status = 'requested' then 'accepted'::ocs.drafting_status
                              else status end
          where id = $1 and company_id = $2 and deleted_at is null
          returning ${ORDER_COLUMNS}`,
        [id, ctx.companyId, body.assignedTo],
      );
      if (!updated) throw notFound('Drafting order');

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'drafting_order.assigned',
        entityType: 'drafting_order',
        entityId: id,
        after: { assignedTo: body.assignedTo },
        requestId: req.id,
      });

      return updated;
    });
  });

  /** Add a revision. Numbering is derived under a row lock, never client-supplied. */
  app.post('/v1/drafting-orders/:id/revisions', { preHandler: authenticate }, async (req, reply) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'member');

    const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
    const body = parse(
      z.object({ notes: z.string().trim().max(5000).optional() }),
      req.body,
      'revision',
    );

    const revision = await withTenant(ctx, async (tx) => {
      const order = await tx.one<{ id: string; current_revision: number; title: string }>(
        `select id, current_revision, title from ocs.drafting_orders
          where id = $1 and company_id = $2 and deleted_at is null
          for update`,
        [id, ctx.companyId],
      );
      if (!order) throw notFound('Drafting order');

      const next = order.current_revision + 1;

      // Earlier revisions become 'superseded' rather than being modified.
      await tx.query(
        `update ocs.drafting_revisions
            set status = 'superseded'
          where drafting_order_id = $1 and status in ('draft','submitted')`,
        [id],
      );

      const row = await tx.one<{ id: string; revision_number: number }>(
        `insert into ocs.drafting_revisions
           (company_id, drafting_order_id, revision_number, notes, status, submitted_by, submitted_at)
         values ($1,$2,$3,$4,'submitted',$5,now())
         returning id, revision_number, status::text, notes, submitted_at`,
        [ctx.companyId, id, next, body.notes ?? null, p.userId],
      );

      await tx.query(
        `update ocs.drafting_orders
            set current_revision = $2,
                status = 'client_review'::ocs.drafting_status
          where id = $1`,
        [id, next],
      );

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'drafting_revision.submitted',
        entityType: 'drafting_revision',
        entityId: row?.id ?? null,
        summary: `Revision ${next} submitted for "${order.title}"`,
        requestId: req.id,
      });

      const recipients = await tx.many<{ user_id: string; email: string }>(
        `select m.user_id, u.email from ocs.company_memberships m
           join ocs.app_users u on u.id = m.user_id
          where m.company_id = $1 and m.is_active and u.is_active and u.deleted_at is null
            and m.user_id <> $2`,
        [ctx.companyId, p.userId],
      );
      for (const r of recipients) {
        await notify(tx, {
          companyId: ctx.companyId,
          userId: r.user_id,
          kind: 'drafting_ready_for_review',
          title: `Revision ${next} ready for review: ${order.title}`,
          entityType: 'drafting_order',
          entityId: id,
          linkPath: `/drafting/${id}`,
          email: { to: r.email },
        });
      }

      return row;
    });

    return created(reply, revision);
  });

  /** Contractor approves or rejects a revision. */
  app.post(
    '/v1/drafting-orders/:id/revisions/:revisionId/decision',
    { preHandler: authenticate },
    async (req) => {
      const p = principalOf(req);
      const ctx = tenantOf(req);
      requireCompanyRole(p, 'member');

      const params = parse(
        z.object({ id: z.string().uuid(), revisionId: z.string().uuid() }),
        req.params,
        'parameters',
      );
      const body = parse(
        z.object({
          decision: z.enum(['approved', 'rejected']),
          reason: z.string().trim().max(2000).optional(),
        }),
        req.body,
        'decision',
      );

      if (body.decision === 'rejected' && !body.reason) {
        throw unprocessable('A reason is required when rejecting a revision');
      }

      return withTenant(ctx, async (tx) => {
        const revision = await tx.one<{ id: string; status: string; revision_number: number }>(
          `select id, status::text, revision_number from ocs.drafting_revisions
            where id = $1 and drafting_order_id = $2 and company_id = $3
            for update`,
          [params.revisionId, params.id, ctx.companyId],
        );
        if (!revision) throw notFound('Revision');

        if (revision.status === 'approved' || revision.status === 'rejected') {
          throw unprocessable(`This revision was already ${revision.status}`);
        }

        const updated = await tx.one(
          `update ocs.drafting_revisions
              set status = $2::ocs.revision_status,
                  reviewed_by = $3,
                  reviewed_at = now(),
                  rejection_reason = $4
            where id = $1
            returning id, revision_number, status::text, reviewed_at, rejection_reason`,
          [revision.id, body.decision, p.userId, body.reason ?? null],
        );

        await tx.query(
          `update ocs.drafting_orders
              set status = $2::ocs.drafting_status
            where id = $1`,
          [params.id, body.decision === 'approved' ? 'approved' : 'revision_requested'],
        );

        await writeAudit(tx, {
          companyId: ctx.companyId,
          actorUserId: p.userId,
          actorEmail: p.email,
          action: `drafting_revision.${body.decision}`,
          entityType: 'drafting_revision',
          entityId: revision.id,
          summary: `Revision ${revision.revision_number} ${body.decision}`,
          after: { decision: body.decision, reason: body.reason ?? null },
          requestId: req.id,
          ipAddress: clientIp(req),
          userAgent: userAgent(req),
        });

        return updated;
      });
    },
  );

  /** Markups on a revision. */
  app.post(
    '/v1/drafting-revisions/:revisionId/markups',
    { preHandler: authenticate },
    async (req, reply) => {
      const p = principalOf(req);
      const ctx = tenantOf(req);
      requireCompanyRole(p, 'member');

      const params = parse(
        z.object({ revisionId: z.string().uuid() }),
        req.params,
        'parameters',
      );
      const body = parse(
        z.object({
          body: z.string().trim().min(1).max(4000),
          pageNumber: z.number().int().positive().optional(),
          positionX: z.number().min(0).max(1).optional(),
          positionY: z.number().min(0).max(1).optional(),
        }),
        req.body,
        'markup',
      );

      const markup = await withTenant(ctx, async (tx) => {
        const revision = await tx.one(
          `select id from ocs.drafting_revisions where id = $1 and company_id = $2`,
          [params.revisionId, ctx.companyId],
        );
        if (!revision) throw notFound('Revision');

        return tx.one(
          `insert into ocs.drafting_markups
             (company_id, revision_id, page_number, position_x, position_y, body, created_by)
           values ($1,$2,$3,$4,$5,$6,$7)
           returning id, revision_id, page_number, position_x, position_y, body,
                     is_resolved, created_by, created_at`,
          [
            ctx.companyId,
            params.revisionId,
            body.pageNumber ?? null,
            body.positionX ?? null,
            body.positionY ?? null,
            body.body,
            p.userId,
          ],
        );
      });

      return created(reply, markup);
    },
  );

  app.get('/v1/drafting-revisions/:revisionId/markups', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'viewer');

    const params = parse(z.object({ revisionId: z.string().uuid() }), req.params, 'parameters');

    return withTenant(ctx, async (tx) => ({
      data: await tx.many(
        `select m.id, m.page_number, m.position_x, m.position_y, m.body,
                m.is_resolved, m.resolved_by, m.resolved_at, m.created_by, m.created_at,
                u.full_name as author_name
           from ocs.drafting_markups m
           left join ocs.app_users u on u.id = m.created_by
          where m.revision_id = $1 and m.company_id = $2
          order by m.created_at`,
        [params.revisionId, ctx.companyId],
      ),
    }));
  });
}

/**
 * Projects.
 *
 * Note on the queries below: they include `company_id = $1` even though
 * row-level security already guarantees it. That is not redundancy for its own
 * sake -- the predicate lets Postgres use the (company_id, status) indexes, and
 * it documents intent at the call site. The security guarantee comes from RLS;
 * this is for the planner and the reader.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, principalOf, tenantOf } from '../auth/plugin.js';
import { withTenant } from '../db/tenant.js';
import { requireCompanyRole } from '../auth/rbac.js';
import { parse, clientIp, userAgent, created } from '../lib/http-helpers.js';
import { writeAudit } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';
import { paginationQuery, decodeCursor, buildPage } from '../lib/pagination.js';

const projectStatus = z.enum(['lead', 'active', 'on_hold', 'completed', 'cancelled']);

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional(),
  status: projectStatus.default('active'),
  municipalityId: z.string().uuid().optional(),
  addressLine1: z.string().trim().max(200).optional(),
  addressLine2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().length(2).default('FL'),
  postalCode: z.string().trim().max(12).optional(),
  parcelNumber: z.string().trim().max(60).optional(),
  clientName: z.string().trim().max(200).optional(),
  clientEmail: z.string().email().max(200).optional(),
  clientPhone: z.string().trim().max(40).optional(),
  estimatedValue: z.number().nonnegative().max(1e12).optional(),
  startDate: z.string().date().optional(),
  targetCompletionDate: z.string().date().optional(),
});

const listQuery = paginationQuery.extend({
  status: projectStatus.optional(),
  search: z.string().trim().max(200).optional(),
  municipalityId: z.string().uuid().optional(),
});

const SELECT_COLUMNS = `
  id, company_id, project_number, name, description, status::text,
  municipality_id, address_line1, address_line2, city, state, postal_code,
  parcel_number, client_name, client_email, client_phone,
  estimated_value, start_date, target_completion_date, completed_at,
  created_by, created_at, updated_at
`;

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/projects', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'viewer');

    const q = parse(listQuery, req.query, 'query');
    const cursor = decodeCursor(q.cursor);

    return withTenant(ctx, async (tx) => {
      const rows = await tx.many<{ id: string; created_at: string }>(
        `select ${SELECT_COLUMNS}
           from ocs.projects
          where company_id = $1
            and deleted_at is null
            and ($2::ocs.project_status is null or status = $2::ocs.project_status)
            and ($3::uuid is null or municipality_id = $3::uuid)
            and ($4::text is null or name ilike '%' || $4 || '%'
                 or client_name ilike '%' || $4 || '%'
                 or address_line1 ilike '%' || $4 || '%')
            and ($5::timestamptz is null
                 or (created_at, id) < ($5::timestamptz, $6::uuid))
          order by created_at desc, id desc
          limit $7`,
        [
          ctx.companyId,
          q.status ?? null,
          q.municipalityId ?? null,
          q.search ?? null,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          q.limit + 1,
        ],
      );

      return buildPage(rows, q.limit);
    });
  });

  app.get('/v1/projects/:id', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'viewer');

    const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');

    return withTenant(ctx, async (tx) => {
      const project = await tx.one(
        `select ${SELECT_COLUMNS} from ocs.projects
          where id = $1 and company_id = $2 and deleted_at is null`,
        [id, ctx.companyId],
      );
      // Another tenant's id lands here as 404, because RLS filtered the row out
      // before this check ran. The caller cannot tell "not yours" from
      // "does not exist", which is the intent.
      if (!project) throw notFound('Project');

      const permits = await tx.many(
        `select id, permit_number, permit_type, status::text, applied_at, issued_at, expires_at
           from ocs.permits
          where project_id = $1 and deleted_at is null
          order by created_at desc`,
        [id],
      );

      return { ...project, permits };
    });
  });

  app.post('/v1/projects', { preHandler: authenticate }, async (req, reply) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'member');

    const body = parse(createSchema, req.body, 'project');

    const project = await withTenant(ctx, async (tx) => {
      const row = await tx.one<{ id: string; project_number: number }>(
        `insert into ocs.projects
           (company_id, name, description, status, municipality_id,
            address_line1, address_line2, city, state, postal_code, parcel_number,
            client_name, client_email, client_phone, estimated_value,
            start_date, target_completion_date, created_by)
         values ($1,$2,$3,$4::ocs.project_status,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         returning ${SELECT_COLUMNS}`,
        [
          ctx.companyId,
          body.name,
          body.description ?? null,
          body.status,
          body.municipalityId ?? null,
          body.addressLine1 ?? null,
          body.addressLine2 ?? null,
          body.city ?? null,
          body.state,
          body.postalCode ?? null,
          body.parcelNumber ?? null,
          body.clientName ?? null,
          body.clientEmail ?? null,
          body.clientPhone ?? null,
          body.estimatedValue ?? null,
          body.startDate ?? null,
          body.targetCompletionDate ?? null,
          p.userId,
        ],
      );

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'project.created',
        entityType: 'project',
        entityId: row?.id ?? null,
        summary: `Project "${body.name}" created`,
        after: row,
        requestId: req.id,
        ipAddress: clientIp(req),
        userAgent: userAgent(req),
      });

      return row;
    });

    return created(reply, project);
  });

  app.patch('/v1/projects/:id', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'member');

    const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
    const body = parse(createSchema.partial(), req.body, 'project');

    return withTenant(ctx, async (tx) => {
      const before = await tx.one(
        `select ${SELECT_COLUMNS} from ocs.projects
          where id = $1 and company_id = $2 and deleted_at is null`,
        [id, ctx.companyId],
      );
      if (!before) throw notFound('Project');

      const updated = await tx.one(
        `update ocs.projects
            set name = coalesce($3, name),
                description = coalesce($4, description),
                status = coalesce($5::ocs.project_status, status),
                municipality_id = coalesce($6, municipality_id),
                address_line1 = coalesce($7, address_line1),
                address_line2 = coalesce($8, address_line2),
                city = coalesce($9, city),
                state = coalesce($10, state),
                postal_code = coalesce($11, postal_code),
                parcel_number = coalesce($12, parcel_number),
                client_name = coalesce($13, client_name),
                client_email = coalesce($14, client_email),
                client_phone = coalesce($15, client_phone),
                estimated_value = coalesce($16, estimated_value),
                start_date = coalesce($17, start_date),
                target_completion_date = coalesce($18, target_completion_date),
                completed_at = case when $5 = 'completed' and completed_at is null
                                    then now() else completed_at end
          where id = $1 and company_id = $2 and deleted_at is null
          returning ${SELECT_COLUMNS}`,
        [
          id,
          ctx.companyId,
          body.name ?? null,
          body.description ?? null,
          body.status ?? null,
          body.municipalityId ?? null,
          body.addressLine1 ?? null,
          body.addressLine2 ?? null,
          body.city ?? null,
          body.state ?? null,
          body.postalCode ?? null,
          body.parcelNumber ?? null,
          body.clientName ?? null,
          body.clientEmail ?? null,
          body.clientPhone ?? null,
          body.estimatedValue ?? null,
          body.startDate ?? null,
          body.targetCompletionDate ?? null,
        ],
      );

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'project.updated',
        entityType: 'project',
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

  /**
   * Soft delete. Permits, documents and history hang off this row, and a hard
   * delete would take a permit record the jurisdiction still considers live.
   */
  app.delete('/v1/projects/:id', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'admin');

    const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');

    return withTenant(ctx, async (tx) => {
      const row = await tx.one<{ id: string; name: string }>(
        `update ocs.projects set deleted_at = now()
          where id = $1 and company_id = $2 and deleted_at is null
          returning id, name`,
        [id, ctx.companyId],
      );
      if (!row) throw notFound('Project');

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'project.deleted',
        entityType: 'project',
        entityId: id,
        summary: `Project "${row.name}" deleted`,
        requestId: req.id,
        ipAddress: clientIp(req),
        userAgent: userAgent(req),
      });

      return { id: row.id, deleted: true };
    });
  });
}

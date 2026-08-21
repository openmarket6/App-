/**
 * Administrative endpoints.
 *
 * Split by who they are for:
 *
 *   /v1/audit-log       -- a company's own history. Available to that company's
 *                          admins, tenant-scoped like everything else.
 *   /v1/admin/*         -- One Contractor Solutions platform staff only.
 *
 * The /v1/admin/* routes each call requirePlatformRole explicitly. There is no
 * "admin router with a blanket guard", because a route added to such a router
 * without thinking inherits privileges silently. Here, an unguarded admin route
 * is a visible omission in the handler.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, principalOf, tenantOf } from '../auth/plugin.js';
import { withTenant, withServiceContext } from '../db/tenant.js';
import { requireCompanyRole, requirePlatformRole, requireMfa } from '../auth/rbac.js';
import { parse } from '../lib/http-helpers.js';
import { writeAudit } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';
import { paginationQuery, decodeCursor, buildPage } from '../lib/pagination.js';
import { deadJobs, retryDeadJob, queueStats } from '../jobs/queue.js';
import { listAdapters } from '../services/municipalities/adapter.js';
import { registeredJobTypes } from '../jobs/runner.js';

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  /** A company's own audit history. */
  app.get('/v1/audit-log', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'admin');

    const q = parse(
      paginationQuery.extend({
        entityType: z.string().trim().max(60).optional(),
        entityId: z.string().uuid().optional(),
        action: z.string().trim().max(80).optional(),
      }),
      req.query,
      'query',
    );
    const cursor = decodeCursor(q.cursor);

    return withTenant(ctx, async (tx) => {
      const rows = await tx.many<{ id: string; created_at: string }>(
        `select id::text, actor_user_id, actor_email, action, entity_type, entity_id,
                summary, request_id, ip_address::text, created_at
           from ocs.audit_log
          where company_id = $1
            and ($2::text is null or entity_type = $2)
            and ($3::uuid is null or entity_id = $3::uuid)
            and ($4::text is null or action = $4)
            and ($5::timestamptz is null or created_at < $5::timestamptz)
          order by created_at desc, id desc
          limit $6`,
        [
          ctx.companyId,
          q.entityType ?? null,
          q.entityId ?? null,
          q.action ?? null,
          cursor?.createdAt ?? null,
          q.limit + 1,
        ],
      );
      return buildPage(rows, q.limit);
    });
  });

  // ---------------------------------------------------------------------------
  // Platform staff
  // ---------------------------------------------------------------------------

  app.get('/v1/admin/queue', { preHandler: authenticate }, async (req) => {
    requirePlatformRole(principalOf(req), 'staff');
    return {
      stats: await queueStats(),
      registeredJobTypes: registeredJobTypes(),
    };
  });

  /**
   * Jobs that exhausted their retries. Each one is work that did NOT happen --
   * an unsent expiry warning, an unapplied payment event -- so this list should
   * be watched, not just available.
   */
  app.get('/v1/admin/jobs/dead', { preHandler: authenticate }, async (req) => {
    requirePlatformRole(principalOf(req), 'staff');
    const q = parse(
      z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
      req.query,
      'query',
    );
    return { data: await deadJobs(q.limit) };
  });

  app.post('/v1/admin/jobs/:jobId/retry', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    requirePlatformRole(p, 'admin');

    const { jobId } = parse(z.object({ jobId: z.string().uuid() }), req.params, 'parameters');
    const requeued = await retryDeadJob(jobId);
    if (!requeued) throw notFound('Dead job');

    await withServiceContext(
      async (tx) => {
        await writeAudit(tx, {
          actorUserId: p.userId,
          actorEmail: p.email,
          action: 'admin.job_retried',
          entityType: 'job',
          entityId: jobId,
          summary: `Dead job ${jobId} requeued`,
          requestId: req.id,
        });
      },
      { reason: 'audit_job_retry' },
    );

    return { jobId, requeued: true };
  });

  app.get('/v1/admin/webhooks', { preHandler: authenticate }, async (req) => {
    requirePlatformRole(principalOf(req), 'staff');
    const q = parse(
      z.object({
        status: z.enum(['received', 'processing', 'processed', 'failed', 'ignored']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
      'query',
    );

    return withServiceContext(
      async (tx) => ({
        // Deliberately excludes `payload`: provider payloads carry customer
        // details that an admin list view has no need to display.
        data: await tx.many(
          `select id, provider, provider_event_id, event_type, signature_verified,
                  status, attempts, last_error, received_at, processed_at
             from ocs.webhook_events
            where ($1::text is null or status = $1)
            order by received_at desc
            limit $2`,
          [q.status ?? null, q.limit],
        ),
      }),
      { reason: 'admin_list_webhooks' },
    );
  });

  app.get('/v1/admin/companies', { preHandler: authenticate }, async (req) => {
    requirePlatformRole(principalOf(req), 'admin');
    const q = parse(
      z.object({
        search: z.string().trim().max(120).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
      'query',
    );

    return withServiceContext(
      async (tx) => ({
        data: await tx.many(
          `select c.id, c.name, c.status::text, c.license_number, c.created_at,
                  (select count(*) from ocs.company_memberships m
                    where m.company_id = c.id and m.is_active)::int as member_count,
                  (select count(*) from ocs.projects p
                    where p.company_id = c.id and p.deleted_at is null)::int as project_count
             from ocs.companies c
            where c.deleted_at is null
              and ($1::text is null or c.name ilike '%' || $1 || '%')
            order by c.name
            limit $2`,
          [q.search ?? null, q.limit],
        ),
      }),
      { reason: 'admin_list_companies' },
    );
  });

  app.get('/v1/admin/integrations', { preHandler: authenticate }, async (req) => {
    requirePlatformRole(principalOf(req), 'staff');

    return withServiceContext(
      async (tx) => ({
        adapters: listAdapters(),
        jurisdictions: await tx.many(
          `select id, name, kind::text, integration_method::text, adapter_key,
                  status_check_enabled, status_check_interval_seconds, portal_url
             from ocs.municipalities
            where is_active
            order by status_check_enabled desc, name
            limit 500`,
        ),
        recentFailures: await tx.many(
          `select r.id::text, r.integration_key, r.operation, r.outcome, r.http_status,
                  r.error_message, r.created_at, m.name as municipality
             from ocs.integration_runs r
             left join ocs.municipalities m on m.id = r.municipality_id
            where r.outcome not in ('success','no_change')
            order by r.created_at desc
            limit 50`,
        ),
      }),
      { reason: 'admin_integrations' },
    );
  });

  /**
   * Configure a jurisdiction's automated status checking.
   *
   * MFA-gated: turning this on points automation at an external system and
   * changes what contractors are told about their permits.
   */
  app.patch('/v1/admin/municipalities/:id', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    requirePlatformRole(p, 'admin');
    requireMfa(p);

    const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
    const body = parse(
      z.object({
        portalUrl: z.string().url().max(500).optional(),
        adapterKey: z.string().trim().max(80).optional(),
        integrationMethod: z
          .enum(['api', 'portal_scrape', 'email', 'manual', 'none'])
          .optional(),
        statusCheckEnabled: z.boolean().optional(),
        statusCheckIntervalSeconds: z.number().int().min(300).max(604800).optional(),
        contactPhone: z.string().trim().max(40).optional(),
        contactEmail: z.string().email().max(200).optional(),
        notes: z.string().trim().max(2000).optional(),
      }),
      req.body,
      'municipality',
    );

    return withServiceContext(
      async (tx) => {
        const before = await tx.one(`select * from ocs.municipalities where id = $1`, [id]);
        if (!before) throw notFound('Municipality');

        const updated = await tx.one(
          `update ocs.municipalities
              set portal_url = coalesce($2, portal_url),
                  adapter_key = coalesce($3, adapter_key),
                  integration_method = coalesce($4::ocs.integration_method, integration_method),
                  status_check_enabled = coalesce($5, status_check_enabled),
                  status_check_interval_seconds = coalesce($6, status_check_interval_seconds),
                  contact_phone = coalesce($7, contact_phone),
                  contact_email = coalesce($8, contact_email),
                  notes = coalesce($9, notes)
            where id = $1
            returning id, name, kind::text, portal_url, adapter_key,
                      integration_method::text, status_check_enabled,
                      status_check_interval_seconds`,
          [
            id,
            body.portalUrl ?? null,
            body.adapterKey ?? null,
            body.integrationMethod ?? null,
            body.statusCheckEnabled ?? null,
            body.statusCheckIntervalSeconds ?? null,
            body.contactPhone ?? null,
            body.contactEmail ?? null,
            body.notes ?? null,
          ],
        );

        await writeAudit(tx, {
          actorUserId: p.userId,
          actorEmail: p.email,
          action: 'admin.municipality_updated',
          entityType: 'municipality',
          entityId: id,
          before,
          after: updated,
          requestId: req.id,
        });

        return updated;
      },
      { reason: 'admin_update_municipality' },
    );
  });
}

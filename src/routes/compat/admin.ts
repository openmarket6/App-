/**
 * /api/admin — running the platform, rather than using it.
 *
 * The previous implementation's admin area was mostly housekeeping for the
 * Netlify Blobs store: seeding, purging demo rows, taking and restoring
 * backups. None of that survives the move to Postgres. Migrations replace
 * seeding, and backups belong to the managed database, where they are
 * continuous and point-in-time rather than a JSON file somebody remembered to
 * write. Reimplementing them here would mean a worse copy of something the
 * platform already does properly.
 *
 * What is here instead is what an administrator actually needs and could not
 * previously get without a database client: who has access, what has been
 * happening, and whether the integrations this business depends on are
 * configured.
 *
 * ONE RULE THROUGHOUT: this file reports whether a secret is SET. It never
 * reports its value, its length, or a prefix. A diagnostics page is the most
 * commonly screen-shotted page in any admin panel.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withServiceContext } from '../../db/tenant.js';
import { requireApiAuth, requireCapability } from './auth.js';
import { parse } from '../../lib/http-helpers.js';
import { forbidden } from '../../lib/errors.js';
import { env } from '../../config/env.js';
import { usingSeparateServiceRole } from '../../db/pool.js';
import { ROLE_CAPABILITIES, roleCatalogue } from '../../domain/capabilities.js';

/** True when a configuration value is present and not blank. */
const isSet = (v: string | undefined | null): boolean => Boolean(v && v.trim().length > 0);

/**
 * Refuses anyone who is not an ADMIN.
 *
 * Capabilities govern the rest of the API, but this area is deliberately
 * role-gated as well. Several of these endpoints describe the shape of the
 * system itself, and that is an administrator's business specifically -- not
 * something to hand out by editing a capability list.
 */
async function requireAdmin(req: Parameters<typeof requireApiAuth>[0]): Promise<void> {
  if (req.apiAuth?.role !== 'ADMIN') {
    throw forbidden('This area is restricted to administrators');
  }
}

export async function compatAdminRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Is the platform configured, and what is it missing?
   *
   * Written to be read by a person deciding what to do next, so each connector
   * says what stops working while it is unconfigured rather than only true or
   * false.
   */
  app.get(
    '/api/admin/diagnostics',
    { preHandler: [requireApiAuth, requireAdmin] },
    async () => {
      const connectors = [
        {
          key: 'database_service_role',
          label: 'Separate service database role',
          configured: usingSeparateServiceRole,
          without:
            'Background work runs on the same role as user requests, so tenant ' +
            'isolation depends on application code alone rather than the database.',
        },
        {
          key: 'native_auth',
          label: 'Email and password sign-in',
          configured: isSet(env.AUTH_JWT_SECRET) && isSet(env.AUTH_REFRESH_SECRET),
          without: 'Nobody can sign in.',
        },
        {
          key: 'integration_encryption',
          label: 'Credential encryption key',
          configured: isSet(env.INTEGRATION_ENCRYPTION_KEY),
          without: 'Municipal portal logins cannot be stored.',
        },
        {
          key: 'stripe',
          label: 'Stripe',
          configured: isSet(env.STRIPE_SECRET_KEY),
          without: 'No payments, subscriptions or invoicing.',
        },
        {
          key: 'stripe_webhook',
          label: 'Stripe webhook signing secret',
          configured: isSet(env.STRIPE_WEBHOOK_SECRET),
          without:
            'Payment results are never confirmed back, so an invoice can be paid ' +
            'and still show as outstanding.',
        },
        {
          key: 'email',
          label: 'Email delivery (Resend)',
          configured: isSet(env.RESEND_API_KEY),
          without: 'No notifications, invitations or reminders are delivered.',
        },
        {
          key: 'storage',
          label: 'Supabase storage',
          configured: isSet(env.SUPABASE_URL) && isSet(env.SUPABASE_SERVICE_ROLE_KEY),
          without: 'Documents and supervision photographs cannot be uploaded.',
        },
      ];

      return {
        environment: env.NODE_ENV,
        connectors,
        // The count is what an operator scans first; the detail is underneath.
        unconfigured: connectors.filter((c) => !c.configured).map((c) => c.key),
        roles: roleCatalogue(),
        time: new Date().toISOString(),
      };
    },
  );

  /**
   * The audit trail.
   *
   * Append-only at the database level, which is what makes it worth reading:
   * an actor cannot tidy away their own entry. `actorEmail` is denormalised
   * onto each row, so the record still names who did it after the account is
   * deleted.
   */
  app.get(
    '/api/admin/audit',
    { preHandler: [requireApiAuth, requireAdmin] },
    async (req) => {
      const q = parse(
        z.object({
          action: z.string().max(80).optional(),
          entityType: z.string().max(60).optional(),
          entityId: z.string().uuid().optional(),
          actorUserId: z.string().uuid().optional(),
          companyId: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(100),
          before: z.coerce.number().int().positive().optional(),
        }),
        req.query,
        'query',
      );

      return withServiceContext(
        async (tx) => {
          const entries = await tx.many(
            `select id, company_id as "companyId", actor_user_id as "actorUserId",
                    actor_email as "actorEmail", action, entity_type as "entityType",
                    entity_id as "entityId", summary, before_data as "before",
                    after_data as "after", request_id as "requestId",
                    host(ip_address) as "ipAddress", created_at as "createdAt"
               from ocs.audit_log
              where ($1::text is null or action = $1)
                and ($2::text is null or entity_type = $2)
                and ($3::uuid is null or entity_id = $3)
                and ($4::uuid is null or actor_user_id = $4)
                and ($5::uuid is null or company_id = $5)
                and ($6::bigint is null or id < $6)
              order by id desc
              limit $7`,
            [
              q.action ?? null, q.entityType ?? null, q.entityId ?? null,
              q.actorUserId ?? null, q.companyId ?? null, q.before ?? null, q.limit,
            ],
          );

          // Keyset pagination on the primary key rather than an offset: an
          // audit log is written to constantly, and an offset shifts under the
          // reader so rows are skipped or shown twice while paging.
          const last = entries.at(-1) as { id?: string } | undefined;
          return {
            entries,
            total: entries.length,
            nextBefore: entries.length === q.limit ? (last?.id ?? null) : null,
          };
        },
        { reason: 'read_audit_log' },
      );
    },
  );

  /** What each role may do. Reference for whoever assigns them. */
  app.get(
    '/api/admin/capabilities',
    { preHandler: [requireApiAuth, requireCapability('user:read')] },
    async () => ({
      roles: roleCatalogue().map((r) => ({
        ...r,
        capabilities: ROLE_CAPABILITIES[r.value] ?? [],
      })),
    }),
  );

  /**
   * A count of everything, for an administrator wondering what is actually in
   * here. Cheap enough to run on demand; these are indexed counts, not scans of
   * wide rows.
   */
  app.get(
    '/api/admin/stats',
    { preHandler: [requireApiAuth, requireAdmin] },
    async () => {
      return withServiceContext(
        async (tx) => {
          const row = await tx.one(
            `select
               (select count(*) from ocs.companies where deleted_at is null)        as "contractors",
               (select count(*) from ocs.app_users where deleted_at is null)        as "users",
               (select count(*) from ocs.app_users
                 where deleted_at is null and password_hash is null)                as "usersWithoutPassword",
               (select count(*) from ocs.app_users
                 where deleted_at is null and app_role = 'PENDING')                 as "usersAwaitingRole",
               (select count(*) from ocs.permits where deleted_at is null)          as "permits",
               (select count(*) from ocs.permits
                 where deleted_at is null and status = 'corrections_required')      as "permitsInCorrections",
               (select count(*) from ocs.permit_inspections
                 where result = 'scheduled')                                        as "inspectionsScheduled",
               (select count(*) from ocs.supervision_visits
                 where status = 'scheduled')                                        as "visitsScheduled",
               (select count(*) from ocs.demo_requests where status = 'new')        as "newDemoRequests",
               (select count(*) from ocs.jobs where status = 'dead')                as "deadJobs",
               (select count(*) from ocs.municipalities
                 where status_check_enabled)                                        as "jurisdictionsAutomated"`,
          );

          /**
           * Two of these are the ones that matter operationally, so they are
           * called out rather than left for someone to notice in a list:
           * accounts that can never sign in, and background jobs that have
           * given up. Both are silent failures otherwise -- the first looks
           * like "the login is broken", the second like work that quietly
           * stopped happening.
           */
          const counts = row as Record<string, string>;
          const attention: string[] = [];
          if (Number(counts['usersWithoutPassword']) > 0) {
            attention.push(
              `${counts['usersWithoutPassword']} account(s) have never set a password and cannot sign in`,
            );
          }
          if (Number(counts['usersAwaitingRole']) > 0) {
            attention.push(
              `${counts['usersAwaitingRole']} account(s) are awaiting a role and can do nothing once signed in`,
            );
          }
          if (Number(counts['deadJobs']) > 0) {
            attention.push(`${counts['deadJobs']} background job(s) have exhausted their retries`);
          }

          return { counts: row, attention };
        },
        { reason: 'admin_stats' },
      );
    },
  );

  /**
   * Background jobs that gave up.
   *
   * A dead job is work that was meant to happen and did not -- a status check,
   * a reminder, a notification. Nothing else in the product will mention it, so
   * without this view it is invisible until a customer asks why they were never
   * told something.
   */
  app.get(
    '/api/admin/jobs/dead',
    { preHandler: [requireApiAuth, requireAdmin] },
    async (req) => {
      const q = parse(
        z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
        req.query,
        'query',
      );

      return withServiceContext(
        async (tx) => {
          const jobs = await tx.many(
            `select id, company_id as "companyId", queue, job_type as "jobType",
                    attempts, max_attempts as "maxAttempts", error_count as "errorCount",
                    last_error as "lastError", run_at as "runAt",
                    created_at as "createdAt", started_at as "startedAt",
                    finished_at as "finishedAt"
               from ocs.jobs
              where status = 'dead'
              order by coalesce(finished_at, run_at) desc
              limit $1`,
            [q.limit],
          );
          return { jobs, total: jobs.length };
        },
        { reason: 'list_dead_jobs' },
      );
    },
  );

  /**
   * Put a dead job back in the queue.
   *
   * Attempts are reset, because a job that died from a transient outage should
   * get a full allowance once the cause is fixed rather than one last try.
   */
  app.post(
    '/api/admin/jobs/:id/retry',
    { preHandler: [requireApiAuth, requireAdmin] },
    async (req) => {
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');

      return withServiceContext(
        async (tx) => {
          const job = await tx.one(
            `update ocs.jobs
                set status = 'queued', attempts = 0, run_at = now(),
                    last_error = null, locked_at = null, locked_by = null,
                    started_at = null, finished_at = null
              where id = $1 and status = 'dead'
              returning id, job_type as "jobType", status::text as status`,
            [id],
          );
          if (!job) {
            // Not a 404: the job may exist and simply not be dead, and saying
            // so is more useful than "not found".
            return { requeued: false, message: 'That job is not in a dead state' };
          }
          return { requeued: true, job };
        },
        { reason: 'retry_dead_job' },
      );
    },
  );
}

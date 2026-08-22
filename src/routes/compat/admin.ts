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
import { parse, clientIp } from '../../lib/http-helpers.js';
import { forbidden, badRequest, notFound } from '../../lib/errors.js';
import { env } from '../../config/env.js';
import { usingSeparateServiceRole } from '../../db/pool.js';
import { writeAudit } from '../../lib/audit.js';
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

  /**
   * Municipal credentials, on the path the application actually uses.
   *
   * These already existed under /v1/admin/*, and were unreachable. That route
   * family authenticates against SUPABASE tokens and requires an `aal2` claim
   * for multi-factor; the application signs in through /api/auth/login, which
   * issues its own token carrying no such claim. So an administrator using the
   * product could not open the screen at all -- not a permission they could be
   * granted, a different authentication system.
   *
   * MFA IS NOT ENFORCED HERE, AND THAT IS A REAL GAP. These credentials pull
   * permits under our licence in every jurisdiction we work; they deserve a
   * second factor and the /v1 route was right to demand one. Native
   * multi-factor does not exist yet, so this is gated on ADMIN alone. When it
   * lands, this endpoint must require it -- the /v1 version is the model.
   */
  app.get(
    '/api/admin/integrations/house-credentials',
    { preHandler: [requireApiAuth, requireAdmin] },
    async () =>
      withServiceContext(
        async (tx) => {
          const credentials = await tx.many(
            `select c.id, c.integration_key as "integrationKey",
                    c.municipality_id as "municipalityId", m.name as "municipalityName",
                    c.username, c.is_active as "isActive",
                    c.last_verified_at as "lastVerifiedAt", c.last_error as "lastError",
                    c.created_at as "createdAt"
               from ocs.integration_credentials c
               left join ocs.municipalities m on m.id = c.municipality_id
              where c.company_id is null
              order by c.integration_key, m.name nulls first`,
          );
          // Usernames and state only. The secret is never returned by any path.
          return { credentials, total: credentials.length, mfaEnforced: false };
        },
        { reason: 'list_house_credentials' },
      ),
  );

  app.put(
    '/api/admin/integrations/house-credentials',
    { preHandler: [requireApiAuth, requireAdmin] },
    async (req) => {
      const auth = req.apiAuth!;

      if (!env.INTEGRATION_ENCRYPTION_KEY) {
        throw badRequest(
          'Credential storage is not configured on this server: INTEGRATION_ENCRYPTION_KEY is unset. ' +
            'Without it there is nowhere safe to put a municipal password.',
        );
      }

      const body = parse(
        z.object({
          integrationKey: z.string().trim().min(1).max(80),
          /**
           * Null covers every agency on the platform, which is the normal case
           * for Accela: one account, many agencies.
           */
          municipalityId: z.string().uuid().nullable().optional(),
          username: z.string().trim().min(1).max(200),
          secret: z.string().min(1).max(2000),
        }),
        req.body,
        'house credentials',
      );

      const municipalityId = body.municipalityId ?? null;

      return withServiceContext(
        async (tx) => {
          if (municipalityId) {
            const muni = await tx.one<{ id: string }>(
              `select id from ocs.municipalities where id = $1`, [municipalityId],
            );
            if (!muni) throw notFound('Municipality');
          }

          /*
           * Two conflict targets, because a house credential's uniqueness is
           * enforced by two partial indexes rather than one constraint: NULL is
           * never equal to NULL, so the table's own unique constraint cannot
           * see these rows at all.
           */
          const row = municipalityId
            ? await tx.one<{ id: string }>(
                `insert into ocs.integration_credentials
                   (company_id, municipality_id, integration_key, username, secret_encrypted, created_by)
                 values (null, $1, $2, $3, pgp_sym_encrypt($4, $5), $6)
                 on conflict (integration_key, municipality_id) where company_id is null
                   do update set username = excluded.username,
                                 secret_encrypted = excluded.secret_encrypted,
                                 is_active = true, last_error = null
                 returning id`,
                [
                  municipalityId, body.integrationKey, body.username,
                  body.secret, env.INTEGRATION_ENCRYPTION_KEY, auth.userId,
                ],
              )
            : await tx.one<{ id: string }>(
                `insert into ocs.integration_credentials
                   (company_id, municipality_id, integration_key, username, secret_encrypted, created_by)
                 values (null, null, $1, $2, pgp_sym_encrypt($3, $4), $5)
                 on conflict (integration_key) where company_id is null and municipality_id is null
                   do update set username = excluded.username,
                                 secret_encrypted = excluded.secret_encrypted,
                                 is_active = true, last_error = null
                 returning id`,
                [
                  body.integrationKey, body.username,
                  body.secret, env.INTEGRATION_ENCRYPTION_KEY, auth.userId,
                ],
              );

          await writeAudit(tx, {
            actorUserId: auth.userId,
            actorEmail: auth.email,
            action: 'integration.house_credentials_stored',
            entityType: 'integration_credential',
            entityId: row!.id,
            summary: `House credentials stored for ${body.integrationKey}`,
            // The username, never the secret. An audit log holding the
            // credential is a second copy to protect.
            after: {
              integrationKey: body.integrationKey,
              municipalityId,
              username: body.username,
            },
            requestId: req.id,
            ipAddress: clientIp(req),
          });

          return {
            id: row!.id,
            integrationKey: body.integrationKey,
            municipalityId,
            isHouse: true,
          };
        },
        { reason: 'store_house_credentials' },
      );
    },
  );

  /** Point a jurisdiction at its platform, so an adapter can be chosen. */
  app.patch(
    '/api/admin/jurisdictions/:id/integration',
    { preHandler: [requireApiAuth, requireAdmin] },
    async (req) => {
      const auth = req.apiAuth!;
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
      const body = parse(
        z.object({
          platform: z.string().trim().max(40).optional(),
          agencyCode: z.string().trim().max(80).nullable().optional(),
          apiEnvironment: z.string().trim().max(40).nullable().optional(),
          apiBaseUrl: z.string().url().max(500).nullable().optional(),
          clientId: z.string().trim().max(200).optional(),
          clientSecret: z.string().trim().max(400).optional(),
        }).strict(),
        req.body,
        'integration config',
      );

      return withServiceContext(
        async (tx) => {
          const before = await tx.one<{ id: string; api_config: Record<string, unknown> }>(
            `select id, api_config from ocs.municipalities where id = $1`, [id],
          );
          if (!before) throw notFound('Jurisdiction');

          // Merged, not replaced, so setting an agency code does not wipe a
          // status-check mapping somebody else configured.
          const apiConfig = { ...(before.api_config ?? {}) };
          if (body.clientId !== undefined) apiConfig['clientId'] = body.clientId;
          if (body.clientSecret !== undefined) apiConfig['clientSecret'] = body.clientSecret;

          await tx.query(
            `update ocs.municipalities
                set platform = coalesce($2::ocs.permit_platform, platform),
                    agency_code = case when $3::boolean then $4 else agency_code end,
                    api_environment = case when $5::boolean then $6 else api_environment end,
                    api_base_url = case when $7::boolean then $8 else api_base_url end,
                    api_config = $9::jsonb
              where id = $1`,
            [
              id, body.platform ?? null,
              body.agencyCode !== undefined, body.agencyCode ?? null,
              body.apiEnvironment !== undefined, body.apiEnvironment ?? null,
              body.apiBaseUrl !== undefined, body.apiBaseUrl ?? null,
              JSON.stringify(apiConfig),
            ],
          );

          await writeAudit(tx, {
            actorUserId: auth.userId,
            actorEmail: auth.email,
            action: 'jurisdiction.integration_configured',
            entityType: 'municipality',
            entityId: id,
            summary: `Integration configured: ${body.platform ?? 'unchanged'}`,
            // Records THAT an app secret was set, never its value.
            after: {
              platform: body.platform ?? null,
              agencyCode: body.agencyCode ?? null,
              apiEnvironment: body.apiEnvironment ?? null,
              clientSecretSet: body.clientSecret !== undefined,
            },
            requestId: req.id,
            ipAddress: clientIp(req),
          });

          return tx.one(
            `select id, name, county, platform::text as platform,
                    agency_code as "agencyCode", api_environment as "apiEnvironment",
                    api_base_url as "apiBaseUrl",
                    adapter_verified_at as "adapterVerifiedAt",
                    status_check_enabled as "statusCheckEnabled"
               from ocs.municipalities where id = $1`,
            [id],
          );
        },
        { reason: 'configure_jurisdiction' },
      );
    },
  );
}

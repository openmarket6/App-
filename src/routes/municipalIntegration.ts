/**
 * Onboarding a jurisdiction's permitting system.
 *
 * The intended sequence, and why it is a sequence rather than one toggle:
 *
 *   1. PATCH  /v1/admin/municipalities/:id            record platform + config
 *   2. POST   .../credentials                         store the login, encrypted
 *   3. POST   .../test-connection                     dry run against a real permit
 *   4. POST   .../verify                              record that a human saw it work
 *   5. status_check_enabled = true                    only now does automation run
 *
 * Step 3 is the point. Onboarding a jurisdiction means calling its real system
 * with a real permit number and looking at what comes back — not reading
 * documentation and hoping. Step 4 records who confirmed it and when, and the
 * database refuses to enable checking without it (see the CHECK constraint in
 * 0011).
 *
 * The cost of skipping this is not a blank screen. It is telling a contractor
 * their permit was issued when it was not, and a crew arriving at a job site
 * they are not permitted to work.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, principalOf, tenantOf } from '../auth/plugin.js';
import { withTenant, withServiceContext } from '../db/tenant.js';
import { requirePlatformRole, requireCompanyRole, requireMfa } from '../auth/rbac.js';
import { parse } from '../lib/http-helpers.js';
import { writeAudit } from '../lib/audit.js';
import { notFound, unprocessable, serviceUnavailable, badRequest } from '../lib/errors.js';
import { resolveForMunicipality } from '../services/municipalities/vendors/index.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

const platform = z.enum([
  'accela', 'tyler_energov', 'opengov', 'centralsquare', 'cityview',
  'mygovernmentonline', 'clariti', 'iworq', 'govbuilt', 'cloudpermit',
  'citizenserve', 'camino', 'custom', 'none',
]);

const statusCheckConfig = z.object({
  method: z.enum(['GET', 'POST']).default('GET'),
  urlTemplate: z.string().url().max(500),
  auth: z
    .object({
      type: z.enum(['none', 'bearer', 'apiKey', 'basic']),
      headerName: z.string().max(80).optional(),
      extraHeaders: z.record(z.string().max(200)).optional(),
    })
    .optional(),
  bodyTemplate: z.string().max(2000).optional(),
  statusPath: z.string().min(1).max(200),
  statusMap: z.record(z.string().max(60)).optional(),
  timeoutMs: z.number().int().min(1000).max(60_000).optional(),
});

export async function municipalIntegrationRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Coverage across Florida: which jurisdictions are automated, which still
   * need a person, and what platform each one runs.
   */
  app.get('/v1/admin/integrations/coverage', { preHandler: authenticate }, async (req) => {
    requirePlatformRole(principalOf(req), 'staff');

    return withServiceContext(
      async (tx) => {
        const byPlatform = await tx.many(
          `select m.platform::text,
                  pc.display_name,
                  pc.integration_confidence,
                  pc.has_public_api,
                  count(*)::int as jurisdictions,
                  count(*) filter (where m.adapter_verified_at is not null)::int as verified,
                  count(*) filter (where m.status_check_enabled)::int as automated
             from ocs.municipalities m
             left join ocs.platform_capabilities pc on pc.platform = m.platform
            where m.is_active
            group by m.platform, pc.display_name, pc.integration_confidence, pc.has_public_api
            order by count(*) desc`,
        );

        const totals = await tx.one<{ total: string; verified: string; automated: string }>(
          `select count(*)::text as total,
                  count(*) filter (where adapter_verified_at is not null)::text as verified,
                  count(*) filter (where status_check_enabled)::text as automated
             from ocs.municipalities where is_active`,
        );

        return {
          totals: {
            jurisdictions: Number(totals?.total ?? 0),
            verified: Number(totals?.verified ?? 0),
            automated: Number(totals?.automated ?? 0),
          },
          byPlatform,
          note:
            'A jurisdiction only becomes automated after someone has tested it against ' +
            'the real system and recorded that verification. Unverified jurisdictions ' +
            'fall back to a portal link for a human to check.',
        };
      },
      { reason: 'integration_coverage' },
    );
  });

  /** Configure a jurisdiction's platform and status-check mapping. */
  app.patch('/v1/admin/municipalities/:id/integration', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    requirePlatformRole(p, 'admin');

    const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
    const body = parse(
      z.object({
        platform: platform.optional(),
        apiBaseUrl: z.string().url().max(500).optional(),
        apiEnvironment: z.string().max(40).optional(),
        agencyCode: z.string().max(80).optional(),
        portalUrl: z.string().url().max(500).optional(),
        lookupUrlTemplate: z.string().url().max(500).optional(),
        statusCheck: statusCheckConfig.optional(),
        additionalRequiredDocuments: z.array(z.string().max(60)).max(30).optional(),
        supportsStatusCheck: z.boolean().optional(),
        supportsSubmission: z.boolean().optional(),
        supportsDocumentUpload: z.boolean().optional(),
        statusCheckIntervalSeconds: z.number().int().min(300).max(604800).optional(),
        notes: z.string().max(2000).optional(),
      }),
      req.body,
      'integration config',
    );

    return withServiceContext(
      async (tx) => {
        const before = await tx.one<{ id: string; api_config: Record<string, unknown> }>(
          `select id, api_config from ocs.municipalities where id = $1`,
          [id],
        );
        if (!before) throw notFound('Municipality');

        // Merge rather than replace, so setting a lookup URL does not wipe a
        // status-check mapping someone else configured.
        const mergedConfig: Record<string, unknown> = { ...(before.api_config ?? {}) };
        if (body.statusCheck) mergedConfig['statusCheck'] = body.statusCheck;
        if (body.lookupUrlTemplate) mergedConfig['lookupUrlTemplate'] = body.lookupUrlTemplate;
        if (body.additionalRequiredDocuments) {
          mergedConfig['additionalRequiredDocuments'] = body.additionalRequiredDocuments;
        }

        const updated = await tx.one(
          `update ocs.municipalities
              set platform = coalesce($2::ocs.permit_platform, platform),
                  api_base_url = coalesce($3, api_base_url),
                  api_environment = coalesce($4, api_environment),
                  agency_code = coalesce($5, agency_code),
                  portal_url = coalesce($6, portal_url),
                  api_config = $7,
                  supports_status_check = coalesce($8, supports_status_check),
                  supports_submission = coalesce($9, supports_submission),
                  supports_document_upload = coalesce($10, supports_document_upload),
                  status_check_interval_seconds = coalesce($11, status_check_interval_seconds),
                  adapter_notes = coalesce($12, adapter_notes),
                  -- Changing the configuration invalidates any prior
                  -- verification: what was confirmed is no longer what will run.
                  adapter_verified_at = case when $13 then null else adapter_verified_at end,
                  status_check_enabled = case when $13 then false else status_check_enabled end
            where id = $1
            returning id, name, platform::text, api_base_url, api_environment, agency_code,
                      portal_url, api_config, supports_status_check, supports_submission,
                      supports_document_upload, status_check_enabled, adapter_verified_at,
                      status_check_interval_seconds, adapter_notes`,
          [
            id, body.platform ?? null, body.apiBaseUrl ?? null, body.apiEnvironment ?? null,
            body.agencyCode ?? null, body.portalUrl ?? null, JSON.stringify(mergedConfig),
            body.supportsStatusCheck ?? null, body.supportsSubmission ?? null,
            body.supportsDocumentUpload ?? null, body.statusCheckIntervalSeconds ?? null,
            body.notes ?? null,
            Boolean(body.statusCheck || body.platform || body.apiBaseUrl),
          ],
        );

        await writeAudit(tx, {
          actorUserId: p.userId,
          actorEmail: p.email,
          action: 'admin.municipality_integration_configured',
          entityType: 'municipality',
          entityId: id,
          summary: `Integration configured${body.platform ? ` for ${body.platform}` : ''}`,
          after: updated,
          requestId: req.id,
        });

        return updated;
      },
      { reason: 'configure_municipality_integration' },
    );
  });

  /**
   * Store a contractor's portal credentials for a jurisdiction, encrypted.
   *
   * Company-scoped: these are the contractor's own portal logins, not ours, so
   * they live under their tenant and are never returned by any endpoint. The
   * response confirms storage and nothing else.
   */
  app.put('/v1/municipalities/:id/credentials', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'admin');
    requireMfa(p);

    if (!env.INTEGRATION_ENCRYPTION_KEY) {
      throw serviceUnavailable('Credential storage is not configured on this server');
    }

    const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
    const body = parse(
      z.object({
        integrationKey: z.string().trim().min(1).max(80),
        username: z.string().trim().max(200).optional(),
        secret: z.string().min(1).max(2000),
      }),
      req.body,
      'credentials',
    );

    return withTenant(ctx, async (tx) => {
      const row = await tx.one<{ id: string }>(
        `insert into ocs.integration_credentials
           (company_id, municipality_id, integration_key, username, secret_encrypted, created_by)
         values ($1, $2, $3, $4, pgp_sym_encrypt($5, $6), $7)
         on conflict (company_id, integration_key, municipality_id) do update
           set username = excluded.username,
               secret_encrypted = excluded.secret_encrypted,
               is_active = true,
               last_error = null
         returning id`,
        [
          ctx.companyId, id, body.integrationKey, body.username ?? null,
          body.secret, env.INTEGRATION_ENCRYPTION_KEY, p.userId,
        ],
      );

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'integration.credentials_stored',
        entityType: 'municipality',
        entityId: id,
        // The credential itself is never written to the audit trail.
        summary: `Portal credentials stored for integration "${body.integrationKey}"`,
        requestId: req.id,
      });

      return { id: row?.id, stored: true };
    });
  });

  /**
   * Dry run against the real jurisdiction system.
   *
   * Calls the configured endpoint with a permit number the operator supplies and
   * returns exactly what came back, including the raw excerpt. Nothing is
   * written to any permit — this is for looking, so that verification is based
   * on observed behaviour.
   */
  app.post('/v1/admin/municipalities/:id/test-connection', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    requirePlatformRole(p, 'admin');

    const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
    const body = parse(
      z.object({
        permitNumber: z.string().trim().min(1).max(120),
        companyId: z.string().uuid().optional(),
      }),
      req.body,
      'test',
    );

    const municipality = await withServiceContext(
      async (tx) =>
        tx.one<{
          id: string; name: string; platform: string; portal_url: string | null;
          api_base_url: string | null; api_config: Record<string, unknown>;
          adapter_verified_at: string | null; supports_status_check: boolean;
        }>(
          `select id, name, platform::text, portal_url, api_base_url, api_config,
                  adapter_verified_at, supports_status_check
             from ocs.municipalities where id = $1`,
          [id],
        ),
      { reason: 'load_municipality_for_test' },
    );
    if (!municipality) throw notFound('Municipality');

    // Credentials belong to a contractor, so a test needs to say whose to use.
    let credentials: { username: string | null; secret: string | null } | null = null;
    if (body.companyId && env.INTEGRATION_ENCRYPTION_KEY) {
      credentials = await withServiceContext(
        async (tx) =>
          tx.one<{ username: string | null; secret: string | null }>(
            `select username,
                    case when secret_encrypted is null then null
                         else pgp_sym_decrypt(secret_encrypted, $3) end as secret
               from ocs.integration_credentials
              where company_id = $1 and municipality_id = $2 and is_active
              limit 1`,
            [body.companyId, id, env.INTEGRATION_ENCRYPTION_KEY],
          ),
        { reason: 'load_credentials_for_test', companyId: body.companyId },
      );
    }

    // Force the configured adapter even though the jurisdiction is not yet
    // verified -- testing is precisely how it becomes verified.
    const adapter = resolveForMunicipality(
      { ...municipality, adapter_verified_at: municipality.adapter_verified_at ?? 'test-run' },
      credentials,
    );

    const result = await adapter.checkPermitStatus({
      permitId: '00000000-0000-0000-0000-000000000000',
      companyId: body.companyId ?? '',
      permitNumber: body.permitNumber,
      externalReference: null,
      currentStatus: 'submitted',
      municipality: {
        id: municipality.id,
        name: municipality.name,
        portalUrl: municipality.portal_url,
        adapterKey: municipality.platform,
        integrationMethod: 'api',
      },
      credentials,
    });

    logger.info(
      { municipalityId: id, outcome: result.outcome, actor: p.userId },
      'municipal integration test run',
    );

    return {
      municipality: { id: municipality.id, name: municipality.name, platform: municipality.platform },
      adapter: { key: adapter.key, automated: adapter.automated },
      result,
      readyToVerify: result.outcome === 'success',
      guidance:
        result.outcome === 'success'
          ? 'The endpoint returned a status we could map. Record verification to enable automated checks.'
          : result.outcome === 'skipped'
            ? 'No API is configured for this jurisdiction; it will stay a manual portal lookup.'
            : 'Fix the configuration and test again. Do not verify a jurisdiction that has not returned a usable status.',
    };
  });

  /**
   * Record that a human confirmed this jurisdiction works, and optionally turn
   * automated checking on.
   */
  app.post('/v1/admin/municipalities/:id/verify', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    requirePlatformRole(p, 'admin');
    requireMfa(p);

    const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
    const body = parse(
      z.object({
        enableStatusChecks: z.boolean().default(false),
        notes: z.string().trim().max(2000).optional(),
        confirmedWorkingPermitNumber: z.string().trim().max(120).optional(),
      }),
      req.body,
      'verification',
    );

    return withServiceContext(
      async (tx) => {
        const municipality = await tx.one<{
          id: string; name: string; platform: string; api_config: Record<string, unknown>;
        }>(
          `select id, name, platform::text, api_config from ocs.municipalities where id = $1`,
          [id],
        );
        if (!municipality) throw notFound('Municipality');

        const hasConfig = Boolean(
          (municipality.api_config?.['statusCheck'] as { urlTemplate?: string } | undefined)?.urlTemplate,
        );

        if (body.enableStatusChecks && !hasConfig) {
          throw unprocessable(
            'This jurisdiction has no status-check configuration, so automated checks cannot be enabled. ' +
              'Configure it first, then test the connection.',
          );
        }

        if (body.enableStatusChecks && !body.confirmedWorkingPermitNumber) {
          // Requiring the permit number that was actually tested makes
          // verification a record of something observed, not a checkbox.
          throw badRequest(
            'Provide the permit number you successfully tested against before enabling automated checks',
          );
        }

        const updated = await tx.one(
          `update ocs.municipalities
              set adapter_verified_at = now(),
                  adapter_verified_by = $2,
                  status_check_enabled = $3,
                  supports_status_check = case when $3 then true else supports_status_check end,
                  adapter_notes = coalesce($4, adapter_notes)
            where id = $1
            returning id, name, platform::text, status_check_enabled,
                      adapter_verified_at, status_check_interval_seconds`,
          [
            id, p.userId, body.enableStatusChecks,
            body.notes
              ? `${body.notes}${body.confirmedWorkingPermitNumber ? ` (tested with ${body.confirmedWorkingPermitNumber})` : ''}`
              : null,
          ],
        );

        await writeAudit(tx, {
          actorUserId: p.userId,
          actorEmail: p.email,
          action: 'admin.municipality_verified',
          entityType: 'municipality',
          entityId: id,
          summary:
            `${municipality.name} verified` +
            (body.enableStatusChecks ? ' and automated status checks enabled' : ''),
          after: {
            enabled: body.enableStatusChecks,
            testedWith: body.confirmedWorkingPermitNumber ?? null,
          },
          requestId: req.id,
        });

        logger.info(
          { municipalityId: id, enabled: body.enableStatusChecks, actor: p.userId },
          'jurisdiction verified',
        );

        return updated;
      },
      { reason: 'verify_municipality' },
    );
  });

  /** Platform reference: what each vendor is and how reachable it is. */
  app.get('/v1/admin/integrations/platforms', { preHandler: authenticate }, async (req) => {
    requirePlatformRole(principalOf(req), 'staff');
    return withServiceContext(
      async (tx) => ({
        data: await tx.many(
          `select platform::text, display_name, vendor, has_public_api, auth_method,
                  integration_confidence, notes
             from ocs.platform_capabilities
            order by integration_confidence, display_name`,
        ),
      }),
      { reason: 'list_platforms' },
    );
  });
}

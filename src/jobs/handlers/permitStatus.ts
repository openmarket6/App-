/**
 * Permit status checking against municipal systems.
 *
 * Two jobs, deliberately:
 *
 *   permit.status_sweep -- runs hourly, finds permits that are due, and
 *                          enqueues one job per permit.
 *   permit.status_check -- checks exactly one permit.
 *
 * One job per permit rather than one job that loops over all of them, because a
 * single loop means one jurisdiction timing out stalls every other permit
 * behind it, and a crash halfway through loses the work already done. Separate
 * jobs fail, retry and back off independently.
 */
import { withServiceContext, withWorkerTenant } from '../../db/tenant.js';
import { enqueue, type JobRow } from '../queue.js';
import { registerHandler, PermanentJobError } from '../runner.js';
import { loadCredentials, type DetectedStatus } from '../../services/municipalities/adapter.js';
import { resolveForMunicipality } from '../../services/municipalities/vendors/index.js';
import { notify } from '../../services/notifications.js';
import { writeAudit } from '../../lib/audit.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';

const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';

/** Statuses we will not overwrite from an automated check. */
const TERMINAL = new Set(['closed', 'withdrawn', 'rejected', 'expired']);

interface DuePermit {
  id: string;
  company_id: string;
  municipality_id: string | null;
}

async function sweep(): Promise<{ enqueued: number }> {
  const due = await withServiceContext(
    async (tx) =>
      tx.many<DuePermit>(
        `select p.id, p.company_id, p.municipality_id
           from ocs.permits p
           join ocs.municipalities m on m.id = p.municipality_id
          where p.deleted_at is null
            and m.status_check_enabled
            and m.is_active
            and p.status not in ('draft','ready_to_submit','closed','withdrawn','rejected','expired')
            and (p.next_check_at is null or p.next_check_at <= now())
          order by p.next_check_at asc nulls first
          limit 500`,
      ),
    { reason: 'permit_status_sweep' },
  );

  let enqueued = 0;
  for (const permit of due) {
    await withServiceContext(
      async (tx) => {
        const id = await enqueue(tx, {
          jobType: 'permit.status_check',
          queue: 'integrations',
          companyId: permit.company_id,
          payload: { permitId: permit.id },
          maxAttempts: 3,
          timeoutSeconds: 120,
          // One outstanding check per permit, however often the sweep runs.
          dedupeKey: `permit_check:${permit.id}`,
        });
        if (id) enqueued++;

        // Move the permit's next check forward immediately, so a sweep that
        // runs again before this job completes does not re-select it.
        await tx.query(
          `update ocs.permits
              set next_check_at = now() + make_interval(
                    secs => (select status_check_interval_seconds
                               from ocs.municipalities where id = $2))
            where id = $1`,
          [permit.id, permit.municipality_id],
        );
      },
      { reason: 'permit_sweep_enqueue', companyId: permit.company_id },
    );
  }

  logger.info({ due: due.length, enqueued }, 'permit status sweep complete');
  return { enqueued };
}

interface PermitDetail {
  id: string;
  company_id: string;
  permit_number: string | null;
  external_reference: string | null;
  status: string;
  municipality_id: string | null;
  municipality_name: string | null;
  portal_url: string | null;
  adapter_key: string | null;
  integration_method: string;
  platform: string;
  api_base_url: string | null;
  api_config: Record<string, unknown>;
  adapter_verified_at: string | null;
  supports_status_check: boolean;
}

/** Map an adapter's detected status onto ocs.permit_status. */
function toPermitStatus(detected: DetectedStatus): string | null {
  if (detected === 'unknown') return null;
  return detected;
}

async function checkOne(job: JobRow): Promise<unknown> {
  const permitId = job.payload['permitId'];
  if (typeof permitId !== 'string') {
    throw new PermanentJobError('permit.status_check requires a string permitId');
  }

  const detail = await withServiceContext(
    async (tx) =>
      tx.one<PermitDetail>(
        `select p.id, p.company_id, p.permit_number, p.external_reference, p.status::text,
                p.municipality_id,
                m.name as municipality_name, m.portal_url, m.adapter_key,
                m.integration_method::text as integration_method,
                m.platform::text as platform, m.api_base_url, m.api_config,
                m.adapter_verified_at, m.supports_status_check
           from ocs.permits p
           left join ocs.municipalities m on m.id = p.municipality_id
          where p.id = $1 and p.deleted_at is null`,
        [permitId],
      ),
    { reason: 'permit_check_load' },
  );

  if (!detail) throw new PermanentJobError(`permit ${permitId} not found`);
  if (TERMINAL.has(detail.status)) {
    return { skipped: true, reason: `permit is ${detail.status}` };
  }

  // Credentials are loaded inside the tenant's own context and never leave it.
  // Keyed on the platform, so one stored login serves every jurisdiction a
  // contractor accesses through the same vendor portal.
  const credentials =
    detail.municipality_id && env.INTEGRATION_ENCRYPTION_KEY
      ? await withWorkerTenant(
          { companyId: detail.company_id, userId: SYSTEM_USER, platformRole: 'none' },
          (tx) =>
            loadCredentials(tx, {
              companyId: detail.company_id,
              municipalityId: detail.municipality_id!,
              integrationKey: detail.platform,
              encryptionKey: env.INTEGRATION_ENCRYPTION_KEY!,
            }),
        )
      : null;

  // Picks the configured HTTP adapter only when this jurisdiction has been
  // verified; otherwise falls back to "a person must check". See
  // services/municipalities/vendors/index.ts.
  const adapter = resolveForMunicipality(
    {
      id: detail.municipality_id ?? '',
      name: detail.municipality_name ?? 'Unknown jurisdiction',
      platform: detail.platform ?? 'none',
      portal_url: detail.portal_url,
      api_base_url: detail.api_base_url,
      api_config: detail.api_config ?? {},
      adapter_verified_at: detail.adapter_verified_at,
      supports_status_check: detail.supports_status_check ?? false,
    },
    credentials,
  );

  const result = await adapter.checkPermitStatus({
    permitId: detail.id,
    companyId: detail.company_id,
    permitNumber: detail.permit_number,
    externalReference: detail.external_reference,
    currentStatus: detail.status,
    municipality: {
      id: detail.municipality_id ?? '',
      name: detail.municipality_name ?? 'Unknown',
      portalUrl: detail.portal_url,
      adapterKey: detail.adapter_key,
      integrationMethod: detail.integration_method,
    },
    credentials,
  });

  const newStatus = toPermitStatus(result.detectedStatus);
  const changed = newStatus !== null && newStatus !== detail.status;

  await withWorkerTenant(
    { companyId: detail.company_id, userId: SYSTEM_USER, platformRole: 'none' },
    async (tx) => {
      // Always record the attempt -- including failures. "We tried and the
      // portal was down" is information the team needs; a missing row is
      // indistinguishable from never having tried.
      await tx.query(
        `insert into ocs.integration_runs
           (company_id, municipality_id, permit_id, job_id, integration_key, operation,
            method, outcome, http_status, duration_ms, attempt, detected_status,
            error_message, response_excerpt)
         values ($1,$2,$3,$4,$5,'check_status',$6::ocs.integration_method,$7,$8,$9,$10,$11,$12,$13)`,
        [
          detail.company_id,
          detail.municipality_id,
          detail.id,
          job.id,
          adapter.key,
          detail.integration_method,
          result.outcome,
          result.httpStatus ?? null,
          result.durationMs ?? null,
          job.attempts,
          result.detectedStatus === 'unknown' ? null : result.detectedStatus,
          result.message ?? null,
          result.responseExcerpt ?? null,
        ],
      );

      await tx.query(
        `update ocs.permits
            set last_checked_at = now(),
                last_check_error = $2
          where id = $1`,
        [detail.id, result.outcome === 'success' || result.outcome === 'no_change' ? null : (result.message ?? result.outcome)],
      );

      if (!changed) return;

      // set_config marks the status-history row's source as the automated
      // check rather than a person (see the trigger in 0002).
      await tx.query(`select set_config('ocs.change_source', 'municipal_check', true)`);
      await tx.query(`update ocs.permits set status = $2::ocs.permit_status where id = $1`, [
        detail.id,
        newStatus,
      ]);

      await writeAudit(tx, {
        companyId: detail.company_id,
        action: 'permit.status_changed_by_check',
        entityType: 'permit',
        entityId: detail.id,
        summary: `Status changed from ${detail.status} to ${newStatus} by automated check`,
        before: { status: detail.status },
        after: { status: newStatus },
      });

      // Tell everyone active in the company. Corrections are urgent -- they
      // start a clock the contractor is responsible for.
      const recipients = await tx.many<{ user_id: string; email: string }>(
        `select m.user_id, u.email
           from ocs.company_memberships m
           join ocs.app_users u on u.id = m.user_id
          where m.company_id = $1 and m.is_active and u.is_active and u.deleted_at is null`,
        [detail.company_id],
      );

      for (const r of recipients) {
        await notify(tx, {
          companyId: detail.company_id,
          userId: r.user_id,
          kind: newStatus === 'corrections_required' ? 'corrections_required' : 'permit_status_changed',
          title:
            newStatus === 'corrections_required'
              ? `Corrections required: permit ${detail.permit_number ?? ''}`.trim()
              : `Permit ${detail.permit_number ?? ''} is now ${newStatus}`.trim(),
          body: `${detail.municipality_name ?? 'The jurisdiction'} updated this permit to "${newStatus}".`,
          entityType: 'permit',
          entityId: detail.id,
          linkPath: `/permits/${detail.id}`,
          email: { to: r.email },
          dedupeKey: `permit_status:${detail.id}:${newStatus}:${r.user_id}`,
        });
      }
    },
  );

  return { outcome: result.outcome, detectedStatus: result.detectedStatus, changed };
}

export function register(): void {
  registerHandler('permit.status_sweep', sweep);
  registerHandler('permit.status_check', checkOne);
}

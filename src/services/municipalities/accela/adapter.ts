/**
 * The Accela adapter: one implementation, every Accela agency in Florida.
 *
 * Reads a permit's current state from the agency and reports it in this
 * system's vocabulary. Writing back (booking inspections, posting comments)
 * lives on the client and is driven by the sync service, not from here -- a
 * status check must never have side effects at the agency, or a routine poll
 * starts changing records.
 */
import type {
  MunicipalAdapter, PermitCheckInput, PermitCheckResult, DetectedStatus,
} from '../adapter.js';
import { AccelaClient, AccelaError, type AccelaConfig } from './client.js';
import { toDetectedStatus, toInspectionOutcome } from './mapping.js';
import { logger } from '../../../lib/logger.js';

export interface AccelaAdapterOptions {
  municipalityId: string;
  municipalityName: string;
  config: AccelaConfig;
}

export function createAccelaAdapter(opts: AccelaAdapterOptions): MunicipalAdapter {
  // One client per adapter, so the OAuth token is fetched once and reused
  // across every permit in a sync rather than once per permit.
  const client = new AccelaClient(opts.config);

  return {
    key: `accela:${opts.municipalityId}`,
    displayName: `${opts.municipalityName} (Accela)`,
    automated: true,

    async checkPermitStatus(input: PermitCheckInput): Promise<PermitCheckResult> {
      const startedAt = Date.now();

      // externalReference is Accela's own record id and is exact. The permit
      // number is what a person read off paperwork and needs a search.
      const reference = input.externalReference?.trim();
      const permitNumber = input.permitNumber?.trim();

      if (!reference && !permitNumber) {
        return {
          outcome: 'skipped',
          detectedStatus: 'unknown',
          message: 'No Accela record id or permit number to look this up by',
        };
      }

      try {
        const record = reference
          ? await client.getRecord(reference)
          : await client.findByPermitNumber(permitNumber!);

        if (!record) {
          return {
            outcome: 'not_found',
            detectedStatus: 'unknown',
            durationMs: Date.now() - startedAt,
            message: 'Accela has no record matching this permit',
          };
        }

        const rawStatus = record.status?.text ?? record.status?.value ?? null;
        const detectedStatus: DetectedStatus = toDetectedStatus(rawStatus);

        // A status we could not read is reported as such, with the agency's own
        // wording attached so a person can resolve it in one look rather than
        // opening the portal.
        const message =
          detectedStatus === 'unknown' && rawStatus
            ? `Accela reported a status we do not recognise: "${rawStatus}"`
            : undefined;

        if (detectedStatus === 'unknown' && rawStatus) {
          logger.warn(
            { municipalityId: opts.municipalityId, rawStatus },
            'unmapped Accela status; a person must interpret this one',
          );
        }

        /**
         * Inspections are fetched only once the permit has reached a stage where
         * they exist. Asking for them on an application still in plan review is
         * a wasted round trip against a rate-limited API, multiplied by every
         * permit in the account.
         */
        let inspections: Array<Record<string, unknown>> = [];
        if (detectedStatus === 'issued' || detectedStatus === 'inspections') {
          try {
            const found = await client.getInspections(record.id);
            inspections = found.map((i) => ({
              externalId: i.id ?? null,
              type: i.type?.text ?? i.type?.value ?? null,
              scheduledFor: i.scheduledDate ?? null,
              completedAt: i.completedDate ?? null,
              rawResult: i.result ?? i.status?.text ?? null,
              result: toInspectionOutcome(i.result ?? i.status?.text),
              inspector: i.inspectorName ?? null,
              note: i.comment ?? null,
            }));
          } catch (err) {
            // A failed inspection fetch must not discard a good status read.
            logger.warn(
              { municipalityId: opts.municipalityId, err: (err as Error).message },
              'could not fetch Accela inspections; status still recorded',
            );
          }
        }

        return {
          outcome: 'success',
          detectedStatus,
          httpStatus: 200,
          durationMs: Date.now() - startedAt,
          ...(message ? { message } : {}),
          extra: {
            accelaRecordId: record.id,
            rawStatus,
            statusDate: record.statusDate ?? null,
            recordType: record.type?.text ?? null,
            totalFeeCents: record.totalFee != null ? Math.round(record.totalFee * 100) : null,
            balanceCents: record.balance != null ? Math.round(record.balance * 100) : null,
            inspections,
          },
        };
      } catch (err) {
        const durationMs = Date.now() - startedAt;

        if (err instanceof AccelaError) {
          // Each failure kind gets its own outcome so the scheduler can respond
          // properly: back off on a rate limit, stop and alert on bad
          // credentials, retry later on a transport fault. Collapsing them into
          // "error" makes a wrong credential look like a flaky network and it
          // never gets fixed.
          const outcome =
            err.kind === 'auth' ? 'auth_failed'
            : err.kind === 'rate_limited' ? 'rate_limited'
            : err.kind === 'not_found' ? 'not_found'
            : err.kind === 'transport' ? 'timeout'
            : 'error';

          return {
            outcome,
            detectedStatus: 'unknown',
            durationMs,
            ...(err.httpStatus ? { httpStatus: err.httpStatus } : {}),
            message: err.message,
            ...(err.bodyExcerpt ? { responseExcerpt: err.bodyExcerpt } : {}),
          };
        }

        return {
          outcome: 'error',
          detectedStatus: 'unknown',
          durationMs,
          message: (err as Error).message,
        };
      }
    },
  };
}

/**
 * Build an adapter config from a jurisdiction row and its decrypted credential.
 *
 * Returns null when anything required is missing, which routes the jurisdiction
 * back to portal-only rather than to an adapter that will fail on every call.
 */
export function accelaConfigFrom(
  municipality: {
    api_base_url: string | null;
    agency_code: string | null;
    api_environment: string | null;
    api_config: Record<string, unknown>;
  },
  credentials: { username: string | null; secret: string | null } | null,
): AccelaConfig | null {
  const cfg = municipality.api_config ?? {};
  const clientId = cfg['clientId'] as string | undefined;
  const clientSecret = cfg['clientSecret'] as string | undefined;

  // clientSecret is expected to arrive already decrypted alongside the user
  // credential; a config holding a plaintext secret is a misconfiguration.
  if (!clientId || !clientSecret) return null;
  if (!municipality.agency_code) return null;
  if (!credentials?.username || !credentials.secret) return null;

  return {
    ...(municipality.api_base_url ? { baseUrl: municipality.api_base_url } : {}),
    clientId,
    clientSecret,
    agency: municipality.agency_code,
    environment: municipality.api_environment ?? 'PROD',
    username: credentials.username,
    password: credentials.secret,
    ...(cfg['scope'] ? { scope: cfg['scope'] as string } : {}),
    ...(cfg['authScheme'] === 'bearer' ? { authScheme: 'bearer' as const } : {}),
  };
}

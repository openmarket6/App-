/**
 * Municipal permit-status adapters.
 *
 * Florida has 67 counties and hundreds of municipalities, and their permitting
 * systems have essentially nothing in common: some publish a REST API, many
 * only have a web portal, some send status by email, and plenty require a phone
 * call. This interface lets each jurisdiction be handled by whatever mechanism
 * it actually supports, without the calling job knowing the difference.
 *
 * WHAT IS DELIBERATELY NOT HERE: adapters for specific jurisdictions. Writing
 * one requires the real endpoint, the real auth method and the real response
 * shape, verified against that jurisdiction. Guessing produces an adapter that
 * confidently reports wrong permit statuses -- materially worse than reporting
 * none, because a contractor would act on it. New jurisdictions get an adapter
 * once someone has confirmed how that portal really behaves.
 *
 * Until then every jurisdiction uses `manualAdapter`, which records that a human
 * still needs to check.
 */
import type { Tx } from '../../db/tenant.js';
import { requestWithRetry, excerpt } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';

/** Statuses an adapter may report, mapped onto ocs.permit_status by the caller. */
export type DetectedStatus =
  | 'submitted'
  | 'under_review'
  | 'corrections_required'
  | 'approved'
  | 'issued'
  | 'inspections'
  | 'closed'
  | 'rejected'
  | 'expired'
  | 'unknown';

export type CheckOutcome =
  | 'success'
  | 'no_change'
  | 'not_found'
  | 'auth_failed'
  | 'rate_limited'
  | 'timeout'
  | 'error'
  | 'skipped';

export interface PermitCheckInput {
  permitId: string;
  companyId: string;
  permitNumber: string | null;
  externalReference: string | null;
  currentStatus: string;
  municipality: {
    id: string;
    name: string;
    portalUrl: string | null;
    adapterKey: string | null;
    integrationMethod: string;
  };
  /** Decrypted per-company portal credentials, when the jurisdiction needs them. */
  credentials: { username: string | null; secret: string | null } | null;
}

export interface PermitCheckResult {
  outcome: CheckOutcome;
  detectedStatus: DetectedStatus;
  httpStatus?: number;
  durationMs?: number;
  message?: string;
  responseExcerpt?: string;
  /** Free-form fields worth storing on the permit (fees due, inspection dates). */
  extra?: Record<string, unknown>;
}

export interface MunicipalAdapter {
  key: string;
  displayName: string;
  /** False for adapters that cannot run unattended. */
  automated: boolean;
  checkPermitStatus(input: PermitCheckInput): Promise<PermitCheckResult>;
}

/**
 * The honest default: this jurisdiction has no verified automation, so record
 * that a person must check it rather than inventing a result.
 */
export const manualAdapter: MunicipalAdapter = {
  key: 'manual',
  displayName: 'Manual check required',
  automated: false,
  async checkPermitStatus(input) {
    return {
      outcome: 'skipped',
      detectedStatus: 'unknown',
      message:
        `${input.municipality.name} has no verified automated status source. ` +
        'A team member must check the portal and update this permit.',
    };
  },
};

/**
 * Template for a jurisdiction that exposes a JSON API.
 *
 * Left unregistered on purpose. To bring a real jurisdiction online:
 *   1. Confirm its endpoint, auth scheme and response shape against the real
 *      system (a sandbox if one exists).
 *   2. Copy this, implement `parseStatus` for that response shape.
 *   3. Register it below, set the municipality's adapter_key and
 *      integration_method='api', and only then flip status_check_enabled=true.
 */
export function createRestAdapter(config: {
  key: string;
  displayName: string;
  buildUrl: (input: PermitCheckInput) => string;
  buildHeaders?: (input: PermitCheckInput) => Record<string, string>;
  parseStatus: (body: unknown) => DetectedStatus;
  timeoutMs?: number;
}): MunicipalAdapter {
  return {
    key: config.key,
    displayName: config.displayName,
    automated: true,
    async checkPermitStatus(input) {
      const started = Date.now();

      if (!input.permitNumber && !input.externalReference) {
        return {
          outcome: 'skipped',
          detectedStatus: 'unknown',
          message: 'Permit has no municipal reference number yet',
        };
      }

      try {
        const res = await requestWithRetry(
          config.buildUrl(input),
          { method: 'GET', headers: config.buildHeaders?.(input) ?? {} },
          { attempts: 3, timeoutMs: config.timeoutMs ?? 20_000, label: `municipal.${config.key}` },
        );

        const durationMs = Date.now() - started;

        if (res.status === 404) {
          return {
            outcome: 'not_found',
            detectedStatus: 'unknown',
            httpStatus: 404,
            durationMs,
            message: 'Permit not found in the jurisdiction system',
          };
        }
        if (res.status === 401 || res.status === 403) {
          return {
            outcome: 'auth_failed',
            detectedStatus: 'unknown',
            httpStatus: res.status,
            durationMs,
            message: 'Portal credentials were rejected',
          };
        }
        if (res.status === 429) {
          return {
            outcome: 'rate_limited',
            detectedStatus: 'unknown',
            httpStatus: 429,
            durationMs,
            message: 'Jurisdiction rate limit reached',
          };
        }
        if (!res.ok) {
          return {
            outcome: 'error',
            detectedStatus: 'unknown',
            httpStatus: res.status,
            durationMs,
            responseExcerpt: excerpt(res.body),
            message: `Unexpected response ${res.status}`,
          };
        }

        const detected = config.parseStatus(JSON.parse(res.body));
        return {
          outcome: detected === 'unknown' ? 'error' : 'success',
          detectedStatus: detected,
          httpStatus: res.status,
          durationMs,
          responseExcerpt: excerpt(res.body, 300),
        };
      } catch (err) {
        const error = err as Error;
        const timedOut = error.name === 'TimeoutError';
        logger.warn({ err: error.message, adapter: config.key }, 'municipal status check failed');
        return {
          outcome: timedOut ? 'timeout' : 'error',
          detectedStatus: 'unknown',
          durationMs: Date.now() - started,
          message: error.message,
        };
      }
    },
  };
}

/**
 * Adapter registry.
 *
 * Every jurisdiction currently resolves to manualAdapter. Register verified
 * adapters here as they are built.
 */
const registry = new Map<string, MunicipalAdapter>([['manual', manualAdapter]]);

export function registerAdapter(adapter: MunicipalAdapter): void {
  registry.set(adapter.key, adapter);
}

export function resolveAdapter(adapterKey: string | null): MunicipalAdapter {
  if (!adapterKey) return manualAdapter;
  return registry.get(adapterKey) ?? manualAdapter;
}

export function listAdapters(): Array<{ key: string; displayName: string; automated: boolean }> {
  return [...registry.values()].map((a) => ({
    key: a.key,
    displayName: a.displayName,
    automated: a.automated,
  }));
}

/**
 * Decrypt a stored portal credential.
 *
 * Kept in one place so the decryption key is used in exactly one code path and
 * the plaintext never travels further than the adapter that needs it. Nothing
 * here is ever returned through the API.
 */
export async function loadCredentials(
  tx: Tx,
  params: { companyId: string; municipalityId: string; integrationKey: string; encryptionKey: string },
): Promise<{ username: string | null; secret: string | null } | null> {
  const row = await tx.one<{ username: string | null; secret: string | null }>(
    `select username,
            case when secret_encrypted is null then null
                 else pgp_sym_decrypt(secret_encrypted, $4)
            end as secret
       from ocs.integration_credentials
      where company_id = $1
        and municipality_id = $2
        and integration_key = $3
        and is_active`,
    [params.companyId, params.municipalityId, params.integrationKey, params.encryptionKey],
  );
  return row;
}

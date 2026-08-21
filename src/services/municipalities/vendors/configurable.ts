/**
 * Configuration-driven municipal adapter.
 *
 * WHY THIS EXISTS INSTEAD OF ONE HAND-WRITTEN ADAPTER PER VENDOR
 *
 * Florida jurisdictions run maybe a dozen different permitting platforms, and
 * each platform's API differs per agency: different base URLs, different auth,
 * different field names for "status". Hand-writing an adapter for each one
 * means a code change and a deploy every time a jurisdiction is onboarded, and
 * it means guessing at response shapes we have not seen.
 *
 * This adapter instead reads a mapping from the jurisdiction's `api_config`:
 * where to call, how to authenticate, which field in the response holds the
 * status, and how that vendor's status words map onto ours. Onboarding a new
 * jurisdiction becomes a configuration task performed by someone looking at a
 * real response, not a guess baked into code.
 *
 * Nothing here invents an endpoint. If a jurisdiction has no configuration, the
 * adapter reports that a human must check -- which is the truth.
 *
 * Example api_config:
 * {
 *   "statusCheck": {
 *     "method": "GET",
 *     "urlTemplate": "https://permits.example.gov/api/v1/permits/{permitNumber}",
 *     "auth": { "type": "apiKey", "headerName": "X-API-Key" },
 *     "statusPath": "data.currentStatus",
 *     "statusMap": {
 *       "Issued": "issued",
 *       "In Review": "under_review",
 *       "Corrections Required": "corrections_required"
 *     }
 *   }
 * }
 */
import { requestWithRetry, excerpt } from '../../../lib/http.js';
import { logger } from '../../../lib/logger.js';
import type {
  MunicipalAdapter, PermitCheckInput, PermitCheckResult, DetectedStatus,
} from '../adapter.js';

export interface StatusCheckConfig {
  method?: 'GET' | 'POST';
  urlTemplate: string;
  auth?: {
    type: 'none' | 'bearer' | 'apiKey' | 'basic';
    headerName?: string;
    /** Extra static headers, e.g. Accela's x-accela-appid. Never secrets. */
    extraHeaders?: Record<string, string>;
  };
  bodyTemplate?: string;
  statusPath: string;
  statusMap?: Record<string, string>;
  timeoutMs?: number;
}

const VALID_STATUSES = new Set<DetectedStatus>([
  'submitted', 'under_review', 'corrections_required', 'approved', 'issued',
  'inspections', 'closed', 'rejected', 'expired', 'unknown',
]);

/** Read a dot-separated path out of a parsed JSON body. */
export function readPath(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value)) {
      const index = Number(key);
      return Number.isInteger(index) ? value[index] : undefined;
    }
    if (typeof value === 'object') return (value as Record<string, unknown>)[key];
    return undefined;
  }, source);
}

/**
 * Fill {placeholders} in a URL template.
 *
 * Values are URL-encoded. A permit number is jurisdiction-supplied data, and
 * interpolating it raw would let a stray `/` or `?` rewrite the request path.
 */
export function renderTemplate(template: string, values: Record<string, string | null>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = values[key];
    return value === null || value === undefined ? '' : encodeURIComponent(value);
  });
}

/**
 * Translate a vendor's status wording into ours.
 *
 * Unmapped values return 'unknown' rather than a guess. Treating an
 * unrecognised string as "approved" because it contains the word would be how a
 * contractor gets told to start work on an unapproved permit.
 */
export function mapStatus(raw: unknown, statusMap: Record<string, string> | undefined): DetectedStatus {
  if (typeof raw !== 'string') return 'unknown';
  const trimmed = raw.trim();

  const mapped = statusMap?.[trimmed] ?? statusMap?.[trimmed.toLowerCase()];
  if (mapped && VALID_STATUSES.has(mapped as DetectedStatus)) {
    return mapped as DetectedStatus;
  }

  // Accept an exact match on our own vocabulary, so a jurisdiction already
  // speaking our terms needs no map at all.
  const normalised = trimmed.toLowerCase().replace(/[\s-]+/g, '_');
  if (VALID_STATUSES.has(normalised as DetectedStatus)) return normalised as DetectedStatus;

  return 'unknown';
}

export function createConfigurableAdapter(params: {
  key: string;
  displayName: string;
  config: StatusCheckConfig;
  secret: string | null;
  username: string | null;
}): MunicipalAdapter {
  return {
    key: params.key,
    displayName: params.displayName,
    automated: true,

    async checkPermitStatus(input: PermitCheckInput): Promise<PermitCheckResult> {
      const started = Date.now();
      const cfg = params.config;

      const reference = input.externalReference ?? input.permitNumber;
      if (!reference) {
        return {
          outcome: 'skipped',
          detectedStatus: 'unknown',
          message: 'Permit has no jurisdiction reference number yet',
        };
      }

      const url = renderTemplate(cfg.urlTemplate, {
        permitNumber: input.permitNumber,
        externalReference: input.externalReference,
        reference,
      });

      const headers: Record<string, string> = {
        accept: 'application/json',
        ...(cfg.auth?.extraHeaders ?? {}),
      };

      switch (cfg.auth?.type) {
        case 'bearer':
          if (params.secret) headers['authorization'] = `Bearer ${params.secret}`;
          break;
        case 'apiKey':
          if (params.secret) headers[cfg.auth.headerName ?? 'x-api-key'] = params.secret;
          break;
        case 'basic':
          if (params.username && params.secret) {
            headers['authorization'] =
              `Basic ${Buffer.from(`${params.username}:${params.secret}`).toString('base64')}`;
          }
          break;
        default:
          break;
      }

      if (cfg.auth && cfg.auth.type !== 'none' && !params.secret) {
        return {
          outcome: 'auth_failed',
          detectedStatus: 'unknown',
          message: 'No credentials are stored for this jurisdiction',
        };
      }

      try {
        const res = await requestWithRetry(
          url,
          {
            method: cfg.method ?? 'GET',
            headers,
            ...(cfg.bodyTemplate
              ? { body: renderTemplate(cfg.bodyTemplate, { permitNumber: input.permitNumber, reference }) }
              : {}),
          },
          {
            attempts: 3,
            timeoutMs: cfg.timeoutMs ?? 20_000,
            label: `municipal.${params.key}`,
            // A status lookup is a read even when the vendor models it as POST.
            retryUnsafeMethod: (cfg.method ?? 'GET') === 'POST',
          },
        );

        const durationMs = Date.now() - started;

        if (res.status === 404) {
          return {
            outcome: 'not_found', detectedStatus: 'unknown', httpStatus: 404, durationMs,
            message: 'The jurisdiction has no record with that number',
          };
        }
        if (res.status === 401 || res.status === 403) {
          return {
            outcome: 'auth_failed', detectedStatus: 'unknown', httpStatus: res.status, durationMs,
            message: 'The jurisdiction rejected our credentials',
          };
        }
        if (res.status === 429) {
          return {
            outcome: 'rate_limited', detectedStatus: 'unknown', httpStatus: 429, durationMs,
            message: 'Rate limited by the jurisdiction',
          };
        }
        if (!res.ok) {
          return {
            outcome: 'error', detectedStatus: 'unknown', httpStatus: res.status, durationMs,
            responseExcerpt: excerpt(res.body), message: `Unexpected response ${res.status}`,
          };
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(res.body);
        } catch {
          return {
            outcome: 'error', detectedStatus: 'unknown', httpStatus: res.status, durationMs,
            responseExcerpt: excerpt(res.body, 200),
            message: 'Response was not JSON — the endpoint may be an HTML portal rather than an API',
          };
        }

        const raw = readPath(parsed, cfg.statusPath);
        const detected = mapStatus(raw, cfg.statusMap);

        if (detected === 'unknown') {
          // Surfaced as an error so it reaches the integration failure list and
          // someone extends the status map, instead of being silently dropped.
          return {
            outcome: 'error',
            detectedStatus: 'unknown',
            httpStatus: res.status,
            durationMs,
            message:
              typeof raw === 'string'
                ? `Unrecognised status "${raw}" — add it to this jurisdiction's statusMap`
                : `No status found at path "${cfg.statusPath}"`,
            responseExcerpt: excerpt(res.body, 300),
          };
        }

        return {
          outcome: 'success',
          detectedStatus: detected,
          httpStatus: res.status,
          durationMs,
          responseExcerpt: excerpt(res.body, 200),
        };
      } catch (err) {
        const error = err as Error;
        logger.warn({ err: error.message, adapter: params.key }, 'configured municipal check failed');
        return {
          outcome: error.name === 'TimeoutError' ? 'timeout' : 'error',
          detectedStatus: 'unknown',
          durationMs: Date.now() - started,
          message: error.message,
        };
      }
    },
  };
}

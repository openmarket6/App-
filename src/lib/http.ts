/**
 * Outbound HTTP with timeouts, bounded retries and backoff.
 *
 * Every call to a municipality, payment provider or vendor goes through here.
 * The defaults encode three lessons about third-party calls:
 *
 *   - A request with no timeout is a request that can hang forever, and one
 *     hung call holds a worker slot indefinitely. There is ALWAYS a deadline.
 *   - Retrying a non-idempotent POST can duplicate the side effect. Only safe
 *     methods retry by default; a caller that knows its POST is idempotent must
 *     say so explicitly.
 *   - Retrying immediately during an outage adds load to something already
 *     struggling. Backoff is exponential with jitter so a fleet of workers does
 *     not resynchronise into a thundering herd.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { logger } from './logger.js';

export interface RetryOptions {
  /** Total attempts including the first. */
  attempts?: number;
  /** Per-attempt deadline in milliseconds. */
  timeoutMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Allow retrying a non-safe method. Only set when the endpoint is idempotent. */
  retryUnsafeMethod?: boolean;
  /** Label used in logs and integration_runs. */
  label?: string;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly bodyExcerpt: string,
    readonly url: string,
  ) {
    super(`HTTP ${status} ${statusText}`);
    this.name = 'HttpError';
  }
}

export class TimeoutError extends Error {
  constructor(readonly timeoutMs: number, readonly url: string) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

/** Full jitter: random within the backoff window, not a fixed step. */
function backoffFor(attempt: number, base: number, max: number): number {
  const window = Math.min(max, base * 2 ** (attempt - 1));
  return Math.floor(Math.random() * window);
}

/** Honour Retry-After when the server tells us how long to wait. */
function retryAfterMs(res: Response): number | null {
  const header = res.headers.get('retry-after');
  if (!header) return null;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

export interface HttpResult {
  status: number;
  ok: boolean;
  headers: Headers;
  body: string;
  attempts: number;
  durationMs: number;
}

export async function requestWithRetry(
  url: string,
  init: RequestInit = {},
  opts: RetryOptions = {},
): Promise<HttpResult> {
  const attempts = opts.attempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 15_000;
  const method = (init.method ?? 'GET').toUpperCase();
  const mayRetry = SAFE_METHODS.has(method) || opts.retryUnsafeMethod === true;
  const label = opts.label ?? url;

  const startedAll = Date.now();
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      // Read the body before deciding: a retry needs the connection released.
      const body = await res.text();

      if (res.ok) {
        return {
          status: res.status,
          ok: true,
          headers: res.headers,
          body,
          attempts: attempt,
          durationMs: Date.now() - startedAll,
        };
      }

      const shouldRetry = mayRetry && RETRYABLE_STATUS.has(res.status) && attempt < attempts;

      if (!shouldRetry) {
        return {
          status: res.status,
          ok: false,
          headers: res.headers,
          body,
          attempts: attempt,
          durationMs: Date.now() - startedAll,
        };
      }

      const wait = retryAfterMs(res) ?? backoffFor(attempt, baseDelayMs, maxDelayMs);
      logger.warn(
        { label, status: res.status, attempt, waitMs: wait },
        'retryable HTTP response; backing off',
      );
      await delay(wait);
      continue;
    } catch (err) {
      const isAbort = (err as Error).name === 'AbortError';
      lastError = isAbort ? new TimeoutError(timeoutMs, url) : (err as Error);

      // A network error or timeout on a non-idempotent request is genuinely
      // ambiguous -- the server may have processed it. We do not retry those,
      // because "maybe it went through" plus a retry is how duplicates happen.
      if (!mayRetry || attempt >= attempts) break;

      const wait = backoffFor(attempt, baseDelayMs, maxDelayMs);
      logger.warn({ label, attempt, waitMs: wait, err: lastError.message }, 'request failed; retrying');
      await delay(wait);
    } finally {
      globalThis.clearTimeout(timer);
    }
  }

  throw lastError ?? new Error(`Request to ${label} failed`);
}

/** Truncate an upstream body for storage in integration_runs. */
export function excerpt(body: string, max = 500): string {
  const collapsed = body.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}...` : collapsed;
}

/**
 * Idempotency-Key support for unsafe operations.
 *
 * The problem this solves is mundane and expensive: a contractor taps "Pay",
 * the response is slow, they tap again. Or a mobile client retries a POST after
 * a dropped connection. Without this, that is two charges.
 *
 * How it works:
 *   1. Insert the key first. The unique index on (company_id, endpoint, key) is
 *      the actual guard -- two concurrent requests race and exactly one wins.
 *   2. The loser reads the stored response. If the winner has finished, it
 *      replays that response verbatim. If not, it returns 409 so the client
 *      retries rather than duplicating work.
 *   3. On success the response is recorded for replay within the retention
 *      window.
 *
 * A key replayed with a DIFFERENT body is rejected: that means a client bug,
 * and silently returning the first response would hide it.
 */
import { createHash } from 'node:crypto';
import type { Tx } from '../db/tenant.js';
import { AppError, conflict } from './errors.js';
import { logger } from './logger.js';

export interface IdempotencyOutcome<T> {
  replayed: boolean;
  status: number;
  body: T;
}

function hashRequest(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

export async function withIdempotency<T>(
  tx: Tx,
  params: { companyId: string; endpoint: string; key: string | undefined; body: unknown },
  operation: () => Promise<{ status: number; body: T }>,
): Promise<IdempotencyOutcome<T>> {
  // No key supplied: run normally. Callers that must have one enforce it before
  // getting here (see routes/payments.ts).
  if (!params.key) {
    const result = await operation();
    return { replayed: false, ...result };
  }

  if (params.key.length > 255) {
    throw new AppError(400, 'bad_request', 'Idempotency-Key is too long');
  }

  const requestHash = hashRequest(params.body);

  const claimed = await tx.one<{ id: string }>(
    `insert into ocs.idempotency_keys (company_id, idempotency_key, endpoint, request_hash)
          values ($1, $2, $3, $4)
     on conflict (company_id, endpoint, idempotency_key) do nothing
       returning id`,
    [params.companyId, params.key, params.endpoint, requestHash],
  );

  if (!claimed) {
    const existing = await tx.one<{
      status: string;
      request_hash: string;
      response_status: number | null;
      response_body: unknown;
    }>(
      `select status, request_hash, response_status, response_body
         from ocs.idempotency_keys
        where company_id = $1 and endpoint = $2 and idempotency_key = $3`,
      [params.companyId, params.endpoint, params.key],
    );

    if (!existing) {
      // The row vanished between our insert and this read -- only possible if it
      // expired in that window. Treat as a conflict and let the client retry.
      throw conflict('Idempotency key is in an inconsistent state; retry the request');
    }

    if (existing.request_hash !== requestHash) {
      throw conflict(
        'This Idempotency-Key was already used with a different request body',
      );
    }

    if (existing.status === 'completed' && existing.response_status !== null) {
      logger.info({ endpoint: params.endpoint }, 'replaying idempotent response');
      return {
        replayed: true,
        status: existing.response_status,
        body: existing.response_body as T,
      };
    }

    // Still in flight elsewhere. 409 tells the client "not done yet, ask again"
    // -- much safer than executing the operation a second time.
    throw conflict('A request with this Idempotency-Key is still being processed');
  }

  try {
    const result = await operation();

    await tx.query(
      `update ocs.idempotency_keys
          set status = 'completed',
              response_status = $1,
              response_body = $2,
              completed_at = now()
        where company_id = $3 and endpoint = $4 and idempotency_key = $5`,
      [result.status, JSON.stringify(result.body), params.companyId, params.endpoint, params.key],
    );

    return { replayed: false, ...result };
  } catch (err) {
    // Mark failed so a retry with the same key is allowed to try again rather
    // than being stuck behind a permanently 'in_progress' row.
    await tx
      .query(
        `update ocs.idempotency_keys
            set status = 'failed', completed_at = now()
          where company_id = $1 and endpoint = $2 and idempotency_key = $3`,
        [params.companyId, params.endpoint, params.key],
      )
      .catch(() => undefined);
    throw err;
  }
}

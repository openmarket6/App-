/**
 * Tenant-scoped database access.
 *
 * THIS MODULE IS THE TENANT ISOLATION BOUNDARY. Every read or write of customer
 * data goes through withTenant(), which opens a transaction and installs the
 * caller's company_id as a transaction-local Postgres setting. The RLS policies
 * in 0008_rls.sql then filter every statement against it.
 *
 * The practical consequence: a query that forgets `where company_id = $1` is
 * still safe, and fetching a row by a guessed id returns nothing. The database
 * enforces the boundary, so route handlers cannot accidentally opt out of it.
 *
 * Rules:
 *   - Never run tenant queries on a raw pool client. Always withTenant().
 *   - Never build the company id into SQL text. set_config() is parameterised
 *     below precisely so a crafted id cannot become an injection.
 *   - withServiceContext() is for the worker and webhooks only, never for a
 *     request made by a logged-in user.
 */
import type pg from 'pg';
import { appPool, servicePool } from './pool.js';
import { logger } from '../lib/logger.js';
import { AppError } from '../lib/errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PlatformRole = 'none' | 'staff' | 'admin';

export interface TenantContext {
  companyId: string;
  userId: string;
  platformRole: PlatformRole;
  /** Correlates database work with the HTTP request that caused it. */
  requestId?: string;
}

/** The transaction handle handed to callbacks. Deliberately minimal. */
export interface Tx {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<R>>;
  /** Convenience: first row or null. */
  one<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<R | null>;
  /** All rows. */
  many<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<R[]>;
}

function wrap(client: pg.PoolClient): Tx {
  return {
    query: (text, values) => client.query(text, values as unknown[] | undefined),
    async one(text, values) {
      const res = await client.query(text, values as unknown[] | undefined);
      return (res.rows[0] as never) ?? null;
    },
    async many(text, values) {
      const res = await client.query(text, values as unknown[] | undefined);
      return res.rows as never[];
    },
  };
}

/**
 * Run `fn` inside a transaction scoped to one company.
 *
 * Commits on success, rolls back on any throw. The settings are transaction-
 * local (`set_config(..., true)`), so when the connection returns to the pool
 * it carries no tenant context with it -- the next borrower starts blind, which
 * is the fail-closed default we want.
 */
export async function withTenant<T>(
  ctx: TenantContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(ctx.companyId)) {
    throw new AppError(400, 'bad_request', 'Invalid company context');
  }
  if (!UUID_RE.test(ctx.userId)) {
    throw new AppError(400, 'bad_request', 'Invalid user context');
  }

  const client = await appPool.connect();
  try {
    await client.query('begin');
    // Parameterised, not interpolated. `true` = transaction-scoped.
    await client.query(
      `select set_config('ocs.company_id', $1, true),
              set_config('ocs.user_id', $2, true),
              set_config('ocs.platform_role', $3, true),
              set_config('ocs.request_id', $4, true)`,
      [ctx.companyId, ctx.userId, ctx.platformRole, ctx.requestId ?? ''],
    );

    const result = await fn(wrap(client));
    await client.query('commit');
    return result;
  } catch (err) {
    try {
      await client.query('rollback');
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr }, 'rollback failed');
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run `fn` with cross-tenant access, on the ocs_service role.
 *
 * Only two kinds of caller belong here: the background worker (which processes
 * jobs for many companies) and the payment webhook handler (which receives
 * events before it knows whose they are). Anything reached from a user's HTTP
 * request must use withTenant() instead.
 *
 * If this is called on a connection that is not ocs_service, the pg_has_role()
 * guard inside ocs.is_service_context() means the flag has no effect and
 * queries stay tenant-filtered -- it fails safe rather than silently escalating.
 */
export async function withServiceContext<T>(
  fn: (tx: Tx) => Promise<T>,
  opts: { reason: string; companyId?: string },
): Promise<T> {
  const client = await servicePool.connect();
  try {
    await client.query('begin');
    await client.query(
      `select set_config('ocs.service_context', 'on', true),
              set_config('ocs.company_id', $1, true)`,
      [opts.companyId ?? ''],
    );

    const result = await fn(wrap(client));
    await client.query('commit');
    return result;
  } catch (err) {
    try {
      await client.query('rollback');
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr, reason: opts.reason }, 'service rollback failed');
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Tenant-scoped work from the worker: the job knows its company, so it gets the
 * same RLS protection a user request would, with no service flag set.
 */
export async function withWorkerTenant<T>(
  ctx: TenantContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(ctx.companyId)) {
    throw new AppError(400, 'bad_request', 'Invalid company context');
  }

  const client = await servicePool.connect();
  try {
    await client.query('begin');
    await client.query(
      `select set_config('ocs.company_id', $1, true),
              set_config('ocs.user_id', $2, true),
              set_config('ocs.platform_role', $3, true),
              set_config('ocs.change_source', 'system', true)`,
      [ctx.companyId, ctx.userId, ctx.platformRole],
    );
    const result = await fn(wrap(client));
    await client.query('commit');
    return result;
  } catch (err) {
    try {
      await client.query('rollback');
    } catch {
      /* already failing; the original error is the useful one */
    }
    throw err;
  } finally {
    client.release();
  }
}

export { UUID_RE };

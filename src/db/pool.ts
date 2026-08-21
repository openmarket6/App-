/**
 * Postgres connection pools.
 *
 * Two pools, matching the two database roles created in 0008_rls.sql:
 *
 *   appPool     -> ocs_app     -- request handling. Confined to one tenant by
 *                                row-level security; cannot enter service
 *                                context even if it tries.
 *   servicePool -> ocs_service -- background worker and payment webhooks. May
 *                                cross tenants deliberately.
 *
 * Keeping them separate is what stops a bug in a route handler from reaching
 * another customer's rows. Route code must never import servicePool.
 */
import { existsSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

const { Pool } = pg;

/**
 * Return numeric/int8 as strings rather than JS numbers.
 *
 * bigint columns (byte_size, amount_cents) can exceed Number.MAX_SAFE_INTEGER,
 * and numeric columns (money) lose precision as floats. Parsing them to Number
 * silently corrupts values; keeping them as strings forces each call site to
 * convert deliberately.
 */
pg.types.setTypeParser(20, (v) => v); // int8
pg.types.setTypeParser(1700, (v) => v); // numeric

function createPool(connectionString: string, name: string): pg.Pool {
  const pool = new Pool({
    connectionString,
    max: env.DATABASE_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Belt and braces against a runaway query pinning a connection forever.
    statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
    query_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
    application_name: `ocs-${name}`,
    ...(connectionString.includes('localhost') || connectionString.includes('127.0.0.1')
      ? {}
      : {
          ssl: (() => {
            const caPath = process.env.DATABASE_CA_CERT_PATH ?? process.env.NODE_EXTRA_CA_CERTS;
            if (caPath && existsSync(caPath)) {
              return { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
            }
            if (process.env.DATABASE_SSL_INSECURE === 'true') {
              return { rejectUnauthorized: false };
            }
            return { rejectUnauthorized: true };
          })(),
        }),
  });

  // An idle client erroring is normal (network blip, server restart). Log it
  // and let the pool replace the connection -- but never let it crash the
  // process, which is pg's default for unhandled 'error' events.
  pool.on('error', (err) => {
    logger.error({ err, pool: name }, 'idle database client error');
  });

  return pool;
}

export const appPool = createPool(env.DATABASE_URL, 'app');

/**
 * Falls back to DATABASE_URL in development so a single connection string is
 * enough to get started. Production requires it explicitly (see config/env.ts),
 * because without the separate role the isolation guarantee is weaker.
 */
export const servicePool = createPool(
  env.DATABASE_SERVICE_URL ?? env.DATABASE_URL,
  'service',
);

export const usingSeparateServiceRole = Boolean(env.DATABASE_SERVICE_URL);

export async function closePools(): Promise<void> {
  await Promise.allSettled([appPool.end(), servicePool.end()]);
}

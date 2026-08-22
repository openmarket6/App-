/**
 * Test database helpers.
 *
 * These tests run against a REAL Postgres, not a mock. Row-level security is a
 * database behaviour -- a mocked client would happily return whatever the test
 * told it to and prove nothing about whether tenants are actually separated.
 *
 * Required environment (see README "Running the tests"):
 *   TEST_DATABASE_URL          owner/superuser -- applies migrations, seeds
 *   TEST_APP_DATABASE_URL      connects as ocs_app
 *   TEST_SERVICE_DATABASE_URL  connects as ocs_service
 */
import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../db/migrations');

export const ownerUrl = process.env['TEST_DATABASE_URL'];
export const appUrl = process.env['TEST_APP_DATABASE_URL'];
export const serviceUrl = process.env['TEST_SERVICE_DATABASE_URL'];

export const dbConfigured = Boolean(ownerUrl && appUrl && serviceUrl);

export function client(url: string): pg.Client {
  return new pg.Client({ connectionString: url });
}

/**
 * Apply pending migrations, tracked in ocs.schema_migrations exactly as the
 * real runner does. Test files each call this, and vitest may run several
 * against the same database, so it has to be a no-op once already applied --
 * re-running 0001 would fail on "type already exists".
 */
export async function applyMigrations(): Promise<void> {
  const c = client(ownerUrl!);
  await c.connect();
  try {
    await c.query('create schema if not exists ocs');
    /*
     * Same shape as src/db/migrate.ts, checksum column included.
     *
     * It diverged once, and the divergence went unnoticed for as long as no new
     * migration was added: `create table if not exists` on an existing database
     * is a no-op, so tests kept passing against a table the real runner had
     * created. The next new migration failed on a not-null checksum. Matching
     * the runner is what keeps that from happening again.
     */
    await c.query(`
      create table if not exists ocs.schema_migrations (
        version     text primary key,
        checksum    text not null,
        applied_at  timestamptz not null default now(),
        duration_ms int
      )
    `);

    const applied = new Set(
      (await c.query<{ version: string }>('select version from ocs.schema_migrations')).rows.map(
        (r) => r.version,
      ),
    );

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      const version = f.replace(/\.sql$/, '');
      if (applied.has(version)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, f), 'utf8');
      await c.query(sql);
      await c.query(
        'insert into ocs.schema_migrations (version, checksum) values ($1, $2)',
        [version, createHash('sha256').update(sql).digest('hex').slice(0, 16)],
      );
    }
  } finally {
    await c.end();
  }
}

export const ALPHA = '11111111-1111-1111-1111-111111111111';
export const BETA = '22222222-2222-2222-2222-222222222222';
export const ALPHA_USER = 'aaaaaaaa-0000-0000-0000-000000000001';
export const BETA_USER = 'bbbbbbbb-0000-0000-0000-000000000002';
export const ALPHA_PROJECT = 'aaaa1111-0000-0000-0000-000000000001';
export const BETA_PROJECT = 'bbbb2222-0000-0000-0000-000000000002';

/** Two tenants with one project each: the minimum to prove separation. */
export async function seedTwoTenants(): Promise<void> {
  const c = client(ownerUrl!);
  await c.connect();
  try {
    await c.query(`delete from ocs.companies where id in ($1, $2)`, [ALPHA, BETA]);
    await c.query(`delete from ocs.app_users where id in ($1, $2)`, [ALPHA_USER, BETA_USER]);

    await c.query(
      `insert into ocs.companies (id, name) values ($1, 'Alpha Roofing LLC'), ($2, 'Beta Builders Inc')`,
      [ALPHA, BETA],
    );
    await c.query(
      `insert into ocs.app_users (id, email, full_name)
       values ($1, 'ana@alpha.test', 'Ana Alpha'), ($2, 'ben@beta.test', 'Ben Beta')`,
      [ALPHA_USER, BETA_USER],
    );
    await c.query(
      `insert into ocs.company_memberships (company_id, user_id, role)
       values ($1, $2, 'owner'), ($3, $4, 'owner')`,
      [ALPHA, ALPHA_USER, BETA, BETA_USER],
    );
    await c.query(
      `insert into ocs.projects (id, company_id, name)
       values ($1, $2, 'Alpha Job Site'), ($3, $4, 'Beta Job Site')`,
      [ALPHA_PROJECT, ALPHA, BETA_PROJECT, BETA],
    );
  } finally {
    await c.end();
  }
}

/** Run a callback in a transaction with tenant context, as the API would. */
export async function asTenant<T>(
  url: string,
  ctx: { companyId: string; userId?: string; platformRole?: string },
  fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
  const c = client(url);
  await c.connect();
  try {
    await c.query('begin');
    await c.query(
      `select set_config('ocs.company_id', $1, true),
              set_config('ocs.user_id', $2, true),
              set_config('ocs.platform_role', $3, true)`,
      [ctx.companyId, ctx.userId ?? ALPHA_USER, ctx.platformRole ?? 'none'],
    );
    const result = await fn(c);
    await c.query('rollback');
    return result;
  } finally {
    await c.end();
  }
}

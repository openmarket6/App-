/**
 * SQL migration runner.
 *
 * Deliberately plain: numbered .sql files applied in order, recorded in
 * ocs.schema_migrations. No DSL and no down-migrations -- rolling a schema
 * change backwards on a live database with real customer data is rarely the
 * right move, and a pretend "down" invites someone to try it. Fixes go forward
 * as a new migration.
 *
 * Two safety properties:
 *   - An advisory lock serialises concurrent deploys, so two instances booting
 *     at once cannot apply the same migration twice.
 *   - Each applied file's checksum is stored. Editing a migration that has
 *     already run is caught here rather than becoming a silent drift between
 *     environments.
 *
 * Usage:  npm run migrate         (apply pending)
 *         npm run migrate:status  (report only)
 */
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../db/migrations');
const LOCK_KEY = 8_274_119; // arbitrary but fixed

interface Applied {
  version: string;
  checksum: string;
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex').slice(0, 16);
}

async function listMigrations(): Promise<Array<{ version: string; path: string; sql: string }>> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  return Promise.all(
    files.map(async (f) => ({
      version: f.replace(/\.sql$/, ''),
      path: join(MIGRATIONS_DIR, f),
      sql: await readFile(join(MIGRATIONS_DIR, f), 'utf8'),
    })),
  );
}

async function ensureTable(client: pg.Client): Promise<void> {
  await client.query(`create schema if not exists ocs`);
  await client.query(`
    create table if not exists ocs.schema_migrations (
      version     text primary key,
      checksum    text not null,
      applied_at  timestamptz not null default now(),
      duration_ms int
    )
  `);
}

async function run(mode: 'up' | 'status'): Promise<void> {
  const connectionString =
    process.env.DATABASE_MIGRATION_URL ??
    process.env.DATABASE_SERVICE_URL ??
    process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      'No database URL. Set DATABASE_MIGRATION_URL (preferred, owner privileges) or DATABASE_URL.',
    );
  }

  const client = new pg.Client({
    connectionString,
    ...(connectionString.includes('localhost') || connectionString.includes('127.0.0.1')
      ? {}
      : { ssl: { rejectUnauthorized: true } }),
  });
  await client.connect();

  try {
    await ensureTable(client);

    const { rows } = await client.query<Applied>(
      'select version, checksum from ocs.schema_migrations',
    );
    const appliedByVersion = new Map(rows.map((r) => [r.version, r.checksum]));
    const migrations = await listMigrations();

    // Detect edits to migrations that already ran anywhere.
    for (const m of migrations) {
      const prior = appliedByVersion.get(m.version);
      if (prior && prior !== checksum(m.sql)) {
        throw new Error(
          `Migration ${m.version} has been modified after it was applied ` +
            `(checksum ${prior} -> ${checksum(m.sql)}). ` +
            'Applied migrations are immutable; add a new migration instead.',
        );
      }
    }

    const pending = migrations.filter((m) => !appliedByVersion.has(m.version));

    if (mode === 'status') {
      console.log(`applied: ${appliedByVersion.size}, pending: ${pending.length}`);
      for (const m of pending) console.log(`  pending  ${m.version}`);
      return;
    }

    if (pending.length === 0) {
      console.log('No pending migrations.');
      return;
    }

    // Serialise concurrent deploys. Session-scoped; released in `finally`.
    await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);

    try {
      for (const m of pending) {
        const started = Date.now();
        console.log(`applying ${m.version}...`);

        // Each migration is one transaction: it either lands whole or not at all.
        await client.query('begin');
        try {
          await client.query(m.sql);
          await client.query(
            `insert into ocs.schema_migrations (version, checksum, duration_ms)
             values ($1, $2, $3)`,
            [m.version, checksum(m.sql), Date.now() - started],
          );
          await client.query('commit');
          console.log(`  ok (${Date.now() - started}ms)`);
        } catch (err) {
          await client.query('rollback');
          throw new Error(
            `Migration ${m.version} failed and was rolled back: ${(err as Error).message}`,
          );
        }
      }
    } finally {
      await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]);
    }

    console.log(`Applied ${pending.length} migration(s).`);
  } finally {
    await client.end();
  }
}

const mode = process.argv[2] === 'status' ? 'status' : 'up';
run(mode).catch((err: Error) => {
  console.error(`migration failed: ${err.message}`);
  process.exit(1);
});

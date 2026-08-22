/**
 * Guards for the failure class that took the job system down on 22 Aug 2026.
 *
 * None of these need a database or a server. They are cheap enough to run on
 * every commit, which is the only reason a guard ever actually fires.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const MIGRATIONS = join(ROOT, 'db', 'migrations');

function migrationSql(): string {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
    .join('\n');
}

function handlerSource(): string {
  const dir = join(ROOT, 'src', 'jobs', 'handlers');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
}

describe('scheduled jobs', () => {
  /**
   * `system.cleanup_refresh_tokens` was seeded by migration 0014 and no
   * handler was ever written. It failed on every run for a day and a half and
   * the only evidence was a log line. The scheduler and the handler registry
   * are edited in different files by different people; nothing connected them.
   */
  it('every job type seeded into ocs.job_schedules has a registered handler', () => {
    const sql = migrationSql();
    const src = handlerSource();

    const scheduled = new Set<string>();
    // insert into ocs.job_schedules (...) values ('name', 'job.type', ...)
    for (const m of sql.matchAll(
      /insert\s+into\s+ocs\.job_schedules[\s\S]{0,400}?values\s*([\s\S]*?);/gi,
    )) {
      for (const v of m[1]!.matchAll(/'([a-z_]+\.[a-z_]+)'/g)) scheduled.add(v[1]!);
    }

    const registered = new Set(
      [...src.matchAll(/registerHandler\(\s*'([^']+)'/g)].map((m) => m[1]!),
    );

    expect(scheduled.size).toBeGreaterThan(5); // the scan itself must not be vacuous

    const orphaned = [...scheduled].filter((t) => !registered.has(t)).sort();
    expect(orphaned, `schedules with no handler: ${orphaned.join(', ')}`).toEqual([]);
  });

  /**
   * The reaper must not be reachable only through the queue it repairs. On
   * 22 Aug the worker died mid-reap; the reaper stayed `running` with an
   * expired lock; its dedupe key then blocked every replacement; and nothing
   * cleared it for two and a half hours while `/healthz/queue` said `ok`.
   */
  it('the worker reaps stuck jobs out of band, not only as a queued job', () => {
    const runner = readFileSync(join(ROOT, 'src', 'jobs', 'runner.ts'), 'utf8');
    expect(runner).toContain('reapOutOfBand');
    // Called on the loop, so it does not depend on the scheduler either.
    expect(runner.match(/await reapOutOfBand\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('a reaper exists in SQL, for when no worker is alive at all', () => {
    expect(migrationSql()).toMatch(/create or replace function ocs\.reap_stuck_jobs\(\)/i);
  });
});

describe('monitoring surface', () => {
  /**
   * Netlify's SPA fallback answers any unproxied path with app.html and HTTP
   * 200. Verified live on 22 Aug: /healthz, /healthz/queue and /healthz/deep
   * all returned text/html 200 through the app domain. A monitor pointed
   * there is green forever.
   */
  it('netlify proxies the health endpoints instead of swallowing them', () => {
    const toml = readFileSync(join(ROOT, 'netlify.toml'), 'utf8');
    expect(toml).toMatch(/from\s*=\s*"\/healthz"/);
    expect(toml).toMatch(/from\s*=\s*"\/healthz\/\*"/);

    // and they must come before the catch-all, or the rule is decorative
    const healthAt = toml.indexOf('from = "/healthz"');
    const spaAt = toml.indexOf('from = "/*"');
    expect(healthAt).toBeGreaterThan(-1);
    expect(spaAt).toBeGreaterThan(healthAt);
  });

  it('the alert definitions live in one place', () => {
    const sql = migrationSql();
    expect(sql).toMatch(/create or replace function ocs\.ops_alerts\(\)/i);

    const health = readFileSync(join(ROOT, 'src', 'routes', 'health.ts'), 'utf8');
    const system = readFileSync(join(ROOT, 'src', 'jobs', 'handlers', 'system.ts'), 'utf8');
    const watchdog = readFileSync(join(ROOT, 'ops', 'watchdog.mjs'), 'utf8');

    // All three read the same function rather than restating the checks, so
    // they cannot disagree about whether the system is healthy.
    for (const [name, src] of [['health', health], ['sweep', system], ['watchdog', watchdog]]) {
      expect(src, `${name} should read ocs.ops_alerts()`).toContain('ocs.ops_alerts()');
    }
  });
});

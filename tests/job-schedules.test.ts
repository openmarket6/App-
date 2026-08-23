/**
 * Every scheduled job must have a handler, and every handler should be reachable.
 *
 * The scheduler promotes rows from ocs.job_schedules into real jobs; the worker
 * looks the job type up in a registry populated at boot. The two lists are
 * maintained in completely different places — one in a migration written months
 * ago, one in registerAllHandlers — and nothing compared them.
 *
 * system.cleanup_refresh_tokens had been scheduled since 0007 with no handler
 * ever written. The worker takes the job, finds nothing registered, and raises
 * PermanentJobError: four permanent failures a day, every day, sitting in the
 * failed-jobs list. That is the sort of standing noise that gets a list stopped
 * being read, and the real failures go with it. Nothing was deleted either, so
 * ocs.refresh_tokens kept a row per sign-in for the life of the deployment.
 *
 * The reverse direction matters less but is worth knowing: a handler nothing
 * ever enqueues is code that has never run and cannot be assumed to work.
 */
import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbConfigured, applyMigrations, client, ownerUrl } from './helpers/db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const describeIfDb = dbConfigured ? describe : describe.skip;

/** Job types registered at boot, read out of the handler sources. */
async function registeredHandlers(): Promise<Set<string>> {
  const dir = join(ROOT, 'src', 'jobs', 'handlers');
  const names = new Set<string>();
  for (const f of await readdir(dir)) {
    if (!f.endsWith('.ts') || f === 'index.ts') continue;
    const src = await readFile(join(dir, f), 'utf8');
    for (const m of src.matchAll(/registerHandler\(\s*'([a-z_.]+)'/g)) names.add(m[1]!);
  }
  return names;
}

/** Job types some route or handler puts on the queue directly. */
async function enqueuedTypes(): Promise<Set<string>> {
  const out = new Set<string>();
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith('.ts')) {
        const src = await readFile(full, 'utf8');
        for (const m of src.matchAll(/jobType:\s*'([a-z_.]+)'/g)) out.add(m[1]!);
      }
    }
  };
  await walk(join(ROOT, 'src'));
  return out;
}

describeIfDb('background jobs', () => {
  it('has a handler for every schedule', async () => {
    await applyMigrations();
    const handlers = await registeredHandlers();
    expect(handlers.size, 'should have found the handler registry')
      .toBeGreaterThan(5);

    const c = client(ownerUrl!);
    await c.connect();
    let scheduled: string[];
    try {
      const { rows } = await c.query<{ job_type: string; name: string }>(
        'select distinct job_type, name from ocs.job_schedules where is_enabled',
      );
      expect(rows.length, 'no schedules found — the seed did not run').toBeGreaterThan(0);
      scheduled = rows.map((r) => `${r.job_type} (${r.name})`);
    } finally {
      await c.end();
    }

    const orphans = scheduled.filter((s) => !handlers.has(s.split(' ')[0]!));
    expect(
      orphans,
      orphans.length
        ? 'These job types are scheduled and have no handler. The worker takes ' +
          'the job, finds nothing registered, and fails it permanently — on ' +
          `repeat, forever:\n  ${orphans.join('\n  ')}\n` +
          'Write the handler, or disable the schedule in a migration.'
        : '',
    ).toEqual([]);
  });

  it('leaves no handler that nothing ever runs', async () => {
    await applyMigrations();
    const handlers = await registeredHandlers();
    const enqueued = await enqueuedTypes();

    const c = client(ownerUrl!);
    await c.connect();
    let scheduled: Set<string>;
    try {
      const { rows } = await c.query<{ job_type: string }>(
        'select distinct job_type from ocs.job_schedules',
      );
      scheduled = new Set(rows.map((r) => r.job_type));
    } finally {
      await c.end();
    }

    const unreachable = [...handlers].filter((h) => !scheduled.has(h) && !enqueued.has(h));
    expect(
      unreachable,
      unreachable.length
        ? 'These handlers are registered but nothing schedules or enqueues ' +
          `them, so they have never run:\n  ${unreachable.join('\n  ')}\n` +
          'Either something should be putting them on the queue, or they are ' +
          'dead code wearing the appearance of a working feature.'
        : '',
    ).toEqual([]);
  });

  it('actually deletes the tokens it was written to delete', async () => {
    await applyMigrations();
    const c = client(ownerUrl!);
    await c.connect();
    let userId: string;
    try {
      await c.query('create extension if not exists pgcrypto');
      await c.query(`delete from ocs.app_users where email = 'jobs-token@test.invalid'`);
      const { rows } = await c.query<{ id: string }>(
        `insert into ocs.app_users (email, name, app_role, is_active)
         values ('jobs-token@test.invalid','Token','ADMIN',true) returning id`,
      );
      userId = rows[0]!.id;

      await c.query(
        `insert into ocs.refresh_tokens (user_id, token_hash, token_version, expires_at, revoked_at)
         values
           -- expired: goes
           ($1, 'hash-expired', 1, now() - interval '1 day', null),
           -- revoked a fortnight ago: goes
           ($1, 'hash-old-revoked', 1, now() + interval '30 days', now() - interval '14 days'),
           -- revoked yesterday: KEPT, because "signed out at 14:02 Tuesday" is
           -- the answer to a question somebody asks after a suspicious login
           ($1, 'hash-just-revoked', 1, now() + interval '30 days', now() - interval '1 day'),
           -- live: obviously kept
           ($1, 'hash-live', 1, now() + interval '30 days', null)`,
        [userId],
      );
    } finally {
      await c.end();
    }

    const { registerAllHandlers } = await import('../src/jobs/handlers/index.js');
    const { getHandler } = await import('../src/jobs/runner.js');
    registerAllHandlers();
    const handler = getHandler('system.cleanup_refresh_tokens');
    expect(handler, 'no handler registered for system.cleanup_refresh_tokens').toBeTruthy();

    const result = await handler!({ payload: {} } as never) as
      { expired: number; revoked: number };
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(result.revoked).toBeGreaterThanOrEqual(1);

    const c2 = client(ownerUrl!);
    await c2.connect();
    try {
      const { rows } = await c2.query<{ token_hash: string }>(
        'select token_hash from ocs.refresh_tokens where user_id = $1 order by token_hash',
        [userId],
      );
      expect(rows.map((r) => r.token_hash)).toEqual(['hash-just-revoked', 'hash-live']);
    } finally {
      await c2.end();
    }
  });
});

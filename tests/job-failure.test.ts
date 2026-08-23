/**
 * What happens when a job fails.
 *
 * There was no test for this, in a queue that had shipped retries, a
 * dead-letter state, an admin retry endpoint and a reaper. All four depended
 * on two SQL statements that raised on every execution:
 *
 *   failJob        42P08  inconsistent types deduced for parameter $2
 *                         (text versus ocs.job_status)
 *   reapStuckJobs  42804  column "status" is of type ocs.job_status
 *                         but expression is of type text
 *
 * So no job had ever been retried, nothing had ever reached 'dead', and the
 * reaper had never cleared anything. A failing handler left its row 'running'
 * forever, holding one of four concurrency slots. Production had 23 such rows
 * when this was found, the oldest 20 hours old.
 *
 * These tests execute the real statements against a real Postgres. A mock
 * would have passed against the broken SQL, which is the whole point.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { dbConfigured, applyMigrations, client, ownerUrl } from './helpers/db.js';

const describeIfDb = dbConfigured ? describe : describe.skip;

async function db<T>(fn: (c: import('pg').Client) => Promise<T>): Promise<T> {
  const c = client(ownerUrl!);
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Insert a job already claimed by `lockedBy`, locked `lockedAgo` ago. */
async function seedRunning(opts: {
  jobType?: string;
  attempts?: number;
  maxAttempts?: number;
  lockedBy?: string;
  lockedAgo?: string;
  timeoutSeconds?: number;
}): Promise<{ id: string; job_type: string; attempts: number; max_attempts: number; timeout_seconds: number; queue: string; payload: unknown; company_id: string | null }> {
  return db(async (c) => {
    const res = await c.query(
      `insert into ocs.jobs
         (queue, job_type, payload, status, run_at, attempts, max_attempts,
          locked_at, locked_by, timeout_seconds)
       values ('default', $1, '{}', 'running', now(), $2, $3,
               now() - $4::interval, $5, $6)
       returning id, job_type, attempts, max_attempts, timeout_seconds, queue, payload, company_id`,
      [
        opts.jobType ?? 'system.cleanup_idempotency',
        opts.attempts ?? 1,
        opts.maxAttempts ?? 3,
        opts.lockedAgo ?? '1 second',
        opts.lockedBy ?? 'worker-a',
        opts.timeoutSeconds ?? 300,
      ],
    );
    return res.rows[0];
  });
}

const statusOf = (id: string) =>
  db(async (c) => {
    const r = await c.query(
      `select status::text as status, attempts, error_count, locked_by,
              last_error, finished_at, run_at > now() as retry_in_future
         from ocs.jobs where id = $1`,
      [id],
    );
    return r.rows[0];
  });

describeIfDb('a job that fails', () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await db((c) => c.query(`delete from ocs.jobs`));
  });

  it('is marked failed and scheduled for a retry', async () => {
    const { failJob } = await import('../src/jobs/queue.js');
    const job = await seedRunning({ attempts: 1, maxAttempts: 3 });

    const outcome = await failJob(job as never, new Error('the county portal timed out'), {}, 'worker-a');

    expect(outcome).toBe('retrying');
    const row = await statusOf(job.id);
    expect(row.status).toBe('failed');
    expect(row.last_error).toContain('county portal');
    expect(row.locked_by).toBeNull();
    // The retry is in the future, so it is not claimed again on the next poll.
    expect(row.retry_in_future).toBe(true);
    expect(row.finished_at).toBeNull();
  });

  it('is dead-lettered once its attempts are exhausted', async () => {
    const { failJob } = await import('../src/jobs/queue.js');
    const job = await seedRunning({ attempts: 3, maxAttempts: 3 });

    const outcome = await failJob(job as never, new Error('still broken'), {}, 'worker-a');

    expect(outcome).toBe('dead');
    const row = await statusOf(job.id);
    expect(row.status).toBe('dead');
    expect(row.finished_at).not.toBeNull();
  });

  it('is dead-lettered immediately when the failure is permanent', async () => {
    const { failJob } = await import('../src/jobs/queue.js');
    const job = await seedRunning({ attempts: 1, maxAttempts: 5 });

    const outcome = await failJob(
      job as never,
      new Error('no handler registered'),
      { permanent: true },
      'worker-a',
    );

    expect(outcome).toBe('dead');
    expect((await statusOf(job.id)).status).toBe('dead');
  });

  it('cannot be failed by a worker that no longer owns it', async () => {
    // The abandoned-handler case: worker A timed out, the reaper released the
    // job, worker B took it, and A's handler finally throws. A's late failure
    // must not rewrite B's job.
    const { failJob } = await import('../src/jobs/queue.js');
    const job = await seedRunning({ lockedBy: 'worker-b' });

    await failJob(job as never, new Error('late failure from worker A'), {}, 'worker-a');

    const row = await statusOf(job.id);
    expect(row.status).toBe('running');
    expect(row.locked_by).toBe('worker-b');
    expect(row.last_error).toBeNull();
  });
});

describeIfDb('the reaper', () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await db((c) => c.query(`delete from ocs.jobs`));
  });

  it('releases a job whose lock has expired', async () => {
    const { reapStuckJobs } = await import('../src/jobs/queue.js');
    const job = await seedRunning({ lockedAgo: '1 hour', timeoutSeconds: 300, attempts: 1, maxAttempts: 3 });

    expect(await reapStuckJobs()).toBe(1);

    const row = await statusOf(job.id);
    expect(row.status).toBe('failed');
    expect(row.locked_by).toBeNull();
    expect(row.retry_in_future).toBe(true);
  });

  it('dead-letters a stuck job that has no attempts left', async () => {
    const { reapStuckJobs } = await import('../src/jobs/queue.js');
    const job = await seedRunning({ lockedAgo: '1 hour', attempts: 3, maxAttempts: 3 });

    expect(await reapStuckJobs()).toBe(1);
    const row = await statusOf(job.id);
    expect(row.status).toBe('dead');
    expect(row.finished_at).not.toBeNull();
  });

  it('leaves a job whose lock is still valid alone', async () => {
    const { reapStuckJobs } = await import('../src/jobs/queue.js');
    const job = await seedRunning({ lockedAgo: '10 seconds', timeoutSeconds: 300 });

    expect(await reapStuckJobs()).toBe(0);
    expect((await statusOf(job.id)).status).toBe('running');
  });

  it('does not wedge itself: a stuck reaper is released by the next reaper', async () => {
    // The production failure, reproduced. system.reap_stuck_jobs is itself a
    // queued job; if it can never be released, nothing else can be either.
    const { reapStuckJobs } = await import('../src/jobs/queue.js');
    const stuckReaper = await seedRunning({
      jobType: 'system.reap_stuck_jobs',
      lockedAgo: '20 hours',
      attempts: 1,
      maxAttempts: 5,
    });

    expect(await reapStuckJobs()).toBe(1);
    expect((await statusOf(stuckReaper.id)).status).toBe('failed');
  });
});

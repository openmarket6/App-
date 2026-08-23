/**
 * Postgres-backed job queue.
 *
 * Claiming uses `for update skip locked`, which is the pattern that makes a
 * plain table behave correctly as a queue: each worker locks the rows it takes,
 * other workers step over locked rows instead of blocking, and if a worker dies
 * its transaction aborts and the rows unlock immediately.
 *
 * Retry policy:
 *   - Failures reschedule with exponential backoff plus jitter.
 *   - After max_attempts the job becomes 'dead' rather than looping forever.
 *     Dead jobs are visible to the admin endpoint so a human sees them; they
 *     are never discarded silently, because a silently dropped
 *     "notify the contractor their permit expires" is exactly the failure that
 *     costs a customer money.
 */
import type { Tx } from '../db/tenant.js';
import { withServiceContext } from '../db/tenant.js';
import { logger } from '../lib/logger.js';

export interface EnqueueParams {
  jobType: string;
  payload?: Record<string, unknown>;
  companyId?: string | null;
  queue?: string;
  runAt?: Date;
  maxAttempts?: number;
  priority?: number;
  timeoutSeconds?: number;
  /**
   * Makes enqueue idempotent while a matching job is still pending. Without it,
   * an hourly sweep that runs while the previous one is still working will
   * happily queue the same permit check twice.
   */
  dedupeKey?: string;
}

export interface JobRow {
  id: string;
  company_id: string | null;
  queue: string;
  job_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  timeout_seconds: number;
}

/**
 * Enqueue inside the CALLER'S transaction.
 *
 * Taking `tx` rather than opening its own connection is the important detail:
 * the job and the data change it refers to commit together. A job can never
 * reference a row that was rolled back, and a committed change can never lose
 * its follow-up job.
 */
export async function enqueue(tx: Tx, params: EnqueueParams): Promise<string | null> {
  const row = await tx.one<{ id: string }>(
    `insert into ocs.jobs
       (company_id, queue, job_type, payload, run_at, max_attempts, priority,
        timeout_seconds, dedupe_key)
     values ($1, $2, $3, $4, coalesce($5, now()), $6, $7, $8, $9)
     on conflict (queue, dedupe_key)
       where dedupe_key is not null and status in ('queued','running','failed')
       do nothing
     returning id`,
    [
      params.companyId ?? null,
      params.queue ?? 'default',
      params.jobType,
      JSON.stringify(params.payload ?? {}),
      params.runAt ?? null,
      params.maxAttempts ?? 5,
      params.priority ?? 100,
      params.timeoutSeconds ?? 300,
      params.dedupeKey ?? null,
    ],
  );

  if (!row) {
    logger.debug({ jobType: params.jobType, dedupeKey: params.dedupeKey }, 'job deduplicated');
    return null;
  }
  return row.id;
}

/** Claim up to `limit` due jobs for this worker. */
export async function claimJobs(queue: string, limit: number, workerId: string): Promise<JobRow[]> {
  return withServiceContext(
    async (tx) =>
      tx.many<JobRow>(
        `with claimed as (
           select id
             from ocs.jobs
            where queue = $1
              and status in ('queued', 'failed')
              and run_at <= now()
            order by priority asc, run_at asc
            limit $2
            for update skip locked
         )
         update ocs.jobs j
            set status     = 'running',
                locked_at  = now(),
                locked_by  = $3,
                started_at = now(),
                attempts   = j.attempts + 1
           from claimed
          where j.id = claimed.id
        returning j.id, j.company_id, j.queue, j.job_type, j.payload,
                  j.attempts, j.max_attempts, j.timeout_seconds`,
        [queue, limit, workerId],
      ),
    { reason: 'claim_jobs' },
  );
}

/**
 * Mark a job finished — but only if this worker still owns it.
 *
 * The ownership clause is the point. Promise.race in the runner ABANDONS a
 * timed-out handler rather than cancelling it: a handler stuck on a socket
 * keeps running after its timeout fires, the reaper releases the job, another
 * worker picks it up, and the original invocation eventually returns and
 * writes 'succeeded' over a job somebody else is midway through — clearing
 * locked_by underneath them.
 *
 * `locked_by` is the whole guard. Zero rows updated means "I was reaped while
 * I worked; my result is not wanted", which is a fact worth logging rather
 * than a failure.
 */
export async function completeJob(
  jobId: string,
  result?: unknown,
  ownedBy?: string,
): Promise<void> {
  await withServiceContext(
    async (tx) => {
      const res = await tx.query(
        `update ocs.jobs
            set status = 'succeeded',
                finished_at = now(),
                locked_at = null,
                locked_by = null,
                result = $2,
                last_error = null
          where id = $1
            and status = 'running'
            and ($3::text is null or locked_by = $3)`,
        [jobId, result === undefined ? null : JSON.stringify(result), ownedBy ?? null],
      );
      if (res.rowCount === 0) {
        logger.warn(
          { jobId, ownedBy },
          'job finished but was no longer ours — reaped mid-run; result discarded',
        );
      }
    },
    { reason: 'complete_job' },
  );
}

/** Exponential backoff with jitter, capped at one hour. */
function retryDelaySeconds(attempts: number): number {
  const base = Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));
  return Math.floor(base * (0.5 + Math.random() * 0.5));
}

/**
 * Record a failure and decide whether to retry or give up.
 *
 * `permanent` is for errors that retrying cannot fix -- a malformed payload, a
 * deleted record. Retrying those five times just delays the alert and burns
 * capacity.
 */
export async function failJob(
  job: JobRow,
  error: Error,
  opts: { permanent?: boolean } = {},
  /**
   * The worker recording the failure.
   *
   * Symmetric with `completeJob`. `runWithTimeout` abandons a timed-out
   * handler rather than cancelling it, so one stuck on a socket keeps running
   * after its timeout fires; the reaper releases the job, another worker takes
   * it, and the original invocation eventually throws. Without this guard that
   * late failure clears `locked_by` and rewrites the status of a job somebody
   * else is midway through -- and computes exhaustion from its own stale
   * `attempts`, so it can declare a live job dead.
   */
  ownedBy?: string,
): Promise<'retrying' | 'dead'> {
  const exhausted = opts.permanent === true || job.attempts >= job.max_attempts;
  const delaySeconds = retryDelaySeconds(job.attempts);

  await withServiceContext(
    async (tx) => {
      await tx.query(
        /*
         * `$2::ocs.job_status` and the separate `$3` text copy are not
         * stylistic.
         *
         * `status` is an enum column. Sending the new status as one untyped
         * parameter used in both `set status = $2` and `case when $2 =
         * 'failed'` made Postgres deduce ocs.job_status from the assignment
         * and text from the comparison, and refuse the whole statement with
         *
         *     42P08  inconsistent types deduced for parameter $2
         *            detail: text versus ocs.job_status
         *
         * every single time. This statement had therefore NEVER succeeded:
         * no job in this system has ever been retried or dead-lettered. A
         * handler that threw left its row 'running' forever, holding a
         * concurrency slot, and `reapStuckJobs` -- which had the same defect
         * in its own CASE -- could not clean it up either. Four failures of
         * any kind and background processing stops permanently and silently.
         *
         * Found 23 Aug 2026 with 23 such rows in production, the oldest 20
         * hours old. No test had ever exercised a failing job; there are now
         * eight, in tests/job-failure.test.ts.
         */
        `update ocs.jobs
            set status      = $2::ocs.job_status,
                last_error  = $4,
                error_count = error_count + 1,
                locked_at   = null,
                locked_by   = null,
                run_at      = case when $3 = 'failed'
                                   then now() + make_interval(secs => $5)
                                   else run_at end,
                finished_at = case when $3 = 'dead' then now() else null end
          where id = $1
            and status = 'running'
            and ($6::text is null or locked_by = $6)`,
        [
          job.id,
          exhausted ? 'dead' : 'failed',
          exhausted ? 'dead' : 'failed',
          error.message.slice(0, 2000),
          delaySeconds,
          ownedBy ?? null,
        ],
      );
    },
    { reason: 'fail_job' },
  );

  if (exhausted) {
    // Deliberately error-level: a dead job is unfinished business that needs a
    // person, and it should be loud enough to trigger an alert.
    logger.error(
      { jobId: job.id, jobType: job.job_type, attempts: job.attempts, err: error.message },
      'JOB DEAD - retries exhausted, manual intervention required',
    );
    return 'dead';
  }

  logger.warn(
    { jobId: job.id, jobType: job.job_type, attempts: job.attempts, retryInSeconds: delaySeconds },
    'job failed; scheduled for retry',
  );
  return 'retrying';
}

/**
 * Reclaim jobs whose worker vanished.
 *
 * A process killed mid-job (deploy, OOM, host reclaim) leaves its row stuck in
 * 'running' forever. Without this, a deploy at the wrong moment quietly
 * abandons whatever was in flight.
 */
export async function reapStuckJobs(): Promise<number> {
  return withServiceContext(
    async (tx) => {
      const rows = await tx.many<{ id: string; job_type: string }>(
        `update ocs.jobs
            -- Cast required: a CASE over two string literals resolves to
            -- text, and text does not assign to an enum column. Without it
            -- this statement raised 42804 on every run and the reaper had
            -- never once cleared a stuck job.
            set status = (case when attempts >= max_attempts then 'dead' else 'failed' end)::ocs.job_status,
                last_error = 'worker timed out or died before completing',
                error_count = error_count + 1,
                locked_at = null,
                locked_by = null,
                run_at = now() + interval '60 seconds',
                finished_at = case when attempts >= max_attempts then now() else null end
          where status = 'running'
            and locked_at < now() - make_interval(secs => timeout_seconds)
        returning id, job_type`,
      );

      if (rows.length > 0) {
        logger.warn({ count: rows.length, jobs: rows.map((r) => r.job_type) }, 'reaped stuck jobs');
      }
      return rows.length;
    },
    { reason: 'reap_stuck_jobs' },
  );
}

/** Snapshot for the health endpoint and admin dashboard. */
export async function queueStats(): Promise<Record<string, number>> {
  return withServiceContext(
    async (tx) => {
      const rows = await tx.many<{ status: string; count: string }>(
        `select status::text, count(*)::text from ocs.jobs
          where created_at > now() - interval '7 days'
          group by status`,
      );
      const out: Record<string, number> = {};
      for (const r of rows) out[r.status] = Number(r.count);
      return out;
    },
    { reason: 'queue_stats' },
  );
}

/** Jobs needing a human. Surfaced by GET /v1/admin/jobs/dead. */
export async function deadJobs(limit = 50): Promise<unknown[]> {
  return withServiceContext(
    async (tx) =>
      tx.many(
        `select id, company_id, queue, job_type, attempts, last_error, finished_at
           from ocs.jobs
          where status = 'dead'
          order by finished_at desc
          limit $1`,
        [limit],
      ),
    { reason: 'dead_jobs' },
  );
}

/** Re-queue a dead job after the underlying cause is fixed. */
export async function retryDeadJob(jobId: string): Promise<boolean> {
  return withServiceContext(
    async (tx) => {
      const row = await tx.one<{ id: string }>(
        `update ocs.jobs
            set status = 'queued',
                attempts = 0,
                error_count = 0,
                last_error = null,
                run_at = now(),
                finished_at = null
          where id = $1 and status = 'dead'
        returning id`,
        [jobId],
      );
      return row !== null;
    },
    { reason: 'retry_dead_job' },
  );
}

/**
 * Worker loop and scheduler.
 *
 * Runs as its own process (`npm run start:worker`), separate from the API. That
 * separation matters: a slow municipal portal scrape must never make a
 * contractor's page load slowly, and restarting the API for a deploy must not
 * abandon work in flight.
 *
 * Shutdown is graceful. On SIGTERM -- which is what Render sends before
 * replacing a container -- we stop claiming new jobs and let in-flight ones
 * finish. Anything still running when the grace period expires is reclaimed by
 * the reaper, so no job is lost either way.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { withServiceContext } from '../db/tenant.js';
import { claimJobs, completeJob, failJob, enqueue, reapStuckJobs, type JobRow } from './queue.js';

export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

export type JobHandler = (job: JobRow) => Promise<unknown>;

const handlers = new Map<string, JobHandler>();

export function registerHandler(jobType: string, handler: JobHandler): void {
  if (handlers.has(jobType)) throw new Error(`duplicate handler for ${jobType}`);
  handlers.set(jobType, handler);
}

export function registeredJobTypes(): string[] {
  return [...handlers.keys()].sort();
}

const WORKER_ID = `${process.env.RENDER_INSTANCE_ID ?? 'local'}-${randomUUID().slice(0, 8)}`;

let running = false;
let shuttingDown = false;
let inFlight = 0;

/**
 * Enforce the job's own timeout in-process.
 *
 * The reaper is the backstop for a dead worker, but a job that hangs on a
 * socket inside a live worker would otherwise occupy a slot indefinitely. This
 * bounds it from the inside as well.
 */
async function runWithTimeout(job: JobRow, handler: JobHandler): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = globalThis.setTimeout(
      () => reject(new Error(`job exceeded ${job.timeout_seconds}s timeout`)),
      job.timeout_seconds * 1000,
    );
  });

  try {
    return await Promise.race([handler(job), timeout]);
  } finally {
    if (timer) globalThis.clearTimeout(timer);
  }
}

async function processJob(job: JobRow): Promise<void> {
  inFlight++;
  const started = Date.now();
  const log = logger.child({ jobId: job.id, jobType: job.job_type, attempt: job.attempts });

  try {
    const handler = handlers.get(job.job_type);
    if (!handler) {
      // Unknown type is permanent: no number of retries will conjure a handler.
      throw new PermanentJobError(`no handler registered for job type "${job.job_type}"`);
    }

    const result = await runWithTimeout(job, handler);
    recordJobProcessed();
      await completeJob(job.id, result);
    log.info({ durationMs: Date.now() - started }, 'job completed');
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    await failJob(job, error, { permanent: error instanceof PermanentJobError }).catch(
      (failErr: unknown) => {
        // If we cannot even record the failure the job stays 'running' and the
        // reaper will pick it up. Log loudly; do not crash the worker.
        log.error({ err: failErr }, 'failed to record job failure');
      },
    );
  } finally {
    inFlight--;
  }
}

/**
 * Promote due entries from ocs.job_schedules into real jobs.
 *
 * `next_run_at` advances in the same statement that selects the row, with
 * `for update skip locked`, so two workers polling simultaneously cannot both
 * fire the same schedule.
 */
async function tickScheduler(): Promise<void> {
  const due = await withServiceContext(
    async (tx) =>
      tx.many<{ id: string; name: string; job_type: string; queue: string; payload: Record<string, unknown> }>(
        `with due as (
           select id from ocs.job_schedules
            where is_enabled and next_run_at <= now()
            for update skip locked
            limit 20
         )
         update ocs.job_schedules s
            set last_run_at = now(),
                next_run_at = now() + make_interval(secs => s.interval_seconds)
           from due
          where s.id = due.id
        returning s.id, s.name, s.job_type, s.queue, s.payload`,
      ),
    { reason: 'scheduler_tick' },
  );

  for (const schedule of due) {
    const jobId = await withServiceContext(
      async (tx) =>
        enqueue(tx, {
          jobType: schedule.job_type,
          queue: schedule.queue,
          payload: { ...schedule.payload, scheduleName: schedule.name },
          // One pending run per schedule at a time.
          dedupeKey: `schedule:${schedule.name}`,
        }),
      { reason: 'scheduler_enqueue' },
    );

    // A null id means the unique dedupe index rejected the insert because a
    // previous run of this schedule is still queued, running or failed.
    //
    // That is normal for one tick and a silent outage if it persists: on
    // 22 Aug 2026 the reaper wedged in `running` with an expired lock, every
    // later enqueue was deduped away, and `next_run_at` kept advancing as if
    // the schedule were healthy. Recording the outcome is what makes the
    // difference visible; `consecutive_failures` is what makes it alertable.
    const status = jobId ? 'enqueued' : 'deduped';
    await withServiceContext(
      async (tx) => {
        await tx.query(
          `update ocs.job_schedules
              set last_status = $2,
                  last_enqueued_job_id = coalesce($3::uuid, last_enqueued_job_id),
                  consecutive_failures =
                    case when $2 = 'enqueued' then 0 else consecutive_failures + 1 end,
                  last_error =
                    case when $2 = 'enqueued' then null
                         else 'enqueue deduplicated: a previous run has not finished' end,
                  updated_at = now()
            where id = $1`,
          [schedule.id, status, jobId],
        );
      },
      { reason: 'scheduler_status' },
    );

    if (jobId) {
      logger.info({ schedule: schedule.name, jobType: schedule.job_type }, 'scheduled job enqueued');
    } else {
      logger.warn(
        { schedule: schedule.name, jobType: schedule.job_type },
        'scheduled job NOT enqueued -- a previous run is still outstanding',
      );
    }
  }
}

/**
 * Reap stuck jobs out of band.
 *
 * `system.reap_stuck_jobs` also exists as a queued job, and that is exactly the
 * problem it cannot solve: if the worker dies while running the reaper, the
 * reaper is itself a stuck job, its dedupe key blocks every replacement, and
 * nothing ever clears it. The recovery path must not travel through the queue
 * it is recovering.
 *
 * So this runs directly on the worker loop, on a timer, owing nothing to the
 * scheduler or the jobs table. `ocs.reap_stuck_jobs()` in migration 0038 is the
 * third line: it can be run by pg_cron or by a human with a SQL console when
 * no worker is alive at all.
 */
const REAP_INTERVAL_MS = 60_000;
let lastReapAt = 0;

async function reapOutOfBand(): Promise<void> {
  const now = Date.now();
  if (now - lastReapAt < REAP_INTERVAL_MS) return;
  lastReapAt = now;
  try {
    const reaped = await reapStuckJobs();
    if (reaped > 0) logger.warn({ reaped }, 'out-of-band reaper cleared stuck jobs');
  } catch (err) {
    logger.warn({ err }, 'out-of-band reap failed; will retry next tick');
  }
}

/**
 * Refuse to run a scheduler that is scheduling work nobody handles.
 *
 * `system.cleanup_refresh_tokens` was seeded by migration 0014 and no handler
 * was ever registered for it. It has been enqueued every six hours since,
 * failing permanently each time, and the only evidence was a log line among
 * many. A schedule with no handler is a configuration error, and a
 * configuration error should be loud at boot rather than quiet forever.
 */
export async function assertScheduledTypesAreHandled(): Promise<void> {
  const rows = await withServiceContext(
    async (tx) =>
      tx.many<{ name: string; job_type: string }>(
        `select name, job_type from ocs.job_schedules where is_enabled order by name`,
      ),
    { reason: 'schedule_handler_check' },
  );

  const orphaned = rows.filter((r) => !handlers.has(r.job_type));
  if (orphaned.length === 0) return;

  // Deliberately not a boot refusal. A worker that will not start because one
  // schedule is misconfigured stops *all* background work -- a worse outcome
  // than the fault it is objecting to. Disable the orphans instead, so they
  // stop consuming a dedupe slot every interval, and make the fact loud in
  // three places: the log, `job_schedules.last_status`, and `ocs.ops_alerts()`.
  logger.error(
    { orphaned, registered: registeredJobTypes() },
    'enabled schedules have no registered handler; disabling them -- fix the handler or delete the schedule',
  );

  await withServiceContext(
    async (tx) => {
      await tx.query(
        `update ocs.job_schedules
            set is_enabled = false,
                last_status = 'no_handler',
                last_error = 'no handler is registered for this job type',
                updated_at = now()
          where job_type = any($1::text[])`,
        [orphaned.map((r) => r.job_type)],
      );
    },
    { reason: 'disable_orphaned_schedules' },
  );
}

const QUEUES = ['default', 'integrations', 'notifications'];


/**
 * Records that this worker is alive and what it has done.
 *
 * Written on a timer rather than on every poll: the loop spins several times a
 * second when idle, and a write per spin would be thousands of pointless
 * updates an hour to say nothing changed.
 *
 * Failures here are logged and swallowed. A worker that stops processing jobs
 * because it could not write a heartbeat has turned an observability feature
 * into the outage it was meant to detect.
 */
let lastHeartbeatAt = 0;
let jobsProcessedTotal = 0;
let lastJobAt: Date | null = null;

const HEARTBEAT_INTERVAL_MS = 15_000;

export function recordJobProcessed(): void {
  jobsProcessedTotal += 1;
  lastJobAt = new Date();
}

async function writeHeartbeat(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return;
  lastHeartbeatAt = now;

  try {
    await withServiceContext(
      async (tx) => {
        await tx.query(
          `insert into ocs.worker_heartbeats
             (queue, instance_id, last_seen_at, jobs_processed, last_job_at, commit_sha)
           values ('default', $1, now(), $2, $3, $4)
           on conflict (queue) do update
             set instance_id = excluded.instance_id,
                 last_seen_at = now(),
                 jobs_processed = excluded.jobs_processed,
                 last_job_at = coalesce(excluded.last_job_at, ocs.worker_heartbeats.last_job_at),
                 -- started_at is NOT touched: it marks when this instance came
                 -- up, and a restart loop is only visible if it survives the
                 -- upsert.
                 commit_sha = excluded.commit_sha`,
          [
            WORKER_ID,
            jobsProcessedTotal,
            lastJobAt,
            process.env['RENDER_GIT_COMMIT'] ?? null,
          ],
        );
      },
      { reason: 'worker_heartbeat' },
    );
  } catch (err) {
    logger.warn({ err }, 'could not write worker heartbeat; continuing');
  }
}

async function loop(): Promise<void> {
  while (!shuttingDown) {
    try {
      await writeHeartbeat();
      await reapOutOfBand();
      await tickScheduler();

      const capacity = env.WORKER_CONCURRENCY - inFlight;
      if (capacity <= 0) {
        await delay(250);
        continue;
      }

      let claimedAny = false;
      for (const queue of QUEUES) {
        if (shuttingDown) break;
        const remaining = env.WORKER_CONCURRENCY - inFlight;
        if (remaining <= 0) break;

        const jobs = await claimJobs(queue, remaining, WORKER_ID);
        if (jobs.length > 0) {
          claimedAny = true;
          // Deliberately not awaited: jobs run concurrently up to the
          // concurrency cap, which `inFlight` enforces above.
          for (const job of jobs) void processJob(job);
        }
      }

      // Only idle-sleep when there was nothing to do, so a backlog drains at
      // full speed instead of pausing between batches.
      if (!claimedAny) await delay(env.WORKER_POLL_INTERVAL_MS);
    } catch (err) {
      logger.error({ err }, 'worker loop error; continuing');
      await delay(env.WORKER_POLL_INTERVAL_MS);
    }
  }
}

export async function startWorker(): Promise<void> {
  if (running) return;
  running = true;
  logger.info(
    { workerId: WORKER_ID, concurrency: env.WORKER_CONCURRENCY, handlers: registeredJobTypes() },
    'worker started',
  );
  // Written immediately, so a worker that dies during its first poll is still
  // distinguishable from one that never started at all.
  await writeHeartbeat(true);

  // Clear anything the previous instance abandoned before claiming new work.
  // A redeploy is the single most common way jobs are orphaned, and this is
  // the first moment a healthy process exists to notice.
  lastReapAt = 0;
  await reapOutOfBand();

  await assertScheduledTypesAreHandled();

  await loop();
}

export async function stopWorker(graceMs = 25_000): Promise<void> {
  shuttingDown = true;
  logger.info({ inFlight }, 'worker shutting down; waiting for in-flight jobs');

  const deadline = Date.now() + graceMs;
  while (inFlight > 0 && Date.now() < deadline) {
    await delay(200);
  }

  if (inFlight > 0) {
    logger.warn({ inFlight }, 'shutdown grace expired; remaining jobs will be reaped and retried');
  }
  running = false;
}

export function workerHealth(): { running: boolean; inFlight: number; workerId: string } {
  return { running, inFlight, workerId: WORKER_ID };
}

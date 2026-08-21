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
import { claimJobs, completeJob, failJob, enqueue, type JobRow } from './queue.js';

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
    await withServiceContext(
      async (tx) => {
        await enqueue(tx, {
          jobType: schedule.job_type,
          queue: schedule.queue,
          payload: { ...schedule.payload, scheduleName: schedule.name },
          // One pending run per schedule at a time.
          dedupeKey: `schedule:${schedule.name}`,
        });
      },
      { reason: 'scheduler_enqueue' },
    );
    logger.info({ schedule: schedule.name, jobType: schedule.job_type }, 'scheduled job enqueued');
  }
}

const QUEUES = ['default', 'integrations', 'notifications'];

async function loop(): Promise<void> {
  while (!shuttingDown) {
    try {
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

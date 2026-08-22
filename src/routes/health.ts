/**
 * Health and readiness.
 *
 * Two endpoints because they answer different questions and have different
 * consequences:
 *
 *   /healthz  -- "is this process alive?" Never touches the database. If it
 *                depended on Postgres, a brief database blip would make the
 *                platform kill and restart healthy containers, turning a small
 *                problem into an outage.
 *
 *   /readyz   -- "can this instance serve traffic?" Checks the database. A
 *                failure here removes the instance from the load balancer
 *                without killing it, so it can rejoin when the dependency
 *                recovers.
 *
 *   /version  -- "which commit is this?" Nothing else. See the note on it
 *                below for why it is public.
 *
 * None of them exposes dependency hostnames or configuration -- health
 * endpoints are public, and they should not be a reconnaissance tool.
 */
import { withServiceContext } from '../db/tenant.js';
import type { FastifyInstance } from 'fastify';
import { appPool, servicePool, usingSeparateServiceRole } from '../db/pool.js';
import { queueStats } from '../jobs/queue.js';
import { logger } from '../lib/logger.js';

const startedAt = Date.now();

/**
 * Render sets these on every build. Read once at module load: they do not
 * change while the process lives, and reading process.env per request would
 * suggest they might.
 */
const commit = process.env['RENDER_GIT_COMMIT'] ?? null;
const branch = process.env['RENDER_GIT_BRANCH'] ?? null;

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({
    status: 'ok',
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  }));

  /**
   * The same fact, in the shape the Settings page asks for.
   *
   * The frontend has always called /api/health and there has never been one --
   * every load of the Firm tab got a 404 and rendered its health panel empty.
   * The infrastructure probes stay unprefixed where the platform expects them;
   * this is the in-app answer, and it reports what the page actually shows:
   * whether the database answers, which driver is serving, and the time as the
   * server sees it.
   */
  app.get('/api/health', async () => {
    let ok = true;
    try {
      const res = await appPool.query('select 1 as ok');
      ok = res.rows.length === 1;
    } catch {
      ok = false;
    }
    return {
      ok,
      driver: 'postgres',
      brand: 'One Contractor Solutions',
      time: new Date().toISOString(),
    };
  });

  /**
   * Which commit is serving this request.
   *
   * This exists because a failed build leaves the PREVIOUS deploy running,
   * health checks green and all -- so "the API is up" has never been evidence
   * that the API is current. Until now the only place the live commit appeared
   * was the Render dashboard, which needs a login and a browser, and an
   * unattended check could therefore never answer the one question it was for.
   *
   * Public, unlike the rest of this file's caution, for a specific reason: the
   * repository is public, so the SHA reveals nothing a reader could not already
   * read. If the repository is ever made private, put this behind auth.
   *
   * Null when running anywhere other than Render -- locally, or in a container
   * built by hand -- rather than a guess or a lie.
   */
  app.get('/version', async () => ({
    commit,
    branch,
    startedAt: new Date(startedAt).toISOString(),
  }));

  app.get('/readyz', async (_req, reply) => {
    const checks: Record<string, string> = {};
    let healthy = true;

    try {
      const res = await appPool.query('select 1 as ok');
      checks['database'] = res.rows.length === 1 ? 'ok' : 'unexpected response';
    } catch (err) {
      healthy = false;
      checks['database'] = 'unreachable';
      logger.error({ err }, 'readiness check: database unreachable');
    }

    if (usingSeparateServiceRole) {
      try {
        await servicePool.query('select 1');
        checks['database_service_role'] = 'ok';
      } catch (err) {
        healthy = false;
        checks['database_service_role'] = 'unreachable';
        logger.error({ err }, 'readiness check: service pool unreachable');
      }
    } else {
      // Not fatal, but it means the ocs_app / ocs_service split is not in
      // effect and background work runs with request-handling credentials.
      checks['database_service_role'] = 'not configured (using DATABASE_URL)';
    }

    if (!healthy) reply.code(503);
    return { status: healthy ? 'ready' : 'not_ready', checks };
  });

  /**
   * Operational snapshot. Unauthenticated on purpose but deliberately dull:
   * job counts by status and nothing tenant-identifying.
   */
  /**
   * Queue depth AND whether anything is draining it.
   *
   * Depth alone is not health. An empty queue with a dead worker looks exactly
   * like an empty queue with a healthy one, and that ambiguity is how scheduled
   * municipal checks stopped firing on the previous build without anyone
   * noticing for months. The heartbeat is what tells them apart.
   *
   * Answers 503 when no worker has checked in, because a system that cannot do
   * background work is not healthy even while it serves pages perfectly.
   */
  app.get('/healthz/queue', async (_req, reply) => {
    try {
      const [jobs, worker] = await Promise.all([
        queueStats(),
        withServiceContext(
          async (tx) =>
            tx.one<{
              alive: boolean; last_seen_at: string | null; started_at: string | null;
              jobs_processed: string | null; last_job_at: string | null; instance_id: string | null;
            }>(
              `select ocs.worker_is_alive('default') as alive,
                      h.last_seen_at, h.started_at, h.jobs_processed,
                      h.last_job_at, h.instance_id
                 from (select 1) as _
                 left join ocs.worker_heartbeats h on h.queue = 'default'`,
            ),
          { reason: 'queue_health' },
        ),
      ]);

      // Heartbeat freshness alone is not health. On 22 Aug 2026 the worker was
      // checking in every fifteen seconds, this endpoint said `ok`, and no job
      // had actually run for two and a half hours because the reaper was
      // itself wedged. A liveness probe that cannot see that is decorative.
      const stuck = await withServiceContext(
        async (tx) =>
          tx.one<{ n: string }>(
            `select count(*)::text as n
               from ocs.jobs
              where status = 'running'
                and locked_at < now() - make_interval(secs => timeout_seconds)`,
          ),
        { reason: 'queue_health_stuck' },
      );
      const stuckCount = Number(stuck?.n ?? 0);

      const alive = worker?.alive === true && stuckCount === 0;

      const body = {
        status: alive ? 'ok' : 'degraded',
        stuckJobs: stuckCount,
        jobs,
        worker: worker?.last_seen_at
          ? {
              alive,
              lastSeenAt: worker.last_seen_at,
              startedAt: worker.started_at,
              jobsProcessed: Number(worker.jobs_processed ?? 0),
              lastJobAt: worker.last_job_at,
              instanceId: worker.instance_id,
            }
          : null,
        note: alive
          ? undefined
          : stuckCount > 0 && worker?.alive === true
            ? `${stuckCount} job(s) hold an expired lock. The worker is alive but ` +
              'work is not draining -- if one of them is system.reap_stuck_jobs, ' +
              'nothing will clear it without intervention.'
            : worker?.last_seen_at
            ? 'A worker has run but has not checked in recently. Scheduled municipal ' +
              'checks, licence reminders and notifications are not being processed.'
            : 'No worker has ever checked in. Nothing is processing background work — ' +
              'confirm the worker service is deployed and WORKER_ENABLED is true.',
      };

      if (!alive) reply.code(503);
      return body;
    } catch (err) {
      logger.error({ err }, 'queue stats failed');
      reply.code(503);
      return { status: 'unavailable' };
    }
  });

  /**
   * Everything that is quietly wrong, in one request.
   *
   * `/healthz` answers "is the process up", `/readyz` answers "can it serve",
   * and neither notices a system that is running perfectly while doing nothing
   * useful -- permits nobody has checked, uploads that never completed, an
   * invoice whose payments do not add up. Those are the failures that cost a
   * client a deadline, and they are invisible to a status code.
   *
   * Every check lives in `ocs.ops_alerts()`, so this endpoint, the
   * `system.integrity_sweep` job and the external watchdog cannot disagree.
   *
   * 503 when anything critical is open, so an uptime monitor can watch it
   * directly. Point the monitor at the RENDER origin, not the Netlify domain:
   * Netlify's SPA fallback answers unproxied paths with HTML and 200, which
   * means a monitor aimed at the app domain reports green during an outage.
   */
  app.get('/healthz/deep', async (_req, reply) => {
    try {
      const [alerts, schedules] = await Promise.all([
        withServiceContext(
          async (tx) =>
            tx.many<{ severity: string; code: string; detail: Record<string, unknown> }>(
              `select severity, code, detail from ocs.ops_alerts()`,
            ),
          { reason: 'health_deep_alerts' },
        ),
        withServiceContext(
          async (tx) =>
            tx.many<{
              name: string; last_status: string | null; consecutive_failures: number;
              last_run_at: string | null; next_run_at: string; overdue: boolean;
            }>(
              `select name, last_status, consecutive_failures, last_run_at, next_run_at,
                      next_run_at < now() - make_interval(secs => interval_seconds) as overdue
                 from ocs.job_schedules
                where is_enabled
                order by name`,
            ),
          { reason: 'health_deep_schedules' },
        ),
      ]);

      const critical = alerts.filter((a) => a.severity === 'critical');
      const body = {
        status: critical.length > 0 ? 'critical' : alerts.length > 0 ? 'warn' : 'ok',
        commit,
        checkedAt: new Date().toISOString(),
        alerts,
        schedules,
      };

      if (critical.length > 0) reply.code(503);
      return body;
    } catch (err) {
      logger.error({ err }, 'deep health check failed');
      reply.code(503);
      return { status: 'unavailable' };
    }
  });
}

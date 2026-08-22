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
import { emailConfigured } from '../services/notifications.js';
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
      /*
       * Whether outbound mail is configured at all -- a boolean, never the key.
       *
       * Invitations and password resets are sent from here, and when no
       * provider is set they fail silently: the account is created, the link is
       * returned to whoever clicked, and the person it was for is told nothing.
       * That has already cost two people their logins. Reporting it here means
       * the hourly contract check sees the moment it starts working, and the
       * moment it ever stops -- an expired or revoked key looks exactly like
       * never having configured one.
       */
      emailConfigured: emailConfigured(),
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

      const alive = worker?.alive === true;

      const body = {
        status: alive ? 'ok' : 'degraded',
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
}

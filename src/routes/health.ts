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
  app.get('/healthz/queue', async (_req, reply) => {
    try {
      return { status: 'ok', jobs: await queueStats() };
    } catch (err) {
      logger.error({ err }, 'queue stats failed');
      reply.code(503);
      return { status: 'unavailable' };
    }
  });
}

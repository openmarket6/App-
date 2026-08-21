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
 * Neither exposes version details, dependency hostnames or configuration --
 * health endpoints are public, and they should not be a reconnaissance tool.
 */
import type { FastifyInstance } from 'fastify';
import { appPool, servicePool, usingSeparateServiceRole } from '../db/pool.js';
import { queueStats } from '../jobs/queue.js';
import { logger } from '../lib/logger.js';

const startedAt = Date.now();

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({
    status: 'ok',
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
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

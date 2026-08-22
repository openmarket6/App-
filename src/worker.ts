/**
 * Background worker entry point.
 *
 * Runs as a separate process from the API. Two reasons:
 *   - A municipal portal that takes 30 seconds must not compete with page loads
 *     for the same request workers.
 *   - The API and the worker can be scaled and restarted independently.
 *
 * Deployed on Render as a Background Worker; runs locally with
 * `npm run dev:worker`.
 */
import { logger } from './lib/logger.js';
import { closePools, usingSeparateServiceRole } from './db/pool.js';
import { registerAllHandlers } from './jobs/handlers/index.js';
import { startWorker, stopWorker } from './jobs/runner.js';
import { env } from './config/env.js';

async function main(): Promise<void> {
  // The worker has no HTTP surface, so it cannot answer /version the way the
  // API does. One line at startup is the equivalent: it puts the commit in the
  // log stream, which is the only place anyone can look.
  logger.info(
    {
      commit: process.env['RENDER_GIT_COMMIT'] ?? null,
      branch: process.env['RENDER_GIT_BRANCH'] ?? null,
    },
    'worker starting',
  );

  if (!env.WORKER_ENABLED) {
    logger.warn('WORKER_ENABLED is false; exiting without processing jobs');
    return;
  }

  if (!usingSeparateServiceRole) {
    logger.warn(
      'DATABASE_SERVICE_URL is not set. Cross-tenant background work requires the ' +
        'ocs_service role; without it, service-context queries will return no rows.',
    );
  }

  registerAllHandlers();

  // SIGTERM is what Render sends before replacing this container. Draining
  // in-flight jobs here is what keeps a deploy from abandoning work mid-flight;
  // anything still running past the grace period is reclaimed by the reaper.
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down worker');
    try {
      await stopWorker();
      await closePools();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during worker shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandled promise rejection in worker');
  });

  await startWorker();
}

main().catch((err: Error) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});

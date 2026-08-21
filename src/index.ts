/**
 * API server.
 *
 * Security middleware is registered before any route, so nothing can be served
 * outside it. Ordering matters: helmet and CORS set response policy, the rate
 * limiter runs before handlers, and the error handler catches everything.
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';

import { env, corsOrigins, isProd } from './config/env.js';
import { logger } from './lib/logger.js';
import { AppError, forbidden } from './lib/errors.js';
import { closePools, usingSeparateServiceRole } from './db/pool.js';

import { healthRoutes } from './routes/health.js';
import { meRoutes } from './routes/me.js';
import { projectRoutes } from './routes/projects.js';
import { permitRoutes } from './routes/permits.js';
import { permitApplicationRoutes } from './routes/permitApplications.js';
import { draftingRoutes } from './routes/drafting.js';
import { documentRoutes } from './routes/documents.js';
import { complianceRoutes } from './routes/compliance.js';
import { messageRoutes } from './routes/messages.js';
import { paymentRoutes } from './routes/payments.js';
import { webhookRoutes } from './routes/webhooks.js';
import { adminRoutes } from './routes/admin.js';
import { municipalIntegrationRoutes } from './routes/municipalIntegration.js';
import { registerAppShell, isApiPath, hasFrontend, htmlContentSecurityPolicy } from './routes/app-shell.js';
import { supervisionRoutes } from './routes/supervision.js';

export async function buildServer() {
  const app = Fastify({
    loggerInstance: logger,
    // Trust the platform proxy so req.ip is the real client, not the load
    // balancer. Rate limiting and audit records depend on this being right.
    trustProxy: true,
    genReqId: (req) => (req.headers['x-request-id'] as string) ?? randomUUID(),
    // Reject oversized JSON early. Files never come through here -- they go
    // direct to storage -- so a large body is a mistake or an attack.
    bodyLimit: 1024 * 1024,
  });

  await app.register(helmet, {
    /**
     * CSP is handled by the onSend hook below, not by helmet.
     *
     * This service serves BOTH JSON and the HTML app shell, and they need
     * different policies. Letting helmet set one while a hook sets another
     * emits two CSP headers, which browsers intersect -- the stricter one wins
     * and the shell's inline script is blocked. One header, chosen per
     * response, is the only arrangement that behaves predictably.
     */
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: isProd ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });

  await app.register(cors, {
    /**
     * Exact-origin allow-list. Never a wildcard, and never a reflected origin:
     * with credentials enabled, reflecting whatever Origin arrives lets any
     * site make authenticated requests on a logged-in user's behalf.
     */
    origin: (origin, cb) => {
      // Same-origin and server-to-server requests send no Origin header.
      if (!origin) return cb(null, true);
      if (corsOrigins.includes(origin)) return cb(null, true);

      // A rejected origin is a client-side problem, so it must surface as 403.
      // A bare Error here would become a 500 and fill error monitoring with
      // noise that looks like the server is broken when it is working exactly
      // as configured.
      logger.warn({ origin }, 'blocked cross-origin request');
      cb(forbidden('Origin not allowed'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'x-company-id', 'idempotency-key', 'x-request-id'],
    exposedHeaders: ['idempotent-replay', 'x-request-id'],
    maxAge: 86_400,
  });

  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    /**
     * Key on the authenticated user when there is one, falling back to IP.
     * IP alone punishes everyone behind one office NAT for a single noisy
     * client, and lets one user rotate addresses to escape the limit.
     *
     * NOTE: this store is per-instance and in-memory. With more than one API
     * instance the effective limit multiplies by the instance count. Move to a
     * shared Redis store before scaling out -- see README "Before production".
     */
    keyGenerator: (req) => req.principal?.userId ?? req.ip,
    // Health checks must never be throttled: throttling them makes the platform
    // think a busy instance is a dead one.
    allowList: (req) => req.url === '/healthz' || req.url === '/readyz',
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
  });

  /**
   * One Content-Security-Policy per response, chosen by content type.
   *
   * JSON gets `default-src 'none'` -- if an API response is ever rendered as a
   * document, nothing in it can execute. HTML gets the app-shell policy, which
   * permits its inline script and style and nothing else off-origin.
   */
  const JSON_CSP =
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-request-id', req.id);

    const type = String(reply.getHeader('content-type') ?? '');
    reply.header(
      'content-security-policy',
      type.includes('text/html') ? htmlContentSecurityPolicy() : JSON_CSP,
    );

    return payload;
  });

  /**
   * Single error handler.
   *
   * Known AppErrors return their message. Anything else returns a generic
   * message with the request id, and the real error goes only to the logs --
   * stack traces and driver messages disclose schema and file paths.
   */
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      if (err.statusCode >= 500) {
        req.log.error({ err, internal: err.internal, requestId: req.id }, err.message);
      } else {
        req.log.info({ code: err.code, requestId: req.id, path: req.url }, err.message);
      }

      reply.code(err.statusCode);
      return {
        error: err.code,
        message: err.expose ? err.message : 'An unexpected error occurred',
        ...(err.details ? { details: err.details } : {}),
        requestId: req.id,
      };
    }

    // Fastify's own validation and parsing errors.
    const fastifyErr = err as { statusCode?: number; message?: string };
    const statusCode = fastifyErr.statusCode;
    if (statusCode && statusCode < 500) {
      req.log.info({ err: fastifyErr.message, requestId: req.id }, 'client error');
      reply.code(statusCode);
      return {
        error: 'bad_request',
        message: fastifyErr.message ?? 'Bad request',
        requestId: req.id,
      };
    }

    req.log.error({ err, requestId: req.id, path: req.url }, 'unhandled error');
    reply.code(500);
    return {
      error: 'internal_error',
      message: 'An unexpected error occurred',
      requestId: req.id,
    };
  });

  /**
   * Unknown paths.
   *
   * API paths get a JSON 404 — serving HTML to a fetch() that expected JSON
   * turns "wrong URL" into a confusing parse error. Everything else falls back
   * to the portal shell, so a bookmarked deep link still opens the app.
   */
  app.setNotFoundHandler((req, reply) => {
    if (!isApiPath(req.url) && hasFrontend() && req.method === 'GET') {
      return reply.sendFile('portal.html');
    }
    reply.code(404);
    return { error: 'not_found', message: `No route for ${req.method} ${req.url}` };
  });

  await app.register(healthRoutes);
  await app.register(meRoutes);
  await app.register(projectRoutes);
  await app.register(permitRoutes);
  await app.register(permitApplicationRoutes);
  await app.register(draftingRoutes);
  await app.register(documentRoutes);
  await app.register(complianceRoutes);
  await app.register(messageRoutes);
  await app.register(paymentRoutes);
  await app.register(webhookRoutes);
  await app.register(adminRoutes);
  await app.register(municipalIntegrationRoutes);
  await app.register(supervisionRoutes);

  // Last: serves the portal and intake form from this same service, so the
  // whole product is one deployment on one origin.
  await registerAppShell(app);

  return app;
}

async function main(): Promise<void> {
  const app = await buildServer();

  if (!usingSeparateServiceRole) {
    logger.warn(
      'DATABASE_SERVICE_URL is not set: background work and webhooks are using ' +
        'the request-handling role. Configure the ocs_service role before production.',
    );
  }

  // Shut down cleanly so in-flight requests finish instead of being cut off
  // mid-response when the platform replaces this container.
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down api');
    try {
      await app.close();
      await closePools();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandled promise rejection');
  });

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'api listening');
}

// Only auto-start when run directly, so tests can import buildServer().
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main().catch((err: Error) => {
    logger.fatal({ err }, 'failed to start api');
    process.exit(1);
  });
}

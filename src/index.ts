/**
 * API server.
 *
 * Security middleware is registered before any route, so nothing can be served
 * outside it. Ordering matters: helmet and CORS set response policy, the rate
 * limiter runs before handlers, and the error handler catches everything.
 */
import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import type { FastifyCorsOptions } from '@fastify/cors';
import { randomUUID } from 'node:crypto';

import { env, corsOrigins, isProd } from './config/env.js';
import { logger } from './lib/logger.js';
import { AppError } from './lib/errors.js';
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
import { registerAppShell, isApiPath, hasFrontend, htmlContentSecurityPolicy, shellFile } from './routes/app-shell.js';
import { compatAuthRoutes } from './routes/compat/auth.js';
import { compatApiRoutes } from './routes/compat/api.js';
import { compatDetailRoutes } from './routes/compat/detail.js';
import { compatCorrectionsRoutes } from './routes/compat/corrections.js';
import { compatInspectionsRoutes } from './routes/compat/inspections.js';
import { compatAdminRoutes } from './routes/compat/admin.js';
import { compatSupportRoutes } from './routes/compat/support.js';
import { compatNotaryRoutes } from './routes/compat/notary.js';
import { compatBillingRoutes } from './routes/compat/billing.js';
import { compatEngineeringRoutes } from './routes/compat/engineering.js';
import { compatDraftingRoutes } from './routes/compat/drafting.js';
import { compatPortalRoutes } from './routes/compat/portal.js';
import { compatProjectsRoutes } from './routes/compat/projects.js';
import { compatComplianceRoutes } from './routes/compat/compliance.js';
import { compatDocumentsRoutes } from './routes/compat/documents.js';
import { compatGeneratedDocumentsRoutes } from './routes/compat/generated-documents.js';
import { compatMailingRoutes } from './routes/compat/mailings.js';
import { compatInvoiceRoutes } from './routes/compat/invoices.js';
import { compatSupervisionRoutes } from './routes/compat/supervision.js';
import { supervisionRoutes } from './routes/supervision.js';
import { publicSiteRoutes } from './routes/public-site.js';

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

  /**
   * CORS.
   *
   * Registered as a dynamic delegate rather than a static option object so the
   * request is available: that is what lets same-origin requests be recognised
   * as such.
   *
   * Why that matters. The React bundle's <script> and <link> tags carry the
   * `crossorigin` attribute, which makes the browser fetch those assets in CORS
   * mode even when they come from the very same origin as the page. With a
   * plain allow-list the app's own origin is not on it, the asset requests are
   * rejected, and the application loads a blank page with its stylesheet and
   * bundle 403'd. Comparing Origin against the request's own host fixes it
   * without widening anything: a same-origin request is not a cross-origin
   * request in any meaningful sense.
   */
  await app.register(cors, (instance: unknown) => {
    void instance;
    return (
      req: FastifyRequest,
      callback: (err: Error | null, options: FastifyCorsOptions) => void,
    ) => {
      const origin = req.headers.origin;

      const allowed = (ok: boolean) =>
        callback(null, {
          origin: ok,
          credentials: true,
          methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
          allowedHeaders: [
            'authorization', 'content-type', 'x-company-id',
            'idempotency-key', 'x-request-id',
          ],
          exposedHeaders: ['idempotent-replay', 'x-request-id'],
          maxAge: 86_400,
        });

      // No Origin header: a same-origin navigation, or a server-to-server call.
      if (!origin) return allowed(true);

      // The page's own origin, reached in CORS mode because of `crossorigin`.
      const host = req.headers.host;
      if (host) {
        const proto =
          (req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol ?? 'http';
        if (origin === `${proto}://${host}` || origin === `https://${host}` || origin === `http://${host}`) {
          return allowed(true);
        }
      }

      if (corsOrigins.includes(origin)) return allowed(true);

      // A genuinely disallowed origin. Reject the CORS handshake rather than
      // throwing, so the browser reports a CORS failure and the server does not
      // log a 500 for what is a correctly-enforced policy.
      logger.warn({ origin, path: req.url }, 'blocked cross-origin request');
      return allowed(false);
    };
  });

  // Required by the /api/auth refresh-cookie flow the existing frontend uses.
  // Registered before the routes so reply.setCookie is decorated by the time
  // any handler runs.
  await app.register(cookie);

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
    allowList: (req) =>
      req.url === '/healthz' || req.url === '/readyz' || req.url === '/version',
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

    /*
     * A route that already chose a policy keeps it.
     *
     * The app shell needs a policy permissive enough to run itself. A generated
     * legal instrument does not: it is our template wrapped around values
     * somebody typed into a form, and it should be served under the tightest
     * policy that still renders. Handing it the shell's policy because both are
     * text/html would be applying the loosest rule to the least trusted page.
     */
    if (!reply.getHeader('content-security-policy')) {
      const type = String(reply.getHeader('content-type') ?? '');
      reply.header(
        'content-security-policy',
        type.includes('text/html') ? htmlContentSecurityPolicy() : JSON_CSP,
      );
    }

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
      return reply.sendFile(shellFile());
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

  // Compatibility layer for the existing React frontend: same /api contract,
  // backed by Postgres instead of Netlify Blobs.
  await app.register(publicSiteRoutes);
  await app.register(compatAuthRoutes);
  await app.register(compatCorrectionsRoutes);
  await app.register(compatInspectionsRoutes);
  await app.register(compatAdminRoutes);
  await app.register(compatSupportRoutes);
  await app.register(compatNotaryRoutes);
  await app.register(compatBillingRoutes);
  await app.register(compatEngineeringRoutes);
  await app.register(compatDraftingRoutes);
  await app.register(compatPortalRoutes);
  await app.register(compatProjectsRoutes);
  await app.register(compatComplianceRoutes);
  await app.register(compatDocumentsRoutes);
  await app.register(compatGeneratedDocumentsRoutes);
  await app.register(compatMailingRoutes);
  await app.register(compatInvoiceRoutes);
  await app.register(compatSupervisionRoutes);
  await app.register(compatApiRoutes);
  await app.register(compatDetailRoutes);

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

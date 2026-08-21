/**
 * Serving the frontend from the API.
 *
 * The portal and intake form are served by this same service, so the whole
 * product is ONE deployment on ONE domain. That removes the two things most
 * likely to go wrong in a split setup:
 *
 *   - CORS. Same origin means the browser never preflights and there is no
 *     allow-list to keep in step with a changing frontend URL.
 *   - Drift. The frontend and the API it talks to can never be different
 *     versions, because they ship together.
 *
 * The files stay self-contained single-page documents, so they can ALSO still
 * be dropped straight onto Netlify if the frontend is ever split out again.
 *
 * CSP: the API's global policy is `default-src 'none'`, which is right for JSON
 * and would block these pages entirely — they carry inline <style> and
 * <script>. The hook below replaces the header for HTML responses only, so the
 * JSON endpoints keep the strict policy.
 */
import type { FastifyInstance } from 'fastify';

/**
 * Fastify's instance type is parameterised by the logger implementation. The
 * server is built with a concrete pino instance, so the default-parameterised
 * `FastifyInstance` does not match it. Accepting the any-parameterised form
 * here keeps the signature honest without threading five generics through a
 * function that only calls addHook, register and get.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFastifyInstance = FastifyInstance<any, any, any, any, any>;
import fastifyStatic from '@fastify/static';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../public');

/**
 * Policy for the app pages.
 *
 * `unsafe-inline` is required because these are deliberately single-file
 * documents; the alternative is splitting each into three files and losing the
 * drag-and-drop deployability that makes them useful. Everything else stays
 * locked down: no external scripts, no framing, no form posts off-origin.
 *
 * connect-src names the Supabase origin explicitly rather than allowing all of
 * https:, so the page can reach auth and storage and nothing else.
 */
export function htmlContentSecurityPolicy(): string {
  const supabase = env.SUPABASE_URL ? new URL(env.SUPABASE_URL).origin : '';

  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    // data: for inline icons, blob: for locally captured photos before upload,
    // and the Supabase origin for signed image URLs.
    `img-src 'self' data: blob:${supabase ? ' ' + supabase : ''}`,
    `connect-src 'self'${supabase ? ' ' + supabase : ''}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}

/**
 * Paths that must never fall back to the HTML shell.
 *
 * A mistyped API endpoint has to return a JSON 404. Serving a page of HTML to a
 * fetch() that expected JSON produces a parse error at the call site and hides
 * the real problem, which is that the URL was wrong.
 */
export function isApiPath(url: string): boolean {
  return url.startsWith('/v1/') || url.startsWith('/healthz') || url.startsWith('/readyz');
}

export function hasFrontend(): boolean {
  return existsSync(PUBLIC_DIR);
}

/**
 * Registered directly on the root instance rather than through app.register().
 *
 * @fastify/static is wrapped with fastify-plugin, so registering it here puts
 * `reply.sendFile` on the root scope where the shared not-found handler in
 * index.ts can reach it. Wrapping this in an encapsulated plugin would hide
 * that decorator, and a second not-found handler at the same prefix is an
 * error in Fastify anyway.
 */
export async function registerAppShell(app: AnyFastifyInstance): Promise<void> {
  if (!hasFrontend()) {
    logger.warn({ dir: PUBLIC_DIR }, 'public directory not found; frontend will not be served');
    return;
  }

  // The CSP header itself is set centrally in index.ts, because two CSP headers
  // on one response are intersected by the browser and the stricter one wins --
  // which silently cancelled the 'unsafe-inline' these pages need. Only the
  // cache policy is set here.
  app.addHook('onSend', async (_req, reply, payload) => {
    const type = String(reply.getHeader('content-type') ?? '');
    if (type.includes('text/html')) {
      // The app shell must not be cached: a stale copy pointed at a changed API
      // is the classic "it works for me" bug after a deploy.
      reply.header('cache-control', 'no-cache, must-revalidate');
    }
    return payload;
  });

  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: '/',
    index: false,
    maxAge: '1h',
    serveDotFiles: false,
  });

  app.get('/', async (_req, reply) => reply.sendFile('portal.html'));
  app.get('/intake', async (_req, reply) => reply.sendFile('permit-intake.html'));

  logger.info({ dir: PUBLIC_DIR }, 'serving frontend from the API');
}

/**
 * Route helpers: validation and consistent error shaping.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeAny, TypeOf } from 'zod';
import { logger } from './logger.js';
import { badRequest } from './errors.js';

/**
 * Parse and validate untrusted input.
 *
 * Every route body, query and param goes through a Zod schema. Beyond catching
 * typos, this is what stops unexpected fields reaching a query builder: the
 * parsed value contains only declared keys, so a client cannot smuggle
 * `company_id` or `role` into an update by adding it to the JSON.
 */
/**
 * Fields a caller sent that the schema does not know about.
 *
 * Zod strips unknown keys and reports success, which is the single most
 * expensive behaviour in this codebase. It has now caused three separate
 * production faults, each with the same shape: the screen sends a field, the
 * server returns 200, the value is discarded, and the damage appears somewhere
 * else entirely.
 *
 *   - a compliance reviewer corrected an expiry date and watched it save and
 *     vanish, so every renewal warning was computed from the old day
 *   - clientAdmin was dropped from an invitation, so a contractor's owner could
 *     never add their own crew and the 403 named a role nobody could hold
 *   - valuationCents went to the permit endpoint, which does not take it
 *
 * None of these could be seen from the response. So instead of tightening every
 * schema at once -- which would turn a silent drop into a hard 400 for callers
 * we have not audited yet -- unknown keys are LOGGED, loudly, with the route
 * that received them. That makes the whole class visible in one log search
 * without breaking anything that works today.
 */
function unknownKeys(schema: ZodTypeAny, value: unknown): string[] {
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  if (!shape || typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const known = new Set(Object.keys(shape));
  return Object.keys(value as Record<string, unknown>).filter((k) => !known.has(k));
}

export function parse<S extends ZodTypeAny>(
  schema: S,
  value: unknown,
  what = 'request',
): TypeOf<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest(`Invalid ${what}`, {
      issues: result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }

  const extra = unknownKeys(schema, value);
  if (extra.length > 0) {
    logger.warn(
      { what, ignoredFields: extra },
      'request carried fields this endpoint does not accept; they were DISCARDED',
    );
  }

  return result.data;
}

/** Client IP, honouring the proxy header Render sets. */
export function clientIp(req: FastifyRequest): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.ip || null;
}

export function userAgent(req: FastifyRequest): string | null {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua.slice(0, 500) : null;
}

/** Single-value header accessor (Fastify may hand back an array). */
export function header(req: FastifyRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function created<T>(reply: FastifyReply, body: T): T {
  reply.code(201);
  return body;
}

export function noContent(reply: FastifyReply): null {
  reply.code(204);
  return null;
}

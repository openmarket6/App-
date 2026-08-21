/**
 * Route helpers: validation and consistent error shaping.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeAny, TypeOf } from 'zod';
import { badRequest } from './errors.js';

/**
 * Parse and validate untrusted input.
 *
 * Every route body, query and param goes through a Zod schema. Beyond catching
 * typos, this is what stops unexpected fields reaching a query builder: the
 * parsed value contains only declared keys, so a client cannot smuggle
 * `company_id` or `role` into an update by adding it to the JSON.
 */
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

/**
 * Typed application errors.
 *
 * The split between `message` (safe to return) and `internal` (logged only)
 * exists so that a handler can be specific in the logs without leaking schema
 * details, row ids or upstream error text to whoever made the request.
 */

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;
  readonly internal?: unknown;
  readonly expose: boolean;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    opts: { details?: unknown; internal?: unknown; expose?: boolean } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = opts.details;
    this.internal = opts.internal;
    this.expose = opts.expose ?? statusCode < 500;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'bad_request', message, { details });

export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'unauthorized', message);

export const forbidden = (message = 'You do not have access to this resource') =>
  new AppError(403, 'forbidden', message);

/**
 * Used for "exists but not yours" as well as "does not exist".
 *
 * Returning 404 rather than 403 for another tenant's record is deliberate: a
 * 403 confirms the id is real, which is itself a small cross-tenant leak. The
 * caller cannot distinguish the two cases, so they learn nothing.
 */
export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);

export const conflict = (message: string, details?: unknown) =>
  new AppError(409, 'conflict', message, { details });

export const unprocessable = (message: string, details?: unknown) =>
  new AppError(422, 'unprocessable_entity', message, { details });

export const tooManyRequests = (message = 'Too many requests') =>
  new AppError(429, 'too_many_requests', message);

export const internalError = (internal?: unknown) =>
  new AppError(500, 'internal_error', 'An unexpected error occurred', { internal, expose: false });

export const serviceUnavailable = (message: string, internal?: unknown) =>
  new AppError(503, 'service_unavailable', message, { internal });

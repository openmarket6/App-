/**
 * Environment configuration.
 *
 * Every value the process needs is declared, validated and typed here, and the
 * validation runs at startup rather than at first use. A missing STRIPE_
 * WEBHOOK_SECRET should stop the deploy, not surface three days later as a
 * silently unverified webhook.
 */
import { z } from 'zod';

const isProd = process.env.NODE_ENV === 'production';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /** Public URL of this API, used to build webhook and callback URLs. */
  API_BASE_URL: z.string().url().default('http://localhost:8080'),
  /** Where the Netlify frontend lives; used in notification links. */
  APP_BASE_URL: z.string().url().default('http://localhost:5173'),

  // ---------------------------------------------------------------------------
  // Database
  //
  // Two connection strings on purpose: DATABASE_URL connects as `ocs_app` and
  // can only ever see one tenant, DATABASE_SERVICE_URL connects as
  // `ocs_service` and may cross tenants for background work. See 0008_rls.sql.
  // ---------------------------------------------------------------------------
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SERVICE_URL: z.string().min(1).optional(),
  /**
   * Owner-privileged connection used only by `npm run migrate`. DDL and role
   * creation need privileges the runtime roles deliberately lack.
   */
  DATABASE_MIGRATION_URL: z.string().min(1).optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  // ---------------------------------------------------------------------------
  // Supabase (auth + storage)
  // ---------------------------------------------------------------------------
  SUPABASE_URL: z.string().url().optional(),
  /**
   * Server-side key used to mint signed upload/download URLs. This is a secret:
   * it bypasses storage policies. It must never be sent to the browser.
   */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  /** Legacy HS256 JWT secret. Leave unset when using asymmetric (JWKS) keys. */
  SUPABASE_JWT_SECRET: z.string().min(1).optional(),
  SUPABASE_STORAGE_BUCKET: z.string().min(1).default('ocs-documents'),
  /** Expected `aud` claim on access tokens. */
  SUPABASE_JWT_AUDIENCE: z.string().default('authenticated'),

  // ---------------------------------------------------------------------------
  // Payments
  // ---------------------------------------------------------------------------
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),

  // ---------------------------------------------------------------------------
  // Outbound email
  //
  // Optional. When unset, notifications are still created in-app and their
  // delivery rows are marked 'failed' with a clear reason -- never silently
  // dropped, and never reported as sent.
  // ---------------------------------------------------------------------------
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().email().optional(),

  // ---------------------------------------------------------------------------
  // Security
  // ---------------------------------------------------------------------------
  /** Comma-separated exact origins. Never "*" -- see buildCorsOptions. */
  CORS_ALLOWED_ORIGINS: z.string().default('http://localhost:5173'),
  /** pgcrypto key for municipal portal credentials (integration_credentials). */
  INTEGRATION_ENCRYPTION_KEY: z.string().min(16).optional(),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),

  // ---------------------------------------------------------------------------
  // Uploads
  // ---------------------------------------------------------------------------
  /** Refused above this size. Default 100 MB -- drawing sets are large. */
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(100 * 1024 * 1024),
  /** How long a soft-deleted document is recoverable before storage purge. */
  DOCUMENT_RETENTION_DAYS: z.coerce.number().int().positive().default(30),

  // ---------------------------------------------------------------------------
  // Worker
  // ---------------------------------------------------------------------------
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  WORKER_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v === 'true' || v === '1'),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    // Print only the variable NAMES and the reason. Never the value -- this
    // output goes to deploy logs, which are far more widely readable than the
    // secrets themselves.
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const env = parsed.data;

  // Fail the boot rather than run a production deploy that is quietly degraded.
  if (env.NODE_ENV === 'production') {
    const required: Array<[keyof Env, string]> = [
      ['DATABASE_SERVICE_URL', 'background jobs and webhooks cannot run without the service role'],
      ['SUPABASE_URL', 'authentication cannot be verified'],
      ['SUPABASE_SERVICE_ROLE_KEY', 'file uploads and downloads cannot be signed'],
      ['INTEGRATION_ENCRYPTION_KEY', 'municipal credentials would be unencryptable'],
    ];
    const missing = required.filter(([k]) => !env[k]).map(([k, why]) => `  - ${k}: ${why}`);
    if (missing.length > 0) {
      throw new Error(`Missing required production configuration:\n${missing.join('\n')}`);
    }

    if (env.CORS_ALLOWED_ORIGINS.split(',').some((o) => o.trim() === '*')) {
      throw new Error(
        'CORS_ALLOWED_ORIGINS may not contain "*" in production: ' +
          'credentialed requests from any origin would be permitted.',
      );
    }
  }

  return env;
}

export const env = load();

export const corsOrigins = env.CORS_ALLOWED_ORIGINS.split(',')
  .map((o) => o.trim())
  .filter(Boolean);

/** True when payments are fully configured; routes 503 rather than half-work. */
export const paymentsConfigured = Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);

/** True when file storage is fully configured. */
export const storageConfigured = Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);

export { isProd };

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
  // Publishable, and safe to send to a browser -- that is what it is for. It is
  // read here rather than hard-coded into the frontend so a key rotation is a
  // configuration change rather than a rebuild and redeploy of the app.
  STRIPE_PUBLISHABLE_KEY: z.string().min(1).optional(),

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
  // Physical mail
  //
  // Notices to Owner have to be SERVED, and service has to be provable. Lob
  // posts certified mail with return receipt and reports delivery back over a
  // webhook, which is the proof.
  //
  // Optional, like everything else here: unconfigured, the mail endpoints
  // answer 503 with a sentence rather than silently recording letters that were
  // never posted. A mailing that exists in our database and not in the postal
  // system is worse than no mailing, because somebody will rely on it.
  // ---------------------------------------------------------------------------
  LOB_API_KEY: z.string().min(1).optional(),
  LOB_WEBHOOK_SECRET: z.string().min(1).optional(),
  /*
   * Where the green card and the return-to-sender come back to. Held as
   * configuration rather than derived from a company record: this is OCS's own
   * return address, it is the same on every letter, and a per-tenant value
   * would mean a contractor's typo could lose the proof of service.
   */
  MAIL_RETURN_NAME: z.string().min(1).optional(),
  MAIL_RETURN_LINE1: z.string().min(1).optional(),
  MAIL_RETURN_LINE2: z.string().optional(),
  MAIL_RETURN_CITY: z.string().min(1).optional(),
  MAIL_RETURN_STATE: z.string().length(2).optional(),
  MAIL_RETURN_POSTAL_CODE: z.string().min(5).optional(),

  // ---------------------------------------------------------------------------
  // Native authentication (the /api/auth contract the existing frontend uses)
  //
  // Two separate secrets on purpose: an access token leaked from a browser must
  // not be usable to mint refresh tokens, and the two have very different
  // lifetimes and blast radii.
  // ---------------------------------------------------------------------------
  AUTH_JWT_SECRET: z.string().min(32).optional(),
  AUTH_REFRESH_SECRET: z.string().min(32).optional(),
  /** Access token lifetime. Short, because it cannot be revoked once issued. */
  AUTH_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  /** Refresh lifetime. Revocable, so it can safely be much longer. */
  AUTH_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),

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

  /*
   * Fail the boot rather than run a production deploy that is quietly degraded.
   *
   * Only what EVERY process needs. This list used to include the auth secrets,
   * which the API needs and the worker does not -- and the worker, having no
   * HTTP surface, has no health check either. So it crashed on boot, Render
   * reported the deploy "live" because the BUILD succeeded, and eleven
   * scheduled jobs silently never ran for seventeen hours. Nothing anywhere
   * said so.
   *
   * Per-process requirements now belong to the process. See assertApiConfig
   * below, called by the API entrypoint. A requirement one process invented can
   * no longer kill another.
   */
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

/**
 * What only the API needs.
 *
 * Called by the API entrypoint, not at import time, so the worker -- which
 * serves no sign-ins and issues no tokens -- is not killed by a requirement
 * that has nothing to do with it.
 */
export function assertApiConfig(): void {
  if (env.NODE_ENV !== 'production') return;
  const required: Array<[keyof Env, string]> = [
    ['AUTH_JWT_SECRET', 'the frontend cannot sign in without it'],
    ['AUTH_REFRESH_SECRET', 'sessions cannot be refreshed without it'],
  ];
  const missing = required.filter(([k]) => !env[k]).map(([k, why]) => `  - ${k}: ${why}`);
  if (missing.length > 0) {
    throw new Error(`Missing required API configuration:\n${missing.join('\n')}`);
  }
}

/**
 * Everything optional that is NOT configured, in words.
 *
 * Logged once at boot by both processes. "Quietly degraded" is the failure
 * this whole file exists to prevent, and an integration that is simply absent
 * is the quietest degradation there is: nothing errors, the feature just never
 * happens, and the first person to notice is a customer.
 */
export function missingIntegrations(): string[] {
  const out: string[] = [];
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    out.push('email (RESEND_API_KEY, EMAIL_FROM) — no invitations, reminders or notifications are delivered');
  }
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
    out.push('payments (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET) — no subscriptions, invoices or card payments');
  }
  if (!env.LOB_API_KEY || !env.LOB_WEBHOOK_SECRET) {
    out.push('physical mail (LOB_API_KEY, LOB_WEBHOOK_SECRET) — notices cannot be posted');
  }
  if (returnAddress() === null) {
    out.push('return address (MAIL_RETURN_*) — certified mail cannot prove service without one');
  }
  return out;
}

export const corsOrigins = env.CORS_ALLOWED_ORIGINS.split(',')
  .map((o) => o.trim())
  .filter(Boolean);

/** True when payments are fully configured; routes 503 rather than half-work. */
export const paymentsConfigured = Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);

/** True when file storage is fully configured. */
export const storageConfigured = Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);

/**
 * True when mail can actually be posted AND its delivery heard back.
 *
 * Both halves are required. An API key with no webhook secret would let us send
 * certified mail and never learn whether it arrived -- which is precisely the
 * fact the certified mail was bought to establish.
 */
export const mailConfigured = Boolean(env.LOB_API_KEY && env.LOB_WEBHOOK_SECRET);

/** OCS's own return address, or null when it has not been configured. */
export function returnAddress(): {
  name: string; line1: string; line2: string | null;
  city: string; state: string; postalCode: string;
} | null {
  if (
    !env.MAIL_RETURN_NAME || !env.MAIL_RETURN_LINE1 || !env.MAIL_RETURN_CITY ||
    !env.MAIL_RETURN_STATE || !env.MAIL_RETURN_POSTAL_CODE
  ) {
    return null;
  }
  return {
    name: env.MAIL_RETURN_NAME,
    line1: env.MAIL_RETURN_LINE1,
    line2: env.MAIL_RETURN_LINE2 ?? null,
    city: env.MAIL_RETURN_CITY,
    state: env.MAIL_RETURN_STATE.toUpperCase(),
    postalCode: env.MAIL_RETURN_POSTAL_CODE,
  };
}

/** True when native email/password sign-in is available. */
export const nativeAuthConfigured = Boolean(env.AUTH_JWT_SECRET && env.AUTH_REFRESH_SECRET);

export { isProd };

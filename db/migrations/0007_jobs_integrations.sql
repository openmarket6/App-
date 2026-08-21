-- =============================================================================
-- 0007  Background job queue, schedules, and external integration state
-- =============================================================================

create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- jobs -- a Postgres-backed work queue.
--
-- Why Postgres and not SQS/Redis: the job and the data it mutates commit in the
-- SAME transaction. Enqueueing a "notify the contractor" job alongside the
-- permit status update means the two cannot disagree -- either both happen or
-- neither does. With an external broker the classic bug is a job that fires for
-- a transaction that later rolled back, or a status change whose notification
-- silently vanished.
--
-- Claiming uses FOR UPDATE SKIP LOCKED, so N workers pull disjoint jobs without
-- coordinating and a crashed worker's rows unlock when its transaction dies.
-- -----------------------------------------------------------------------------

create type ocs.job_status as enum (
  'queued',
  'running',
  'succeeded',
  'failed',      -- will be retried
  'dead',        -- retries exhausted; needs a human
  'cancelled'
);

create table ocs.jobs (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid references ocs.companies (id) on delete cascade,

  queue         text not null default 'default',
  job_type      text not null,
  payload       jsonb not null default '{}'::jsonb,

  status        ocs.job_status not null default 'queued',
  priority      int not null default 100,     -- lower runs first

  run_at        timestamptz not null default now(),
  attempts      int not null default 0,
  max_attempts  int not null default 5 check (max_attempts >= 1),

  -- Set when a worker claims the job. `locked_at` lets a reaper reclaim jobs
  -- from a worker that died mid-run without releasing its lock.
  locked_at     timestamptz,
  locked_by     text,
  -- Wall-clock budget for one attempt; the reaper uses it to decide "stuck".
  timeout_seconds int not null default 300 check (timeout_seconds > 0),

  last_error    text,
  error_count   int not null default 0,

  -- Optional uniqueness. Setting a dedupe_key makes enqueue idempotent, so
  -- "check this permit's status" cannot pile up 40 duplicate jobs.
  dedupe_key    text,

  result        jsonb,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz
);

-- The claim query's covering index: "queued, due now, best priority first".
create index jobs_claim_idx on ocs.jobs (queue, priority, run_at)
  where status in ('queued', 'failed');
create index jobs_stuck_idx on ocs.jobs (locked_at) where status = 'running';
create index jobs_dead_idx on ocs.jobs (finished_at desc) where status = 'dead';
create index jobs_company_idx on ocs.jobs (company_id, created_at desc);
create unique index jobs_dedupe_key
  on ocs.jobs (queue, dedupe_key)
  where dedupe_key is not null and status in ('queued', 'running', 'failed');

-- -----------------------------------------------------------------------------
-- job_schedules -- recurring work (the "scheduled functions" replacement).
--
-- The worker polls this table rather than relying on a platform cron trigger.
-- That keeps scheduling portable: it behaves identically on Render, on a laptop,
-- or anywhere else the worker runs, with no hosting-specific configuration.
-- -----------------------------------------------------------------------------

create table ocs.job_schedules (
  id              uuid primary key default gen_random_uuid(),
  name            text not null unique,
  job_type        text not null,
  queue           text not null default 'default',
  payload         jsonb not null default '{}'::jsonb,

  interval_seconds int not null check (interval_seconds >= 60),
  is_enabled      boolean not null default true,

  last_run_at     timestamptz,
  next_run_at     timestamptz not null default now(),
  last_status     text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index job_schedules_due_idx on ocs.job_schedules (next_run_at) where is_enabled;

create trigger job_schedules_set_updated_at
  before update on ocs.job_schedules
  for each row execute function ocs.set_updated_at();

-- -----------------------------------------------------------------------------
-- integration_credentials -- per-company logins for municipal portals.
--
-- Some Florida jurisdictions have no API; we hold the contractor's portal
-- credentials to check status on their behalf. Those are encrypted at rest with
-- pgcrypto using a key held in the environment (INTEGRATION_ENCRYPTION_KEY),
-- NOT in this database -- so a database dump alone does not yield usable
-- credentials. The API never returns the decrypted value in any response.
-- -----------------------------------------------------------------------------

create table ocs.integration_credentials (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references ocs.companies (id) on delete cascade,
  municipality_id uuid references ocs.municipalities (id) on delete cascade,

  integration_key text not null,          -- adapter this belongs to
  username        text,
  -- pgp_sym_encrypt output. Decrypted only inside the worker, at use time.
  secret_encrypted bytea,
  extra           jsonb not null default '{}'::jsonb,   -- non-secret config only

  is_active       boolean not null default true,
  last_verified_at timestamptz,
  last_error      text,

  created_by      uuid references ocs.app_users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  unique (company_id, integration_key, municipality_id)
);

create index integration_credentials_company_idx
  on ocs.integration_credentials (company_id) where is_active;

create trigger integration_credentials_set_updated_at
  before update on ocs.integration_credentials
  for each row execute function ocs.set_updated_at();

-- -----------------------------------------------------------------------------
-- integration_runs -- one row per outbound call to a municipality or vendor.
--
-- This is the audit trail for "did we actually check this permit, and what came
-- back". It also feeds rate limiting: the adapter reads recent rows for a
-- jurisdiction before deciding whether it is allowed to call again.
--
-- Only response METADATA is stored. Response bodies can contain applicant
-- personal data, so we keep status, timing and a short excerpt -- not the
-- whole document.
-- -----------------------------------------------------------------------------

create table ocs.integration_runs (
  id              bigserial primary key,
  company_id      uuid references ocs.companies (id) on delete cascade,
  municipality_id uuid references ocs.municipalities (id) on delete set null,
  permit_id       uuid references ocs.permits (id) on delete cascade,
  job_id          uuid references ocs.jobs (id) on delete set null,

  integration_key text not null,
  operation       text not null,          -- e.g. 'check_status'
  method          ocs.integration_method not null default 'api',

  outcome         text not null
                    check (outcome in ('success', 'no_change', 'not_found',
                                       'auth_failed', 'rate_limited', 'timeout',
                                       'error', 'skipped')),
  http_status     int,
  duration_ms     int,
  attempt         int not null default 1,

  detected_status text,                   -- status parsed out of the response
  error_message   text,
  response_excerpt text,                  -- truncated, metadata only

  created_at      timestamptz not null default now()
);

create index integration_runs_permit_idx
  on ocs.integration_runs (permit_id, created_at desc);
create index integration_runs_municipality_idx
  on ocs.integration_runs (municipality_id, created_at desc);
create index integration_runs_company_idx on ocs.integration_runs (company_id, created_at desc);
create index integration_runs_failures_idx on ocs.integration_runs (created_at desc)
  where outcome not in ('success', 'no_change');

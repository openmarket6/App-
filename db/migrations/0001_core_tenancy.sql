-- =============================================================================
-- 0001  Core tenancy: schema, session accessors, companies, users, audit
-- =============================================================================
-- All application tables live in the `ocs` schema, NOT `public`. Supabase's
-- auto-generated PostgREST API only exposes `public` by default, so keeping our
-- tables out of it means an anon/service key alone cannot reach them over HTTP.
-- The only path to this data is through our API, which sets tenant context and
-- is subject to the row-level security policies defined in 0008.
-- =============================================================================

create schema if not exists ocs;

-- -----------------------------------------------------------------------------
-- Session accessors.
--
-- The API opens a transaction per request and issues:
--     set local ocs.company_id = '<uuid>';
--     set local ocs.user_id    = '<uuid>';
--     set local ocs.platform_role = 'none'|'staff'|'admin';
--
-- These read that context. Every one of them FAILS CLOSED: when the setting is
-- absent or blank they return NULL, and `company_id = NULL` is never true, so an
-- un-scoped connection sees zero rows rather than every row.
-- -----------------------------------------------------------------------------

create or replace function ocs.current_company_id() returns uuid
  language sql stable
  set search_path = ocs, pg_temp
as $$
  select nullif(current_setting('ocs.company_id', true), '')::uuid
$$;

create or replace function ocs.current_user_id() returns uuid
  language sql stable
  set search_path = ocs, pg_temp
as $$
  select nullif(current_setting('ocs.user_id', true), '')::uuid
$$;

create or replace function ocs.current_platform_role() returns text
  language sql stable
  set search_path = ocs, pg_temp
as $$
  select coalesce(nullif(current_setting('ocs.platform_role', true), ''), 'none')
$$;

create or replace function ocs.is_platform_staff() returns boolean
  language sql stable
  set search_path = ocs, pg_temp
as $$
  select ocs.current_platform_role() in ('staff', 'admin')
$$;

-- Shared updated_at trigger.
create or replace function ocs.set_updated_at() returns trigger
  language plpgsql
  set search_path = ocs, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

-- Internal One Contractor Solutions employees. `none` = external contractor user.
create type ocs.platform_role as enum ('none', 'staff', 'admin');

-- A user's role within one contractor company.
create type ocs.company_role as enum ('owner', 'admin', 'member', 'viewer');

create type ocs.company_status as enum ('active', 'suspended', 'closed');

-- -----------------------------------------------------------------------------
-- companies -- the tenant boundary. Every tenant-owned row in this database
-- carries a company_id pointing here.
-- -----------------------------------------------------------------------------

create table ocs.companies (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (length(btrim(name)) > 0),
  legal_name      text,
  status          ocs.company_status not null default 'active',

  -- Florida contractor identifiers
  license_number  text,
  federal_ein     text,

  phone           text,
  email           text,
  address_line1   text,
  address_line2   text,
  city            text,
  state           text not null default 'FL',
  postal_code     text,

  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

create index companies_status_idx on ocs.companies (status) where deleted_at is null;

create trigger companies_set_updated_at
  before update on ocs.companies
  for each row execute function ocs.set_updated_at();

-- -----------------------------------------------------------------------------
-- app_users -- one row per human. Identity/passwords/MFA live in Supabase Auth;
-- `auth_user_id` is the link to auth.users. We never store password material.
-- -----------------------------------------------------------------------------

create table ocs.app_users (
  id             uuid primary key default gen_random_uuid(),
  auth_user_id   uuid unique,             -- Supabase auth.users.id
  email          text not null,
  full_name      text,
  phone          text,
  platform_role  ocs.platform_role not null default 'none',
  is_active      boolean not null default true,
  last_seen_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);

create unique index app_users_email_key on ocs.app_users (lower(email));
create index app_users_platform_role_idx on ocs.app_users (platform_role)
  where platform_role <> 'none';

create trigger app_users_set_updated_at
  before update on ocs.app_users
  for each row execute function ocs.set_updated_at();

-- -----------------------------------------------------------------------------
-- company_memberships -- which users belong to which company, and as what.
-- This is the table the API consults to decide what company context a request
-- is allowed to open.
-- -----------------------------------------------------------------------------

create table ocs.company_memberships (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references ocs.companies (id) on delete cascade,
  user_id      uuid not null references ocs.app_users (id) on delete cascade,
  role         ocs.company_role not null default 'member',
  invited_by   uuid references ocs.app_users (id),
  invited_at   timestamptz,
  accepted_at  timestamptz,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  unique (company_id, user_id)
);

create index company_memberships_user_idx on ocs.company_memberships (user_id)
  where is_active;
create index company_memberships_company_idx on ocs.company_memberships (company_id)
  where is_active;

create trigger company_memberships_set_updated_at
  before update on ocs.company_memberships
  for each row execute function ocs.set_updated_at();

-- -----------------------------------------------------------------------------
-- audit_log -- append-only record of consequential actions.
--
-- Append-only is enforced two ways: the RLS policies in 0008 grant INSERT and
-- SELECT but never UPDATE or DELETE, and the API role is granted only those two
-- privileges. company_id is nullable because some events (platform admin login,
-- cross-tenant admin actions) are not scoped to a single tenant.
-- -----------------------------------------------------------------------------

create table ocs.audit_log (
  id            bigserial primary key,
  company_id    uuid references ocs.companies (id) on delete set null,
  actor_user_id uuid references ocs.app_users (id) on delete set null,
  actor_email   text,                      -- denormalised: survives user deletion
  action        text not null,             -- e.g. 'permit.status_changed'
  entity_type   text,                      -- e.g. 'permit'
  entity_id     uuid,
  summary       text,
  before_data   jsonb,
  after_data    jsonb,
  request_id    text,
  ip_address    inet,
  user_agent    text,
  created_at    timestamptz not null default now()
);

create index audit_log_company_created_idx on ocs.audit_log (company_id, created_at desc);
create index audit_log_entity_idx on ocs.audit_log (entity_type, entity_id, created_at desc);
create index audit_log_actor_idx on ocs.audit_log (actor_user_id, created_at desc);

-- -----------------------------------------------------------------------------
-- idempotency_keys -- makes unsafe POSTs replay-safe (see src/lib/idempotency.ts).
--
-- A caller sends `Idempotency-Key`. We insert the key up front; a duplicate hits
-- the unique constraint and we replay the stored response instead of acting
-- twice. This is what stops a double-submitted payment from charging twice.
-- -----------------------------------------------------------------------------

create table ocs.idempotency_keys (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid references ocs.companies (id) on delete cascade,
  idempotency_key text not null,
  endpoint        text not null,
  request_hash    text not null,          -- rejects key reuse with a different body
  status          text not null default 'in_progress'
                    check (status in ('in_progress', 'completed', 'failed')),
  response_status int,
  response_body   jsonb,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz,
  expires_at      timestamptz not null default now() + interval '24 hours',

  unique (company_id, endpoint, idempotency_key)
);

create index idempotency_keys_expiry_idx on ocs.idempotency_keys (expires_at);

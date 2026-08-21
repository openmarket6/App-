-- =============================================================================
-- 0014  Native authentication and the staff role model
-- =============================================================================
-- WHY THIS EXISTS
--
-- The existing React frontend authenticates against its own /api/auth
-- endpoints: email + password, a bearer access token, and an httpOnly refresh
-- cookie. Only the BUILT bundle of that frontend exists, so its auth flow
-- cannot be rewritten to use Supabase Auth.
--
-- Rather than strand a working frontend, this migration teaches the backend to
-- speak that same contract. Supabase JWTs keep working alongside it (see
-- src/auth/plugin.ts), so both the existing app and the newer portal
-- authenticate against one backend.
--
-- ROLES
--
-- The names match what the frontend already ships with -- ADMIN, PERMIT_TECH,
-- VIEWER, CLIENT, PENDING -- because those strings are compiled into the
-- bundle and cannot be changed from here. SITE_SUPERVISOR is added for the
-- field staff who perform visits and take the photographs.
--
-- PENDING is the important one: a new signup can do nothing at all until an
-- administrator assigns a role. Self-service signup that lands somewhere
-- useful is how a stranger ends up reading a contractor's permits.
-- =============================================================================

create type ocs.app_role as enum (
  'ADMIN',            -- full access: users, billing, credentials, connectors
  'PERMIT_TECH',      -- day-to-day permit work across all contractors
  'SITE_SUPERVISOR',  -- field staff: site visits, photographs, sign-offs
  'VIEWER',           -- read-only across the firm
  'CLIENT',           -- a contractor, scoped to their own company
  'PENDING'           -- signed up, not yet authorised; sees nothing
);

alter table ocs.app_users
  add column name           text,
  -- bcrypt hash. Never a password, never a reversible encryption of one.
  add column password_hash  text,
  add column app_role       ocs.app_role not null default 'PENDING',
  -- Set for CLIENT users: the contractor company they belong to. Staff roles
  -- leave this null, which is what lets them work across contractors.
  add column client_id      uuid references ocs.companies (id) on delete set null,

  -- Bumped on password change, invite acceptance, or forced sign-out. Refresh
  -- tokens carry the version they were minted with, so raising it invalidates
  -- every outstanding session for that user at once -- which is what makes
  -- "revoke access now" actually immediate.
  add column token_version  int not null default 0,

  add column invite_token   text,
  add column invite_expires_at timestamptz,
  add column last_login_at  timestamptz;

create unique index app_users_invite_token_key on ocs.app_users (invite_token)
  where invite_token is not null;
create index app_users_app_role_idx on ocs.app_users (app_role);
create index app_users_client_idx on ocs.app_users (client_id) where client_id is not null;

-- A CLIENT is meaningless without the company it belongs to, and a staff role
-- confined to one company would silently stop seeing other contractors' work.
alter table ocs.app_users
  add constraint app_users_client_role_consistency
  check (
    (app_role = 'CLIENT' and client_id is not null)
    or (app_role <> 'CLIENT' and client_id is null)
  ) not valid;

-- NOT VALID so existing rows (created before roles existed) are not rejected;
-- it is enforced for every insert and update from here on.

-- -----------------------------------------------------------------------------
-- refresh_tokens
--
-- Refresh tokens are recorded rather than merely signed, so a session can be
-- revoked individually without bumping token_version and signing the user out
-- everywhere. Only a hash is stored: a database dump must not yield usable
-- sessions.
-- -----------------------------------------------------------------------------

create table ocs.refresh_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references ocs.app_users (id) on delete cascade,
  token_hash    text not null unique,
  token_version int not null,

  issued_at     timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked_at    timestamptz,

  -- Recorded so an unfamiliar sign-in location is visible after the fact.
  ip_address    inet,
  user_agent    text
);

create index refresh_tokens_user_idx on ocs.refresh_tokens (user_id)
  where revoked_at is null;
create index refresh_tokens_expiry_idx on ocs.refresh_tokens (expires_at);

-- Infrastructure, not tenant data: reachable only from a service-context
-- transaction, exactly like webhook_events.
alter table ocs.refresh_tokens enable row level security;
alter table ocs.refresh_tokens force row level security;

create policy service_only on ocs.refresh_tokens
  for all to ocs_app, ocs_service
  using (ocs.is_service_context())
  with check (ocs.is_service_context());

grant select, insert, update, delete on ocs.refresh_tokens to ocs_app, ocs_service;

-- -----------------------------------------------------------------------------
-- Link supervisors to the new role.
--
-- A supervisor row is the field-staff profile (trades, counties, capacity); the
-- SITE_SUPERVISOR role is what lets that person sign in and log a visit. They
-- are separate because one can exist without the other during onboarding.
-- -----------------------------------------------------------------------------

alter table ocs.supervisors
  add column onboarded_at timestamptz,
  -- Field staff photograph work under our licence. Recording that they have
  -- been briefed is part of showing supervision is real rather than nominal.
  add column briefed_at   timestamptz,
  add column briefing_notes text;

-- -----------------------------------------------------------------------------
-- Bootstrap helper: is there an administrator yet?
--
-- Drives GET /api/auth/setup-state, which the frontend uses to decide between
-- showing a sign-in box and a first-run setup form.
-- -----------------------------------------------------------------------------

create or replace function ocs.needs_setup() returns boolean
  language sql stable
  set search_path = ocs, pg_temp
as $$
  select not exists (
    select 1 from ocs.app_users
     where app_role = 'ADMIN' and is_active and deleted_at is null
       and password_hash is not null
  )
$$;

grant execute on function ocs.needs_setup() to ocs_app, ocs_service;

-- -----------------------------------------------------------------------------
-- Housekeeping for expired sessions.
-- -----------------------------------------------------------------------------

insert into ocs.job_schedules (name, job_type, queue, interval_seconds, payload)
values ('cleanup-refresh-tokens', 'system.cleanup_refresh_tokens', 'default', 21600, '{}'::jsonb)
on conflict (name) do nothing;

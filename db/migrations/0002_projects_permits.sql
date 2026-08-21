-- =============================================================================
-- 0002  Municipalities (shared reference data), projects, permits
-- =============================================================================

-- -----------------------------------------------------------------------------
-- municipalities -- Florida cities and counties we file permits with.
--
-- This is SHARED reference data, not tenant-owned: it has no company_id and
-- every tenant reads the same rows. 0008 gives it a read-to-all / write-to-
-- platform-admin policy rather than a company_id policy.
-- -----------------------------------------------------------------------------

create type ocs.jurisdiction_kind as enum ('city', 'county', 'state', 'special_district');

-- How we actually get status out of this jurisdiction. Drives which adapter the
-- permit status-check job uses, and whether it can be automated at all.
create type ocs.integration_method as enum (
  'api',              -- documented HTTP API
  'portal_scrape',    -- authenticated portal, HTML scraped
  'email',            -- status arrives by email
  'manual',           -- a human checks; no automation
  'none'              -- no status source known
);

create table ocs.municipalities (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  kind                ocs.jurisdiction_kind not null,
  county              text,
  state               text not null default 'FL',

  -- Permitting portal / integration
  portal_url          text,
  integration_method  ocs.integration_method not null default 'none',
  adapter_key         text,        -- maps to a module in src/services/municipalities
  status_check_enabled boolean not null default false,
  -- Minimum seconds between automated status checks for this jurisdiction.
  -- Municipal portals are fragile and rate-limit aggressively; the job runner
  -- reads this rather than hammering every jurisdiction at the same cadence.
  status_check_interval_seconds int not null default 86400
    check (status_check_interval_seconds >= 300),

  contact_phone       text,
  contact_email       text,
  notes               text,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (name, kind, state)
);

create index municipalities_active_idx on ocs.municipalities (state, kind) where is_active;
create index municipalities_status_check_idx on ocs.municipalities (adapter_key)
  where status_check_enabled;

create trigger municipalities_set_updated_at
  before update on ocs.municipalities
  for each row execute function ocs.set_updated_at();

-- -----------------------------------------------------------------------------
-- projects -- a job site / scope of work. Owns one or more permits.
-- -----------------------------------------------------------------------------

create type ocs.project_status as enum (
  'lead', 'active', 'on_hold', 'completed', 'cancelled'
);

create table ocs.projects (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references ocs.companies (id) on delete cascade,

  -- Human-facing sequential number, unique per company (see trigger below).
  project_number   int not null,
  name             text not null check (length(btrim(name)) > 0),
  description      text,
  status           ocs.project_status not null default 'active',

  -- Job site
  municipality_id  uuid references ocs.municipalities (id),
  address_line1    text,
  address_line2    text,
  city             text,
  state            text not null default 'FL',
  postal_code      text,
  parcel_number    text,

  client_name      text,           -- the contractor's own customer
  client_email     text,
  client_phone     text,

  estimated_value  numeric(14, 2) check (estimated_value >= 0),
  start_date       date,
  target_completion_date date,
  completed_at     timestamptz,

  created_by       uuid references ocs.app_users (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,

  unique (company_id, project_number)
);

create index projects_company_status_idx on ocs.projects (company_id, status)
  where deleted_at is null;
create index projects_company_created_idx on ocs.projects (company_id, created_at desc);
create index projects_municipality_idx on ocs.projects (municipality_id);

create trigger projects_set_updated_at
  before update on ocs.projects
  for each row execute function ocs.set_updated_at();

-- Per-company sequential project numbers.
--
-- Uses an advisory lock keyed on the company rather than a global sequence so
-- each contractor sees their own 1, 2, 3... and two concurrent inserts for the
-- same company cannot collide. The lock is transaction-scoped and released on
-- commit.
create or replace function ocs.assign_project_number() returns trigger
  language plpgsql
  set search_path = ocs, pg_temp
as $$
begin
  if new.project_number is null or new.project_number = 0 then
    perform pg_advisory_xact_lock(hashtext('project_number:' || new.company_id::text));
    select coalesce(max(project_number), 0) + 1
      into new.project_number
      from ocs.projects
     where company_id = new.company_id;
  end if;
  return new;
end;
$$;

create trigger projects_assign_number
  before insert on ocs.projects
  for each row execute function ocs.assign_project_number();

-- -----------------------------------------------------------------------------
-- permits -- one municipal permit application. A project may have many.
-- -----------------------------------------------------------------------------

create type ocs.permit_status as enum (
  'draft',                 -- being prepared internally
  'ready_to_submit',
  'submitted',             -- filed with the jurisdiction
  'under_review',
  'corrections_required',  -- jurisdiction returned comments
  'resubmitted',
  'approved',
  'issued',                -- permit card in hand, work may begin
  'inspections',
  'closed',                -- finaled
  'expired',
  'rejected',
  'withdrawn'
);

create table ocs.permits (
  id                  uuid primary key default gen_random_uuid(),
  -- Denormalised from projects. Redundant, and deliberately so: it lets the RLS
  -- policy on this table be a plain column comparison instead of a subquery
  -- against projects, and the trigger below guarantees it stays consistent.
  company_id          uuid not null references ocs.companies (id) on delete cascade,
  project_id          uuid not null references ocs.projects (id) on delete cascade,
  municipality_id     uuid references ocs.municipalities (id),

  permit_number       text,        -- assigned by the jurisdiction once filed
  permit_type         text not null,
  status              ocs.permit_status not null default 'draft',
  scope_of_work       text,
  valuation           numeric(14, 2) check (valuation >= 0),

  applied_at          timestamptz,
  submitted_at        timestamptz,
  approved_at         timestamptz,
  issued_at           timestamptz,
  expires_at          timestamptz,
  closed_at           timestamptz,

  -- Automated status checking against the jurisdiction
  external_reference  text,        -- the id the portal knows this by
  last_checked_at     timestamptz,
  last_check_error    text,
  next_check_at       timestamptz,

  fee_amount          numeric(12, 2) check (fee_amount >= 0),
  fee_paid_at         timestamptz,

  assigned_to         uuid references ocs.app_users (id),
  created_by          uuid references ocs.app_users (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz
);

create index permits_company_status_idx on ocs.permits (company_id, status)
  where deleted_at is null;
create index permits_project_idx on ocs.permits (project_id) where deleted_at is null;
create index permits_expiring_idx on ocs.permits (expires_at)
  where deleted_at is null and status in ('issued', 'inspections');
-- Drives the scheduled status-check job: cheap lookup of "what is due now".
create index permits_next_check_idx on ocs.permits (next_check_at)
  where deleted_at is null and next_check_at is not null;
create unique index permits_municipality_number_key
  on ocs.permits (municipality_id, permit_number)
  where permit_number is not null and deleted_at is null;

create trigger permits_set_updated_at
  before update on ocs.permits
  for each row execute function ocs.set_updated_at();

-- Keep permits.company_id locked to the parent project's company.
--
-- Without this, a caller who could set company_id directly could park a permit
-- under another tenant's project, or hide a row from its own tenant. The child
-- never gets to disagree with its parent.
create or replace function ocs.sync_permit_company() returns trigger
  language plpgsql
  set search_path = ocs, pg_temp
as $$
declare
  parent_company uuid;
begin
  select company_id into parent_company from ocs.projects where id = new.project_id;
  if parent_company is null then
    raise exception 'project % not found', new.project_id;
  end if;
  new.company_id := parent_company;
  return new;
end;
$$;

create trigger permits_sync_company
  before insert or update of project_id, company_id on ocs.permits
  for each row execute function ocs.sync_permit_company();

-- -----------------------------------------------------------------------------
-- permit_status_history -- every status transition, who caused it, and why.
-- Written by a trigger so it cannot be skipped by a code path that forgets.
-- -----------------------------------------------------------------------------

create table ocs.permit_status_history (
  id           bigserial primary key,
  company_id   uuid not null references ocs.companies (id) on delete cascade,
  permit_id    uuid not null references ocs.permits (id) on delete cascade,
  from_status  ocs.permit_status,
  to_status    ocs.permit_status not null,
  source       text not null default 'user'
                 check (source in ('user', 'municipal_check', 'webhook', 'system')),
  note         text,
  changed_by   uuid references ocs.app_users (id),
  created_at   timestamptz not null default now()
);

create index permit_status_history_permit_idx
  on ocs.permit_status_history (permit_id, created_at desc);
create index permit_status_history_company_idx
  on ocs.permit_status_history (company_id, created_at desc);

create or replace function ocs.record_permit_status_change() returns trigger
  language plpgsql
  set search_path = ocs, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new;
  end if;

  insert into ocs.permit_status_history
    (company_id, permit_id, from_status, to_status, source, changed_by)
  values (
    new.company_id,
    new.id,
    case when tg_op = 'UPDATE' then old.status else null end,
    new.status,
    coalesce(nullif(current_setting('ocs.change_source', true), ''), 'user'),
    ocs.current_user_id()
  );
  return new;
end;
$$;

create trigger permits_record_status_change
  after insert or update of status on ocs.permits
  for each row execute function ocs.record_permit_status_change();

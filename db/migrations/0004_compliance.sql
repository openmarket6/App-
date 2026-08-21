-- =============================================================================
-- 0004  Qualifiers, licenses, insurance -- everything with an expiry date
-- =============================================================================
-- These three tables share a shape: they expire, and someone must be warned
-- before they do. The `expires_on` partial indexes exist to make the daily
-- expiration scan (src/jobs/handlers/expirationScan.ts) a cheap indexed range
-- read rather than a full scan of every tenant's records.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- qualifiers -- the licensed individual who qualifies a contractor company.
-- -----------------------------------------------------------------------------

create table ocs.qualifiers (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references ocs.companies (id) on delete cascade,
  user_id        uuid references ocs.app_users (id) on delete set null,

  full_name      text not null check (length(btrim(full_name)) > 0),
  email          text,
  phone          text,
  license_number text,
  is_primary     boolean not null default false,
  is_active      boolean not null default true,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);

create index qualifiers_company_idx on ocs.qualifiers (company_id) where deleted_at is null;
-- At most one primary qualifier per company.
create unique index qualifiers_one_primary
  on ocs.qualifiers (company_id)
  where is_primary and is_active and deleted_at is null;

create trigger qualifiers_set_updated_at
  before update on ocs.qualifiers
  for each row execute function ocs.set_updated_at();

-- -----------------------------------------------------------------------------
-- licenses
-- -----------------------------------------------------------------------------

create type ocs.license_type as enum (
  'state_certified',
  'state_registered',
  'county_local',
  'municipal',
  'specialty',
  'business_tax_receipt',
  'other'
);

create type ocs.compliance_status as enum (
  'active', 'expiring_soon', 'expired', 'suspended', 'revoked', 'pending'
);

create table ocs.licenses (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references ocs.companies (id) on delete cascade,
  qualifier_id    uuid references ocs.qualifiers (id) on delete set null,
  municipality_id uuid references ocs.municipalities (id),

  license_type    ocs.license_type not null,
  license_number  text not null,
  trade           text,                 -- e.g. 'Roofing', 'General', 'Electrical'
  issuing_authority text,
  status          ocs.compliance_status not null default 'active',

  issued_on       date,
  expires_on      date,
  -- How many days before expiry the first reminder fires.
  reminder_days   int not null default 60 check (reminder_days between 0 and 365),
  last_reminder_sent_at timestamptz,

  -- The scanned certificate itself.
  document_id     uuid references ocs.documents (id) on delete set null,

  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,

  unique (company_id, license_type, license_number)
);

create index licenses_company_idx on ocs.licenses (company_id) where deleted_at is null;
create index licenses_expiring_idx on ocs.licenses (expires_on)
  where deleted_at is null and expires_on is not null;
create index licenses_status_idx on ocs.licenses (company_id, status)
  where deleted_at is null;

create trigger licenses_set_updated_at
  before update on ocs.licenses
  for each row execute function ocs.set_updated_at();

-- -----------------------------------------------------------------------------
-- insurance_policies
-- -----------------------------------------------------------------------------

create type ocs.insurance_type as enum (
  'general_liability',
  'workers_compensation',
  'commercial_auto',
  'umbrella',
  'professional_liability',
  'builders_risk',
  'other'
);

create table ocs.insurance_policies (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references ocs.companies (id) on delete cascade,

  insurance_type    ocs.insurance_type not null,
  policy_number     text not null,
  carrier_name      text,
  agent_name        text,
  agent_email       text,
  agent_phone       text,

  status            ocs.compliance_status not null default 'active',
  coverage_amount   numeric(14, 2) check (coverage_amount >= 0),
  deductible        numeric(12, 2) check (deductible >= 0),

  effective_on      date,
  expires_on        date,
  reminder_days     int not null default 45 check (reminder_days between 0 and 365),
  last_reminder_sent_at timestamptz,

  -- Certificate of insurance.
  document_id       uuid references ocs.documents (id) on delete set null,

  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,

  unique (company_id, insurance_type, policy_number)
);

create index insurance_company_idx on ocs.insurance_policies (company_id)
  where deleted_at is null;
create index insurance_expiring_idx on ocs.insurance_policies (expires_on)
  where deleted_at is null and expires_on is not null;

create trigger insurance_set_updated_at
  before update on ocs.insurance_policies
  for each row execute function ocs.set_updated_at();

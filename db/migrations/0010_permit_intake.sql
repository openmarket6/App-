-- =============================================================================
-- 0010  Permit application intake
-- =============================================================================
-- A `permit_application` is what a contractor SUBMITS. A `permit` (0002) is what
-- exists once a jurisdiction has one on file. They are separate tables because
-- they have different lifecycles: an application can be rejected, abandoned or
-- resubmitted three times and still never become a permit, and squashing both
-- into one row loses that history the moment it matters.
--
-- The Florida-specific fields here are not decoration. Each one is something a
-- jurisdiction rejects an application for omitting:
--
--   * Notice of Commencement -- required by FL Statute 713.13 for improvements
--     over $2,500. Filing without a recorded NOC is one of the most common
--     reasons a permit gets held.
--   * HVHZ (High Velocity Hurricane Zone) -- Miami-Dade and Broward. Products
--     used there need a Miami-Dade Notice of Acceptance, not just a statewide
--     Florida Product Approval number.
--   * Wind design (speed + exposure category) -- required for structural
--     review across coastal Florida.
--   * Flood zone and the FEMA 50% substantial-improvement rule -- determines
--     whether the whole structure must be brought up to current code.
--
-- Capturing them at intake means the rejection happens in our form, in seconds,
-- rather than at the counter three weeks later.
-- =============================================================================

create type ocs.application_status as enum (
  'draft',            -- contractor still filling it in
  'submitted',        -- handed to One Contractor Solutions
  'in_review',        -- OCS checking completeness
  'info_requested',   -- something is missing; back with the contractor
  'accepted',         -- complete; ready to file with the jurisdiction
  'rejected',
  'converted',        -- became a permit record
  'withdrawn'
);

create type ocs.occupancy_type as enum (
  'residential_single_family',
  'residential_multi_family',
  'residential_mobile_manufactured',
  'commercial',
  'industrial',
  'institutional',
  'agricultural',
  'other'
);

create type ocs.wind_exposure as enum ('B', 'C', 'D');

create type ocs.required_document_type as enum (
  'site_plan',
  'floor_plan',
  'elevation_drawing',
  'structural_plans',
  'truss_engineering',
  'energy_calculation',
  'product_approval',        -- statewide Florida Product Approval
  'noa_hvhz',                -- Miami-Dade Notice of Acceptance (HVHZ only)
  'survey',
  'notice_of_commencement',
  'owner_authorization',
  'owner_builder_affidavit',
  'contractor_license',
  'insurance_certificate',
  'workers_comp_exemption',
  'subcontractor_affidavit',
  'soil_report',
  'septic_approval',
  'well_permit',
  'dep_environmental',
  'hoa_approval',
  'asbestos_survey',
  'demolition_plan',
  'flood_elevation_certificate',
  'other'
);

-- -----------------------------------------------------------------------------
-- permit_applications
-- -----------------------------------------------------------------------------

create table ocs.permit_applications (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references ocs.companies (id) on delete cascade,
  project_id          uuid references ocs.projects (id) on delete set null,
  municipality_id     uuid references ocs.municipalities (id),

  application_number  int not null,          -- per company, assigned by trigger
  status              ocs.application_status not null default 'draft',
  permit_type         text not null,

  -- --- Job site ------------------------------------------------------------
  site_address_line1  text,
  site_address_line2  text,
  site_city           text,
  site_county         text,
  site_state          text not null default 'FL',
  site_postal_code    text,
  -- Florida counties call this the "folio" or "parcel ID". Jurisdictions key
  -- their records on it, so a wrong one routes the application to the wrong
  -- property.
  parcel_number       text,
  subdivision         text,
  lot                 text,
  block               text,

  -- --- Property owner ------------------------------------------------------
  owner_name          text,
  owner_phone         text,
  owner_email         text,
  owner_mailing_address text,
  -- Owner-builder permits are legal in Florida but require a signed affidavit
  -- and disqualify the contractor from pulling the permit themselves.
  is_owner_builder    boolean not null default false,

  -- --- Scope ---------------------------------------------------------------
  scope_of_work       text,
  -- Integer cents, like every other money column in this schema.
  valuation_cents     bigint check (valuation_cents >= 0),
  square_footage      int check (square_footage >= 0),
  stories             int check (stories >= 0),
  dwelling_units      int check (dwelling_units >= 0),
  is_new_construction boolean not null default false,
  occupancy_type      ocs.occupancy_type,

  -- --- Florida structural / environmental ----------------------------------
  design_wind_speed_mph int check (design_wind_speed_mph between 90 and 220),
  wind_exposure       ocs.wind_exposure,
  -- Derived from the county on write (see the trigger below) rather than
  -- trusted from the form: whether HVHZ rules apply is a fact about the
  -- address, not an opinion the applicant gets to hold.
  in_hvhz             boolean not null default false,

  flood_zone          text,
  base_flood_elevation numeric(7,2),
  -- FEMA's 50% rule: improvements worth half the structure's value or more
  -- force the whole building up to current code.
  is_substantial_improvement boolean not null default false,

  -- --- Notice of Commencement (FL Statute 713.13) --------------------------
  -- requires_noc is derived, never supplied. See ocs.apply_application_rules().
  requires_noc        boolean not null default false,
  noc_recorded        boolean not null default false,
  noc_book            text,
  noc_page            text,
  noc_recorded_date   date,

  -- --- Contractor ----------------------------------------------------------
  qualifier_id        uuid references ocs.qualifiers (id) on delete set null,
  license_id          uuid references ocs.licenses (id) on delete set null,

  -- --- Contact + scheduling ------------------------------------------------
  contact_name        text,
  contact_phone       text,
  contact_email       text,
  requested_start_date date,
  is_expedited        boolean not null default false,
  expedite_reason     text,

  -- --- Workflow ------------------------------------------------------------
  submitted_at        timestamptz,
  submitted_by        uuid references ocs.app_users (id),
  reviewed_at         timestamptz,
  reviewed_by         uuid references ocs.app_users (id),
  review_notes        text,
  rejection_reason    text,
  converted_permit_id uuid references ocs.permits (id) on delete set null,

  created_by          uuid references ocs.app_users (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,

  unique (company_id, application_number),

  -- A rejection without a reason is useless to the contractor receiving it.
  constraint applications_rejection_has_reason
    check (status <> 'rejected' or rejection_reason is not null),
  constraint applications_expedite_has_reason
    check (not is_expedited or expedite_reason is not null)
);

create index permit_applications_company_status_idx
  on ocs.permit_applications (company_id, status) where deleted_at is null;
create index permit_applications_company_created_idx
  on ocs.permit_applications (company_id, created_at desc);
create index permit_applications_municipality_idx
  on ocs.permit_applications (municipality_id);
create index permit_applications_project_idx on ocs.permit_applications (project_id);

create trigger permit_applications_set_updated_at
  before update on ocs.permit_applications
  for each row execute function ocs.set_updated_at();

create or replace function ocs.assign_application_number() returns trigger
  language plpgsql
  set search_path = ocs, pg_temp
as $$
begin
  if new.application_number is null or new.application_number = 0 then
    perform pg_advisory_xact_lock(hashtext('application_number:' || new.company_id::text));
    select coalesce(max(application_number), 0) + 1
      into new.application_number
      from ocs.permit_applications
     where company_id = new.company_id;
  end if;
  return new;
end;
$$;

create trigger permit_applications_assign_number
  before insert on ocs.permit_applications
  for each row execute function ocs.assign_application_number();

-- -----------------------------------------------------------------------------
-- Derived Florida rules.
--
-- These are computed in the database rather than in a route handler so they
-- hold for every write path -- the intake form, a bulk import, an admin
-- correction, a future mobile client. A rule enforced in one controller is a
-- rule that is wrong everywhere else.
-- -----------------------------------------------------------------------------

-- Florida's High Velocity Hurricane Zone is defined by statute as Miami-Dade
-- and Broward counties. It is not a judgement call, so it is not an input.
create or replace function ocs.county_is_hvhz(county_name text) returns boolean
  language sql immutable
  set search_path = ocs, pg_temp
as $$
  select lower(btrim(coalesce(county_name, ''))) in ('miami-dade', 'miami dade', 'dade', 'broward')
$$;

-- FL Statute 713.13: a Notice of Commencement is required for improvements
-- over $2,500. Threshold in cents to match valuation_cents.
create or replace function ocs.noc_threshold_cents() returns bigint
  language sql immutable as $$ select 250000::bigint $$;

create or replace function ocs.apply_application_rules() returns trigger
  language plpgsql
  set search_path = ocs, pg_temp
as $$
declare
  resolved_county text;
begin
  -- Prefer the county typed on the application; fall back to the jurisdiction's.
  resolved_county := nullif(btrim(coalesce(new.site_county, '')), '');

  if resolved_county is null and new.municipality_id is not null then
    select coalesce(m.county, case when m.kind = 'county' then m.name else null end)
      into resolved_county
      from ocs.municipalities m
     where m.id = new.municipality_id;
    new.site_county := resolved_county;
  end if;

  new.in_hvhz := ocs.county_is_hvhz(resolved_county);

  new.requires_noc := coalesce(new.valuation_cents, 0) > ocs.noc_threshold_cents();

  -- Owner-builder and a company qualifier are mutually exclusive: either the
  -- owner pulls the permit or the licensed contractor does, never both.
  if new.is_owner_builder and new.qualifier_id is not null then
    raise exception 'an owner-builder application cannot also name a company qualifier';
  end if;

  return new;
end;
$$;

create trigger permit_applications_apply_rules
  before insert or update on ocs.permit_applications
  for each row execute function ocs.apply_application_rules();

-- -----------------------------------------------------------------------------
-- application_subcontractors
--
-- Florida jurisdictions require each trade sub to be named and licensed on the
-- application. Missing subs are a routine cause of rejection.
-- -----------------------------------------------------------------------------

create table ocs.application_subcontractors (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references ocs.companies (id) on delete cascade,
  application_id uuid not null references ocs.permit_applications (id) on delete cascade,

  trade          text not null,          -- 'Electrical', 'Plumbing', 'Mechanical'...
  business_name  text not null,
  license_number text,
  qualifier_name text,
  phone          text,
  email          text,
  -- Florida requires either active workers' comp or a filed exemption.
  has_workers_comp boolean,
  workers_comp_exempt boolean not null default false,

  created_at     timestamptz not null default now()
);

create index application_subcontractors_app_idx
  on ocs.application_subcontractors (application_id);
create index application_subcontractors_company_idx
  on ocs.application_subcontractors (company_id);

create or replace function ocs.sync_subcontractor_company() returns trigger
  language plpgsql
  set search_path = ocs, pg_temp
as $$
declare
  parent_company uuid;
begin
  select company_id into parent_company
    from ocs.permit_applications where id = new.application_id;
  if parent_company is null then
    raise exception 'permit application % not found', new.application_id;
  end if;
  new.company_id := parent_company;
  return new;
end;
$$;

create trigger application_subcontractors_sync_company
  before insert or update of application_id, company_id on ocs.application_subcontractors
  for each row execute function ocs.sync_subcontractor_company();

-- -----------------------------------------------------------------------------
-- application_documents -- the required-document checklist.
--
-- One row per required item, created when the application is created. This is
-- what makes "what is still missing?" a query instead of a guess, and it is
-- what the submit endpoint checks before letting an application through.
-- -----------------------------------------------------------------------------

create table ocs.application_documents (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references ocs.companies (id) on delete cascade,
  application_id uuid not null references ocs.permit_applications (id) on delete cascade,

  document_type  ocs.required_document_type not null,
  is_required    boolean not null default true,
  -- Populated once the contractor uploads the file (0003 documents).
  document_id    uuid references ocs.documents (id) on delete set null,

  status         text not null default 'missing'
                   check (status in ('missing', 'provided', 'accepted', 'rejected', 'waived')),
  notes          text,
  reviewed_by    uuid references ocs.app_users (id),
  reviewed_at    timestamptz,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  unique (application_id, document_type)
);

create index application_documents_app_idx on ocs.application_documents (application_id);
create index application_documents_company_idx on ocs.application_documents (company_id);
create index application_documents_missing_idx
  on ocs.application_documents (application_id) where status = 'missing' and is_required;

create trigger application_documents_set_updated_at
  before update on ocs.application_documents
  for each row execute function ocs.set_updated_at();

create or replace function ocs.sync_application_document_company() returns trigger
  language plpgsql
  set search_path = ocs, pg_temp
as $$
declare
  parent_company uuid;
begin
  select company_id into parent_company
    from ocs.permit_applications where id = new.application_id;
  if parent_company is null then
    raise exception 'permit application % not found', new.application_id;
  end if;
  new.company_id := parent_company;
  return new;
end;
$$;

create trigger application_documents_sync_company
  before insert or update of application_id, company_id on ocs.application_documents
  for each row execute function ocs.sync_application_document_company();

-- -----------------------------------------------------------------------------
-- RLS for the three new tables. Identical policy to every other tenant table;
-- the isolation test in tests/tenant-isolation.test.ts asserts that no table in
-- this schema is left without one.
-- -----------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['permit_applications', 'application_subcontractors', 'application_documents']
  loop
    execute format('alter table ocs.%I enable row level security', t);
    execute format('alter table ocs.%I force row level security', t);
    execute format($f$
      create policy tenant_isolation on ocs.%I
        for all
        to ocs_app, ocs_service
        using (company_id = ocs.current_company_id() or ocs.is_service_context())
        with check (company_id = ocs.current_company_id() or ocs.is_service_context())
    $f$, t);
    execute format(
      'grant select, insert, update, delete on ocs.%I to ocs_app, ocs_service', t);
  end loop;
end
$$;

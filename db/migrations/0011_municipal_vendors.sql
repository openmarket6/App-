-- =============================================================================
-- 0011  Municipal permitting platforms
-- =============================================================================
-- THE CENTRAL INSIGHT OF THIS MIGRATION
--
-- Florida has 67 counties and roughly 400 municipalities, and a large share of
-- them issue their own building permits. Writing one integration per
-- jurisdiction would mean hundreds of integrations that each break
-- independently.
--
-- But those jurisdictions do not run hundreds of different systems. They buy
-- from a short list of vendors -- Accela, Tyler EnerGov, OpenGov, CentralSquare,
-- CityView, MyGovernmentOnline and a handful of others. Every Accela agency
-- speaks the same API; only the agency code, environment and credentials
-- differ.
--
-- So integration is modelled per VENDOR, configured per JURISDICTION. One
-- Accela adapter, written once, serves every Accela agency in the state. That
-- turns an impossible problem into roughly a dozen tractable ones.
--
-- WHY EVERYTHING IS DISABLED BY DEFAULT
--
-- A jurisdiction cannot be status-checked until someone has confirmed its real
-- endpoint and credentials and recorded that confirmation in
-- `adapter_verified_at`. An unverified adapter does not return "no data" -- it
-- returns confidently wrong permit statuses, and a contractor who believes an
-- application was approved when it was not will send a crew to a job site they
-- are not permitted to work. Wrong is materially worse than absent here.
-- =============================================================================

create type ocs.permit_platform as enum (
  'accela',              -- Accela Civic Platform / Construct API
  'tyler_energov',       -- Tyler Technologies EnerGov, Citizen Self Service
  'opengov',             -- OpenGov Permitting & Licensing (was ViewPoint Cloud)
  'centralsquare',       -- CentralSquare Community Development / eTRAKiT
  'cityview',            -- Harris CityView
  'mygovernmentonline',  -- MyGovernmentOnline (common in the FL panhandle)
  'clariti',
  'iworq',
  'govbuilt',
  'cloudpermit',
  'citizenserve',
  'camino',
  'custom',              -- bespoke jurisdiction system
  'none'                 -- no online system; counter or phone only
);

alter table ocs.municipalities
  add column platform ocs.permit_platform not null default 'none',

  -- Per-jurisdiction connection details. Never credentials -- those live in
  -- ocs.integration_credentials, encrypted, keyed by company.
  add column api_base_url      text,
  add column api_environment   text,      -- e.g. Accela 'PROD' / 'TEST'
  add column agency_code       text,      -- the vendor's identifier for this agency
  add column api_config        jsonb not null default '{}'::jsonb,

  -- What this jurisdiction actually supports. Capabilities differ per agency
  -- even on the same platform, because agencies license different modules.
  add column supports_status_check   boolean not null default false,
  add column supports_submission     boolean not null default false,
  add column supports_document_upload boolean not null default false,
  add column supports_fee_lookup     boolean not null default false,
  add column supports_inspections    boolean not null default false,

  -- The verification gate. status_check_enabled must not be turned on while
  -- this is null; the admin endpoint enforces that.
  add column adapter_verified_at timestamptz,
  add column adapter_verified_by uuid references ocs.app_users (id),
  add column adapter_notes       text;

create index municipalities_platform_idx on ocs.municipalities (platform)
  where platform <> 'none';
create index municipalities_verified_idx on ocs.municipalities (adapter_verified_at)
  where adapter_verified_at is not null;

-- Belt and braces for the rule above: automated checking cannot be switched on
-- for a jurisdiction nobody has verified, whatever code path tries.
alter table ocs.municipalities
  add constraint municipalities_check_requires_verification
  check (not status_check_enabled or adapter_verified_at is not null);

-- -----------------------------------------------------------------------------
-- platform_capabilities -- what each VENDOR supports, and how confident we are.
--
-- `integration_confidence` is deliberately explicit. 'documented' means a public
-- API specification exists. 'verified' means we have actually run it against a
-- live agency. Nothing reaches a contractor's screen on the strength of
-- 'documented' alone.
-- -----------------------------------------------------------------------------

create table ocs.platform_capabilities (
  platform            ocs.permit_platform primary key,
  display_name        text not null,
  vendor              text,
  has_public_api      boolean not null default false,
  auth_method         text,               -- 'oauth2', 'api_key', 'session', 'none'
  docs_url            text,
  integration_confidence text not null default 'unknown'
    check (integration_confidence in ('unknown', 'documented', 'verified', 'unavailable')),
  notes               text,
  updated_at          timestamptz not null default now()
);

create trigger platform_capabilities_set_updated_at
  before update on ocs.platform_capabilities
  for each row execute function ocs.set_updated_at();

-- Seeded from public knowledge of each vendor. Every row is 'documented' or
-- weaker: none has been run against a live Florida agency from this codebase
-- yet, and the column says so rather than implying otherwise.
insert into ocs.platform_capabilities
  (platform, display_name, vendor, has_public_api, auth_method, integration_confidence, notes)
values
  ('accela', 'Accela Civic Platform', 'Accela', true, 'oauth2', 'documented',
   'Construct API. Per-agency app credentials plus agency name and environment. Widely used by larger Florida jurisdictions.'),
  ('tyler_energov', 'Tyler EnerGov / Enterprise Permitting & Licensing', 'Tyler Technologies', true, 'oauth2', 'documented',
   'API access is generally licensed per agency rather than open. Citizen Self Service portal is the public face.'),
  ('opengov', 'OpenGov Permitting & Licensing', 'OpenGov', true, 'api_key', 'documented',
   'Formerly ViewPoint Cloud. REST API; availability depends on the agency plan.'),
  ('centralsquare', 'CentralSquare Community Development / eTRAKiT', 'CentralSquare', false, 'session', 'unknown',
   'eTRAKiT is typically a portal without a public API. Often needs a per-agency arrangement.'),
  ('cityview', 'Harris CityView', 'Harris', false, 'session', 'unknown',
   'Portal-based. API availability varies by agency and version.'),
  ('mygovernmentonline', 'MyGovernmentOnline', 'MGO', false, 'session', 'unknown',
   'Common across the Florida panhandle. Portal-based; no public API published.'),
  ('clariti', 'Clariti', 'Clariti', true, 'oauth2', 'unknown', 'Salesforce-based platform.'),
  ('iworq', 'iWorQ', 'iWorQ', false, 'session', 'unknown', 'Used by smaller jurisdictions.'),
  ('govbuilt', 'GovBuilt', 'GovBuilt', false, 'session', 'unknown', null),
  ('cloudpermit', 'Cloudpermit', 'Cloudpermit', false, 'session', 'unknown', null),
  ('citizenserve', 'Citizenserve', 'Online Solutions LLC', false, 'session', 'unknown',
   'Used by a number of smaller Florida municipalities.'),
  ('camino', 'Camino', 'Camino', false, 'api_key', 'unknown', null),
  ('custom', 'Bespoke jurisdiction system', null, false, null, 'unknown',
   'One-off system built for a single jurisdiction.'),
  ('none', 'No online system', null, false, 'none', 'unavailable',
   'Counter, phone or email only. Status must be checked by a person.')
on conflict (platform) do nothing;

grant select on ocs.platform_capabilities to ocs_app, ocs_service;

alter table ocs.platform_capabilities enable row level security;
alter table ocs.platform_capabilities force row level security;

-- Reference data: readable by everyone, writable only in service context.
create policy capabilities_read on ocs.platform_capabilities
  for select to ocs_app, ocs_service using (true);
create policy capabilities_write on ocs.platform_capabilities
  for all to ocs_app, ocs_service
  using (ocs.is_service_context())
  with check (ocs.is_service_context());

-- -----------------------------------------------------------------------------
-- Recurring job: refresh the coverage rollup used by the admin dashboard.
-- -----------------------------------------------------------------------------

insert into ocs.job_schedules (name, job_type, queue, interval_seconds, payload)
values ('integration-coverage-report', 'integrations.coverage_report', 'default', 86400, '{}'::jsonb)
on conflict (name) do nothing;

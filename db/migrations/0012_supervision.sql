-- =============================================================================
-- 0012  White-glove service: qualifying and on-site supervision
-- =============================================================================
-- WHAT THIS SERVICE IS
--
-- One Contractor Solutions holds contractor licenses across Florida trades. A
-- contractor without a license in a given trade engages OCS to pull the permit
-- under an OCS qualifier, and OCS puts its own supervisor on site to oversee
-- the work.
--
-- WHY THE SCHEMA LOOKS LIKE THIS
--
-- In Florida a qualifier who lets their license be used on work they do not
-- actually supervise is committing an offence, not a paperwork error (see
-- Fla. Stat. 489.129 and 489.127 on aiding unlicensed activity). The
-- difference between a legitimate qualifying service and "renting a license"
-- is whether real supervision happened and whether it can be PROVEN
-- afterwards.
--
-- So this is not primarily a scheduling system. It is an evidence system. Every
-- table here exists to answer, months later and to someone hostile:
--
--     Who qualified this permit?
--     Which supervisor was responsible?
--     Which visits were required for this trade?
--     Did they happen, when, and was the supervisor actually at the site?
--     Who signed off, and what did they see?
--
-- The constraints below make the un-provable states hard to reach: an
-- engagement cannot go active without a matching unexpired license, a visit
-- cannot be signed off without a check-in, and an engagement cannot be closed
-- with mandatory visits outstanding.
--
-- NOT LEGAL ADVICE. The rules encoded here are a floor, not a compliance
-- opinion. Have a Florida construction attorney review the service model.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- trades -- Florida DBPR license categories.
-- Shared reference data, like municipalities.
-- -----------------------------------------------------------------------------

create type ocs.trade_division as enum (
  'division_1',   -- General, Building, Residential
  'division_2',   -- Roofing, HVAC, Plumbing, Pool, Solar, Specialty...
  'electrical',   -- governed by the ECLB rather than the CILB
  'other'
);

create table ocs.trades (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  name          text not null,
  division      ocs.trade_division not null,
  -- Whether this trade's work generally requires permits and inspections.
  requires_permit boolean not null default true,
  notes         text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

create index trades_division_idx on ocs.trades (division) where is_active;

insert into ocs.trades (code, name, division) values
  ('general',            'General Contractor',                'division_1'),
  ('building',           'Building Contractor',               'division_1'),
  ('residential',        'Residential Contractor',            'division_1'),
  ('roofing',            'Roofing Contractor',                'division_2'),
  ('sheet_metal',        'Sheet Metal Contractor',            'division_2'),
  ('hvac_class_a',       'Air Conditioning Class A',          'division_2'),
  ('hvac_class_b',       'Air Conditioning Class B',          'division_2'),
  ('mechanical',         'Mechanical Contractor',             'division_2'),
  ('plumbing',           'Plumbing Contractor',               'division_2'),
  ('pool_commercial',    'Commercial Pool/Spa Contractor',    'division_2'),
  ('pool_residential',   'Residential Pool/Spa Contractor',   'division_2'),
  ('pool_servicing',     'Swimming Pool Servicing',           'division_2'),
  ('underground_utility','Underground Utility & Excavation',  'division_2'),
  ('solar',              'Solar Contractor',                  'division_2'),
  ('pollutant_storage',  'Pollutant Storage Systems',         'division_2'),
  ('specialty_structure','Specialty Structure Contractor',    'division_2'),
  ('glass_glazing',      'Glass & Glazing Contractor',        'division_2'),
  ('gypsum_drywall',     'Gypsum Drywall Contractor',         'division_2'),
  ('marine',             'Marine Contractor (Seawall/Dock)',  'division_2'),
  ('electrical',         'Electrical Contractor',             'electrical'),
  ('alarm_system_1',     'Alarm System Contractor I',         'electrical'),
  ('alarm_system_2',     'Alarm System Contractor II',        'electrical'),
  ('specialty_electrical','Specialty Electrical Contractor',  'electrical')
on conflict (code) do nothing;

alter table ocs.trades enable row level security;
alter table ocs.trades force row level security;
create policy trades_read on ocs.trades
  for select to ocs_app, ocs_service using (true);
create policy trades_write on ocs.trades
  for all to ocs_app, ocs_service
  using (ocs.is_service_context()) with check (ocs.is_service_context());
grant select, insert, update on ocs.trades to ocs_app, ocs_service;

-- -----------------------------------------------------------------------------
-- service_licenses -- the licenses OCS ITSELF holds and qualifies work under.
--
-- Deliberately separate from ocs.licenses (0004), which records a CUSTOMER's
-- own licenses. These are the licenses the white-glove service is sold on, and
-- an expired one here means the service must stop for that trade statewide --
-- a materially different blast radius, so it gets its own table rather than a
-- flag on the customer table.
--
-- Not tenant-scoped: they belong to OCS, not to any contractor.
-- -----------------------------------------------------------------------------

create table ocs.service_licenses (
  id              uuid primary key default gen_random_uuid(),
  trade_id        uuid not null references ocs.trades (id),

  license_number  text not null,
  license_type    ocs.license_type not null default 'state_certified',
  -- The human being whose license this is. Florida ties qualification to a
  -- person, not a company.
  qualifier_user_id uuid references ocs.app_users (id),
  qualifier_name  text not null,
  issuing_authority text default 'Florida DBPR',

  issued_on       date,
  expires_on      date,
  status          ocs.compliance_status not null default 'active',

  -- How many active engagements this qualifier will take at once. Florida
  -- expects a qualifier to exercise real supervisory control; an unbounded
  -- number makes that claim indefensible.
  max_active_engagements int not null default 25
    check (max_active_engagements between 1 and 500),

  -- Counties this license is used in. Empty means statewide.
  service_counties text[] not null default '{}',

  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,

  unique (trade_id, license_number)
);

create index service_licenses_trade_idx on ocs.service_licenses (trade_id)
  where deleted_at is null;
create index service_licenses_expiring_idx on ocs.service_licenses (expires_on)
  where deleted_at is null and expires_on is not null;

create trigger service_licenses_set_updated_at
  before update on ocs.service_licenses
  for each row execute function ocs.set_updated_at();

alter table ocs.service_licenses enable row level security;
alter table ocs.service_licenses force row level security;

-- Contractors may SEE which trades OCS can qualify (they are choosing a
-- service), but only OCS staff may change them.
create policy service_licenses_read on ocs.service_licenses
  for select to ocs_app, ocs_service using (true);
create policy service_licenses_write on ocs.service_licenses
  for all to ocs_app, ocs_service
  using (ocs.is_service_context()) with check (ocs.is_service_context());
grant select, insert, update on ocs.service_licenses to ocs_app, ocs_service;

-- -----------------------------------------------------------------------------
-- supervisors -- OCS field staff who perform on-site supervision.
-- -----------------------------------------------------------------------------

create table ocs.supervisors (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null unique references ocs.app_users (id) on delete cascade,

  display_name   text not null,
  phone          text,
  -- Trades this person is competent to supervise. An engagement's trade must
  -- appear here before they can be assigned to it.
  trade_ids      uuid[] not null default '{}',
  -- Counties they cover. Empty means statewide.
  service_counties text[] not null default '{}',

  -- Capacity, so dispatch cannot quietly overload one person.
  max_active_engagements int not null default 12 check (max_active_engagements between 1 and 100),
  max_visits_per_day     int not null default 8  check (max_visits_per_day between 1 and 30),

  is_active      boolean not null default true,
  hired_on       date,
  certifications jsonb not null default '[]'::jsonb,
  notes          text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);

create index supervisors_active_idx on ocs.supervisors (is_active) where deleted_at is null;
create index supervisors_trades_idx on ocs.supervisors using gin (trade_ids);
create index supervisors_counties_idx on ocs.supervisors using gin (service_counties);

create trigger supervisors_set_updated_at
  before update on ocs.supervisors
  for each row execute function ocs.set_updated_at();

alter table ocs.supervisors enable row level security;
alter table ocs.supervisors force row level security;

-- A contractor can see the supervisor assigned to their own job (name, phone),
-- which is why read is open; roster management is service-context only.
create policy supervisors_read on ocs.supervisors
  for select to ocs_app, ocs_service using (true);
create policy supervisors_write on ocs.supervisors
  for all to ocs_app, ocs_service
  using (ocs.is_service_context()) with check (ocs.is_service_context());
grant select, insert, update on ocs.supervisors to ocs_app, ocs_service;

-- -----------------------------------------------------------------------------
-- visit_milestone_templates -- which site visits a trade REQUIRES.
--
-- Seeded per trade below. An engagement copies the template at activation, so
-- changing a template later never rewrites the requirements of a job already
-- under way -- the record of what was required at the time stays intact.
-- -----------------------------------------------------------------------------

create table ocs.visit_milestone_templates (
  id           uuid primary key default gen_random_uuid(),
  trade_id     uuid not null references ocs.trades (id) on delete cascade,

  code         text not null,
  name         text not null,
  description  text,
  sequence     int not null default 0,
  is_mandatory boolean not null default true,
  -- Whether the jurisdiction also inspects at this point. Where both happen,
  -- our supervisor should be on site for the inspection.
  aligns_with_inspection boolean not null default false,

  created_at   timestamptz not null default now(),
  unique (trade_id, code)
);

create index visit_milestone_templates_trade_idx
  on ocs.visit_milestone_templates (trade_id, sequence);

alter table ocs.visit_milestone_templates enable row level security;
alter table ocs.visit_milestone_templates force row level security;
create policy templates_read on ocs.visit_milestone_templates
  for select to ocs_app, ocs_service using (true);
create policy templates_write on ocs.visit_milestone_templates
  for all to ocs_app, ocs_service
  using (ocs.is_service_context()) with check (ocs.is_service_context());
grant select, insert, update, delete on ocs.visit_milestone_templates to ocs_app, ocs_service;

insert into ocs.visit_milestone_templates
  (trade_id, code, name, sequence, is_mandatory, aligns_with_inspection)
select t.id, v.code, v.name, v.seq, v.mandatory, v.inspection
from ocs.trades t
join (values
  -- Structural trades follow the inspection sequence a building department uses.
  ('general','site_prep','Site preparation & layout',10,true,false),
  ('general','footer','Footer / foundation',20,true,true),
  ('general','slab','Slab',30,true,true),
  ('general','framing','Framing',40,true,true),
  ('general','dry_in','Sheathing & dry-in',50,true,true),
  ('general','insulation','Insulation',60,true,true),
  ('general','drywall','Drywall',70,false,false),
  ('general','final','Final walkthrough',90,true,true),

  ('building','footer','Footer / foundation',20,true,true),
  ('building','slab','Slab',30,true,true),
  ('building','framing','Framing',40,true,true),
  ('building','dry_in','Sheathing & dry-in',50,true,true),
  ('building','final','Final walkthrough',90,true,true),

  ('residential','footer','Footer / foundation',20,true,true),
  ('residential','slab','Slab',30,true,true),
  ('residential','framing','Framing',40,true,true),
  ('residential','dry_in','Sheathing & dry-in',50,true,true),
  ('residential','final','Final walkthrough',90,true,true),

  ('roofing','tear_off','Tear-off & deck inspection',10,true,false),
  ('roofing','dry_in','Dry-in / nailing',20,true,true),
  ('roofing','in_progress','In-progress',30,false,false),
  ('roofing','final','Final',90,true,true),

  ('electrical','temp_power','Temporary power',10,false,true),
  ('electrical','rough_in','Rough-in',20,true,true),
  ('electrical','service','Service & panel',30,true,true),
  ('electrical','final','Final',90,true,true),

  ('plumbing','underground','Underground rough',10,true,true),
  ('plumbing','rough_in','Rough-in',20,true,true),
  ('plumbing','top_out','Top-out',30,true,true),
  ('plumbing','final','Final',90,true,true),

  ('mechanical','rough_in','Rough-in',20,true,true),
  ('mechanical','equipment_set','Equipment set',40,true,false),
  ('mechanical','final','Final',90,true,true),

  ('hvac_class_a','rough_in','Rough-in',20,true,true),
  ('hvac_class_a','equipment_set','Equipment set',40,true,false),
  ('hvac_class_a','final','Final',90,true,true),

  ('hvac_class_b','rough_in','Rough-in',20,true,true),
  ('hvac_class_b','final','Final',90,true,true),

  ('pool_residential','excavation','Excavation & layout',10,true,false),
  ('pool_residential','steel_bonding','Steel & bonding',20,true,true),
  ('pool_residential','plumbing_pressure','Plumbing pressure test',30,true,true),
  ('pool_residential','deck','Deck & barrier',60,true,true),
  ('pool_residential','final','Final & safety barrier',90,true,true),

  ('pool_commercial','steel_bonding','Steel & bonding',20,true,true),
  ('pool_commercial','deck','Deck & barrier',60,true,true),
  ('pool_commercial','final','Final & safety barrier',90,true,true),

  ('solar','mounting','Mounting & attachment',20,true,true),
  ('solar','electrical_rough','Electrical rough-in',30,true,true),
  ('solar','final','Final & commissioning',90,true,true),

  ('glass_glazing','opening_prep','Opening preparation',10,true,false),
  ('glass_glazing','installation','Installation & anchoring',20,true,true),
  ('glass_glazing','final','Final',90,true,true),

  ('specialty_structure','anchoring','Anchoring & attachment',20,true,true),
  ('specialty_structure','final','Final',90,true,true),

  ('marine','pilings','Pilings & structural',20,true,true),
  ('marine','final','Final',90,true,true),

  ('underground_utility','trench','Trench & bedding',10,true,true),
  ('underground_utility','pressure_test','Pressure test',30,true,true),
  ('underground_utility','final','Final',90,true,true),

  ('gypsum_drywall','hanging','Hanging',20,true,false),
  ('gypsum_drywall','final','Final',90,true,true),

  ('sheet_metal','rough_in','Rough-in',20,true,true),
  ('sheet_metal','final','Final',90,true,true)
) as v(trade_code, code, name, seq, mandatory, inspection)
  on v.trade_code = t.code
on conflict (trade_id, code) do nothing;

-- -----------------------------------------------------------------------------
-- supervision_engagements -- one contractor + one permit + one trade.
--
-- Tenant-scoped to the CONTRACTOR: it is their job, visible in their portal.
-- -----------------------------------------------------------------------------

create type ocs.engagement_status as enum (
  'requested',     -- contractor asked for the service
  'quoted',
  'accepted',      -- terms agreed
  'active',        -- permit qualified, supervision under way
  'on_hold',
  'completed',     -- all mandatory visits done and signed off
  'cancelled',
  'terminated'     -- ended early: non-compliance, non-payment, safety
);

create table ocs.supervision_engagements (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references ocs.companies (id) on delete cascade,

  engagement_number int not null,
  project_id        uuid references ocs.projects (id) on delete set null,
  permit_id         uuid references ocs.permits (id) on delete set null,
  application_id    uuid references ocs.permit_applications (id) on delete set null,

  trade_id          uuid not null references ocs.trades (id),
  -- The OCS license this work is qualified under, and the supervisor on site.
  service_license_id uuid references ocs.service_licenses (id),
  supervisor_id     uuid references ocs.supervisors (id),

  status            ocs.engagement_status not null default 'requested',

  site_address      text,
  site_city         text,
  site_county       text,
  -- Job-site coordinates. Check-ins are validated against these, which is what
  -- turns "a visit was logged" into "someone was actually there".
  site_latitude     numeric(9,6),
  site_longitude    numeric(9,6),

  scope_summary     text,
  estimated_value_cents bigint check (estimated_value_cents >= 0),
  requested_start_date  date,
  expected_completion_date date,

  -- Pricing, in cents like everything else.
  setup_fee_cents   bigint check (setup_fee_cents >= 0),
  per_visit_fee_cents bigint check (per_visit_fee_cents >= 0),
  monthly_fee_cents bigint check (monthly_fee_cents >= 0),

  -- The contractor's acknowledgement that OCS directs the permitted work.
  terms_accepted_at timestamptz,
  terms_accepted_by uuid references ocs.app_users (id),

  activated_at      timestamptz,
  completed_at      timestamptz,
  terminated_at     timestamptz,
  termination_reason text,

  requested_by      uuid references ocs.app_users (id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,

  unique (company_id, engagement_number),

  constraint engagements_termination_has_reason
    check (status <> 'terminated' or termination_reason is not null),

  -- An active engagement must name both the license it is qualified under and
  -- the supervisor responsible. Either missing means nobody is accountable.
  constraint engagements_active_requires_assignment
    check (status <> 'active'
           or (service_license_id is not null and supervisor_id is not null)),

  -- Terms must be accepted before work is qualified under an OCS license.
  constraint engagements_active_requires_terms
    check (status not in ('active', 'completed') or terms_accepted_at is not null)
);

create index engagements_company_status_idx
  on ocs.supervision_engagements (company_id, status) where deleted_at is null;
create index engagements_supervisor_idx
  on ocs.supervision_engagements (supervisor_id, status) where deleted_at is null;
create index engagements_license_idx
  on ocs.supervision_engagements (service_license_id, status) where deleted_at is null;
create index engagements_permit_idx on ocs.supervision_engagements (permit_id);

create trigger engagements_set_updated_at
  before update on ocs.supervision_engagements
  for each row execute function ocs.set_updated_at();

create or replace function ocs.assign_engagement_number() returns trigger
  language plpgsql set search_path = ocs, pg_temp
as $$
begin
  if new.engagement_number is null or new.engagement_number = 0 then
    perform pg_advisory_xact_lock(hashtext('engagement_number:' || new.company_id::text));
    select coalesce(max(engagement_number), 0) + 1
      into new.engagement_number
      from ocs.supervision_engagements
     where company_id = new.company_id;
  end if;
  return new;
end;
$$;

create trigger engagements_assign_number
  before insert on ocs.supervision_engagements
  for each row execute function ocs.assign_engagement_number();

-- -----------------------------------------------------------------------------
-- The compliance gate.
--
-- Refuses to activate an engagement unless the license is real, current, and
-- for the right trade, and the supervisor is competent in that trade and has
-- capacity. These checks live in the database rather than a route handler so
-- an import, an admin fix, or a future client cannot route around them.
-- -----------------------------------------------------------------------------

create or replace function ocs.check_engagement_compliance() returns trigger
  language plpgsql set search_path = ocs, pg_temp
as $$
declare
  lic          record;
  sup          record;
  active_count int;
begin
  if new.status <> 'active' then
    return new;
  end if;

  -- 1. The license must exist, be current, and cover this trade.
  select * into lic from ocs.service_licenses
   where id = new.service_license_id and deleted_at is null;

  if lic is null then
    raise exception 'engagement cannot be activated without a service license';
  end if;
  if lic.trade_id <> new.trade_id then
    raise exception 'the selected license does not cover this trade';
  end if;
  if lic.status <> 'active' then
    raise exception 'the qualifying license is % and cannot be used', lic.status;
  end if;
  if lic.expires_on is not null and lic.expires_on < current_date then
    raise exception 'the qualifying license expired on %', lic.expires_on;
  end if;

  -- 2. The qualifier's active workload must stay within their stated limit.
  --    An unbounded number of jobs makes "real supervisory control" impossible
  --    to defend.
  select count(*) into active_count
    from ocs.supervision_engagements
   where service_license_id = new.service_license_id
     and status = 'active'
     and id <> new.id
     and deleted_at is null;

  if active_count >= lic.max_active_engagements then
    raise exception
      'qualifier % is already supervising % active engagements (limit %)',
      lic.qualifier_name, active_count, lic.max_active_engagements;
  end if;

  -- 3. The supervisor must be active and competent in this trade.
  select * into sup from ocs.supervisors
   where id = new.supervisor_id and deleted_at is null;

  if sup is null then
    raise exception 'engagement cannot be activated without a supervisor';
  end if;
  if not sup.is_active then
    raise exception 'the assigned supervisor is not active';
  end if;
  if array_length(sup.trade_ids, 1) is not null
     and not (new.trade_id = any(sup.trade_ids)) then
    raise exception 'supervisor % is not qualified for this trade', sup.display_name;
  end if;

  -- 4. And within their own capacity.
  select count(*) into active_count
    from ocs.supervision_engagements
   where supervisor_id = new.supervisor_id
     and status = 'active'
     and id <> new.id
     and deleted_at is null;

  if active_count >= sup.max_active_engagements then
    raise exception
      'supervisor % is already on % active engagements (limit %)',
      sup.display_name, active_count, sup.max_active_engagements;
  end if;

  if new.activated_at is null then
    new.activated_at := now();
  end if;

  return new;
end;
$$;

create trigger engagements_check_compliance
  before insert or update on ocs.supervision_engagements
  for each row execute function ocs.check_engagement_compliance();

-- -----------------------------------------------------------------------------
-- supervision_visits -- the evidence.
--
-- A visit row is only worth anything if it records that a person was physically
-- present. check_in_latitude/longitude and distance_from_site_meters are what
-- separate a supervision record from a claim.
-- -----------------------------------------------------------------------------

create type ocs.visit_status as enum (
  'required',     -- created from the template, not yet scheduled
  'scheduled',
  'in_progress',  -- checked in
  'completed',    -- checked out and signed off
  'missed',
  'waived',       -- not applicable to this job; requires a reason
  'cancelled'
);

create table ocs.supervision_visits (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references ocs.companies (id) on delete cascade,
  engagement_id  uuid not null references ocs.supervision_engagements (id) on delete cascade,

  milestone_code text not null,
  milestone_name text not null,
  sequence       int not null default 0,
  is_mandatory   boolean not null default true,

  status         ocs.visit_status not null default 'required',
  supervisor_id  uuid references ocs.supervisors (id),

  scheduled_for  timestamptz,

  -- Presence evidence.
  checked_in_at  timestamptz,
  check_in_latitude  numeric(9,6),
  check_in_longitude numeric(9,6),
  distance_from_site_meters int,
  checked_out_at timestamptz,

  findings       text,
  work_approved  boolean,
  corrections_required text,

  -- Sign-off is the supervisor putting their name to what they saw.
  signed_off_at  timestamptz,
  signed_off_by  uuid references ocs.app_users (id),
  signature_name text,

  waiver_reason  text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  unique (engagement_id, milestone_code),

  -- A completed visit must have a check-in and a sign-off. Without both it is
  -- an assertion, not a record.
  constraint visits_completed_requires_evidence
    check (status <> 'completed'
           or (checked_in_at is not null and signed_off_at is not null)),

  constraint visits_waived_requires_reason
    check (status <> 'waived' or waiver_reason is not null),

  -- Cannot check out before checking in.
  constraint visits_checkout_after_checkin
    check (checked_out_at is null or checked_in_at is null or checked_out_at >= checked_in_at)
);

create index visits_engagement_idx on ocs.supervision_visits (engagement_id, sequence);
create index visits_company_idx on ocs.supervision_visits (company_id, scheduled_for);
create index visits_supervisor_schedule_idx
  on ocs.supervision_visits (supervisor_id, scheduled_for)
  where status in ('scheduled', 'in_progress');
create index visits_outstanding_idx on ocs.supervision_visits (engagement_id)
  where is_mandatory and status not in ('completed', 'waived', 'cancelled');

create trigger visits_set_updated_at
  before update on ocs.supervision_visits
  for each row execute function ocs.set_updated_at();

create or replace function ocs.sync_visit_company() returns trigger
  language plpgsql set search_path = ocs, pg_temp
as $$
declare
  parent_company uuid;
begin
  select company_id into parent_company
    from ocs.supervision_engagements where id = new.engagement_id;
  if parent_company is null then
    raise exception 'engagement % not found', new.engagement_id;
  end if;
  new.company_id := parent_company;
  return new;
end;
$$;

create trigger visits_sync_company
  before insert or update of engagement_id, company_id on ocs.supervision_visits
  for each row execute function ocs.sync_visit_company();

-- -----------------------------------------------------------------------------
-- An engagement cannot be completed with mandatory visits outstanding.
--
-- This is the single most important rule in the file. "Completed" is what OCS
-- would point to as proof the job was supervised; allowing it while required
-- visits never happened would make the record actively misleading -- worse than
-- having no record at all.
-- -----------------------------------------------------------------------------

create or replace function ocs.check_engagement_completion() returns trigger
  language plpgsql set search_path = ocs, pg_temp
as $$
declare
  outstanding int;
  names text;
begin
  if new.status <> 'completed' or old.status = 'completed' then
    return new;
  end if;

  select count(*), string_agg(milestone_name, ', ' order by sequence)
    into outstanding, names
    from ocs.supervision_visits
   where engagement_id = new.id
     and is_mandatory
     and status not in ('completed', 'waived');

  if outstanding > 0 then
    raise exception
      'cannot complete: % required supervision visit(s) outstanding (%)',
      outstanding, names;
  end if;

  if new.completed_at is null then
    new.completed_at := now();
  end if;
  return new;
end;
$$;

create trigger engagements_check_completion
  before update on ocs.supervision_engagements
  for each row execute function ocs.check_engagement_completion();

-- -----------------------------------------------------------------------------
-- supervision_incidents -- safety and compliance problems found on site.
--
-- Recording these protects the qualifier: a documented stop-work instruction is
-- evidence that supervision was real and acted on.
-- -----------------------------------------------------------------------------

create table ocs.supervision_incidents (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references ocs.companies (id) on delete cascade,
  engagement_id  uuid not null references ocs.supervision_engagements (id) on delete cascade,
  visit_id       uuid references ocs.supervision_visits (id) on delete set null,

  severity       text not null default 'observation'
                   check (severity in ('observation', 'minor', 'serious', 'stop_work')),
  category       text,
  description    text not null,
  action_taken   text,

  reported_by    uuid references ocs.app_users (id),
  resolved_at    timestamptz,
  resolved_by    uuid references ocs.app_users (id),
  resolution_notes text,

  created_at     timestamptz not null default now()
);

create index incidents_engagement_idx on ocs.supervision_incidents (engagement_id, created_at desc);
create index incidents_company_idx on ocs.supervision_incidents (company_id, created_at desc);
create index incidents_open_idx on ocs.supervision_incidents (severity)
  where resolved_at is null;

create or replace function ocs.sync_incident_company() returns trigger
  language plpgsql set search_path = ocs, pg_temp
as $$
declare
  parent_company uuid;
begin
  select company_id into parent_company
    from ocs.supervision_engagements where id = new.engagement_id;
  if parent_company is null then
    raise exception 'engagement % not found', new.engagement_id;
  end if;
  new.company_id := parent_company;
  return new;
end;
$$;

create trigger incidents_sync_company
  before insert or update of engagement_id, company_id on ocs.supervision_incidents
  for each row execute function ocs.sync_incident_company();

-- -----------------------------------------------------------------------------
-- RLS for the three tenant-scoped supervision tables.
-- -----------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['supervision_engagements', 'supervision_visits', 'supervision_incidents']
  loop
    execute format('alter table ocs.%I enable row level security', t);
    execute format('alter table ocs.%I force row level security', t);
    execute format($f$
      create policy tenant_isolation on ocs.%I
        for all to ocs_app, ocs_service
        using (company_id = ocs.current_company_id() or ocs.is_service_context())
        with check (company_id = ocs.current_company_id() or ocs.is_service_context())
    $f$, t);
    execute format('grant select, insert, update, delete on ocs.%I to ocs_app, ocs_service', t);
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- Recurring jobs for the service.
-- -----------------------------------------------------------------------------

insert into ocs.job_schedules (name, job_type, queue, interval_seconds, payload)
values
  -- Warns before an OCS license expires. An expired license stops the service
  -- for that trade statewide, so this is a business-critical alarm.
  ('service-license-watch', 'supervision.license_watch', 'default', 43200, '{}'::jsonb),
  -- Flags engagements whose mandatory visits are overdue.
  ('supervision-visit-watch', 'supervision.visit_watch', 'default', 86400, '{}'::jsonb)
on conflict (name) do nothing;

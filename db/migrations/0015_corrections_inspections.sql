-- =============================================================================
-- 0015  Corrections, inspections, and the permit event trail
-- =============================================================================
-- Ports two areas from the previous implementation. The shapes follow that
-- system's contract, because the React frontend reads these field names.
--
-- WHY CORRECTIONS MATTER MORE THAN THEY LOOK
--
-- A correction is the jurisdiction telling a contractor the submission is
-- wrong. It starts a clock the contractor owns, and every cycle adds weeks. The
-- count of cycles a permit has been through is the single best measure of how
-- well a filing was prepared, which is why `correction_cycles` lives on the
-- permit itself rather than being counted on demand.
--
-- Corrections can also be PROMOTED into a jurisdiction requirement: "Broward
-- always asks for X on roofing." That turns one contractor's painful cycle into
-- a checklist item everyone benefits from, which is the compounding value in
-- this data.
-- =============================================================================

-- Where a change came from. Distinguishing a human's entry from an automated
-- portal read matters when reconstructing who knew what and when.
create type ocs.source_channel as enum ('manual', 'api', 'portal', 'email', 'system');

-- Stored lowercase to match this schema's conventions; the compatibility layer
-- uppercases them for the frontend (see src/routes/compat/mapping.ts).
create type ocs.inspection_result as enum (
  'scheduled', 'passed', 'failed', 'partial', 'cancelled', 'no_show'
);

-- -----------------------------------------------------------------------------
-- permits: cycle counter
-- -----------------------------------------------------------------------------

alter table ocs.permits
  add column correction_cycles int not null default 0 check (correction_cycles >= 0),
  add column last_synced_at timestamptz,
  add column source_channel ocs.source_channel not null default 'manual';

create index permits_correction_cycles_idx on ocs.permits (company_id, correction_cycles)
  where deleted_at is null and correction_cycles > 0;

-- -----------------------------------------------------------------------------
-- permit_corrections
-- -----------------------------------------------------------------------------

create table ocs.permit_corrections (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references ocs.companies (id) on delete cascade,
  permit_id     uuid not null references ocs.permits (id) on delete cascade,

  -- Which round of comments this was. Assigned by the trigger below so two
  -- corrections logged at once cannot both claim the same cycle.
  cycle         int not null check (cycle > 0),
  issued_at     timestamptz not null default now(),
  discipline    text,                      -- 'Structural', 'Electrical', ...
  body          text not null check (length(btrim(body)) > 0),

  resolved_at   timestamptz,
  resolved_by   uuid references ocs.app_users (id),

  -- True once this correction has been turned into a jurisdiction requirement.
  promoted_to_requirement boolean not null default false,

  created_by    uuid references ocs.app_users (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index permit_corrections_permit_idx
  on ocs.permit_corrections (permit_id, cycle desc);
create index permit_corrections_company_idx
  on ocs.permit_corrections (company_id, issued_at desc);
-- Drives the "open corrections" figure on the dashboard.
create index permit_corrections_open_idx on ocs.permit_corrections (company_id)
  where resolved_at is null;

create trigger permit_corrections_set_updated_at
  before update on ocs.permit_corrections
  for each row execute function ocs.set_updated_at();

create or replace function ocs.sync_correction_company() returns trigger
  language plpgsql set search_path = ocs, pg_temp
as $$
declare
  parent_company uuid;
begin
  select company_id into parent_company from ocs.permits where id = new.permit_id;
  if parent_company is null then
    raise exception 'permit % not found', new.permit_id;
  end if;
  new.company_id := parent_company;
  return new;
end;
$$;

create trigger permit_corrections_sync_company
  before insert or update of permit_id, company_id on ocs.permit_corrections
  for each row execute function ocs.sync_correction_company();

/*
 * Logging a correction is not just an insert.
 *
 * It advances the permit's cycle count and moves it into
 * CORRECTIONS_REQUIRED, because those three facts must never disagree: a
 * permit showing "in review" while carrying an unresolved correction would
 * misinform whoever reads the dashboard. Doing it in a trigger means every
 * write path gets the same behaviour.
 *
 * The cycle number is assigned here under a row lock rather than taken from the
 * caller, so two corrections logged simultaneously cannot both be "cycle 2".
 */
create or replace function ocs.apply_correction_effects() returns trigger
  language plpgsql set search_path = ocs, pg_temp
as $$
declare
  next_cycle int;
begin
  perform 1 from ocs.permits where id = new.permit_id for update;

  select coalesce(max(cycle), 0) + 1 into next_cycle
    from ocs.permit_corrections where permit_id = new.permit_id;

  new.cycle := next_cycle;
  return new;
end;
$$;

create trigger permit_corrections_assign_cycle
  before insert on ocs.permit_corrections
  for each row execute function ocs.apply_correction_effects();

create or replace function ocs.advance_permit_on_correction() returns trigger
  language plpgsql set search_path = ocs, pg_temp
as $$
begin
  perform set_config('ocs.change_source', 'user', true);

  update ocs.permits
     set correction_cycles = new.cycle,
         status = case
                    -- A terminal permit is not dragged back into review by a
                    -- correction logged late for the record.
                    when status in ('closed','expired','withdrawn','rejected') then status
                    else 'corrections_required'::ocs.permit_status
                  end,
         last_synced_at = now(),
         source_channel = 'manual'
   where id = new.permit_id;

  return new;
end;
$$;

create trigger permit_corrections_advance_permit
  after insert on ocs.permit_corrections
  for each row execute function ocs.advance_permit_on_correction();

-- -----------------------------------------------------------------------------
-- permit_inspections
-- -----------------------------------------------------------------------------

create table ocs.permit_inspections (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references ocs.companies (id) on delete cascade,
  permit_id        uuid not null references ocs.permits (id) on delete cascade,

  inspection_type  text not null check (length(btrim(inspection_type)) > 0),
  scheduled_for    timestamptz,
  result           ocs.inspection_result not null default 'scheduled',
  inspector_note   text,

  -- Set when this inspection exists because an earlier one failed. Following
  -- the chain shows how many attempts a milestone actually took.
  reinspection_of_id uuid references ocs.permit_inspections (id) on delete set null,

  source_channel   ocs.source_channel not null default 'manual',
  recorded_by      uuid references ocs.app_users (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- A result that is not "scheduled" describes something that already happened,
  -- so it cannot be dated in the future.
  constraint inspections_completed_not_future
    check (result = 'scheduled' or scheduled_for is null or scheduled_for <= now() + interval '1 day')
);

create index permit_inspections_permit_idx
  on ocs.permit_inspections (permit_id, scheduled_for desc nulls last);
create index permit_inspections_company_idx
  on ocs.permit_inspections (company_id, scheduled_for desc nulls last);
-- Drives the "inspections this week" figure.
create index permit_inspections_upcoming_idx
  on ocs.permit_inspections (scheduled_for)
  where result = 'scheduled' and scheduled_for is not null;

create trigger permit_inspections_set_updated_at
  before update on ocs.permit_inspections
  for each row execute function ocs.set_updated_at();

create or replace function ocs.sync_inspection_company() returns trigger
  language plpgsql set search_path = ocs, pg_temp
as $$
declare
  parent_company uuid;
begin
  select company_id into parent_company from ocs.permits where id = new.permit_id;
  if parent_company is null then
    raise exception 'permit % not found', new.permit_id;
  end if;
  new.company_id := parent_company;
  return new;
end;
$$;

create trigger permit_inspections_sync_company
  before insert or update of permit_id, company_id on ocs.permit_inspections
  for each row execute function ocs.sync_inspection_company();

-- A re-inspection must belong to the same permit as the inspection it repeats.
create or replace function ocs.check_reinspection_permit() returns trigger
  language plpgsql set search_path = ocs, pg_temp
as $$
declare
  parent_permit uuid;
begin
  if new.reinspection_of_id is null then return new; end if;

  select permit_id into parent_permit
    from ocs.permit_inspections where id = new.reinspection_of_id;

  if parent_permit is null then
    raise exception 'the inspection being re-inspected does not exist';
  end if;
  if parent_permit <> new.permit_id then
    raise exception 'a re-inspection must be on the same permit as the inspection it repeats';
  end if;
  return new;
end;
$$;

create trigger permit_inspections_check_reinspection
  before insert or update of reinspection_of_id on ocs.permit_inspections
  for each row execute function ocs.check_reinspection_permit();

-- -----------------------------------------------------------------------------
-- permit_events -- the narrative history of a permit.
--
-- permit_status_history (0002) records status transitions only. This records
-- everything worth knowing afterwards: a correction logged, an inspection
-- failed, a portal read that changed nothing. `raw_status` keeps the
-- jurisdiction's own wording next to our interpretation of it, which is what
-- makes a disputed reading resolvable later.
-- -----------------------------------------------------------------------------

create table ocs.permit_events (
  id             bigserial primary key,
  company_id     uuid not null references ocs.companies (id) on delete cascade,
  permit_id      uuid not null references ocs.permits (id) on delete cascade,

  occurred_at    timestamptz not null default now(),
  raw_status     text,                    -- the jurisdiction's own wording
  status         ocs.permit_status,       -- our interpretation of it
  note           text,
  source_channel ocs.source_channel not null default 'manual',

  actor_user_id  uuid references ocs.app_users (id),
  created_at     timestamptz not null default now()
);

create index permit_events_permit_idx on ocs.permit_events (permit_id, occurred_at desc);
create index permit_events_company_idx on ocs.permit_events (company_id, occurred_at desc);

create or replace function ocs.sync_permit_event_company() returns trigger
  language plpgsql set search_path = ocs, pg_temp
as $$
declare
  parent_company uuid;
begin
  select company_id into parent_company from ocs.permits where id = new.permit_id;
  if parent_company is null then
    raise exception 'permit % not found', new.permit_id;
  end if;
  new.company_id := parent_company;
  return new;
end;
$$;

create trigger permit_events_sync_company
  before insert or update of permit_id, company_id on ocs.permit_events
  for each row execute function ocs.sync_permit_event_company();

-- -----------------------------------------------------------------------------
-- jurisdiction_requirements -- lessons promoted from corrections.
--
-- NOT tenant-scoped, deliberately. "Broward wants a roof-deck photo on
-- re-roofs" is a fact about Broward, not about the contractor unlucky enough to
-- discover it. Sharing it is the whole point: one contractor's correction cycle
-- becomes everyone's checklist item.
--
-- `learned_from_correction_id` keeps the provenance, so a requirement can be
-- traced back to the specific rejection that taught it.
-- -----------------------------------------------------------------------------

create table ocs.jurisdiction_requirements (
  id              uuid primary key default gen_random_uuid(),
  municipality_id uuid not null references ocs.municipalities (id) on delete cascade,

  -- Null means the requirement applies to every permit type in this
  -- jurisdiction. Scoping it keeps a roofing lesson out of a plumbing checklist.
  permit_type     text,

  requirement_key text not null,
  op              text not null default 'add' check (op in ('add', 'remove', 'amend')),
  label           text,
  detail          text,

  learned_from_correction_id uuid references ocs.permit_corrections (id) on delete set null,
  -- The contractor whose correction taught this. Recorded for provenance only;
  -- it does not scope visibility.
  learned_from_company_id uuid references ocs.companies (id) on delete set null,

  is_active       boolean not null default true,
  created_by      uuid references ocs.app_users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  unique (municipality_id, permit_type, requirement_key)
);

create index jurisdiction_requirements_muni_idx
  on ocs.jurisdiction_requirements (municipality_id) where is_active;

create trigger jurisdiction_requirements_set_updated_at
  before update on ocs.jurisdiction_requirements
  for each row execute function ocs.set_updated_at();

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['permit_corrections', 'permit_inspections', 'permit_events']
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

-- Shared jurisdiction knowledge: readable by everyone, written in service
-- context (the promote endpoint opens one deliberately).
alter table ocs.jurisdiction_requirements enable row level security;
alter table ocs.jurisdiction_requirements force row level security;

create policy requirements_read on ocs.jurisdiction_requirements
  for select to ocs_app, ocs_service using (true);
create policy requirements_write on ocs.jurisdiction_requirements
  for all to ocs_app, ocs_service
  using (ocs.is_service_context()) with check (ocs.is_service_context());

grant select, insert, update, delete on ocs.jurisdiction_requirements to ocs_app, ocs_service;

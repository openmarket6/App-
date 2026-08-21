-- =============================================================================
-- 0013  Photo evidence for supervision visits
-- =============================================================================
-- 100% supervision means every site visit is photographed. This migration makes
-- that a property of the data rather than a policy people are asked to follow.
--
-- A supervision record's whole value is that it can be produced later, to a
-- licensing board or an insurer or a court, as proof the qualifier actually
-- oversaw the work. A GPS check-in shows someone was at the address. Photos
-- show what they saw when they got there. Without them the record says a
-- supervisor stood in a parking lot.
--
-- So photos are not an attachment to a visit. They are part of what makes a
-- visit complete: the trigger below refuses to mark a visit signed off until
-- the required photos exist, exactly as the engagement refuses to complete
-- while required visits are outstanding.
--
-- The image files themselves go through the normal document pipeline
-- (0003_drafting_documents.sql), so they inherit private storage, signed URLs,
-- versioning, retention and malware-scan status rather than getting a parallel
-- half-implementation.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- What each milestone requires.
-- -----------------------------------------------------------------------------

alter table ocs.visit_milestone_templates
  -- Deliberately not zero anywhere. "No photos needed" is not a state this
  -- service has: if a supervisor was on site, there is something to photograph.
  add column min_photos int not null default 3 check (min_photos >= 1),
  -- Categories that must each be represented, e.g. an overall site shot plus
  -- the specific work. Empty means only the count applies.
  add column required_photo_types text[] not null default '{}';

-- Final inspections carry the most weight later, so they need the fullest
-- record: an overview, the completed work, and enough coverage to be useful.
update ocs.visit_milestone_templates
   set min_photos = 4,
       required_photo_types = array['site_overview', 'completed_work']
 where code = 'final';

update ocs.visit_milestone_templates
   set required_photo_types = array['site_overview', 'work_in_progress']
 where code <> 'final';

-- -----------------------------------------------------------------------------
-- Per-visit requirements and running count.
--
-- Copied onto the visit at generation time (like the milestone itself), so
-- changing a template later never alters what an in-flight job was required to
-- produce.
-- -----------------------------------------------------------------------------

alter table ocs.supervision_visits
  add column required_photo_count int not null default 3 check (required_photo_count >= 0),
  add column required_photo_types text[] not null default '{}',
  add column photo_count int not null default 0 check (photo_count >= 0);

-- -----------------------------------------------------------------------------
-- supervision_visit_photos
--
-- One row per photograph. `document_id` points at the stored file; the columns
-- here are the queryable evidence: when it was taken, where, and what it shows.
-- -----------------------------------------------------------------------------

create type ocs.visit_photo_type as enum (
  'site_overview',      -- the job site as a whole, establishing context
  'work_in_progress',   -- the trade work being inspected
  'completed_work',
  'defect',             -- something wrong; pairs with an incident
  'materials',          -- product labels, approval stickers, NOA markings
  'safety',
  'other'
);

create table ocs.supervision_visit_photos (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references ocs.companies (id) on delete cascade,
  visit_id       uuid not null references ocs.supervision_visits (id) on delete cascade,
  -- The image itself, in private storage with signed-URL access.
  document_id    uuid not null references ocs.documents (id) on delete cascade,

  photo_type     ocs.visit_photo_type not null default 'work_in_progress',
  caption        text,
  sequence       int not null default 0,

  -- Capture evidence. `taken_at` is what the device reported; `uploaded_at` is
  -- when it reached us. Keeping both separate matters: a large gap between them
  -- is exactly the pattern of photos assembled after the fact rather than taken
  -- on site, and collapsing them into one column would hide it.
  taken_at       timestamptz,
  uploaded_at    timestamptz not null default now(),

  -- Where the photo was taken, from EXIF or the capturing device.
  latitude       numeric(9,6),
  longitude      numeric(9,6),
  distance_from_site_meters int,

  -- Raw EXIF for anything not modelled above (device, orientation, lens).
  exif           jsonb not null default '{}'::jsonb,

  uploaded_by    uuid references ocs.app_users (id),
  created_at     timestamptz not null default now(),

  unique (visit_id, document_id)
);

create index visit_photos_visit_idx on ocs.supervision_visit_photos (visit_id, sequence);
create index visit_photos_company_idx on ocs.supervision_visit_photos (company_id, created_at desc);
create index visit_photos_type_idx on ocs.supervision_visit_photos (visit_id, photo_type);

create or replace function ocs.sync_visit_photo_company() returns trigger
  language plpgsql set search_path = ocs, pg_temp
as $$
declare
  parent_company uuid;
begin
  select company_id into parent_company
    from ocs.supervision_visits where id = new.visit_id;
  if parent_company is null then
    raise exception 'supervision visit % not found', new.visit_id;
  end if;
  new.company_id := parent_company;
  return new;
end;
$$;

create trigger visit_photos_sync_company
  before insert or update of visit_id, company_id on ocs.supervision_visit_photos
  for each row execute function ocs.sync_visit_photo_company();

-- Keep the visit's photo_count honest without a per-read aggregate.
create or replace function ocs.recount_visit_photos() returns trigger
  language plpgsql set search_path = ocs, pg_temp
as $$
declare
  target uuid;
begin
  target := coalesce(new.visit_id, old.visit_id);
  update ocs.supervision_visits
     set photo_count = (select count(*) from ocs.supervision_visit_photos
                         where visit_id = target)
   where id = target;
  return coalesce(new, old);
end;
$$;

create trigger visit_photos_recount
  after insert or delete on ocs.supervision_visit_photos
  for each row execute function ocs.recount_visit_photos();

-- -----------------------------------------------------------------------------
-- THE GATE: a visit cannot be signed off without its photographs.
--
-- Checked in a trigger rather than a CHECK constraint because it has to count
-- rows in another table and compare categories. The effect is the same: no code
-- path -- route handler, import, admin fix, future mobile client -- can produce
-- a "completed" visit that has no photographic record behind it.
-- -----------------------------------------------------------------------------

create or replace function ocs.check_visit_photo_evidence() returns trigger
  language plpgsql set search_path = ocs, pg_temp
as $$
declare
  actual      int;
  missing     text[];
  present     text[];
begin
  -- Only completion is gated. A waived visit was judged not applicable, and
  -- that decision is separately audited with a reason.
  --
  -- old.status is compared directly, NOT through coalesce(old.status, ''):
  -- visit_status is an enum and '' is not a member of it, so the coalesce form
  -- raises "invalid input value for enum" on every update. This trigger also
  -- fires indirectly whenever a photo is inserted (the recount trigger updates
  -- the visit), so that mistake blocked photo uploads entirely. On UPDATE,
  -- old is always present and needs no fallback.
  if new.status <> 'completed' or old.status = 'completed' then
    return new;
  end if;

  select count(*) into actual
    from ocs.supervision_visit_photos where visit_id = new.id;

  if actual < new.required_photo_count then
    raise exception
      'cannot sign off %: % photo(s) required, % uploaded',
      new.milestone_name, new.required_photo_count, actual;
  end if;

  if array_length(new.required_photo_types, 1) is not null then
    select array_agg(distinct photo_type::text) into present
      from ocs.supervision_visit_photos where visit_id = new.id;

    select array_agg(t) into missing
      from unnest(new.required_photo_types) as t
     where t <> all(coalesce(present, array[]::text[]));

    if array_length(missing, 1) is not null then
      raise exception
        'cannot sign off %: missing required photo type(s): %',
        new.milestone_name, array_to_string(missing, ', ');
    end if;
  end if;

  return new;
end;
$$;

create trigger visits_check_photo_evidence
  before update on ocs.supervision_visits
  for each row execute function ocs.check_visit_photo_evidence();

-- -----------------------------------------------------------------------------
-- RLS, matching every other tenant-scoped table.
-- -----------------------------------------------------------------------------

alter table ocs.supervision_visit_photos enable row level security;
alter table ocs.supervision_visit_photos force row level security;

create policy tenant_isolation on ocs.supervision_visit_photos
  for all to ocs_app, ocs_service
  using (company_id = ocs.current_company_id() or ocs.is_service_context())
  with check (company_id = ocs.current_company_id() or ocs.is_service_context());

grant select, insert, update, delete on ocs.supervision_visit_photos to ocs_app, ocs_service;

-- -----------------------------------------------------------------------------
-- A view for producing the record later.
--
-- This is what gets exported when someone has to demonstrate that a job was
-- supervised: every visit, who signed it, where they stood, and how many
-- photographs back it up.
-- -----------------------------------------------------------------------------

create or replace view ocs.supervision_evidence as
select
  e.company_id,
  e.id                        as engagement_id,
  e.engagement_number,
  t.name                      as trade,
  l.license_number            as qualified_under,
  l.qualifier_name            as qualifier,
  e.site_address,
  e.status::text              as engagement_status,
  v.id                        as visit_id,
  v.milestone_name,
  v.is_mandatory,
  v.status::text              as visit_status,
  s.display_name              as supervisor,
  v.checked_in_at,
  v.checked_out_at,
  v.distance_from_site_meters,
  v.photo_count,
  v.required_photo_count,
  v.work_approved,
  v.findings,
  v.signed_off_at,
  v.signature_name
from ocs.supervision_engagements e
join ocs.trades t on t.id = e.trade_id
left join ocs.service_licenses l on l.id = e.service_license_id
left join ocs.supervisors s on s.id = e.supervisor_id
left join ocs.supervision_visits v on v.engagement_id = e.id
where e.deleted_at is null;

-- The view runs with the querying user's permissions, so the RLS policies on
-- the underlying tables still apply and it cannot be used to read across
-- tenants.
alter view ocs.supervision_evidence set (security_invoker = true);

grant select on ocs.supervision_evidence to ocs_app, ocs_service;

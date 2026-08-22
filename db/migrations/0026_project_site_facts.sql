-- 0026  The site facts a project needs before anything can be filed
--
-- These live on permit_applications already, which was the wrong place for
-- them. A flood zone, a coastal construction control line and an owner-builder
-- declaration are facts about the SITE, not about one application: they are the
-- same on the second permit as the first, and re-asking on every application is
-- how they end up answered differently on two permits for the same address.
--
-- valuation moves too. `estimated_value` was numeric -- float money, which
-- drifts -- and the 50% rule under FEMA compares a valuation against assessed
-- value, so a rounding error there decides whether a whole rebuild must meet
-- current flood code. Integer cents, like every other money column here.

alter table ocs.projects
  add column county text,

  -- Integer cents. See above: this number decides FEMA substantial improvement.
  add column valuation_cents bigint
    check (valuation_cents is null or valuation_cents >= 0),

  /*
   * An owner-builder pulls their own permit under the exemption in s.489.103(7)
   * F.S., which means no contractor is qualifying the work. It changes who is
   * responsible, so it belongs on the site rather than being re-declared per
   * application.
   */
  add column owner_builder boolean not null default false,

  add column flood_zone text,

  /*
   * Seaward of the coastal construction control line, Florida requires a
   * separate DEP permit on top of the local one. A project that is inside it
   * and not flagged is a job that stops on site.
   */
  add column coastal_construction_control_line boolean not null default false;

-- Carry across the values already collected, so nothing has to be re-entered.
update ocs.projects p
   set valuation_cents = round(p.estimated_value * 100)::bigint
 where p.estimated_value is not null and p.valuation_cents is null;

update ocs.projects p
   set county = m.county
  from ocs.municipalities m
 where m.id = p.municipality_id and p.county is null;

-- Take whatever the most recent application for this project already
-- established about the site.
update ocs.projects p
   set flood_zone = a.flood_zone,
       owner_builder = coalesce(a.is_owner_builder, false)
  from (
    select distinct on (project_id) project_id, flood_zone, is_owner_builder
      from ocs.permit_applications
     where project_id is not null
     order by project_id, created_at desc
  ) a
 where a.project_id = p.id and p.flood_zone is null;

create index projects_county_idx on ocs.projects (county) where deleted_at is null;

comment on column ocs.projects.estimated_value is
  'Superseded by valuation_cents. Kept so nothing reading it breaks; new code '
  'must use valuation_cents, because float money drifts and this number decides '
  'whether the FEMA 50% rule applies.';

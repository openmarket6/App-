-- 0029  The facts a document has to carry
--
-- Documents and their versions existed. What was missing is everything that
-- makes a document usable as EVIDENCE rather than as a file: when the camera
-- took the photograph, where it was taken, which revision superseded which, and
-- which correction cycle a submittal went in on.
--
-- Those are not decorations. A supervision photograph with no capture time
-- proves only that somebody uploaded a picture; with one it places a person on
-- a site on a date. And agencies genuinely ask which revision went in on which
-- cycle, so a system that cannot answer sends someone to look through email.

alter table ocs.documents
  /*
   * The camera's own timestamp, not when the file reached us. A supervisor who
   * photographs a roof at 9am and uploads at 6pm when they get signal has
   * evidence of a 9am visit -- but only if we keep the 9am.
   */
  add column captured_at timestamptz,

  -- Photo geotag, when the browser or EXIF supplied one. Null is ordinary and
  -- not a failure: plenty of devices decline, and a visit without a location is
  -- still a visit.
  add column geo_lat double precision,
  add column geo_lng double precision,

  -- Which revision this one replaces. Documents version rather than overwrite,
  -- because agencies ask which revision went on which cycle.
  add column supersedes_id uuid references ocs.documents (id) on delete set null,

  -- The correction cycle this document was submitted on, when it was.
  add column submitted_on_cycle int check (submitted_on_cycle is null or submitted_on_cycle >= 0),

  -- Which requirement this document satisfies, when it was uploaded against one.
  add column requirement_key text,

  add constraint documents_geo_is_a_pair check (
    (geo_lat is null) = (geo_lng is null)
  ),
  add constraint documents_geo_in_range check (
    geo_lat is null or (geo_lat between -90 and 90 and geo_lng between -180 and 180)
  );

-- A document supersedes at most one predecessor, and a predecessor is
-- superseded at most once. Two documents both claiming to replace the same
-- revision is two answers to "which is current".
create unique index documents_supersedes_once
  on ocs.documents (supersedes_id) where supersedes_id is not null;

create index documents_captured_idx on ocs.documents (captured_at)
  where captured_at is not null;

-- A document cannot supersede itself. Obvious, and the kind of thing that
-- reaches production through a copy-pasted id.
alter table ocs.documents
  add constraint documents_no_self_supersede check (supersedes_id is null or supersedes_id <> id);

-- =============================================================================
-- 0003  Drafting workflow, folders, documents and versions
-- =============================================================================

-- -----------------------------------------------------------------------------
-- drafting_orders -- a contractor's request for drafting work.
-- -----------------------------------------------------------------------------

create type ocs.drafting_status as enum (
  'requested',
  'accepted',
  'in_progress',
  'in_review',          -- internal QC
  'client_review',      -- with the contractor for approval
  'revision_requested',
  'approved',
  'delivered',
  'cancelled'
);

create type ocs.drafting_priority as enum ('low', 'normal', 'high', 'rush');

create table ocs.drafting_orders (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references ocs.companies (id) on delete cascade,
  project_id      uuid references ocs.projects (id) on delete set null,
  permit_id       uuid references ocs.permits (id) on delete set null,

  order_number    int not null,          -- per-company, assigned by trigger
  title           text not null check (length(btrim(title)) > 0),
  description     text,
  status          ocs.drafting_status not null default 'requested',
  priority        ocs.drafting_priority not null default 'normal',

  -- Internal OCS drafter this is assigned to (a platform_role <> 'none' user).
  assigned_to     uuid references ocs.app_users (id),
  assigned_at     timestamptz,

  requested_by    uuid references ocs.app_users (id),
  due_date        date,
  delivered_at    timestamptz,

  -- Current revision pointer is maintained by the API when a revision is added.
  current_revision int not null default 0,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,

  unique (company_id, order_number)
);

create index drafting_orders_company_status_idx
  on ocs.drafting_orders (company_id, status) where deleted_at is null;
create index drafting_orders_assigned_idx
  on ocs.drafting_orders (assigned_to, status) where deleted_at is null;
create index drafting_orders_project_idx on ocs.drafting_orders (project_id);
create index drafting_orders_permit_idx on ocs.drafting_orders (permit_id);

create trigger drafting_orders_set_updated_at
  before update on ocs.drafting_orders
  for each row execute function ocs.set_updated_at();

create or replace function ocs.assign_drafting_order_number() returns trigger
  language plpgsql
  set search_path = ocs, pg_temp
as $$
begin
  if new.order_number is null or new.order_number = 0 then
    perform pg_advisory_xact_lock(hashtext('drafting_order_number:' || new.company_id::text));
    select coalesce(max(order_number), 0) + 1
      into new.order_number
      from ocs.drafting_orders
     where company_id = new.company_id;
  end if;
  return new;
end;
$$;

create trigger drafting_orders_assign_number
  before insert on ocs.drafting_orders
  for each row execute function ocs.assign_drafting_order_number();

-- -----------------------------------------------------------------------------
-- drafting_revisions -- each issued version of a drawing set.
-- Revisions are immutable once superseded; a new revision is added rather than
-- editing an old one, so the approval history stays intact.
-- -----------------------------------------------------------------------------

create type ocs.revision_status as enum (
  'draft', 'submitted', 'approved', 'rejected', 'superseded'
);

create table ocs.drafting_revisions (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references ocs.companies (id) on delete cascade,
  drafting_order_id uuid not null references ocs.drafting_orders (id) on delete cascade,

  revision_number   int not null check (revision_number > 0),
  status            ocs.revision_status not null default 'draft',
  notes             text,

  submitted_by      uuid references ocs.app_users (id),
  submitted_at      timestamptz,
  reviewed_by       uuid references ocs.app_users (id),
  reviewed_at       timestamptz,
  rejection_reason  text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique (drafting_order_id, revision_number)
);

create index drafting_revisions_order_idx
  on ocs.drafting_revisions (drafting_order_id, revision_number desc);
create index drafting_revisions_company_idx on ocs.drafting_revisions (company_id);

create trigger drafting_revisions_set_updated_at
  before update on ocs.drafting_revisions
  for each row execute function ocs.set_updated_at();

-- Revisions inherit their company from the parent order (same reasoning as
-- permits.company_id in 0002).
create or replace function ocs.sync_revision_company() returns trigger
  language plpgsql
  set search_path = ocs, pg_temp
as $$
declare
  parent_company uuid;
begin
  select company_id into parent_company
    from ocs.drafting_orders where id = new.drafting_order_id;
  if parent_company is null then
    raise exception 'drafting order % not found', new.drafting_order_id;
  end if;
  new.company_id := parent_company;
  return new;
end;
$$;

create trigger drafting_revisions_sync_company
  before insert or update of drafting_order_id, company_id on ocs.drafting_revisions
  for each row execute function ocs.sync_revision_company();

-- -----------------------------------------------------------------------------
-- drafting_markups -- redline comments on a revision, and their resolution.
-- -----------------------------------------------------------------------------

create table ocs.drafting_markups (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references ocs.companies (id) on delete cascade,
  revision_id  uuid not null references ocs.drafting_revisions (id) on delete cascade,

  page_number  int check (page_number > 0),
  -- Normalised 0..1 coordinates so a markup pins correctly at any zoom/page size.
  position_x   numeric(6, 5) check (position_x between 0 and 1),
  position_y   numeric(6, 5) check (position_y between 0 and 1),

  body         text not null check (length(btrim(body)) > 0),
  is_resolved  boolean not null default false,
  resolved_by  uuid references ocs.app_users (id),
  resolved_at  timestamptz,

  created_by   uuid references ocs.app_users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index drafting_markups_revision_idx
  on ocs.drafting_markups (revision_id, created_at);
create index drafting_markups_company_idx on ocs.drafting_markups (company_id);

create trigger drafting_markups_set_updated_at
  before update on ocs.drafting_markups
  for each row execute function ocs.set_updated_at();

-- -----------------------------------------------------------------------------
-- folders -- hierarchical organisation, scoped to a project or a permit.
-- -----------------------------------------------------------------------------

create table ocs.folders (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references ocs.companies (id) on delete cascade,
  parent_id    uuid references ocs.folders (id) on delete cascade,

  -- A folder hangs off exactly one of project / permit, or neither (company root).
  project_id   uuid references ocs.projects (id) on delete cascade,
  permit_id    uuid references ocs.permits (id) on delete cascade,

  name         text not null check (length(btrim(name)) > 0),
  depth        int not null default 0 check (depth >= 0 and depth <= 10),
  is_system    boolean not null default false,   -- auto-created, cannot be renamed

  created_by   uuid references ocs.app_users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,

  constraint folders_single_owner check (
    (project_id is not null and permit_id is null)
    or (project_id is null and permit_id is not null)
    or (project_id is null and permit_id is null)
  )
);

-- Sibling names must be unique. Two partial indexes because NULL parent_id
-- would otherwise let duplicate top-level folder names through.
create unique index folders_unique_child_name
  on ocs.folders (company_id, parent_id, lower(name))
  where parent_id is not null and deleted_at is null;
create unique index folders_unique_root_name
  on ocs.folders (company_id, coalesce(project_id, permit_id), lower(name))
  where parent_id is null and deleted_at is null;

create index folders_parent_idx on ocs.folders (parent_id) where deleted_at is null;
create index folders_permit_idx on ocs.folders (permit_id) where deleted_at is null;
create index folders_project_idx on ocs.folders (project_id) where deleted_at is null;

create trigger folders_set_updated_at
  before update on ocs.folders
  for each row execute function ocs.set_updated_at();

-- Compute depth and refuse to create a cycle.
--
-- A cycle here would be unrecoverable through the UI: the folder tree would
-- recurse forever and the containing rows would be unreachable. Walking the
-- ancestor chain on write is cheap (depth is capped at 10) and makes the bad
-- state impossible rather than merely unlikely.
create or replace function ocs.folders_check_hierarchy() returns trigger
  language plpgsql
  set search_path = ocs, pg_temp
as $$
declare
  ancestor_id   uuid;
  parent_depth  int;
  parent_company uuid;
  hops          int := 0;
begin
  if new.parent_id is null then
    new.depth := 0;
    return new;
  end if;

  select depth, company_id into parent_depth, parent_company
    from ocs.folders where id = new.parent_id;

  if parent_depth is null then
    raise exception 'parent folder % not found', new.parent_id;
  end if;

  -- A folder may never be re-parented into another tenant.
  if parent_company <> new.company_id then
    raise exception 'cannot nest folder under a folder owned by another company';
  end if;

  new.depth := parent_depth + 1;

  -- Walk up from the proposed parent; if we meet ourselves, it is a cycle.
  ancestor_id := new.parent_id;
  while ancestor_id is not null loop
    if ancestor_id = new.id then
      raise exception 'folder hierarchy cycle detected at %', new.id;
    end if;
    hops := hops + 1;
    if hops > 20 then
      raise exception 'folder hierarchy too deep or already cyclic';
    end if;
    select parent_id into ancestor_id from ocs.folders where id = ancestor_id;
  end loop;

  return new;
end;
$$;

create trigger folders_check_hierarchy
  before insert or update of parent_id on ocs.folders
  for each row execute function ocs.folders_check_hierarchy();

-- -----------------------------------------------------------------------------
-- documents / document_versions
--
-- A `document` is the logical file (e.g. "Roof Plan"). Each upload creates a
-- `document_version` holding the actual object in Supabase Storage.
--
-- IMPORTANT: we store the bucket and object key, never a public URL. Buckets are
-- private; the API mints a short-lived signed URL per request. That way access
-- is re-checked on every download instead of leaking a permanent link into the
-- database, email, or a screenshot.
-- -----------------------------------------------------------------------------

create type ocs.document_category as enum (
  'permit_application',
  'approved_plan',
  'drawing',
  'correction_notice',
  'photo',
  'license',
  'insurance',
  'receipt',
  'invoice',
  'contract',
  'inspection_report',
  'correspondence',
  'other'
);

create type ocs.scan_status as enum ('pending', 'clean', 'infected', 'error', 'skipped');

create table ocs.documents (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references ocs.companies (id) on delete cascade,

  folder_id          uuid references ocs.folders (id) on delete set null,
  project_id         uuid references ocs.projects (id) on delete cascade,
  permit_id          uuid references ocs.permits (id) on delete cascade,
  drafting_order_id  uuid references ocs.drafting_orders (id) on delete cascade,
  drafting_revision_id uuid references ocs.drafting_revisions (id) on delete cascade,

  name               text not null check (length(btrim(name)) > 0),
  category           ocs.document_category not null default 'other',
  description        text,

  current_version_id uuid,          -- FK added after document_versions exists
  version_count      int not null default 0,

  -- Visible to the contractor in their portal. Internal working files stay false.
  is_client_visible  boolean not null default true,

  uploaded_by        uuid references ocs.app_users (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- Soft delete. A nightly job hard-deletes storage objects only after
  -- purge_after has passed, which is what makes "restore a deleted file" possible.
  deleted_at         timestamptz,
  deleted_by         uuid references ocs.app_users (id),
  purge_after        timestamptz
);

create index documents_company_idx on ocs.documents (company_id, created_at desc)
  where deleted_at is null;
create index documents_folder_idx on ocs.documents (folder_id) where deleted_at is null;
create index documents_permit_idx on ocs.documents (permit_id) where deleted_at is null;
create index documents_project_idx on ocs.documents (project_id) where deleted_at is null;
create index documents_category_idx on ocs.documents (company_id, category)
  where deleted_at is null;
create index documents_purge_idx on ocs.documents (purge_after)
  where deleted_at is not null;

create trigger documents_set_updated_at
  before update on ocs.documents
  for each row execute function ocs.set_updated_at();

create table ocs.document_versions (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references ocs.companies (id) on delete cascade,
  document_id    uuid not null references ocs.documents (id) on delete cascade,

  version_number int not null check (version_number > 0),

  -- Supabase Storage coordinates. Never a public URL.
  storage_bucket text not null,
  storage_key    text not null,

  file_name      text not null,
  content_type   text not null,
  byte_size      bigint not null check (byte_size >= 0),
  checksum_sha256 text,

  -- Uploads are direct-to-storage via a signed upload URL, so the row exists
  -- before the bytes land. Until the client confirms, it is not downloadable.
  upload_state   text not null default 'pending'
                   check (upload_state in ('pending', 'uploaded', 'failed')),
  uploaded_at    timestamptz,

  scan_status    ocs.scan_status not null default 'pending',
  scan_result    text,
  scanned_at     timestamptz,

  -- EXIF / capture metadata for site photos (taken_at, gps, device...).
  metadata       jsonb not null default '{}'::jsonb,

  uploaded_by    uuid references ocs.app_users (id),
  created_at     timestamptz not null default now(),

  unique (document_id, version_number),
  unique (storage_bucket, storage_key)
);

create index document_versions_document_idx
  on ocs.document_versions (document_id, version_number desc);
create index document_versions_company_idx on ocs.document_versions (company_id);
create index document_versions_scan_idx on ocs.document_versions (scan_status)
  where scan_status = 'pending';

alter table ocs.documents
  add constraint documents_current_version_fk
  foreign key (current_version_id) references ocs.document_versions (id)
  on delete set null;

create or replace function ocs.sync_document_version_company() returns trigger
  language plpgsql
  set search_path = ocs, pg_temp
as $$
declare
  parent_company uuid;
begin
  select company_id into parent_company from ocs.documents where id = new.document_id;
  if parent_company is null then
    raise exception 'document % not found', new.document_id;
  end if;
  new.company_id := parent_company;
  return new;
end;
$$;

create trigger document_versions_sync_company
  before insert or update of document_id, company_id on ocs.document_versions
  for each row execute function ocs.sync_document_version_company();

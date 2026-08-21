-- =============================================================================
-- 0005  Client communications and notifications
-- =============================================================================

-- -----------------------------------------------------------------------------
-- message_threads -- a conversation, optionally anchored to a record.
-- -----------------------------------------------------------------------------

create table ocs.message_threads (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references ocs.companies (id) on delete cascade,

  project_id        uuid references ocs.projects (id) on delete cascade,
  permit_id         uuid references ocs.permits (id) on delete cascade,
  drafting_order_id uuid references ocs.drafting_orders (id) on delete cascade,

  subject           text not null check (length(btrim(subject)) > 0),
  is_closed         boolean not null default false,

  -- Denormalised so a thread list renders without a per-row aggregate.
  last_message_at   timestamptz,
  message_count     int not null default 0,

  created_by        uuid references ocs.app_users (id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index message_threads_company_idx
  on ocs.message_threads (company_id, last_message_at desc nulls last);
create index message_threads_permit_idx on ocs.message_threads (permit_id);
create index message_threads_project_idx on ocs.message_threads (project_id);

create trigger message_threads_set_updated_at
  before update on ocs.message_threads
  for each row execute function ocs.set_updated_at();

-- -----------------------------------------------------------------------------
-- messages
-- -----------------------------------------------------------------------------

create table ocs.messages (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references ocs.companies (id) on delete cascade,
  thread_id    uuid not null references ocs.message_threads (id) on delete cascade,

  body         text not null check (length(btrim(body)) > 0),

  -- Internal notes are visible only to OCS staff, never to the contractor.
  -- The API filters on this for any non-staff caller; see routes/messages.ts.
  is_internal  boolean not null default false,

  author_id    uuid references ocs.app_users (id),
  author_name  text,          -- denormalised so history survives user deletion

  edited_at    timestamptz,
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz
);

create index messages_thread_idx on ocs.messages (thread_id, created_at)
  where deleted_at is null;
create index messages_company_idx on ocs.messages (company_id, created_at desc);

create or replace function ocs.sync_message_company() returns trigger
  language plpgsql
  set search_path = ocs, pg_temp
as $$
declare
  parent_company uuid;
begin
  select company_id into parent_company
    from ocs.message_threads where id = new.thread_id;
  if parent_company is null then
    raise exception 'thread % not found', new.thread_id;
  end if;
  new.company_id := parent_company;
  return new;
end;
$$;

create trigger messages_sync_company
  before insert or update of thread_id, company_id on ocs.messages
  for each row execute function ocs.sync_message_company();

-- Keep the thread's denormalised counters honest.
create or replace function ocs.bump_thread_counters() returns trigger
  language plpgsql
  set search_path = ocs, pg_temp
as $$
begin
  update ocs.message_threads
     set last_message_at = greatest(coalesce(last_message_at, new.created_at), new.created_at),
         message_count   = message_count + 1
   where id = new.thread_id;
  return new;
end;
$$;

create trigger messages_bump_thread
  after insert on ocs.messages
  for each row execute function ocs.bump_thread_counters();

-- -----------------------------------------------------------------------------
-- message_attachments -- links a message to an already-uploaded document.
-- -----------------------------------------------------------------------------

create table ocs.message_attachments (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references ocs.companies (id) on delete cascade,
  message_id  uuid not null references ocs.messages (id) on delete cascade,
  document_id uuid not null references ocs.documents (id) on delete cascade,
  created_at  timestamptz not null default now(),

  unique (message_id, document_id)
);

create index message_attachments_company_idx on ocs.message_attachments (company_id);

-- -----------------------------------------------------------------------------
-- notifications -- in-app notification feed, one row per recipient.
-- -----------------------------------------------------------------------------

create type ocs.notification_kind as enum (
  'permit_status_changed',
  'permit_expiring',
  'corrections_required',
  'drafting_assigned',
  'drafting_ready_for_review',
  'drafting_approved',
  'document_uploaded',
  'license_expiring',
  'insurance_expiring',
  'message_received',
  'payment_succeeded',
  'payment_failed',
  'system'
);

create table ocs.notifications (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references ocs.companies (id) on delete cascade,
  user_id      uuid not null references ocs.app_users (id) on delete cascade,

  kind         ocs.notification_kind not null,
  title        text not null,
  body         text,

  entity_type  text,
  entity_id    uuid,
  link_path    text,          -- frontend route, e.g. /permits/<id>

  read_at      timestamptz,
  created_at   timestamptz not null default now()
);

create index notifications_user_unread_idx
  on ocs.notifications (user_id, created_at desc) where read_at is null;
create index notifications_company_idx on ocs.notifications (company_id, created_at desc);

-- -----------------------------------------------------------------------------
-- notification_deliveries -- outbound email/SMS attempts.
--
-- Separate from `notifications` because delivery is a different concern with its
-- own retry state: the in-app notification is created once and always succeeds,
-- while the email may bounce, retry, and eventually fail. Keeping them apart
-- means a failing mail provider never blocks the in-app feed.
-- -----------------------------------------------------------------------------

create type ocs.delivery_channel as enum ('email', 'sms', 'webhook');
create type ocs.delivery_status as enum ('queued', 'sent', 'delivered', 'bounced', 'failed');

create table ocs.notification_deliveries (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid references ocs.companies (id) on delete cascade,
  notification_id uuid references ocs.notifications (id) on delete cascade,

  channel         ocs.delivery_channel not null,
  destination     text not null,        -- email address or E.164 number
  status          ocs.delivery_status not null default 'queued',

  provider        text,
  provider_message_id text,
  error_message   text,
  attempts        int not null default 0,

  queued_at       timestamptz not null default now(),
  sent_at         timestamptz,
  updated_at      timestamptz not null default now()
);

create index notification_deliveries_status_idx
  on ocs.notification_deliveries (status, queued_at)
  where status in ('queued', 'failed');
create index notification_deliveries_company_idx
  on ocs.notification_deliveries (company_id, queued_at desc);

create trigger notification_deliveries_set_updated_at
  before update on ocs.notification_deliveries
  for each row execute function ocs.set_updated_at();

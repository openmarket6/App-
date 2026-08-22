-- 0018  Support tickets
--
-- THE ONE THING THIS MIGRATION EXISTS TO GET RIGHT
--
-- A ticket carries two kinds of message: what was said TO the contractor, and
-- what staff said to each other about them. The second kind is candid -- "this
-- client keeps submitting the same wrong drawings", "waive the fee, they are
-- threatening to leave" -- and showing it to the contractor is a business
-- catastrophe, not a bug report.
--
-- The previous implementation filtered internal messages in application code,
-- in a function every route had to remember to call. That works until one route
-- forgets. Here the database refuses to return them: a contractor's row-level
-- security policy simply does not match an internal message, so no query
-- written by anyone can retrieve one in tenant context.

create type ocs.ticket_status as enum (
  'open',
  'in_progress',      -- staff are working it
  'waiting_client',   -- the ball is with the contractor
  'resolved'
);

create type ocs.ticket_priority as enum ('low', 'normal', 'high', 'urgent');

create table ocs.support_tickets (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references ocs.companies (id) on delete cascade,

  -- Human-quotable. "Ticket 8f3a-92c1" is unusable on a phone call.
  reference     text not null unique,

  permit_id     uuid references ocs.permits (id) on delete set null,
  subject       text not null check (length(btrim(subject)) between 1 and 300),
  status        ocs.ticket_status not null default 'open',
  priority      ocs.ticket_priority not null default 'normal',

  opened_by     uuid references ocs.app_users (id),
  assigned_to   uuid references ocs.app_users (id),

  resolved_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Keeps the timestamp honest in both directions: a resolved ticket has a
  -- resolution time, and an unresolved one does not keep a stale one from
  -- before it was reopened.
  constraint tickets_resolved_at_matches_status
    check ((status = 'resolved') = (resolved_at is not null))
);

create index support_tickets_company_idx
  on ocs.support_tickets (company_id, updated_at desc);
-- Drives the staff queue: open work, most urgent first.
create index support_tickets_queue_idx
  on ocs.support_tickets (priority desc, updated_at)
  where status <> 'resolved';
create index support_tickets_permit_idx
  on ocs.support_tickets (permit_id) where permit_id is not null;

create trigger support_tickets_set_updated_at
  before update on ocs.support_tickets
  for each row execute function ocs.set_updated_at();

-- A short, readable reference assigned by the database, so two tickets opened
-- at the same instant cannot collide the way application-generated ones do.
create sequence ocs.support_ticket_seq start 1000;

create or replace function ocs.assign_ticket_reference() returns trigger
  language plpgsql set search_path = ocs, pg_temp
as $$
begin
  if new.reference is null or btrim(new.reference) = '' then
    new.reference := 'TKT-' || lpad(nextval('ocs.support_ticket_seq')::text, 6, '0');
  end if;
  return new;
end;
$$;

create trigger support_tickets_reference
  before insert on ocs.support_tickets
  for each row execute function ocs.assign_ticket_reference();

-- -----------------------------------------------------------------------------
-- support_messages
-- -----------------------------------------------------------------------------

create table ocs.support_messages (
  id             uuid primary key default gen_random_uuid(),
  ticket_id      uuid not null references ocs.support_tickets (id) on delete cascade,
  -- Denormalised from the ticket so the RLS policy is a column comparison
  -- rather than a subquery, and kept true by the trigger below.
  company_id     uuid not null references ocs.companies (id) on delete cascade,

  author_user_id uuid references ocs.app_users (id),
  body           text not null check (length(btrim(body)) between 1 and 20000),

  -- The load-bearing column. See the note at the top of this file.
  is_internal    boolean not null default false,

  /*
   * The message that IS the ticket, rather than a reply to it.
   *
   * Explicit rather than inferred. The obvious inference -- "this is the
   * opening message if no other message exists yet" -- is wrong, because
   * PostgreSQL fires AFTER ROW triggers at the END of the statement. In a
   * multi-row insert the first message can already see the second and
   * concludes it is a reply to something written after it.
   */
  is_opening     boolean not null default false,

  created_at     timestamptz not null default now()
);

create index support_messages_ticket_idx
  on ocs.support_messages (ticket_id, created_at);

-- A ticket is stated once. A second opening message would mean two different
-- accounts of what the ticket is about.
create unique index support_messages_one_opening
  on ocs.support_messages (ticket_id) where is_opening;

create or replace function ocs.sync_support_message_company() returns trigger
  language plpgsql set search_path = ocs, pg_temp
as $$
declare
  parent_company uuid;
begin
  select company_id into parent_company from ocs.support_tickets where id = new.ticket_id;
  if parent_company is null then
    raise exception 'support ticket % not found', new.ticket_id;
  end if;
  new.company_id := parent_company;
  return new;
end;
$$;

create trigger support_messages_sync_company
  before insert or update of ticket_id, company_id on ocs.support_messages
  for each row execute function ocs.sync_support_message_company();

/*
 * Move the ticket along when someone replies.
 *
 * In a trigger rather than the route, because the status is a statement about
 * whose turn it is, and that must follow from the message actually being
 * written. A route that inserts a message and then forgets to update the status
 * leaves a ticket that looks handled and is not.
 *
 * An internal note changes nothing: staff talking to each other does not move
 * the ball, and marking a ticket "waiting on client" because of a note the
 * client cannot see would leave it stuck forever.
 */
create or replace function ocs.advance_ticket_on_message() returns trigger
  language plpgsql set search_path = ocs, pg_temp
as $$
declare
  author_role ocs.app_role;
begin
  update ocs.support_tickets set updated_at = now() where id = new.ticket_id;

  if new.is_internal then
    return new;
  end if;

  /*
   * The opening message does not move the ticket.
   *
   * It is the ticket being stated, not a reply to it. Advancing on it would
   * mark a brand-new ticket "waiting on the client" the moment staff raise one
   * on a contractor's behalf, or "in progress" the moment a contractor opens
   * one -- claiming work is under way before anybody has read it.
   */
  if new.is_opening then
    return new;
  end if;

  select app_role into author_role from ocs.app_users where id = new.author_user_id;

  update ocs.support_tickets
     set status = case
                    -- A resolved ticket that gets a new message is reopened:
                    -- the conversation evidently was not finished.
                    when author_role = 'CLIENT' then 'in_progress'::ocs.ticket_status
                    else 'waiting_client'::ocs.ticket_status
                  end,
         resolved_at = null
   where id = new.ticket_id;

  return new;
end;
$$;

create trigger support_messages_advance_ticket
  after insert on ocs.support_messages
  for each row execute function ocs.advance_ticket_on_message();

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------

alter table ocs.support_tickets enable row level security;
alter table ocs.support_tickets force row level security;

create policy tenant_isolation on ocs.support_tickets
  for all to ocs_app, ocs_service
  using (company_id = ocs.current_company_id() or ocs.is_service_context())
  with check (company_id = ocs.current_company_id() or ocs.is_service_context());

grant select, insert, update, delete on ocs.support_tickets to ocs_app, ocs_service;
grant usage on sequence ocs.support_ticket_seq to ocs_app, ocs_service;

alter table ocs.support_messages enable row level security;
alter table ocs.support_messages force row level security;

/*
 * The important policy in this file.
 *
 * A contractor reads their own ticket's messages EXCEPT the internal ones.
 * Staff work in service context and see everything. There is no code path that
 * can return an internal note to a contractor, because the row is not visible
 * to the query that would have to fetch it.
 *
 * Note the asymmetry between USING and WITH CHECK: a contractor cannot write an
 * internal message either. Otherwise a portal user could post one, watch it
 * vanish from their own view, and use the endpoint to pass invisible messages
 * into staff conversations.
 */
create policy tenant_read on ocs.support_messages
  for select to ocs_app, ocs_service
  using (
    ocs.is_service_context()
    or (company_id = ocs.current_company_id() and not is_internal)
  );

create policy tenant_write on ocs.support_messages
  for insert to ocs_app, ocs_service
  with check (
    ocs.is_service_context()
    or (company_id = ocs.current_company_id() and not is_internal)
  );

grant select, insert on ocs.support_messages to ocs_app, ocs_service;

-- =============================================================================
-- 0034  Mailing an instrument, and proving it went
-- =============================================================================
--
-- For a Notice to Owner, service IS the point. A notice written perfectly and
-- produced perfectly is worth nothing if nobody can show it was served. So this
-- table is not a log of outbound post -- it is the evidence, and it is shaped
-- like evidence.
--
--   ONE ROW PER RECIPIENT. "We served the owner and the contractor" is two
--   facts. They are proved separately, they can fail separately, and a single
--   row covering both could not say which one came back undelivered.
--
--   THE ADDRESS IS FROZEN. Stored on the row rather than joined from the
--   contractor record, because a lien dispute asks where the letter WENT, and
--   the contractor's address on file will have been edited three times by then.
--
--   PROVIDER EVENTS ARE APPENDED, NEVER OVERWRITTEN. "In transit" then
--   "delivered" then "returned to sender" is a story. Keeping only the latest
--   status would throw away the dates the story turns on.
--
--   MONEY IS RECORDED AS BILLED. `expected_cost_cents` is what the screen
--   promised; `charged_cost_cents` is what the provider actually took. A gap
--   between them is a price change we should notice rather than absorb.

create type ocs.mail_class as enum (
  'first_class',
  'certified',
  'certified_return_receipt'
);

create type ocs.mail_recipient_role as enum (
  'owner', 'contractor', 'lender', 'claimant', 'other'
);

/*
 * The lifecycle of one letter.
 *
 * `queued` and `submitted` are deliberately distinct: queued means we intend to
 * send and have taken the money decision; submitted means the provider has it.
 * A crash between the two must be visible as a letter that was paid for and
 * never posted, not as a silent nothing.
 */
create type ocs.mail_status as enum (
  'queued',
  'submitted',
  'in_transit',
  'delivered',
  'returned',        -- came back undelivered; on an NTO this is a failed service
  'failed',          -- the provider refused it (bad address, undeliverable)
  'cancelled'
);

create table ocs.document_mailings (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references ocs.companies (id) on delete cascade,

  generated_document_id uuid not null
    references ocs.generated_documents (id) on delete cascade,

  recipient_role ocs.mail_recipient_role not null default 'other',
  mail_class     ocs.mail_class not null,
  status         ocs.mail_status not null default 'queued',

  -- Frozen at the moment of sending. See the note above.
  to_name        text not null check (length(btrim(to_name)) > 0),
  to_line1       text not null check (length(btrim(to_line1)) > 0),
  to_line2       text,
  to_city        text not null check (length(btrim(to_city)) > 0),
  to_state       text not null check (to_state ~ '^[A-Z]{2}$'),
  to_postal_code text not null check (to_postal_code ~ '^\d{5}(-\d{4})?$'),
  to_country     text not null default 'US',

  from_name      text not null check (length(btrim(from_name)) > 0),
  from_line1     text not null,
  from_line2     text,
  from_city      text not null,
  from_state     text not null check (from_state ~ '^[A-Z]{2}$'),
  from_postal_code text not null check (from_postal_code ~ '^\d{5}(-\d{4})?$'),
  from_country   text not null default 'US',

  -- The provider's own identifier, and the number a person can type into a
  -- tracking page. Unique so a redelivered webhook cannot create a second row.
  provider       text not null default 'lob',
  provider_id    text,
  tracking_number text,

  expected_cost_cents int not null check (expected_cost_cents >= 0),
  charged_cost_cents  int check (charged_cost_cents is null or charged_cost_cents >= 0),

  /*
   * What the provider said about the address BEFORE we spent anything.
   *
   * An undeliverable address on a Notice to Owner is a failed service nobody
   * notices until the return-to-sender arrives, by which point the window has
   * closed. Checking first is cheap; the result is kept because "we checked and
   * it verified" is itself worth being able to say.
   */
  address_verified boolean,
  address_verification jsonb not null default '{}'::jsonb,

  -- Appended, never replaced. Each entry: {at, status, detail}.
  events         jsonb not null default '[]'::jsonb,

  submitted_at   timestamptz,
  delivered_at   timestamptz,
  returned_at    timestamptz,
  expected_delivery_on date,

  last_error     text,

  requested_by   uuid references ocs.app_users (id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  /*
   * A letter the provider has cannot claim to have no provider id, and one that
   * arrived cannot claim to have never been sent. Both are states that only
   * arise from a bug, and both would read as ordinary rows in a report.
   */
  constraint mailings_submitted_has_provider_id check (
    status in ('queued', 'failed', 'cancelled') or provider_id is not null
  ),
  constraint mailings_delivered_has_a_date check (
    status <> 'delivered' or delivered_at is not null
  ),
  constraint mailings_returned_has_a_date check (
    status <> 'returned' or returned_at is not null
  )
);

-- One provider letter, one row. This is what makes a redelivered webhook a
-- no-op rather than a duplicate record of a letter that was sent once.
create unique index document_mailings_provider_id_idx
  on ocs.document_mailings (provider, provider_id)
  where provider_id is not null;

create index document_mailings_document_idx
  on ocs.document_mailings (generated_document_id, created_at desc);
create index document_mailings_company_idx
  on ocs.document_mailings (company_id, created_at desc);
create index document_mailings_status_idx
  on ocs.document_mailings (status) where status in ('queued', 'submitted', 'in_transit');

create trigger document_mailings_set_updated_at
  before update on ocs.document_mailings
  for each row execute function ocs.set_updated_at();

comment on table ocs.document_mailings is
  'One row per RECIPIENT per document. Service of a Notice to Owner has to be '
  'provable per person, so a single row covering several recipients could not '
  'say which one failed.';
comment on column ocs.document_mailings.events is
  'Appended, never replaced. In-transit then delivered then returned is a '
  'story, and only the latest status would throw away the dates it turns on.';
comment on column ocs.document_mailings.to_line1 is
  'Frozen at send time. A dispute asks where the letter WENT, and the address '
  'on the contractor record will have been edited by then.';

alter table ocs.document_mailings enable row level security;
alter table ocs.document_mailings force row level security;

create policy tenant_isolation on ocs.document_mailings
  for all
  to ocs_app, ocs_service
  using (company_id = ocs.current_company_id() or ocs.is_service_context())
  with check (company_id = ocs.current_company_id() or ocs.is_service_context());

grant select, insert, update on ocs.document_mailings to ocs_app, ocs_service;

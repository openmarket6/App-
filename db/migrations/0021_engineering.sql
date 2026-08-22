-- 0021  Engineering: deliverables, quotes, and the seal
--
-- Drafting already had orders, revisions and page markups. What it had no
-- concept of is the thing that makes this work legally meaningful: a licensed
-- engineer signing and sealing a drawing.
--
-- A seal is a legal act, like a notarial one. The engineer is staking their
-- licence on the statement that this drawing is sound, and the record of it
-- either stands up when a building official or a plaintiff's lawyer asks, or it
-- does not. So the seal is modelled with the same care as notarization in 0019:
-- the licence details are copied onto the record, an expired licence cannot
-- seal, and a sealed record cannot be rewritten afterwards.
--
-- The other addition is money. Drafting is quoted per job and approved before
-- work starts, so the quote is part of the order's state machine rather than a
-- note somebody keeps in email -- and work that begins before approval is a
-- conversation nobody wants to have about who agreed to what.

-- Added here, used from 0022 onward. PostgreSQL will not let a new enum value
-- be USED in the transaction that adds it, and each migration runs in one.
alter type ocs.app_role add value if not exists 'ENGINEER';

-- -----------------------------------------------------------------------------
-- What we produce
-- -----------------------------------------------------------------------------

create type ocs.deliverable_type as enum (
  'plan_set',              -- full permit submittal set
  'structural_calcs',
  'truss_layout',
  'wind_load_calcs',       -- ASCE 7 pressures, exposure and risk category
  'hvhz_product_approval', -- Miami-Dade NOA / Florida Product Approval sheets
  'energy_calcs',          -- Florida Energy Conservation Code forms
  'site_plan',
  'fema_worksheet',        -- substantial improvement, the 50% rule
  'noc_preparation',
  'other'
);

create type ocs.engineer_license_type as enum (
  'PE',      -- professional engineer
  'RA',      -- registered architect
  'other'
);

create type ocs.quote_status as enum (
  'none',      -- no quote needed; work may start
  'draft',
  'sent',
  'approved',
  'rejected',
  'expired'
);

-- -----------------------------------------------------------------------------
-- engineers
--
-- Separate from app_users for the same reason supervisors are: the licence is
-- the qualification, and it has its own lifecycle. A person may leave, or their
-- licence may lapse, without either fact disturbing the drawings they already
-- sealed.
-- -----------------------------------------------------------------------------

create table ocs.engineers (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid unique references ocs.app_users (id) on delete set null,

  display_name  text not null check (length(btrim(display_name)) > 0),
  license_type  ocs.engineer_license_type not null default 'PE',
  license_number text not null check (length(btrim(license_number)) > 0),
  license_state  text not null default 'FL' check (length(license_state) = 2),
  license_expires_on date not null,

  -- What this engineer will seal. A structural engineer sealing an electrical
  -- drawing is outside their competence, and the seal is a personal statement.
  disciplines   text[] not null default '{}',

  -- Capacity, so an admin assigning work can see who is already loaded.
  max_active_orders int not null default 15 check (max_active_orders between 1 and 200),

  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (license_type, license_number, license_state)
);

create index engineers_active_idx on ocs.engineers (is_active) where is_active;
create index engineers_expiry_idx on ocs.engineers (license_expires_on) where is_active;

create trigger engineers_set_updated_at
  before update on ocs.engineers
  for each row execute function ocs.set_updated_at();

-- Not tenant data: our engineers are ours, visible to staff across contractors.
alter table ocs.engineers enable row level security;
alter table ocs.engineers force row level security;

create policy engineers_read on ocs.engineers
  for select to ocs_app, ocs_service using (true);
create policy engineers_write on ocs.engineers
  for all to ocs_app, ocs_service
  using (ocs.is_service_context()) with check (ocs.is_service_context());

grant select, insert, update on ocs.engineers to ocs_app, ocs_service;

-- -----------------------------------------------------------------------------
-- drafting_orders: the quote, and who is doing the work
-- -----------------------------------------------------------------------------

alter table ocs.drafting_orders
  add column engineer_id   uuid references ocs.engineers (id) on delete set null,

  add column quote_status  ocs.quote_status not null default 'none',
  add column quoted_cents  int check (quoted_cents is null or quoted_cents >= 0),
  add column quote_note    text,
  add column quoted_by     uuid references ocs.app_users (id),
  add column quoted_at     timestamptz,
  add column quote_expires_on date,

  add column quote_approved_by uuid references ocs.app_users (id),
  add column quote_approved_at timestamptz,
  add column quote_rejected_reason text,

  add column accepted_at   timestamptz,
  add column started_at    timestamptz,

  -- A sent quote names a price. "We will quote you something" is not a quote.
  add constraint drafting_quote_has_amount
    check (quote_status not in ('sent', 'approved') or quoted_cents is not null),

  -- An approved quote records who approved it and when, or it is not evidence
  -- of anything.
  add constraint drafting_quote_approval_complete
    check ((quote_status = 'approved') = (quote_approved_at is not null));

create index drafting_orders_engineer_idx
  on ocs.drafting_orders (engineer_id, due_date)
  where deleted_at is null and status not in ('delivered', 'cancelled');

create index drafting_orders_awaiting_quote_idx
  on ocs.drafting_orders (created_at)
  where deleted_at is null and quote_status in ('draft', 'sent');

/*
 * Work does not start before the quote is approved.
 *
 * The whole point of quoting per job is that both sides agree the price first.
 * An order that slips into progress on an unapproved quote produces the
 * argument this process exists to prevent -- work done, invoice sent, customer
 * saying they never agreed to it.
 *
 * quote_status 'none' means no quote was required, which is a deliberate
 * decision someone made, not an absence.
 */
create or replace function ocs.check_drafting_work_authorised() returns trigger
  language plpgsql set search_path = ocs, pg_temp
as $$
begin
  if new.status not in ('in_progress', 'in_review', 'client_review', 'approved', 'delivered') then
    return new;
  end if;

  if new.quote_status in ('draft', 'sent') then
    raise exception
      'this order cannot start: its quote is % and has not been approved', new.quote_status;
  end if;

  if new.quote_status = 'rejected' then
    raise exception 'this order cannot start: the quote was rejected';
  end if;

  if new.started_at is null then
    new.started_at := now();
  end if;

  return new;
end;
$$;

create trigger drafting_orders_work_authorised
  before insert or update of status on ocs.drafting_orders
  for each row execute function ocs.check_drafting_work_authorised();

/*
 * An approved price is fixed.
 *
 * Re-quoting after approval, without the customer approving again, is how a job
 * quietly becomes more expensive than what was agreed. A genuine change of
 * scope moves the quote back to 'draft' first, which re-opens the approval.
 */
create or replace function ocs.protect_approved_quote() returns trigger
  language plpgsql set search_path = ocs, pg_temp
as $$
begin
  if old.quote_status <> 'approved' then
    return new;
  end if;

  if new.quote_status = 'approved'
     and new.quoted_cents is distinct from old.quoted_cents then
    raise exception
      'an approved quote cannot be re-priced (% -> %); move it back to draft and have it approved again',
      old.quoted_cents, new.quoted_cents;
  end if;

  return new;
end;
$$;

create trigger drafting_orders_protect_quote
  before update on ocs.drafting_orders
  for each row execute function ocs.protect_approved_quote();

-- -----------------------------------------------------------------------------
-- drafting_deliverables -- what this order is actually producing
-- -----------------------------------------------------------------------------

create table ocs.drafting_deliverables (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references ocs.companies (id) on delete cascade,
  drafting_order_id uuid not null references ocs.drafting_orders (id) on delete cascade,

  type          ocs.deliverable_type not null,
  description   text,

  -- Whether this one has to exist before the order can be delivered. A truss
  -- layout that was quoted and then quietly not produced is a permit rejection
  -- three weeks later.
  is_required   boolean not null default true,

  document_id   uuid references ocs.documents (id) on delete set null,
  delivered_at  timestamptz,

  -- Set when this deliverable must carry an engineer's seal. Calculations
  -- almost always must; a site plan often need not.
  requires_seal boolean not null default false,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index drafting_deliverables_order_idx
  on ocs.drafting_deliverables (drafting_order_id);

create trigger drafting_deliverables_set_updated_at
  before update on ocs.drafting_deliverables
  for each row execute function ocs.set_updated_at();

create or replace function ocs.sync_deliverable_company() returns trigger
  language plpgsql set search_path = ocs, pg_temp
as $$
declare
  parent_company uuid;
begin
  select company_id into parent_company from ocs.drafting_orders where id = new.drafting_order_id;
  if parent_company is null then
    raise exception 'drafting order % not found', new.drafting_order_id;
  end if;
  new.company_id := parent_company;
  return new;
end;
$$;

create trigger drafting_deliverables_sync_company
  before insert or update of drafting_order_id, company_id on ocs.drafting_deliverables
  for each row execute function ocs.sync_deliverable_company();

-- -----------------------------------------------------------------------------
-- document_seals -- an engineer staking their licence on a drawing
-- -----------------------------------------------------------------------------

create table ocs.document_seals (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references ocs.companies (id) on delete cascade,

  document_id   uuid not null references ocs.documents (id) on delete cascade,
  -- The exact version sealed. A seal that floats to "the latest version" is
  -- worthless: the engineer sealed a specific drawing, not a moving target.
  document_version_id uuid references ocs.document_versions (id) on delete set null,

  engineer_id   uuid references ocs.engineers (id) on delete set null,

  /*
   * Copied, not referenced. A licence later renewed, transferred, suspended or
   * revoked must not change what this record says about the act performed on
   * the day it was performed.
   */
  sealed_by_name text not null check (length(btrim(sealed_by_name)) > 0),
  license_type   ocs.engineer_license_type not null,
  license_number text not null check (length(btrim(license_number)) > 0),
  license_state  text not null check (length(license_state) = 2),
  license_expires_on date,

  sealed_at     timestamptz not null default now(),
  -- Where the sealed artefact lives, if the seal was applied by an external
  -- signing tool rather than produced here.
  seal_reference text,
  note          text,

  created_at    timestamptz not null default now()
);

create index document_seals_document_idx on ocs.document_seals (document_id, sealed_at desc);
create index document_seals_engineer_idx on ocs.document_seals (engineer_id, sealed_at desc);

-- One seal per document version. A second would mean two engineers each
-- believing they were the one who took responsibility.
create unique index document_seals_one_per_version
  on ocs.document_seals (document_version_id)
  where document_version_id is not null;

create or replace function ocs.sync_seal_company() returns trigger
  language plpgsql set search_path = ocs, pg_temp
as $$
declare
  doc_company uuid;
begin
  select company_id into doc_company from ocs.documents where id = new.document_id;
  if doc_company is null then
    raise exception 'document % not found', new.document_id;
  end if;
  new.company_id := doc_company;
  return new;
end;
$$;

create trigger document_seals_sync_company
  before insert or update of document_id, company_id on ocs.document_seals
  for each row execute function ocs.sync_seal_company();

/*
 * A seal applied after the licence expired is void.
 *
 * Exactly the notary rule in 0019, and for the same reason: discovering it in
 * litigation years later costs incomparably more than refusing it now. A
 * building official who spots it rejects the permit; a plaintiff's lawyer who
 * spots it has found the whole defence.
 */
create or replace function ocs.check_seal_licence() returns trigger
  language plpgsql set search_path = ocs, pg_temp
as $$
begin
  if new.license_expires_on is not null
     and new.sealed_at::date > new.license_expires_on then
    raise exception
      'the % licence % expired on % and cannot seal a drawing dated %',
      new.license_type, new.license_number, new.license_expires_on, new.sealed_at::date;
  end if;
  return new;
end;
$$;

create trigger document_seals_check_licence
  before insert or update on ocs.document_seals
  for each row execute function ocs.check_seal_licence();

/*
 * A seal is a finished record.
 *
 * Only the note and the external reference may be amended afterwards -- a
 * signing tool often returns its reference after the fact. Everything about WHO
 * sealed WHAT and WHEN is fixed. An amendment would be a different act, and
 * would need its own seal.
 */
create or replace function ocs.protect_seal() returns trigger
  language plpgsql set search_path = ocs, pg_temp
as $$
begin
  if new.document_id is distinct from old.document_id
     or new.document_version_id is distinct from old.document_version_id
     or new.company_id is distinct from old.company_id
     or new.sealed_by_name is distinct from old.sealed_by_name
     or new.license_type is distinct from old.license_type
     or new.license_number is distinct from old.license_number
     or new.license_state is distinct from old.license_state
     or new.license_expires_on is distinct from old.license_expires_on
     or new.sealed_at is distinct from old.sealed_at then
    raise exception
      'a seal is a finished record; only its note and external reference may be amended';
  end if;
  return new;
end;
$$;

create trigger document_seals_protect
  before update on ocs.document_seals
  for each row execute function ocs.protect_seal();

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['drafting_deliverables', 'document_seals']
  loop
    execute format('alter table ocs.%I enable row level security', t);
    execute format('alter table ocs.%I force row level security', t);
    execute format($f$
      create policy tenant_isolation on ocs.%I
        for all to ocs_app, ocs_service
        using (company_id = ocs.current_company_id() or ocs.is_service_context())
        with check (company_id = ocs.current_company_id() or ocs.is_service_context())
    $f$, t);
  end loop;
end
$$;

grant select, insert, update, delete on ocs.drafting_deliverables to ocs_app, ocs_service;

-- Seals are written once and never removed. Same reasoning as notarizations:
-- the ability to delete the record of a professional act should not exist in
-- the application.
grant select, insert on ocs.document_seals to ocs_app, ocs_service;
grant update (note, seal_reference) on ocs.document_seals to ocs_app, ocs_service;

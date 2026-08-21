-- =============================================================================
-- 0006  Invoices, payments, refunds, provider webhook events
-- =============================================================================
-- Money rules encoded here:
--
--  1. NO card or bank data ever lands in this database. We store provider
--     tokens and identifiers only. The card number never touches our server --
--     the browser talks to Stripe directly and we receive a token. This keeps
--     the application out of PCI scope.
--
--  2. Amounts are integer cents (bigint), matching the provider exactly. Storing
--     money as a float invites rounding drift; storing it as the provider's own
--     unit means reconciliation is an integer comparison.
--
--  3. Every provider object id is UNIQUE. That constraint -- not application
--     logic -- is what makes a replayed webhook or a double-submitted checkout
--     impossible to process twice.
-- =============================================================================

create type ocs.payment_direction as enum (
  'inbound',   -- contractor pays One Contractor Solutions
  'outbound'   -- we pay a municipality or vendor (permit fees etc.)
);

create type ocs.payment_status as enum (
  'requires_payment_method',
  'requires_action',
  'processing',
  'succeeded',
  'failed',
  'canceled',
  'refunded',
  'partially_refunded'
);

create type ocs.invoice_status as enum (
  'draft', 'open', 'paid', 'void', 'uncollectible', 'past_due'
);

-- -----------------------------------------------------------------------------
-- invoices
-- -----------------------------------------------------------------------------

create table ocs.invoices (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references ocs.companies (id) on delete cascade,
  project_id      uuid references ocs.projects (id) on delete set null,
  permit_id       uuid references ocs.permits (id) on delete set null,
  drafting_order_id uuid references ocs.drafting_orders (id) on delete set null,

  invoice_number  int not null,          -- per-company, assigned by trigger
  status          ocs.invoice_status not null default 'draft',

  subtotal_cents  bigint not null default 0 check (subtotal_cents >= 0),
  tax_cents       bigint not null default 0 check (tax_cents >= 0),
  total_cents     bigint not null default 0 check (total_cents >= 0),
  amount_paid_cents bigint not null default 0 check (amount_paid_cents >= 0),
  currency        text not null default 'usd' check (char_length(currency) = 3),

  issued_on       date,
  due_on          date,
  paid_at         timestamptz,

  provider        text,                  -- 'stripe'
  provider_invoice_id text,

  memo            text,
  created_by      uuid references ocs.app_users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,

  unique (company_id, invoice_number)
);

create unique index invoices_provider_id_key on ocs.invoices (provider, provider_invoice_id)
  where provider_invoice_id is not null;
create index invoices_company_status_idx on ocs.invoices (company_id, status)
  where deleted_at is null;
create index invoices_due_idx on ocs.invoices (due_on)
  where deleted_at is null and status = 'open';

create trigger invoices_set_updated_at
  before update on ocs.invoices
  for each row execute function ocs.set_updated_at();

create or replace function ocs.assign_invoice_number() returns trigger
  language plpgsql
  set search_path = ocs, pg_temp
as $$
begin
  if new.invoice_number is null or new.invoice_number = 0 then
    perform pg_advisory_xact_lock(hashtext('invoice_number:' || new.company_id::text));
    select coalesce(max(invoice_number), 0) + 1
      into new.invoice_number
      from ocs.invoices
     where company_id = new.company_id;
  end if;
  return new;
end;
$$;

create trigger invoices_assign_number
  before insert on ocs.invoices
  for each row execute function ocs.assign_invoice_number();

create table ocs.invoice_line_items (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references ocs.companies (id) on delete cascade,
  invoice_id     uuid not null references ocs.invoices (id) on delete cascade,

  description    text not null,
  quantity       numeric(10, 2) not null default 1 check (quantity > 0),
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  amount_cents   bigint not null check (amount_cents >= 0),
  sort_order     int not null default 0,

  created_at     timestamptz not null default now()
);

create index invoice_line_items_invoice_idx
  on ocs.invoice_line_items (invoice_id, sort_order);
create index invoice_line_items_company_idx on ocs.invoice_line_items (company_id);

-- -----------------------------------------------------------------------------
-- payments
-- -----------------------------------------------------------------------------

create table ocs.payments (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references ocs.companies (id) on delete cascade,
  invoice_id      uuid references ocs.invoices (id) on delete set null,
  permit_id       uuid references ocs.permits (id) on delete set null,

  direction       ocs.payment_direction not null default 'inbound',
  status          ocs.payment_status not null default 'requires_payment_method',

  amount_cents    bigint not null check (amount_cents > 0),
  amount_refunded_cents bigint not null default 0 check (amount_refunded_cents >= 0),
  currency        text not null default 'usd' check (char_length(currency) = 3),

  provider        text not null default 'stripe',
  -- The provider's own object id. UNIQUE, so the same intent can never produce
  -- two payment rows no matter how many times a webhook is redelivered.
  provider_payment_intent_id text,
  provider_charge_id text,
  provider_customer_id text,

  -- Client-supplied Idempotency-Key that created this payment. UNIQUE per
  -- company: a double-clicked "Pay" button reuses the key and the second insert
  -- loses the race instead of charging twice.
  idempotency_key text,

  -- Safe-to-store card display data returned by the provider. Never a PAN.
  payment_method_brand text,
  payment_method_last4 char(4),

  description     text,
  failure_code    text,
  failure_message text,

  -- Reconciliation: set once the payout/settlement is matched to a bank record.
  reconciled_at   timestamptz,
  reconciliation_note text,

  initiated_by    uuid references ocs.app_users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  succeeded_at    timestamptz,

  constraint payments_refund_within_amount
    check (amount_refunded_cents <= amount_cents)
);

create unique index payments_provider_intent_key
  on ocs.payments (provider, provider_payment_intent_id)
  where provider_payment_intent_id is not null;
create unique index payments_provider_charge_key
  on ocs.payments (provider, provider_charge_id)
  where provider_charge_id is not null;
create unique index payments_idempotency_key
  on ocs.payments (company_id, idempotency_key)
  where idempotency_key is not null;

create index payments_company_status_idx on ocs.payments (company_id, status);
create index payments_invoice_idx on ocs.payments (invoice_id);
create index payments_unreconciled_idx on ocs.payments (succeeded_at)
  where status = 'succeeded' and reconciled_at is null;

create trigger payments_set_updated_at
  before update on ocs.payments
  for each row execute function ocs.set_updated_at();

-- -----------------------------------------------------------------------------
-- refunds
-- -----------------------------------------------------------------------------

create table ocs.refunds (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references ocs.companies (id) on delete cascade,
  payment_id      uuid not null references ocs.payments (id) on delete cascade,

  amount_cents    bigint not null check (amount_cents > 0),
  currency        text not null default 'usd',
  status          text not null default 'pending'
                    check (status in ('pending', 'succeeded', 'failed', 'canceled')),
  reason          text,

  provider        text not null default 'stripe',
  provider_refund_id text,
  idempotency_key text,

  requested_by    uuid references ocs.app_users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index refunds_provider_id_key on ocs.refunds (provider, provider_refund_id)
  where provider_refund_id is not null;
create unique index refunds_idempotency_key on ocs.refunds (company_id, idempotency_key)
  where idempotency_key is not null;
create index refunds_payment_idx on ocs.refunds (payment_id);
create index refunds_company_idx on ocs.refunds (company_id);

create trigger refunds_set_updated_at
  before update on ocs.refunds
  for each row execute function ocs.set_updated_at();

-- -----------------------------------------------------------------------------
-- webhook_events -- every inbound provider webhook, recorded before it is acted on.
--
-- This table IS the duplicate-processing guard. The handler inserts the
-- provider's event id first; a redelivery violates the unique index, the handler
-- sees the conflict and returns 200 without re-applying the effect. Stripe
-- retries aggressively and delivers out of order, so this is not optional.
--
-- Not tenant-scoped: webhooks arrive before we know which company they belong to.
-- 0008 restricts this table to the service role only.
-- -----------------------------------------------------------------------------

create table ocs.webhook_events (
  id              uuid primary key default gen_random_uuid(),
  provider        text not null,
  provider_event_id text not null,
  event_type      text not null,

  -- Signature verification outcome, recorded even on failure so that a burst of
  -- forged requests is visible rather than silently dropped.
  signature_verified boolean not null default false,

  status          text not null default 'received'
                    check (status in ('received', 'processing', 'processed', 'failed', 'ignored')),
  attempts        int not null default 0,
  last_error      text,

  company_id      uuid references ocs.companies (id) on delete set null,
  payload         jsonb not null,

  received_at     timestamptz not null default now(),
  processed_at    timestamptz,

  unique (provider, provider_event_id)
);

create index webhook_events_status_idx on ocs.webhook_events (status, received_at)
  where status in ('received', 'failed');
create index webhook_events_type_idx on ocs.webhook_events (provider, event_type, received_at desc);

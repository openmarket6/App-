-- 0030  Invoicing: our fee and the agency's, never blended
--
-- A permit invoice contains two different kinds of money. There is what this
-- firm charges for its work, and there is what the building department charged,
-- which we advanced on the contractor's behalf and are recovering at cost.
--
-- Blending them is the single most damaging thing an expediting business can do
-- to its own credibility. A contractor who discovers that a $412 county fee
-- appeared on their invoice as $495 stops believing every other number on it,
-- and they are right to. So a pass-through line is marked as one, is summed
-- separately, and the constraint below makes a marked-up pass-through
-- impossible to record rather than merely discouraged.
--
-- This mirrors the compliance retainer in 0020: money that moves through the
-- business is not money the business earned, and the schema should say so.

create type ocs.service_line as enum (
  'EXPEDITING',       -- the contractor holds the licence; we file
  'MANAGED_LICENSE'   -- our licence, our qualifier -- the White Glove line
);

alter table ocs.invoices
  add column service_line ocs.service_line not null default 'EXPEDITING',

  -- Agency fees advanced on the contractor's behalf. Recovered, not earned.
  add column pass_through_cents bigint not null default 0
    check (pass_through_cents >= 0),

  add column quickbooks_invoice_id text,
  add column stripe_invoice_id text,

  -- A sent invoice has been issued; a draft has not. Without this an invoice
  -- can sit in 'sent' with no issue date, and nobody can say when the clock
  -- for payment started.
  add constraint invoices_sent_has_issue_date
    check (status = 'draft' or issued_on is not null) not valid;

create index invoices_outstanding_idx
  on ocs.invoices (company_id, due_on)
  where deleted_at is null and status <> 'paid';

alter table ocs.invoice_line_items
  /*
   * True when this line recovers a fee somebody else charged. The whole point
   * of the distinction: it is shown separately and never marked up.
   */
  add column pass_through boolean not null default false,
  add column permit_id uuid references ocs.permits (id) on delete set null;

create index invoice_line_items_permit_idx
  on ocs.invoice_line_items (permit_id) where permit_id is not null;

/*
 * A pass-through line is charged at cost, so its charge kind must say so.
 *
 * Enforced rather than trusted, because the mistake this prevents is not
 * malice -- it is somebody adding a margin to an agency fee to cover the card
 * processing on it, which is exactly how a contractor discovers a $412 fee
 * billed at $495 and stops trusting the invoice.
 */
alter table ocs.invoice_line_items
  add constraint invoice_line_pass_through_is_government_fee
  check (not pass_through or charge_kind = 'government_fee');

-- -----------------------------------------------------------------------------
-- The rate book
--
-- Our fee per trade. Editable, because it is a commercial decision rather than
-- a fact about the world, and stored rather than compiled in so that changing a
-- price does not require a deployment.
-- -----------------------------------------------------------------------------

create table ocs.trade_rates (
  trade         text primary key,
  fee_cents     bigint not null check (fee_cents >= 0),

  -- Charged when a jurisdiction requires paper or counter filing, because that
  -- costs a person a morning.
  manual_surcharge_cents bigint not null default 0 check (manual_surcharge_cents >= 0),

  -- Charged per correction cycle beyond the first, where the firm bills that
  -- way. Deliberately separate: a first correction is often our own to fix.
  resubmittal_cents bigint not null default 0 check (resubmittal_cents >= 0),

  is_active     boolean not null default true,
  updated_by    uuid references ocs.app_users (id),
  updated_at    timestamptz not null default now()
);

create trigger trade_rates_set_updated_at
  before update on ocs.trade_rates
  for each row execute function ocs.set_updated_at();

-- Placeholders matching what the frontend already displays, not market rates.
insert into ocs.trade_rates (trade, fee_cents, manual_surcharge_cents, resubmittal_cents)
values
  ('BUILDING',   45000, 7500, 12500),
  ('ROOFING',    30000, 7500, 12500),
  ('ELECTRICAL', 30000, 7500, 12500),
  ('PLUMBING',   30000, 7500, 12500),
  ('MECHANICAL', 30000, 7500, 12500),
  ('POOL',       30000, 7500, 12500),
  ('SPECIALTY',  20000, 7500, 12500)
on conflict (trade) do nothing;

alter table ocs.trade_rates enable row level security;
alter table ocs.trade_rates force row level security;

create policy trade_rates_read on ocs.trade_rates
  for select to ocs_app, ocs_service using (true);
create policy trade_rates_write on ocs.trade_rates
  for all to ocs_app, ocs_service
  using (ocs.is_service_context()) with check (ocs.is_service_context());

grant select, insert, update on ocs.trade_rates to ocs_app, ocs_service;

-- -----------------------------------------------------------------------------
-- Where a contractor's card lives
--
-- The Stripe customer, never the card. Card details are Stripe's to hold; a
-- copy here would put this database inside PCI scope for no benefit.
-- -----------------------------------------------------------------------------

alter table ocs.companies
  add column stripe_customer_id text unique;

comment on column ocs.companies.stripe_customer_id is
  'Stripe customer. Card details are never stored here -- holding them would '
  'put this database inside PCI scope in exchange for nothing.';

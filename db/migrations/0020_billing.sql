-- 0020  Subscriptions, the compliance retainer, and what appears on an invoice
--
-- THE DISTINCTION THIS MIGRATION EXISTS TO PROTECT
--
-- The compliance retainer is money HELD, not money EARNED. It sits against the
-- licensing risk this business carries for a contractor, and one day some of it
-- goes back. Counting it as revenue would overstate the company by the entire
-- retainer balance -- every month, growing with every customer -- and that is
-- not a reporting quirk. It is the number an owner uses to decide whether they
-- can afford to hire.
--
-- So it does not live on an invoice. It has its own ledger, movements are
-- append-only, and the balance is derived from them rather than stored where it
-- could drift. Invoice lines carry an explicit charge kind so revenue can be
-- summed without anyone having to remember which descriptions to exclude.

create type ocs.plan_key as enum (
  'OWN_LICENSE',
  'ONE_TRADE', 'TWO_TRADES', 'THREE_TRADES', 'FOUR_TRADES',
  'FIVE_TRADES', 'SIX_TRADES', 'ALL_TRADES'
);

create type ocs.subscription_status as enum (
  'pending',    -- agreed, not yet paid for
  'active',
  'past_due',
  'paused',
  'cancelled'
);

create type ocs.charge_kind as enum (
  'monthly_service',
  'onboarding',
  'compliance_retainer',   -- the one that is NOT revenue
  'government_fee',
  'supervisor_visit',
  'per_permit'
);

-- -----------------------------------------------------------------------------
-- subscriptions
-- -----------------------------------------------------------------------------

create table ocs.subscriptions (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references ocs.companies (id) on delete cascade,

  plan_key      ocs.plan_key not null,
  trade_count   int not null default 0 check (trade_count >= 0),
  status        ocs.subscription_status not null default 'pending',

  /*
   * The prices this contractor agreed to, frozen.
   *
   * Without this, changing the published price list silently rewrites what
   * every existing customer owes, and a signed agreement no longer says what it
   * said when it was signed. NOT NULL because a subscription without one is a
   * subscription nobody can prove the terms of.
   */
  pricing_snapshot jsonb not null,

  monthly_price_cents int not null check (monthly_price_cents >= 0),

  /*
   * The running total of onboarding actually COLLECTED -- not the current
   * plan's list price. They differ the moment a customer is given a discount,
   * and using list price would quietly claw that discount back at their next
   * upgrade. Monotonic: enforced by the trigger below.
   */
  onboarding_paid_cents int not null default 0 check (onboarding_paid_cents >= 0),

  -- What the current plan requires be held. The balance actually held lives in
  -- the ledger, and the two are compared rather than assumed equal.
  retainer_required_cents int not null default 0 check (retainer_required_cents >= 0),

  started_on    date,
  current_period_end date,
  cancelled_at  timestamptz,

  provider           text,
  provider_subscription_id text,

  created_by    uuid references ocs.app_users (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- A cancelled subscription has a cancellation time, and a live one does not
  -- carry a stale one from a previous cancellation.
  constraint subscriptions_cancelled_has_time
    check ((status = 'cancelled') = (cancelled_at is not null))
);

/*
 * One live subscription per contractor.
 *
 * A partial unique index rather than a constraint, so the history of cancelled
 * subscriptions is kept. Two live subscriptions would mean two monthly charges
 * and two different answers to "what plan are they on".
 */
create unique index subscriptions_one_live_per_company
  on ocs.subscriptions (company_id)
  where status in ('pending', 'active', 'past_due', 'paused');

create index subscriptions_company_idx on ocs.subscriptions (company_id, created_at desc);
create index subscriptions_status_idx on ocs.subscriptions (status)
  where status in ('active', 'past_due');

create trigger subscriptions_set_updated_at
  before update on ocs.subscriptions
  for each row execute function ocs.set_updated_at();

/*
 * Onboarding paid never goes down.
 *
 * A downgrade refunds no onboarding. If this total could fall, a customer could
 * downgrade and re-upgrade to pay the difference twice -- or, read the other
 * way, be charged the full fee again for a tier they had already paid into.
 */
create or replace function ocs.protect_onboarding_total() returns trigger
  language plpgsql set search_path = ocs, pg_temp
as $$
begin
  if new.onboarding_paid_cents < old.onboarding_paid_cents then
    raise exception
      'onboarding already paid cannot decrease (% -> %); a downgrade refunds no onboarding',
      old.onboarding_paid_cents, new.onboarding_paid_cents;
  end if;
  return new;
end;
$$;

create trigger subscriptions_protect_onboarding
  before update of onboarding_paid_cents on ocs.subscriptions
  for each row execute function ocs.protect_onboarding_total();

-- -----------------------------------------------------------------------------
-- subscription_changes -- how a contractor got to the plan they are on
-- -----------------------------------------------------------------------------

create table ocs.subscription_changes (
  id            bigserial primary key,
  company_id    uuid not null references ocs.companies (id) on delete cascade,
  subscription_id uuid not null references ocs.subscriptions (id) on delete cascade,

  from_plan_key ocs.plan_key,
  to_plan_key   ocs.plan_key not null,
  from_trade_count int,
  to_trade_count   int not null,

  onboarding_charged_cents int not null default 0,
  retainer_delta_cents     int not null default 0,

  -- A retainer reduction needs a person. See the ledger below.
  requires_approval boolean not null default false,
  approved_by   uuid references ocs.app_users (id),
  approved_at   timestamptz,

  pricing_snapshot jsonb not null,
  note          text,
  actor_user_id uuid references ocs.app_users (id),
  created_at    timestamptz not null default now()
);

create index subscription_changes_company_idx
  on ocs.subscription_changes (company_id, created_at desc);
create index subscription_changes_pending_idx
  on ocs.subscription_changes (created_at)
  where requires_approval and approved_at is null;

-- -----------------------------------------------------------------------------
-- retainer_ledger -- money held, on its own books
-- -----------------------------------------------------------------------------

create type ocs.retainer_movement as enum (
  'collect',   -- taken from the contractor and held
  'release',   -- returned to them
  'apply',     -- consumed against an actual liability
  'adjust'     -- correction, always with a reason
);

create table ocs.retainer_ledger (
  id            bigserial primary key,
  company_id    uuid not null references ocs.companies (id) on delete cascade,
  subscription_id uuid references ocs.subscriptions (id) on delete set null,

  movement      ocs.retainer_movement not null,

  /*
   * Signed. Positive increases the held balance, negative decreases it, and the
   * sign must agree with the movement -- otherwise a 'release' could be
   * recorded that quietly increases the balance.
   */
  amount_cents  int not null check (amount_cents <> 0),

  reason        text not null check (length(btrim(reason)) > 0),
  payment_id    uuid references ocs.payments (id) on delete set null,

  approved_by   uuid references ocs.app_users (id),
  actor_user_id uuid references ocs.app_users (id),
  created_at    timestamptz not null default now(),

  constraint retainer_sign_matches_movement check (
    (movement = 'collect' and amount_cents > 0)
    or (movement in ('release', 'apply') and amount_cents < 0)
    or (movement = 'adjust')
  ),

  /*
   * Releasing money held against risk we may still be carrying is a judgement
   * about open jobs and unresolved liability, not arithmetic. A person decides,
   * and the database will not record the movement without them.
   */
  constraint retainer_release_needs_approval check (
    movement <> 'release' or approved_by is not null
  )
);

create index retainer_ledger_company_idx on ocs.retainer_ledger (company_id, created_at desc);

/*
 * Append-only.
 *
 * A ledger you can edit is not a ledger. A correction is another row with a
 * reason, which is exactly what 'adjust' is for -- and it leaves the mistake
 * visible, which is the point.
 *
 * UPDATE only. Deletion is prevented the way it is everywhere else in this
 * schema -- by not granting it to the application roles below -- rather than by
 * a trigger. The difference matters: a trigger blocks the OWNER too, and the
 * owner is what a cascading delete runs as when a company is genuinely removed.
 * Blocking that would make an erasure request impossible to honour, which is a
 * worse problem than the one it solves.
 */
create or replace function ocs.retainer_ledger_is_append_only() returns trigger
  language plpgsql set search_path = ocs, pg_temp
as $$
begin
  raise exception 'the retainer ledger is append-only; record a correcting adjustment instead';
end;
$$;

create trigger retainer_ledger_no_update
  before update on ocs.retainer_ledger
  for each row execute function ocs.retainer_ledger_is_append_only();

/*
 * The held balance, derived rather than stored.
 *
 * A stored balance and a ledger that disagree is the classic accounting bug,
 * and the stored one is always the one that is wrong. Summing an indexed
 * integer column per company is cheap enough that caching it would be
 * optimising the wrong thing.
 */
create or replace function ocs.retainer_balance_cents(p_company_id uuid)
returns int language sql stable set search_path = ocs, pg_temp
as $$
  select coalesce(sum(amount_cents), 0)::int
    from ocs.retainer_ledger
   where company_id = p_company_id
$$;

-- -----------------------------------------------------------------------------
-- Invoice lines carry their kind
-- -----------------------------------------------------------------------------

alter table ocs.invoice_line_items
  add column charge_kind ocs.charge_kind not null default 'monthly_service';

comment on column ocs.invoice_line_items.charge_kind is
  'What sort of charge this line is. Everything except compliance_retainer is '
  'revenue; see ocs.invoice_revenue_line_items.';

/*
 * Revenue, with the retainer excluded by construction.
 *
 * A view rather than a convention, so summing revenue does not depend on every
 * future query remembering which kind to leave out. The one that forgets is the
 * one that overstates the business.
 */
create or replace view ocs.invoice_revenue_line_items as
  select * from ocs.invoice_line_items
   where charge_kind <> 'compliance_retainer';

-- Link a permit-level charge back to the visit that caused it, so a $150 line
-- on an invoice can always be traced to the supervisor visit it paid for.
alter table ocs.invoice_line_items
  add column supervision_visit_id uuid references ocs.supervision_visits (id) on delete set null;

-- A completed visit is billed once. Without this a re-run of the billing job
-- charges the contractor again for the same visit.
create unique index invoice_line_items_one_per_visit
  on ocs.invoice_line_items (supervision_visit_id)
  where supervision_visit_id is not null;

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['subscriptions', 'subscription_changes', 'retainer_ledger']
  loop
    execute format('alter table ocs.%I enable row level security', t);
    execute format('alter table ocs.%I force row level security', t);
    execute format($f$
      create policy tenant_isolation on ocs.%I
        for all to ocs_app, ocs_service
        using (company_id = ocs.current_company_id() or ocs.is_service_context())
        with check (company_id = ocs.current_company_id() or ocs.is_service_context())
    $f$, t);
    execute format('grant select, insert on ocs.%I to ocs_app, ocs_service', t);
  end loop;
end
$$;

-- Subscriptions are the only one of the three the application may amend: a
-- plan changes, a status moves to past_due. The two history tables are written
-- once and never revised.
grant update on ocs.subscriptions to ocs_app, ocs_service;

-- No DELETE on any of them. Financial history is not something the application
-- should be able to remove, and the absence of the grant -- rather than a
-- trigger -- is what enforces that, so a legitimate owner-level cascade still
-- works.

grant select on ocs.invoice_revenue_line_items to ocs_app, ocs_service;
grant usage, select on sequence ocs.subscription_changes_id_seq to ocs_app, ocs_service;
grant usage, select on sequence ocs.retainer_ledger_id_seq to ocs_app, ocs_service;

grant execute on function ocs.retainer_balance_cents(uuid) to ocs_app, ocs_service;

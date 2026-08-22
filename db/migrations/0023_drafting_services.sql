-- 0023  Drafting services, as the shipped frontend understands them
--
-- 0021 modelled engineering the way the business describes it internally:
-- deliverables, seals, quotes. The frontend that contractors actually use
-- describes the same work differently -- an order is a set of SERVICES with a
-- brief, and it moves through nine named statuses.
--
-- Neither vocabulary is wrong, and translating between them in application code
-- would mean the translation lives in whichever route remembered to do it. So
-- the ordered services are stored as the frontend states them, and the parts
-- 0021 owns -- the quote gate, the seal -- stay where they are. One order, both
-- vocabularies, no lossy round trip.

-- Used from 0024 onward: PostgreSQL will not let a new enum value be used in
-- the transaction that adds it, and each migration runs in one.
alter type ocs.drafting_status add value if not exists 'awaiting_seal';

alter table ocs.drafting_orders
  -- The services ordered, in the frontend's own vocabulary. Text rather than an
  -- enum because this catalogue is a commercial decision that changes with the
  -- price list, and an enum would need a migration every time a service is
  -- added or retired.
  add column services text[] not null default '{}',
  add column brief text,
  add column target_delivery_at timestamptz;

create index drafting_orders_services_idx on ocs.drafting_orders using gin (services);

-- -----------------------------------------------------------------------------
-- The service catalogue
--
-- Seeded to match the figures the shipped frontend already displays. Until this
-- exists the prices live only inside a compiled bundle nobody can edit, which
-- means a price change requires a frontend rebuild.
-- -----------------------------------------------------------------------------

create table ocs.drafting_services (
  service       text primary key,
  label         text not null,
  base_cents    int not null check (base_cents >= 0),

  -- Whether this service is priced per job rather than at the base rate. A
  -- site plan is predictable; an architectural set depends on the building.
  quote_required boolean not null default true,

  typical_turnaround_days int not null check (typical_turnaround_days > 0),

  -- Whether the output must carry an engineer's seal before it can be
  -- delivered. See 0021: the seal is a professional act, not a file property.
  requires_seal boolean not null default false,

  is_active     boolean not null default true,
  sort_order    int not null default 100,
  updated_at    timestamptz not null default now()
);

create trigger drafting_services_set_updated_at
  before update on ocs.drafting_services
  for each row execute function ocs.set_updated_at();

insert into ocs.drafting_services
  (service, label, base_cents, quote_required, typical_turnaround_days, requires_seal, sort_order)
values
  ('ARCHITECTURAL_PLANS',    'Architectural plan set',                    250000, true,  10, true,  10),
  ('STRUCTURAL_ENGINEERING', 'Structural engineering (signed & sealed)',  180000, true,   8, true,  20),
  ('MEP_DESIGN',             'MEP design',                                120000, true,   9, true,  30),
  ('TRUSS_LAYOUT',           'Truss layout & engineering',                 90000, true,   7, true,  40),
  ('AS_BUILT',               'As-built drawings',                          75000, true,   6, false, 50),
  ('WIND_LOAD_CALCS',        'Wind load calculations',                     65000, false,  4, true,  60),
  ('SITE_PLAN',              'Site plan',                                  45000, false,  4, false, 70),
  ('ENERGY_CALCS',           'Energy code calculations',                   35000, false,  3, false, 80),
  ('REVISION',               'Plan revision',                              30000, false,  3, false, 90)
on conflict (service) do nothing;

-- Reference data: every authenticated caller may read it, only the service
-- context may change it.
alter table ocs.drafting_services enable row level security;
alter table ocs.drafting_services force row level security;

create policy drafting_services_read on ocs.drafting_services
  for select to ocs_app, ocs_service using (true);
create policy drafting_services_write on ocs.drafting_services
  for all to ocs_app, ocs_service
  using (ocs.is_service_context()) with check (ocs.is_service_context());

grant select, insert, update on ocs.drafting_services to ocs_app, ocs_service;

-- -----------------------------------------------------------------------------
-- Documents attached to an order, and which side of it they are on
-- -----------------------------------------------------------------------------

alter table ocs.documents
  add column drafting_role text
    check (drafting_role is null or drafting_role in ('input', 'output'));

comment on column ocs.documents.drafting_role is
  'For a document attached to a drafting order: whether the contractor supplied '
  'it as input, or we produced it as output. Without this the two are '
  'indistinguishable, and a survey the contractor sent looks like something we drew.';

create index documents_drafting_role_idx
  on ocs.documents (drafting_order_id, drafting_role)
  where drafting_order_id is not null;

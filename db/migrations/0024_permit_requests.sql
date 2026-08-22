-- 0024  Permit requests, and the one contractor who may manage their own team
--
-- A permit request is what a contractor sends us before a permit exists: an
-- address, a description of the work in their own words, and whatever they had
-- to hand. It is deliberately NOT a permit. Triage decides whether it becomes
-- one, and conflating the two would mean every half-formed enquiry appears in
-- the permit pipeline as though it were live work.

create type ocs.permit_request_status as enum (
  'submitted',
  'in_triage',
  'needs_info',   -- we asked them something and are waiting
  'accepted',     -- became a permit
  'declined',
  'withdrawn'     -- they pulled it
);

create table ocs.permit_requests (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references ocs.companies (id) on delete cascade,

  -- Both set only once triage has done its work.
  project_id    uuid references ocs.projects (id) on delete set null,
  permit_id     uuid references ocs.permits (id) on delete set null,

  status        ocs.permit_request_status not null default 'submitted',

  -- Their words, kept verbatim. Rewriting it into our vocabulary before triage
  -- loses the detail that tells a coordinator what is actually being built.
  scope_of_work text not null check (length(btrim(scope_of_work)) > 0),

  address_line1 text not null check (length(btrim(address_line1)) > 0),
  city          text not null,
  zip           text not null,
  county        text,

  -- Their best guess. Triage confirms it; it is never trusted as filed.
  suggested_permit_type text,
  estimated_value_cents bigint check (estimated_value_cents is null or estimated_value_cents >= 0),
  desired_start_date date,

  attachment_ids uuid[] not null default '{}',

  -- The coordinator's reply, shown to the contractor when we need something or
  -- are turning the job down. A decline with no reason generates a phone call.
  triage_note   text,
  triaged_by    uuid references ocs.app_users (id),
  triaged_at    timestamptz,

  submitted_by  uuid references ocs.app_users (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- A resolved request records who resolved it and when.
  constraint permit_requests_triage_recorded check (
    status in ('submitted', 'in_triage') or triaged_at is not null
  ),
  -- An accepted request points at the permit it became. Otherwise "accepted"
  -- is a claim with nothing behind it.
  constraint permit_requests_accepted_has_permit check (
    status <> 'accepted' or permit_id is not null
  ),
  -- Turning work down, or asking for more, requires saying why.
  constraint permit_requests_explained check (
    status not in ('needs_info', 'declined')
    or (triage_note is not null and length(btrim(triage_note)) > 0)
  )
);

create index permit_requests_company_idx
  on ocs.permit_requests (company_id, created_at desc);
create index permit_requests_queue_idx
  on ocs.permit_requests (created_at)
  where status in ('submitted', 'in_triage');

create trigger permit_requests_set_updated_at
  before update on ocs.permit_requests
  for each row execute function ocs.set_updated_at();

alter table ocs.permit_requests enable row level security;
alter table ocs.permit_requests force row level security;

create policy tenant_isolation on ocs.permit_requests
  for all to ocs_app, ocs_service
  using (company_id = ocs.current_company_id() or ocs.is_service_context())
  with check (company_id = ocs.current_company_id() or ocs.is_service_context());

grant select, insert, update on ocs.permit_requests to ocs_app, ocs_service;

-- -----------------------------------------------------------------------------
-- The contractor who runs their own team
--
-- A contractor company needs someone who can invite and deactivate their own
-- staff without going through us. That is not a new role -- they are still a
-- CLIENT, seeing only their own company -- it is one extra permission within
-- it, which is why it is a flag rather than a seventh entry in the role enum.
-- -----------------------------------------------------------------------------

alter table ocs.app_users
  add column client_admin boolean not null default false;

comment on column ocs.app_users.client_admin is
  'A CLIENT who may invite and deactivate logins within their own company. '
  'Meaningless on a staff account, and the constraint below says so.';

-- A staff account with this flag set would be a quiet contradiction: there is
-- no company for them to administer.
alter table ocs.app_users
  add constraint app_users_client_admin_is_client
  check (not client_admin or app_role = 'CLIENT') not valid;

create index app_users_client_admin_idx on ocs.app_users (client_id)
  where client_admin and deleted_at is null;

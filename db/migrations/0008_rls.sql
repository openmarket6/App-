-- =============================================================================
-- 0008  Row-level security -- the tenant isolation boundary
-- =============================================================================
-- This migration is the reason a bug in a route handler cannot leak one
-- contractor's permits to another.
--
-- The application connects as `ocs_app`, which is neither superuser nor table
-- owner, so every statement it runs is filtered by the policies below. Each
-- request opens a transaction and sets `ocs.company_id`; the policies compare
-- that against the row's company_id.
--
-- The design is FAIL-CLOSED. If a code path forgets to set the context,
-- ocs.current_company_id() returns NULL, `company_id = NULL` evaluates to NULL
-- (never true), and the query returns ZERO rows. The failure mode of a mistake
-- is "sees nothing", never "sees everything".
--
-- WITH CHECK mirrors USING on every policy, so a tenant cannot INSERT or UPDATE
-- a row into another tenant's company_id either -- isolation covers writes, not
-- just reads.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Service context.
--
-- The background worker and the payment webhook handler legitimately operate
-- without a single tenant: a Stripe webhook arrives before we know whose it is,
-- and the expiry scan fans out across every company. Those paths set
-- `ocs.service_context = 'on'` for the duration of one transaction.
--
-- This is deliberately narrow. It is set in exactly two places in the codebase
-- (withServiceContext in src/db/tenant.ts) and never from an HTTP request
-- handler that serves a logged-in user.
-- -----------------------------------------------------------------------------

create or replace function ocs.is_service_context() returns boolean
  language sql stable
  set search_path = ocs, pg_temp
as $$
  select coalesce(nullif(current_setting('ocs.service_context', true), ''), 'off') = 'on'
     and pg_has_role(current_user, 'ocs_service', 'member')
$$;

-- The pg_has_role() half of that condition is load-bearing, and it is worth
-- being explicit about why.
--
-- Without it, ANY caller able to execute `set ocs.service_context = 'on'` --
-- through a SQL injection, or a bug that interpolates user input into a SET --
-- would switch off tenant isolation entirely and read every customer's data.
-- The session flag alone is a request-scoped variable, and request-scoped
-- variables are attacker-influenceable.
--
-- Role membership is not. `ocs_app` is not a member of `ocs_service`, so when
-- the API role sets that flag the function still returns false and the policies
-- still filter by company_id. Escalation would require new database
-- credentials, not merely a crafted query.
--
-- This was caught by TEST 7 in tests/tenant-isolation.test.ts, which asserts
-- exactly this attack fails. Do not "simplify" this function.

-- -----------------------------------------------------------------------------
-- The two application roles.
--
--   ocs_app     -- serves HTTP requests for logged-in users. ALWAYS confined to
--                  one company_id. Cannot enter service context, by construction.
--   ocs_service -- the background worker and the payment-webhook handler. May
--                  enter service context to work across tenants.
--
-- Splitting them means a flaw in request-handling code cannot reach cross-tenant
-- data even if it can run arbitrary SQL as its own role.
--
-- Both are created NOLOGIN with no password, so no credential is committed to
-- this repository. Grant login once, out of band, with distinct secrets:
--     alter role ocs_app     login password '<generated secret>';
--     alter role ocs_service login password '<a different generated secret>';
--
-- ocs_app must never be granted membership in ocs_service. That single fact is
-- what the whole separation rests on.
-- -----------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ocs_app') then
    create role ocs_app nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'ocs_service') then
    create role ocs_service nologin;
  end if;
end
$$;

grant usage on schema ocs to ocs_app, ocs_service;

-- -----------------------------------------------------------------------------
-- Standard tenant tables: every row carries company_id, and that column alone
-- decides visibility. Generated in a loop so all 26 tables get an identical,
-- reviewed policy -- hand-writing each one is how a table ends up accidentally
-- unprotected.
-- -----------------------------------------------------------------------------

do $$
declare
  t text;
  tenant_tables text[] := array[
    'company_memberships',
    'projects',
    'permits',
    'permit_status_history',
    'drafting_orders',
    'drafting_revisions',
    'drafting_markups',
    'folders',
    'documents',
    'document_versions',
    'qualifiers',
    'licenses',
    'insurance_policies',
    'message_threads',
    'messages',
    'message_attachments',
    'notifications',
    'notification_deliveries',
    'invoices',
    'invoice_line_items',
    'payments',
    'refunds',
    'integration_credentials',
    'integration_runs',
    'idempotency_keys',
    'jobs'
  ];
begin
  foreach t in array tenant_tables loop
    execute format('alter table ocs.%I enable row level security', t);
    -- FORCE applies the policy to the table owner too, so a future migration
    -- that runs as the owner cannot quietly read across tenants either.
    execute format('alter table ocs.%I force row level security', t);

    execute format($f$
      create policy tenant_isolation on ocs.%I
        for all
        to ocs_app, ocs_service
        using (company_id = ocs.current_company_id() or ocs.is_service_context())
        with check (company_id = ocs.current_company_id() or ocs.is_service_context())
    $f$, t);

    execute format(
      'grant select, insert, update, delete on ocs.%I to ocs_app, ocs_service', t);
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- companies -- keyed on `id`, not `company_id`.
-- -----------------------------------------------------------------------------

alter table ocs.companies enable row level security;
alter table ocs.companies force row level security;

create policy tenant_isolation on ocs.companies
  for all
  to ocs_app, ocs_service
  using (id = ocs.current_company_id() or ocs.is_service_context())
  with check (id = ocs.current_company_id() or ocs.is_service_context());

grant select, insert, update on ocs.companies to ocs_app, ocs_service;

-- -----------------------------------------------------------------------------
-- app_users -- a person exists independently of any one company.
--
-- Visible when: it is you, or you share the currently-active company. The
-- membership subquery is intentionally scoped to ocs.current_company_id(), so
-- a user who belongs to three companies still only sees colleagues from the one
-- they are acting as right now.
-- -----------------------------------------------------------------------------

alter table ocs.app_users enable row level security;
alter table ocs.app_users force row level security;

create policy self_and_colleagues on ocs.app_users
  for select
  to ocs_app, ocs_service
  using (
    ocs.is_service_context()
    or id = ocs.current_user_id()
    or exists (
      select 1 from ocs.company_memberships m
       where m.user_id = ocs.app_users.id
         and m.company_id = ocs.current_company_id()
         and m.is_active
    )
  );

-- A user may edit only their own profile row. Role changes go through
-- membership records, which are governed by the tenant policy above.
create policy self_update on ocs.app_users
  for update
  to ocs_app, ocs_service
  using (ocs.is_service_context() or id = ocs.current_user_id())
  with check (ocs.is_service_context() or id = ocs.current_user_id());

create policy service_insert on ocs.app_users
  for insert
  to ocs_app, ocs_service
  with check (ocs.is_service_context());

grant select, insert, update on ocs.app_users to ocs_app, ocs_service;

-- -----------------------------------------------------------------------------
-- audit_log -- readable within your tenant, append-only for everyone.
--
-- No UPDATE or DELETE policy exists and neither privilege is granted, so the
-- application literally cannot rewrite history. That is the property that makes
-- the audit trail worth having.
-- -----------------------------------------------------------------------------

alter table ocs.audit_log enable row level security;
alter table ocs.audit_log force row level security;

create policy audit_read on ocs.audit_log
  for select
  to ocs_app, ocs_service
  using (company_id = ocs.current_company_id() or ocs.is_service_context());

create policy audit_append on ocs.audit_log
  for insert
  to ocs_app, ocs_service
  with check (company_id = ocs.current_company_id() or ocs.is_service_context());

grant select, insert on ocs.audit_log to ocs_app, ocs_service;

-- -----------------------------------------------------------------------------
-- municipalities -- shared reference data. Everyone reads; only the service
-- context writes (seeded by migration, maintained by platform admins through an
-- admin endpoint that opens a service transaction).
-- -----------------------------------------------------------------------------

alter table ocs.municipalities enable row level security;
alter table ocs.municipalities force row level security;

create policy municipalities_read on ocs.municipalities
  for select to ocs_app, ocs_service using (true);

create policy municipalities_write on ocs.municipalities
  for all to ocs_app, ocs_service
  using (ocs.is_service_context())
  with check (ocs.is_service_context());

grant select, insert, update, delete on ocs.municipalities to ocs_app, ocs_service;

-- -----------------------------------------------------------------------------
-- webhook_events and job_schedules -- infrastructure tables with no tenant.
-- Reachable only from a service-context transaction.
-- -----------------------------------------------------------------------------

alter table ocs.webhook_events enable row level security;
alter table ocs.webhook_events force row level security;

create policy service_only on ocs.webhook_events
  for all to ocs_app, ocs_service
  using (ocs.is_service_context())
  with check (ocs.is_service_context());

grant select, insert, update on ocs.webhook_events to ocs_app, ocs_service;

alter table ocs.job_schedules enable row level security;
alter table ocs.job_schedules force row level security;

create policy service_only on ocs.job_schedules
  for all to ocs_app, ocs_service
  using (ocs.is_service_context())
  with check (ocs.is_service_context());

grant select, insert, update on ocs.job_schedules to ocs_app, ocs_service;

-- -----------------------------------------------------------------------------
-- Sequences (bigserial columns) and function execution.
-- -----------------------------------------------------------------------------

grant usage, select on all sequences in schema ocs to ocs_app, ocs_service;
grant execute on all functions in schema ocs to ocs_app, ocs_service;

-- Anything added by a later migration inherits these grants automatically,
-- so a new table is never silently unreachable by the API.
alter default privileges in schema ocs
  grant usage, select on sequences to ocs_app, ocs_service;

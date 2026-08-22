-- 0027  Compliance: one record per thing a contractor must keep current
--
-- 0002 modelled insurance_policies and licenses as separate tables. That split
-- looks natural and is wrong for the question this business actually asks,
-- which is never "what insurance do they have" but "can we file for them
-- today". Answering it across two tables means two queries, two status
-- calculations, and eventually two different answers -- and the one that says
-- yes is the one that gets a filing rejected.
--
-- So compliance is one table keyed by KIND, covering insurance, licences,
-- registrations, a W9 and a bond alike. Both original tables are empty, so
-- nothing is migrated and nothing is lost.
--
-- The status is NOT stored. It is computed from the expiry date by the same
-- shared function the frontend uses (computeComplianceStatus), because a stored
-- status is a status that goes stale overnight: a policy that expires at
-- midnight is still marked VALID at 9am unless something has run.
--
-- What IS stored is the human decision -- rejected, waived, awaiting review --
-- because no amount of date arithmetic can derive that.

create type ocs.compliance_kind as enum (
  'GENERAL_LIABILITY',
  'WORKERS_COMP',
  'WORKERS_COMP_EXEMPTION',
  'AUTO_LIABILITY',
  'EXCESS_UMBRELLA',
  'PROFESSIONAL_LIABILITY',
  'STATE_LICENSE',
  'LOCAL_REGISTRATION',
  'BUSINESS_TAX_RECEIPT',
  'W9',
  'CERT_OF_INSURANCE',
  'BOND'
);

/*
 * Only the decisions a person makes. Everything else -- valid, expiring,
 * expired -- is derived from the expiry date at read time.
 */
create type ocs.compliance_decision as enum (
  'pending_review',
  'accepted',
  'rejected',
  'waived'
);

create table ocs.compliance_items (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references ocs.companies (id) on delete cascade,

  kind          ocs.compliance_kind not null,

  carrier       text,            -- insurer, or the issuing authority
  policy_number text,

  -- Integer cents. A coverage limit compared as a float is a limit that can
  -- fail a comparison it should pass.
  limit_per_occurrence_cents bigint
    check (limit_per_occurrence_cents is null or limit_per_occurrence_cents >= 0),
  limit_aggregate_cents bigint
    check (limit_aggregate_cents is null or limit_aggregate_cents >= 0),

  effective_date date,
  expires_at     date,

  document_id   uuid references ocs.documents (id) on delete set null,

  decision      ocs.compliance_decision not null default 'pending_review',
  -- Set when a coordinator rejects an upload, so the contractor is told why
  -- rather than left to guess.
  decision_note text,
  decided_by    uuid references ocs.app_users (id),
  decided_at    timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- One live record per kind per contractor. Two general liability policies
  -- means two answers to "are they covered", and nothing decides which wins.
  unique (company_id, kind),

  -- A rejection must say why. "Rejected" with no reason generates the phone
  -- call this system exists to prevent.
  constraint compliance_rejection_explained check (
    decision <> 'rejected' or (decision_note is not null and length(btrim(decision_note)) > 0)
  ),

  -- A waiver is a deliberate exception to a rule, so it records who made it.
  constraint compliance_waiver_attributed check (
    decision <> 'waived' or (decided_by is not null and decided_at is not null)
  ),

  constraint compliance_dates_ordered check (
    effective_date is null or expires_at is null or expires_at >= effective_date
  )
);

create index compliance_items_company_idx on ocs.compliance_items (company_id, kind);
-- Drives the expiring-soon screen without scanning the table.
create index compliance_items_expiry_idx on ocs.compliance_items (expires_at)
  where expires_at is not null and decision <> 'waived';

create trigger compliance_items_set_updated_at
  before update on ocs.compliance_items
  for each row execute function ocs.set_updated_at();

/*
 * Can we file for this contractor today?
 *
 * The one question the whole table exists to answer, in one place so that no
 * caller has to reassemble it. GENERAL_LIABILITY, WORKERS_COMP and
 * STATE_LICENSE block filing; a waiver is a deliberate exception and clears
 * the block; a workers-comp exemption certificate satisfies WORKERS_COMP,
 * which is how Florida actually works for a qualifying officer.
 */
create or replace function ocs.can_file_for(p_company_id uuid)
returns boolean language sql stable set search_path = ocs, pg_temp
as $$
  select not exists (
    select 1
      from unnest(array['GENERAL_LIABILITY','WORKERS_COMP','STATE_LICENSE']::ocs.compliance_kind[]) as required(kind)
     where not exists (
       select 1 from ocs.compliance_items c
        where c.company_id = p_company_id
          and c.decision in ('accepted', 'waived')
          and (c.expires_at is null or c.expires_at >= current_date)
          and (
            c.kind = required.kind
            or (required.kind = 'WORKERS_COMP' and c.kind = 'WORKERS_COMP_EXEMPTION')
          )
     )
  )
$$;

grant execute on function ocs.can_file_for(uuid) to ocs_app, ocs_service;

alter table ocs.compliance_items enable row level security;
alter table ocs.compliance_items force row level security;

create policy tenant_isolation on ocs.compliance_items
  for all to ocs_app, ocs_service
  using (company_id = ocs.current_company_id() or ocs.is_service_context())
  with check (company_id = ocs.current_company_id() or ocs.is_service_context());

grant select, insert, update on ocs.compliance_items to ocs_app, ocs_service;

comment on table ocs.insurance_policies is
  'Superseded by ocs.compliance_items, which answers "can we file for them '
  'today" in one query instead of two. Empty; kept until nothing references it.';
comment on table ocs.licenses is
  'Superseded by ocs.compliance_items. See the comment on insurance_policies.';

-- 0019  Notarization records
--
-- A notarial act is a legal instrument, and the record of it either stands up
-- years later or it does not. That makes this table unlike the rest of the
-- schema: the value is not in serving a screen, it is in being correct and
-- unaltered when somebody disputes a lien or a Notice of Commencement in 2033.
--
-- So the rules below are database constraints rather than route checks. A
-- completed notarization cannot be edited by any code path; a remote online
-- notarization cannot be recorded as complete without a pointer to the session
-- recording Florida requires; and the retention deadline is computed here,
-- never accepted from a caller, for the same reason a supervision timestamp is:
-- a deadline the caller can set is a deadline the caller can shorten.

create type ocs.notary_type as enum (
  'ron',        -- remote online notarization, s.117.201-117.305 F.S.
  'in_person'
);

create type ocs.notary_status as enum (
  'requested',
  'scheduled',
  'completed',
  'failed',
  'cancelled'
);

create type ocs.notary_provider as enum (
  'docusign_notary', 'proof', 'bluenotary', 'in_house'
);

/*
 * Ten years, from s.117.245 F.S.
 *
 * A function rather than a literal in three places, because the day this number
 * changes it must change everywhere at once. A retention period that is ten
 * years in one place and eleven in another is worse than either.
 */
create or replace function ocs.notary_retention_until(completed timestamptz)
returns timestamptz language sql immutable
as $$ select completed + interval '10 years' $$;

create table ocs.notarizations (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references ocs.companies (id) on delete cascade,
  document_id   uuid not null references ocs.documents (id) on delete cascade,

  -- Set when the notarization is part of a wider signing ceremony.
  signature_request_id uuid,

  type          ocs.notary_type not null,
  status        ocs.notary_status not null default 'requested',
  provider      ocs.notary_provider,

  scheduled_for timestamptz,
  completed_at  timestamptz,

  -- The notary's own details, copied onto this record at the moment of the act
  -- rather than referenced. A commission that is later renewed, transferred or
  -- revoked must not change what this record says happened.
  notary_name                   text,
  notary_commission_number      text,
  notary_commission_expires_at  date,

  /*
   * Pointers to evidence held by the provider, not the evidence itself.
   *
   * The audio-video recording of a RON session is large and sensitive, and
   * Florida places the retention duty on the notary or their RON provider.
   * Storing a copy here would create a second custodian of the same personal
   * data with no legal obligation attached to it.
   */
  session_recording_ref text,
  journal_entry_ref     text,

  -- Computed by the trigger below. Never accepted from a caller.
  retention_until timestamptz,

  external_id   text,
  requested_by  uuid references ocs.app_users (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- A completed act has a time; an incomplete one does not carry a stale time
  -- from a previous attempt.
  constraint notarizations_completed_has_time
    check ((status = 'completed') = (completed_at is not null)),

  /*
   * Florida requires the RON session recording to be retained for ten years. A
   * completed RON record with no pointer to that recording is not a complete
   * record -- it is a claim that an act happened with nothing to show for it.
   */
  constraint notarizations_ron_needs_recording
    check (
      status <> 'completed'
      or type <> 'ron'
      or (session_recording_ref is not null and length(btrim(session_recording_ref)) > 0)
    ),

  -- A completed act names the notary who performed it. "Notarized by someone"
  -- is not a record anybody can rely on.
  constraint notarizations_completed_names_notary
    check (
      status <> 'completed'
      or (notary_name is not null and length(btrim(notary_name)) > 0
          and notary_commission_number is not null
          and length(btrim(notary_commission_number)) > 0)
    )
);

create index notarizations_company_idx on ocs.notarizations (company_id, created_at desc);
create index notarizations_document_idx on ocs.notarizations (document_id);
create index notarizations_open_idx on ocs.notarizations (scheduled_for)
  where status in ('requested', 'scheduled');
create index notarizations_retention_idx on ocs.notarizations (retention_until)
  where retention_until is not null;

create trigger notarizations_set_updated_at
  before update on ocs.notarizations
  for each row execute function ocs.set_updated_at();

-- The document decides the tenant, so a notarization cannot be filed into a
-- company that does not own the document being notarized.
create or replace function ocs.sync_notarization_company() returns trigger
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

create trigger notarizations_sync_company
  before insert or update of document_id, company_id on ocs.notarizations
  for each row execute function ocs.sync_notarization_company();

/*
 * Completing an act: compute the retention deadline, and check the commission.
 *
 * The commission check is the one worth having. A notarial act performed after
 * the notary's commission expired is void, and discovering that in litigation
 * years later is far more expensive than refusing it now. It is a hard error
 * rather than a warning for exactly that reason.
 */
create or replace function ocs.finalise_notarization() returns trigger
  language plpgsql set search_path = ocs, pg_temp
as $$
begin
  if new.status <> 'completed' then
    new.retention_until := null;
    return new;
  end if;

  if new.notary_commission_expires_at is not null
     and new.completed_at::date > new.notary_commission_expires_at then
    raise exception
      'the notary commission expired on % and cannot notarize an act dated %',
      new.notary_commission_expires_at, new.completed_at::date;
  end if;

  new.retention_until := ocs.notary_retention_until(new.completed_at);
  return new;
end;
$$;

create trigger notarizations_finalise
  before insert or update on ocs.notarizations
  for each row execute function ocs.finalise_notarization();

/*
 * A completed notarization is a finished record.
 *
 * Only the evidence pointers may still be filled in, because a RON provider
 * often returns the recording reference minutes or hours after the session
 * ends. Everything else -- who notarized, when, under what commission, for
 * which document -- is fixed at the moment of the act. An amendment would be a
 * different act, and would need its own record.
 */
create or replace function ocs.protect_completed_notarization() returns trigger
  language plpgsql set search_path = ocs, pg_temp
as $$
begin
  if old.status <> 'completed' then
    return new;
  end if;

  if new.status is distinct from old.status
     or new.type is distinct from old.type
     or new.document_id is distinct from old.document_id
     or new.company_id is distinct from old.company_id
     or new.completed_at is distinct from old.completed_at
     or new.notary_name is distinct from old.notary_name
     or new.notary_commission_number is distinct from old.notary_commission_number
     or new.notary_commission_expires_at is distinct from old.notary_commission_expires_at
     or new.retention_until is distinct from old.retention_until then
    raise exception
      'a completed notarization is a finished record; only the recording and journal references may still be attached';
  end if;

  return new;
end;
$$;

create trigger notarizations_protect_completed
  before update on ocs.notarizations
  for each row execute function ocs.protect_completed_notarization();

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------

alter table ocs.notarizations enable row level security;
alter table ocs.notarizations force row level security;

create policy tenant_isolation on ocs.notarizations
  for all to ocs_app, ocs_service
  using (company_id = ocs.current_company_id() or ocs.is_service_context())
  with check (company_id = ocs.current_company_id() or ocs.is_service_context());

grant select, insert, update on ocs.notarizations to ocs_app, ocs_service;

-- Deliberately no DELETE grant. A notarial record is retained for ten years by
-- law; the ability to remove one should not exist in the application at all.

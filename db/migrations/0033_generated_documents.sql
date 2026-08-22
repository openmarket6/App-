-- =============================================================================
-- 0033  Generated instruments: Notice of Commencement, Notice to Owner,
--       hold harmless, contractor services agreement
-- =============================================================================
--
-- These are not files. A file is something a person made elsewhere and uploaded;
-- these are instruments this system produced, and that difference decides the
-- whole shape of this table.
--
-- Three things follow from it:
--
--   1. The INPUT is stored, not just the output. A recorded Notice of
--      Commencement that turns out to be defective raises one question -- what
--      was it made from? -- and a system that kept only the rendered page
--      cannot answer it. `input_snapshot` is the answer, frozen.
--
--   2. The output is HASHED. The rendering is deterministic, so a hash that
--      still matches proves the stored page is the page that was produced. It
--      also means the paper copy in a job trailer can be checked against the
--      record.
--
--   3. WARNINGS TRAVEL WITH IT. Somebody generated an NTO past its 45-day
--      window, or an agreement holding less retainer than the plan calls for,
--      and chose to go ahead. That decision belongs on the document, not in a
--      log line nobody reads.
--
-- ⚠️ The templates that produce these have not been reviewed by a Florida
-- construction attorney. See src/domain/documents/noc.ts.

create type ocs.generated_document_kind as enum (
  'NOC',                    -- Notice of Commencement, Fla. Stat. 713.13
  'NTO',                    -- Notice to Owner, Fla. Stat. 713.06
  'HOLD_HARMLESS',          -- indemnity, Fla. Stat. 725.06
  'CONTRACTOR_AGREEMENT'    -- what OCS sells, at the price snapshotted
);

/*
 * The lifecycle differs by kind and the differences are real, not cosmetic.
 * An NOC is RECORDED with a clerk. An NTO is SERVED on an owner. An agreement
 * is EXECUTED by signature. Collapsing those into one word would lose the only
 * fact anyone actually asks about later.
 */
create type ocs.generated_document_status as enum (
  'draft',      -- produced, nothing done with it yet
  'issued',     -- handed to whoever acts on it
  'executed',   -- signed (agreements)
  'recorded',   -- recorded with the county clerk (NOC)
  'served',     -- served on the owner (NTO)
  'void'        -- withdrawn; kept, never deleted
);

create table ocs.generated_documents (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references ocs.companies (id) on delete cascade,

  kind            ocs.generated_document_kind not null,
  status          ocs.generated_document_status not null default 'draft',

  project_id      uuid references ocs.projects (id) on delete set null,
  permit_id       uuid references ocs.permits (id) on delete set null,

  -- Free-text label so a list is readable without opening anything.
  title           text not null check (length(btrim(title)) > 0),

  /*
   * Exactly what the document was rendered from. Never updated in place: a
   * change means a new row that supersedes this one, because the point of the
   * snapshot is that it cannot move under the signature.
   */
  input_snapshot  jsonb not null,

  rendered_html   text not null check (length(rendered_html) > 0),
  content_sha256  text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),

  -- Non-blocking problems the generator raised and somebody accepted anyway.
  warnings        jsonb not null default '[]'::jsonb,

  -- Set when the document is filed into the document library for download.
  document_id     uuid references ocs.documents (id) on delete set null,

  -- A regenerated document points at the one it replaces. Nothing is deleted.
  supersedes_id   uuid references ocs.generated_documents (id) on delete set null,

  generated_by    uuid references ocs.app_users (id),
  generated_at    timestamptz not null default now(),

  -- The one fact anyone asks for later, per kind.
  completed_at    timestamptz,
  -- Clerk instrument number, book/page, or the tracking number of the service.
  completion_reference text,
  completion_note text,

  voided_at       timestamptz,
  voided_by       uuid references ocs.app_users (id),
  void_reason     text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  /*
   * A status a kind cannot reach is a bug that would otherwise be discovered by
   * somebody reading a report. An agreement is never "recorded"; a Notice of
   * Commencement is never "served" -- it is recorded and posted.
   */
  constraint generated_documents_status_fits_kind check (
    status in ('draft', 'issued', 'void')
    or (kind = 'NOC' and status = 'recorded')
    or (kind = 'NTO' and status = 'served')
    or (kind in ('HOLD_HARMLESS', 'CONTRACTOR_AGREEMENT') and status = 'executed')
  ),

  -- A terminal status without its date is a claim with no evidence.
  constraint generated_documents_completion_has_a_date check (
    status in ('draft', 'issued', 'void') or completed_at is not null
  ),

  constraint generated_documents_void_has_a_reason check (
    status <> 'void'
    or (voided_at is not null and length(btrim(coalesce(void_reason, ''))) > 0)
  )
);

create index generated_documents_company_idx
  on ocs.generated_documents (company_id, generated_at desc);
create index generated_documents_kind_idx
  on ocs.generated_documents (company_id, kind, status);
create index generated_documents_permit_idx
  on ocs.generated_documents (permit_id) where permit_id is not null;
create index generated_documents_project_idx
  on ocs.generated_documents (project_id) where project_id is not null;
create index generated_documents_supersedes_idx
  on ocs.generated_documents (supersedes_id) where supersedes_id is not null;

create trigger generated_documents_set_updated_at
  before update on ocs.generated_documents
  for each row execute function ocs.set_updated_at();

comment on column ocs.generated_documents.input_snapshot is
  'What the document was rendered from, frozen. A defective instrument raises '
  'the question "what was it made from?", and only this column answers it.';
comment on column ocs.generated_documents.content_sha256 is
  'sha256 of rendered_html. Rendering is deterministic, so a matching hash '
  'proves a paper copy is the copy that was produced.';
comment on column ocs.generated_documents.warnings is
  'Non-blocking problems raised at generation and accepted anyway. Kept with '
  'the document because that acceptance was a decision.';

alter table ocs.generated_documents enable row level security;
alter table ocs.generated_documents force row level security;

create policy tenant_isolation on ocs.generated_documents
  for all
  to ocs_app, ocs_service
  using (company_id = ocs.current_company_id() or ocs.is_service_context())
  with check (company_id = ocs.current_company_id() or ocs.is_service_context());

grant select, insert, update on ocs.generated_documents to ocs_app, ocs_service;

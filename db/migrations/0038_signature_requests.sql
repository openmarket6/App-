-- =============================================================================
-- 0038  Signatures, and the evidence that makes them worth having
-- =============================================================================
--
-- The signing screens have existed on both the staff side and the contractor
-- portal since before this backend did. They called /api/signing/*, which
-- answered 501, so step 4 of onboarding -- "Agreements" -- sat at pending for
-- every contractor ever onboarded and the checklist could not reach 100%.
-- Nobody has a signed master service agreement with this firm.
--
-- The federal E-SIGN Act and Florida's UETA make an electronic signature as
-- enforceable as ink, but only if three things can be shown afterwards: that
-- the signer INTENDED to sign, that they SAW the document they were signing,
-- and that neither has changed since. This table is shaped by those three
-- burdens and by nothing else.
--
--   THE DOCUMENT TEXT IS STORED, NOT REFERENCED. `rendered_body` is the exact
--   words put in front of the signer, placeholders already resolved. Joining to
--   a template at read time would mean a template edit silently changes what
--   somebody is recorded as having agreed to.
--
--   AND HASHED. `rendered_hash` is sha256 of that text. Recomputed at signing
--   time and stored again inside the evidence, so a later mismatch between the
--   two is visible as a fact rather than a suspicion. This is what the
--   frontend surfaces as "compromised" -- signed, but the words moved.
--
--   THE AUDIT TRAIL IS APPENDED, NEVER REPLACED. created, sent, opened,
--   read_to_end, signed. "They opened it and scrolled to the end" is the
--   presentment half of the burden, and it is only provable if the opening was
--   recorded when it happened.
--
--   CONSENT IS ITS OWN COLUMN. E-SIGN requires consent to transact
--   electronically be AFFIRMATIVE. A checkbox nobody can find later is the
--   same as no checkbox, so it is stored beside the signature rather than
--   buried in a jsonb blob.

create type ocs.signable_kind as enum (
  'MASTER_SERVICE_AGREEMENT',
  'HOLD_HARMLESS',
  'CREDIT_CARD_AUTHORIZATION',
  'MANAGED_LICENSE_ADDENDUM',
  'W9_ACKNOWLEDGEMENT',
  'PERMIT_AGENT_AUTHORIZATION'
);

/*
 * DRAFT exists but is not reachable from any screen yet. It is here because
 * the alternative -- creating rows already SENT -- means a failure between
 * writing the row and sending the email is indistinguishable from a signer
 * ignoring it.
 */
create type ocs.signature_status as enum (
  'DRAFT', 'SENT', 'VIEWED', 'SIGNED', 'DECLINED', 'VOIDED', 'EXPIRED'
);

create table ocs.signature_requests (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references ocs.companies (id) on delete cascade,

  kind          ocs.signable_kind not null,
  status        ocs.signature_status not null default 'SENT',

  /*
   * The template is identified, not joined.
   *
   * Templates live in src/domain/signing/templates.ts rather than a table, so
   * counsel's review lands in a git diff and a wording change is a reviewable
   * commit instead of an UPDATE nobody sees. The id and version are recorded
   * so a signed row can still say which text it came from -- but the text
   * itself is in rendered_body, which is what actually binds.
   */
  template_id      text not null check (length(btrim(template_id)) > 0),
  template_version int not null check (template_version > 0),

  rendered_body text not null check (length(btrim(rendered_body)) > 0),
  rendered_hash text not null check (rendered_hash ~ '^[0-9a-f]{64}$'),

  -- Who we asked, frozen at send time. The contact on the company record will
  -- have changed by the time anyone asks who agreed to this.
  signer_name   text not null check (length(btrim(signer_name)) > 0),
  signer_email  text not null check (position('@' in signer_email) > 1),
  signer_title  text,

  sent_at       timestamptz,
  viewed_at     timestamptz,
  signed_at     timestamptz,
  declined_at   timestamptz,
  decline_reason text,
  expires_at    timestamptz,

  /*
   * The signature itself: typed name, optional drawn image, consent flag, IP,
   * user agent, and the hash recomputed at the moment of signing.
   *
   * Null until signed. Not a separate table because a signature without its
   * request is meaningless and the two are always read together.
   */
  signature     jsonb,

  -- Appended. Each entry: {at, event, ipAddress, detail}.
  audit_trail   jsonb not null default '[]'::jsonb,

  requested_by  uuid references ocs.app_users (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  /*
   * States that can only arise from a bug, refused at the door.
   *
   * Each of these would read as an ordinary row in a report while quietly
   * destroying the evidentiary value of the record: a signature with no date
   * cannot be placed in time, and a row marked SIGNED with no signature is a
   * contractor the system believes is bound by nothing.
   */
  constraint signature_signed_has_evidence check (
    status <> 'SIGNED' or (signature is not null and signed_at is not null)
  ),
  constraint signature_declined_has_a_date check (
    status <> 'DECLINED' or declined_at is not null
  ),
  constraint signature_evidence_implies_signed check (
    signature is null or status = 'SIGNED'
  )
);

/*
 * One live request per kind per contractor.
 *
 * Two open master service agreements is a question nobody can answer -- the
 * contractor signs one and the other sits pending forever, so the verdict says
 * pending and onboarding never completes. Superseded rows (VOIDED, DECLINED,
 * EXPIRED) are excluded so a replacement can always be sent, and SIGNED is
 * excluded so re-signing after a wording change is possible.
 */
create unique index signature_requests_one_open_per_kind
  on ocs.signature_requests (company_id, kind)
  where status in ('DRAFT', 'SENT', 'VIEWED');

create index signature_requests_company_idx
  on ocs.signature_requests (company_id, created_at desc);
create index signature_requests_pending_idx
  on ocs.signature_requests (company_id, kind)
  where status in ('SENT', 'VIEWED');

create trigger signature_requests_set_updated_at
  before update on ocs.signature_requests
  for each row execute function ocs.set_updated_at();

comment on table ocs.signature_requests is
  'One row per document put in front of one contractor. Shaped by the three '
  'things E-SIGN and Florida UETA require be provable afterwards: intent, '
  'presentment, and that neither signature nor document changed since.';
comment on column ocs.signature_requests.rendered_body is
  'The exact words shown to the signer. Stored rather than joined, so editing '
  'a template cannot change what somebody is recorded as having agreed to.';
comment on column ocs.signature_requests.rendered_hash is
  'sha256 of rendered_body. Recomputed at signing and stored again inside '
  'signature.documentHashAtSigning; a mismatch is the tamper signal.';
comment on column ocs.signature_requests.audit_trail is
  'Appended, never replaced. Presentment is only provable if the opening was '
  'recorded when it happened.';

alter table ocs.signature_requests enable row level security;
alter table ocs.signature_requests force row level security;

create policy tenant_isolation on ocs.signature_requests
  for all
  to ocs_app, ocs_service
  using (company_id = ocs.current_company_id() or ocs.is_service_context())
  with check (company_id = ocs.current_company_id() or ocs.is_service_context());

grant select, insert, update on ocs.signature_requests to ocs_app, ocs_service;

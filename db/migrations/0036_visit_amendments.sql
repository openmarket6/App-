-- Amendments to a logged visit, and the columns the frontend already reads.
--
-- SiteVisit in src/shared/supervision.ts carries amendedAt / amendedBy /
-- amendmentReason, and the Supervision page renders them -- but nothing has
-- ever stored them, so the adapter hard-coded null and an amendment silently
-- rewrote history. Recording who changed a site record and why is the whole
-- reason the record is worth anything in a dispute, so it gets columns.

alter table ocs.supervision_visits
  add column if not exists amended_at       timestamptz,
  add column if not exists amended_by       uuid references ocs.app_users (id),
  add column if not exists amendment_reason text;

-- An amendment is not an amendment without a reason for it.
alter table ocs.supervision_visits
  drop constraint if exists visits_amendment_requires_reason;
alter table ocs.supervision_visits
  add constraint visits_amendment_requires_reason
    check (amended_at is null or amendment_reason is not null);

grant update (findings, corrections_required, amended_at, amended_by, amendment_reason)
  on ocs.supervision_visits to ocs_app, ocs_service;
grant insert on ocs.supervision_visits to ocs_app, ocs_service;
grant insert on ocs.supervision_visit_photos to ocs_app, ocs_service;

-- What a coordinator learns on the phone.
--
-- The Jurisdictions page has always offered a "record a correction" form and
-- the PATCH behind it never existed, so nothing typed there was ever kept.
-- The generated dataset is regenerated from scratch, which is exactly why
-- these live on the row instead: a correction has to survive the next rebuild.

alter table ocs.municipalities
  add column if not exists portal_url_confidence text not null default 'low'
    check (portal_url_confidence in ('low', 'high')),
  add column if not exists automation_approved boolean not null default false,
  add column if not exists automation_approved_at timestamptz,
  add column if not exists automation_approved_by uuid references ocs.app_users (id),
  add column if not exists tos_review_note text;

/*
 * Automating against a portal is a legal posture, not a feature flag: someone
 * has to have read that portal's terms and written down what they concluded.
 * Without the note the approval is nobody's decision.
 */
alter table ocs.municipalities
  drop constraint if exists municipalities_automation_needs_review;
alter table ocs.municipalities
  add constraint municipalities_automation_needs_review
    check (automation_approved = false or tos_review_note is not null);

grant update (portal_url, contact_phone, portal_url_confidence,
              automation_approved, automation_approved_at,
              automation_approved_by, tos_review_note)
  on ocs.municipalities to ocs_app, ocs_service;

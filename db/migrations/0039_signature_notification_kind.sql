-- 0039  A notification kind for "please sign this"
--
-- ocs.notification_kind has covered permits, drafting, documents, compliance
-- expiry, messages and payments since 0005. Signing was not a thing this
-- system did, so there was no kind for it.
--
-- Now there is one. Without it a signature request is recorded as SENT and the
-- contractor is told nothing: no notification in the portal, no email queued.
-- The staff screen says "Sent to ana@alpha.test" and means "written to a row",
-- which is exactly the kind of quiet difference between what a screen claims
-- and what happened that this audit keeps turning up.
--
-- `system` would have worked and is the wrong answer. The kind is what the
-- portal groups and filters on, and burying a request for a signature inside
-- the same bucket as everything uncategorised is how it gets scrolled past.

alter type ocs.notification_kind add value if not exists 'signature_requested';

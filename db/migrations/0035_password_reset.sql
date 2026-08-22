-- Password reset.
--
-- Invitations deliberately refuse accounts that already have a password, so
-- until now a forgotten password had no route back at all: the only recovery
-- was an administrator editing the database by hand. This gives reset its own
-- token, separate from invite_token, exactly as the note in accept-invite asks
-- for -- one credential-bearing column per purpose, so neither flow can be
-- used to do the other's job.

alter table ocs.app_users
  add column if not exists reset_token       text,
  add column if not exists reset_expires_at  timestamptz;

-- Lookup is by token on every reset, and the column is sparse: only accounts
-- with a live request have one.
create unique index if not exists app_users_reset_token_key
  on ocs.app_users (reset_token)
  where reset_token is not null;

grant update (reset_token, reset_expires_at) on ocs.app_users to ocs_app, ocs_service;

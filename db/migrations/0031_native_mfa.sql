-- 0031  Multi-factor authentication for the native login
--
-- requireMfa has existed since the beginning and reads `aal2` from a SUPABASE
-- token. The application signs in through /api/auth/login, which issues its own
-- token carrying no such claim, so every endpoint demanding a second factor was
-- either unreachable or -- worse, where I moved one onto the native path -- was
-- silently not demanding anything.
--
-- This is the second factor for the native login. It matters most for the
-- people it will be turned on for first: an administrator's password is the
-- single thing standing between an attacker and the municipal credentials that
-- pull permits under this firm's licence.

alter table ocs.app_users
  /*
   * The TOTP secret, encrypted with the same key as municipal credentials. A
   * secret in plaintext is a database dump that lets someone generate valid
   * codes forever, which is worse than no second factor at all -- because
   * everyone believes there is one.
   */
  add column mfa_secret_encrypted bytea,

  -- Separate from the secret's presence, because enrolment has two steps: a
  -- secret is issued, and only once a code from it has been verified is the
  -- factor actually on. Without the split, a half-finished enrolment locks
  -- someone out of their own account.
  add column mfa_enabled boolean not null default false,
  add column mfa_enrolled_at timestamptz,

  -- Recovery codes, hashed. Single-use; consumed by deletion from the array.
  add column mfa_recovery_hashes text[] not null default '{}',

  add constraint app_users_mfa_enabled_has_secret
    check (not mfa_enabled or mfa_secret_encrypted is not null);

create index app_users_mfa_idx on ocs.app_users (mfa_enabled)
  where mfa_enabled and deleted_at is null;

/*
 * Whether the session behind this refresh token was created with a second
 * factor.
 *
 * A refresh is the same session continuing, not a new sign-in, so the fact has
 * to survive rotation. Without it an administrator would be silently demoted
 * fifteen minutes into their work and asked to re-authenticate for something
 * they had already authenticated for.
 */
alter table ocs.refresh_tokens
  add column mfa_verified boolean not null default false;

/*
 * A short-lived ticket proving the password step succeeded.
 *
 * Sign-in becomes two requests, so something has to carry the fact that the
 * first one passed. It is NOT an access token: it grants nothing, expires in
 * minutes, and is single-use. Reusing the access token for this would mean
 * issuing a working session to someone who has only proved half of what is
 * required.
 */
create table ocs.mfa_challenges (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references ocs.app_users (id) on delete cascade,
  token_hash  text not null unique,

  -- Bounded, so a stolen ticket cannot be brute-forced indefinitely. Six
  -- attempts is enough for a mistyped code and far short of a million.
  attempts    int not null default 0 check (attempts >= 0),

  expires_at  timestamptz not null,
  consumed_at timestamptz,

  ip_address  inet,
  user_agent  text,
  created_at  timestamptz not null default now()
);

create index mfa_challenges_user_idx on ocs.mfa_challenges (user_id, created_at desc);
create index mfa_challenges_expiry_idx on ocs.mfa_challenges (expires_at);

-- Service-only: a challenge is issued and consumed by the login flow, never
-- read by a signed-in user.
alter table ocs.mfa_challenges enable row level security;
alter table ocs.mfa_challenges force row level security;

create policy service_only on ocs.mfa_challenges
  for all to ocs_app, ocs_service
  using (ocs.is_service_context()) with check (ocs.is_service_context());

grant select, insert, update, delete on ocs.mfa_challenges to ocs_app, ocs_service;

/*
 * Housekeeping. A consumed or expired challenge has no further use, and the
 * table would otherwise grow by one row per sign-in forever.
 */
create or replace function ocs.purge_expired_mfa_challenges() returns int
  language sql security definer set search_path = ocs, pg_temp
as $$
  with gone as (
    delete from ocs.mfa_challenges
     where expires_at < now() - interval '1 day'
    returning 1
  )
  select count(*)::int from gone
$$;

grant execute on function ocs.purge_expired_mfa_challenges() to ocs_service;

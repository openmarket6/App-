# Brief for Claude Cowork — One Contractor Solutions

You have access to the live accounts (Supabase, Render, Netlify, GitHub).
The other Claude session does not — its sandbox is blocked from all outbound
network except GitHub, which is why these steps are being handed to you.

All code referenced below is already committed and pushed. Nothing needs to be
written. These are configuration and verification tasks.

- **Repo:** `openmarket6/App-`
- **Branch with all current work:** `claude/ocs-migration-audit-phase-0-03a8qm`
- **API (Render):** `https://ocs-api-i654.onrender.com`
- **Frontend (Netlify):** `https://1contractorapp.netlify.app`

**Security rule for this whole task:** never print, echo, paste or repeat the
*value* of any environment variable, connection string, password, API key or
token. Refer to them by name only. If you need to confirm one is set, confirm
that it is set — do not show it.

---

## TASK 1 — Get Kat signed in (do this first, it is blocking a person)

`kat@1contractorsolutions.com` cannot sign in. The account exists but has no
usable password, which the API reports as "Email or password is incorrect"
because it returns one identical message for every failure so the login form
cannot be used to discover who has an account.

In **Supabase → SQL Editor**, run this. It returns a finished URL:

```sql
insert into ocs.app_users (email, name, app_role, is_active, invite_token, invite_expires_at)
values ('kat@1contractorsolutions.com','Kat','PERMIT_TECH',true,
        replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-',''), now()+interval '7 days')
on conflict (lower(email)) do update
  set app_role='PERMIT_TECH', is_active=true, deleted_at=null, client_id=null,
      invite_token=excluded.invite_token, invite_expires_at=excluded.invite_expires_at
returning 'https://ocs-api-i654.onrender.com/accept-invite?token='||invite_token;
```

Send the returned URL to Kat. She sets her own password (**12 characters
minimum** — shorter is rejected) and is signed in immediately. The link works
once and expires in 7 days.

If she needs full admin instead of permit tech, change both `'PERMIT_TECH'`
values to `'ADMIN'` before running it.

**Report back:** whether the statement returned a URL, and whether Kat got in.

---

## TASK 2 — Configure Render so the deploy actually migrates

The API service on Render needs three settings correct. Check each in the
dashboard and fix any that are wrong.

**2a. `DATABASE_MIGRATION_URL` must be set, using the OWNER role.**

This is the Supabase connection string for the `postgres` (owner) user — NOT
`ocs_app` and NOT `ocs_service`.

Why it matters: migrations create tables and security policies. The app and
service roles deliberately cannot do that — that separation is what stops a
compromised API from rewriting the schema. If this variable is missing, the
migration runner falls back to the service role and the deploy fails with
`permission denied for database`. That failure mode was tested and confirmed.

**2b. Pre-Deploy Command must be `npm run migrate`.**

It is declared in `render.yaml`, but if the service was created by hand in the
dashboard rather than from the blueprint, this field may be empty — in which
case migrations silently never run and the new endpoints return errors against
a schema missing their tables.

**2c. Branch must be `claude/ocs-migration-audit-phase-0-03a8qm`.**

`render.yaml` says `main`, but all current work is on the feature branch. The
dashboard setting is what actually applies. Confirm it points at the branch
above.

**2d. Confirm the background worker service exists.**

There should be a *second* Render service running `npm run start:worker`, with
the same database variables and the same `INTEGRATION_ENCRYPTION_KEY` value as
the API. Without it, scheduled municipal status checks and reminders never run.
If it does not exist, say so — do not create it without asking.

Then **deploy**. Migrations 0015 and 0016 will apply automatically. All 16
migrations were verified to apply cleanly from an empty database, and a second
run reports "No pending migrations", so redeploying is safe.

**Report back:** which of 2a–2d were already correct, which you changed, and
whether the deploy succeeded.

---

## TASK 3 — Confirm Netlify

**3a.** Branch should be `claude/ocs-migration-audit-phase-0-03a8qm`.

**3b.** Publish directory is `public`, build command is empty. Both are in
`netlify.toml` and should not need changing.

**3c.** After the deploy, check these URLs load:

| URL | Expect |
|---|---|
| `/` | Marketing home page, headline "The license, the supervision, and the permit" |
| `/how-it-works` | Four-step page |
| `/pricing` | Price table, $199/permit and $1,500–$10,000/mo tiers |
| `/demo` | Booking form |
| `/dashboard` | The React application (sign-in screen if logged out) |

**3d.** Submit the form on `/demo` with a test address. Expect a thank-you
message, not an error. Then confirm the row landed:

```sql
select company_name, contact_name, email, status, created_at
  from ocs.demo_requests order by created_at desc limit 5;
```

**Report back:** any URL that did not load as described, and whether the demo
form stored a row.

---

## TASK 4 — Diagnose remaining login problems

After the deploy, run this in Supabase and report the result. It exposes no
passwords — `has_password` is a true/false derived from whether a hash exists.

```sql
select email, app_role, is_active,
       (password_hash is not null) as has_password,
       last_login_at
  from ocs.app_users
 where deleted_at is null
 order by last_login_at desc nulls last;
```

How to read it:

- `has_password = false` — never completed setup. Send them an invite link
  using the TASK 1 statement with their email substituted.
- `app_role = 'PENDING'` — can sign in but can do nothing once inside. Every
  screen will be empty or refused, which people report as "login is broken".
  Fix by setting their role.
- `is_active = false` — deactivated. Reactivating is part of the TASK 1
  statement.

**Note:** a bug where a *second browser tab* logged the user out with "Session
expired" was found and fixed; the fix goes live with the TASK 2 deploy. If
anyone reports being kicked out mid-task rather than being unable to sign in,
that was the cause.

**Report back:** the table, with the email column included, so accounts needing
attention can be identified.

---

## TASK 5 — Marketing video clips

The home page has two video slots that currently show a designed placeholder.
To activate them, add files to the repo at:

- `public/media/how-we-work.mp4` and `public/media/how-we-work.jpg`
- `public/media/platform-tour.mp4` and `public/media/platform-tour.jpg`

The `.jpg` files are poster frames shown before playback. Keep each video under
about 10 MB. If no clips exist yet, leave this — the placeholder is deliberate
and looks intentional, not broken.

---

## What is NOT needed

- No code changes. Everything is committed and pushed.
- No merge to `main` — do not merge without asking first.
- No new Render or Netlify services beyond confirming the worker exists.
- Do not run `npm run migrate` by hand. The pre-deploy command does it.

# One Contractor Solutions — handoff

Written for whoever picks this up next, human or otherwise. It assumes you know
nothing about the project and covers what it is, how to run it, what was done in
the audit that produced this package, and — the part worth reading twice — what
is still broken and why it was left that way.

**Going live: Tuesday.** Everything under "Before go-live" is real.

---

## 1. What this is

A multi-tenant platform for a Florida permitting, drafting, licensing and
supervision firm. Contractors ("clients") log into a portal; staff work the
same data from an admin side.

    Netlify  → the frontend (React, built into public/)
    Render   → the API and a background worker (Fastify, Node 22)
    Supabase → Postgres and object storage

One repository holds all of it.

### The layout

    src/
      index.ts              server assembly: middleware order matters, read it first
      worker.ts             background worker entry point
      config/env.ts         every setting, validated at boot; refuses to start without required ones
      auth/                 native email+password auth (native.ts) and Supabase auth (plugin.ts)
      db/                   pool, tenant context, migration runner
      domain/               business rules with no HTTP in them — documents, pricing, capabilities
      shared/               THE SINGLE SOURCE OF TRUTH, imported by BOTH the API and the React app
      routes/
        compat/             /api/* — what the shipped application actually calls
        *.ts                /v1/*  — Supabase-authenticated, UNREACHABLE from the app (see §6)
      jobs/                 queue, runner, handlers
      services/             storage, mail, stripe, notifications
    db/migrations/          numbered SQL, forward-only, checksummed
    tests/                  600+ tests, most against a real Postgres
    scripts/                preflight, config-gaps, catalogue SQL generator
    web/                    the React application

### The one structural thing to understand

`src/shared/` is imported by the server AND the browser. When a rule lives
there — "is this contractor cleared to file", "is this supervision record
defensible" — the screen and the server cannot disagree about it. That is
deliberate and worth preserving. A rule duplicated instead of shared is how the
two sides start giving different answers.

---

## 2. Running it

```bash
npm install
cp .env.example .env          # then fill it in; it holds no real values
npm run migrate               # apply pending migrations
npm run dev                   # API on :8080
npm run dev:worker            # background worker, separate process
npm run dev --prefix web      # frontend on :5173
```

### Before you push anything

```bash
npm run preflight
```

Both typechecks, a real database connection, the full suite, the build, the app
shell checked against what the build wrote, and a plain-English list of what is
not configured. It exists because "the tests pass" has repeatedly not been the
whole story here (§7).

Tests need a real Postgres. Three variables, three roles:

    TEST_DATABASE_URL          owner — applies migrations and seeds
    TEST_APP_DATABASE_URL      connects as ocs_app     (row-level security ON)
    TEST_SERVICE_DATABASE_URL  connects as ocs_service (RLS bypassed by flag)

**If those are unset the database tests SKIP and the suite still reports
success.** Preflight fails instead, which is the point of it.

---

## 3. Things that will bite you

**Zod strips unknown keys and reports success.** This has caused five separate
production faults. The shape is always the same: a screen sends a field, the
server returns 200, the value is discarded, and the damage appears elsewhere.
`parse()` in `src/lib/http-helpers.ts` now LOGS discarded keys. Search the logs
for `DISCARDED` when something saves and vanishes.

**Migrations are immutable once applied.** Checksummed. Editing one that has run
anywhere is caught at boot. Fixes go forward as a new migration. Two migrations
share the number 0034 — historical, grandfathered by a test; do not add a third.

**Postgres specifics that have caused outages here:**
- an enum value cannot be USED in the transaction that adds it — split into two migrations
- `on conflict` needs a matching unique index, partial predicate included
- triggers raise bare exceptions that surface as 500s unless caught
- `bigint` and `numeric` come back from node-postgres as **strings**

**Dates.** Half the date columns are `date` type and arrive as `'2026-06-01'`.
`Date.parse` of that is midnight UTC — 8pm the previous day in Florida.
Comparing one to an instant moves every boundary four hours early, only in the
evening. Use `src/shared/calendar.ts` (`calendarDay`, `daysBetween`, `isPast`).
Two known exceptions remain, deliberately — see §5.

**Two auth systems.** `/api/*` uses `requireApiAuth` (native tokens, what the app
issues). `/v1/*` uses `authenticate` (Supabase tokens the app never issues). A
feature built only on `/v1` is invisible to every user. This was the single most
productive bug class in the audit.

---

## 4. What the audit found and fixed

Roughly thirty commits. The ones worth knowing about, because they say what kind
of bug this codebase produces:

**Invisible from the response.** The permits list returned `serviceLine:
'EXPEDITING'` hard-coded, `correctionCycles: 0` hard-coded, and a `trade`
derived from a column name that was not in the result. Each was the right type
in the right place. Consequences: every permit badged as expediting on the line
where the firm's own licence is on the permit; a first-pass approval rate that
read 100% regardless; every permit classified SPECIALTY.

**Every date in the UI was a day early.** `Date.parse` on a bare date, rendered
through `toLocaleDateString`. A policy expiring 1 June displayed "May 31". On
every screen, all the time — which is why nobody caught it. A date consistently
one day out looks like the data.

**No field photograph could be uploaded.** Server body limit 1 MB; base64
inflates by a third; a phone photo is 2–5 MB. Every job-site photograph got 413
before the handler ran. Supervision photographs are what make a managed licence
defensible.

**The panic switch did not work.** `token_version` is documented as invalidating
every session and was enforced on the refresh path only. Access tokens carried
no version, so revocation left a stolen token working for fifteen more minutes.

**Every rate limit was bypassable.** `trustProxy: true` made `req.ip` the
caller-supplied value. Rotate `X-Forwarded-For` and the login limiter never
fires. Every audit IP was attacker-chosen.

**A job handler missing since migration 0007.** `system.cleanup_refresh_tokens`
scheduled every six hours with nothing registered — four permanent failures a
day, forever, and refresh tokens never purged.

**Signing did not exist.** Screens called `/api/signing/*` and got 501, so
onboarding step 4 could never complete for anybody. Built.

Also: the reaper could dedupe itself out of existence and permanently stop
background processing; record numbers were hand-rolled around the triggers that
serialise them; a contractor could be told "nothing is waiting on you" when the
compliance read had simply failed.

### Guards added

Fourteen test files whose only job is to stop a class of bug returning. Each was
verified by **deliberately breaking the code and watching it fail** — that is the
bar, and two guards written during the audit passed while proving nothing until
they were checked this way:

| Guard | Catches |
|---|---|
| `route-coverage` | a screen calling a path no route serves |
| `response-shape` | snake_case keys, credential material, invented values on the wire |
| `cross-tenant-http` | one contractor reading or writing another's data over HTTP |
| `request-fields` | a field a schema accepts and the handler never reads |
| `mutation-roundtrip` | a PATCH that reports success and changes nothing |
| `no-unhandled-errors` | any 5xx from malformed input, across 50 endpoints |
| `job-schedules` | a scheduled job with no handler, and the reverse |
| `enum-sync` | a Postgres enum and its TypeScript union drifting apart |
| `calendar-dates` | date boundaries computed against instants |
| `sequence-numbers` | hand-rolled record numbers bypassing the DB triggers |
| `drafting-catalogue` | the code catalogue and the DB table disagreeing |
| `build-integrity` | an app shell referencing a bundle that is not there |
| `tailwind-tokens` | a class naming a colour the palette does not define |
| `upload-limits` | a real phone photo being refused at the door |

**If one of these fails, it is telling you something true.** Do not loosen an
assertion to make it pass without understanding what it caught.

---

## 5. Known broken, deliberately

These are real. They were left at the owner's instruction or judged safe to
defer, and each is written up in the code beside the defect.

**Invoicing** — deferred while Stripe is unconfigured. All four bite the day it
is configured:
1. a refund never updates the invoice; it stays PAID at the full amount
2. a partially-refunded payment counts as **zero**, not its net, in the recompute
3. fractional quantities can 500 (`2.3 × 12500` = `28749.999999999996` into a bigint)
4. onboarding is recorded as collected before money moves — and the trigger
   refuses decreases, so it cannot be corrected through the app

**Two date fixes reverted** at the owner's instruction: the qualifier's licence
expiry gate and the invoice due date. Both still flip four hours early in the
evening. Safe only while no service licence is registered and no invoice issued.

**External HTTP calls inside database transactions** — six sites. Ten
supervisors uploading photos on job-site LTE would each hold a connection for up
to 60 seconds against a pool of 10, and the API stops. This is the largest
remaining availability risk. `src/routes/compat/mailings.ts` has the correct
pattern to copy: insert, commit, call outside, record in a second transaction.

**Retainer can be released twice** — no lock around the balance check, no DB
constraint against a negative balance.

**Read-modify-write races** on subscription plan changes and Stripe payment
webhook status.

---

## 6. Open questions and unfinished edges

- **`/v1` is 110 routes the application cannot reach.** Dead surface. Someone
  should decide whether to delete it or wire it up; leaving it is a maintenance
  and security cost with no user.
- **`PortalDashboard` and `PortalHome` are two implementations of one screen.**
  That is why the "nothing is waiting on you" guard existed on one and not the
  other.
- **39 queries still surface no error state.** Judged cosmetic — they populate
  dropdowns, where a failure degrades to an empty list rather than a false
  statement. That judgement could be wrong for some.
- **Never audited:** the marketing site forms, and the website contact form the
  owner reported as "coming back dead" (unstarted — a real open bug).

---

## 7. Before go-live

In order.

1. **`RESEND_API_KEY` and `EMAIL_FROM`.** Nothing else on this list matters as
   much. Without them nobody can be invited, signature requests record as sent
   and go nowhere, and every reminder is silently queued. Env vars on `ocs-api`,
   not a code change.
2. **Confirm an active admin exists before the Render URL is public.**
   `POST /api/auth/setup` is unauthenticated and mints an ADMIN, and
   `GET /api/auth/setup-state` publicly advertises whether that window is open.
   It closes once one active admin with a password exists.
3. **Set `TRUSTED_PROXY_HOPS`.** Defaults to 1. If traffic arrives through the
   Netlify redirect as well as Render's proxy it is 2. Never `true`.
4. Rotate the `postgres` superuser password — still human-memorable, on
   production.
5. Remove the two stale Render services (`one-contractor-solutions`,
   `one-contractor-worker`, running off `main`).
6. Register the firm's service licences and supervisors — `service_licenses` is
   empty, so the managed-licence line refuses.
7. Counsel review: the document templates, the seven as-built letters, and the
   statutory wording on milestone / recertification / SIRS.
8. Replace the placeholder prices on all 73 catalogue services.

### Configuration not set, as of this package

    email          RESEND_API_KEY, EMAIL_FROM
    payments       STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
    physical mail  LOB_API_KEY, LOB_WEBHOOK_SECRET
    return address MAIL_RETURN_*

`npx tsx scripts/config-gaps.ts` prints this live. It prints NAMES, never
values — keep it that way.

---

## 8. The service catalogue

73 orderable services in ten groups, covering architectural, structural, MEP,
fire and life safety, civil, specialty structures, calculations, as-built
records, inspections and recertifications, revisions.

**The catalogue exists twice and must agree.** The screen renders from
`src/shared/drafting.ts`; the create handler validates against
`ocs.drafting_services`. Disagreement means a contractor picks an option and is
refused by a server that just offered it. `tests/drafting-catalogue.test.ts`
holds them together in both directions.

**Add a service by editing `src/shared/drafting.ts`, then:**

```bash
npx tsx scripts/drafting-catalogue-sql.ts > db/migrations/00NN_whatever.sql
```

The script prints SQL; it does not execute. Existing rows keep their price, so a
rate edited in Settings is not stamped back to the placeholder.

**As-built plans and as-built letters are different deliverables.** Plans are the
approved drawings revised to show what was built. A letter is the licensed trade
contractor certifying it over their licence number. A department asking for one
will not accept the other. Both are orderable, per trade.

The three statutory inspections are separate obligations and a building can owe
more than one: the **milestone inspection** (Fla. Stat. 553.899, statewide,
condo/co-op 3+ storeys at 30 years — 25 within three miles of the coast), the
**40-year recertification** (a Miami-Dade and Broward county ordinance covering
structural AND electrical), and the **structural integrity reserve study**
(Fla. Stat. 718.112(2)(g)). The statutory wording in the catalogue came from
secondary summaries — the egress proxy blocked the Florida Senate and county
sites — and should be checked against the statute before it is quoted.

---

## 9. Working rules that earned their place

- **A guard only counts once you have broken the code and watched it fail.** Two
  written during this audit passed while knowing nothing: one reported a clean
  schema while Postgres was down, another pinned a clock to the one instant
  where the bug it existed to catch gives the right answer.
- **A check that cannot run is a failure, not a pass.** The suite skips database
  tests when the connection variables are absent and still reports success.
- **Never use backticks inside a SQL template literal**, including in comments.
  This broke the build three times in one session.
- **Prune built bundles computationally, never by eye.** A stylesheet was
  deleted while its own build still referenced it — the content hash was reused
  because the CSS had not changed. `tests/build-integrity.test.ts` now catches
  it; the safe move is to read the names out of `public/app.html`.
- **Secrets: report by filename, line and variable name. Never a value.** Do not
  open or print `.env` files. Do not run commands that echo environment values.

---

## 10. Git

Work happened on `claude/ocs-migration-audit-phase-0-03a8qm`. Another agent was
committing to the same branch throughout, so **fetch before every push** — a
merge once silently dropped a security fix that compiled cleanly and the
cross-tenant guard is what noticed.

`.github/workflows/ci.yml` runs preflight on every push.

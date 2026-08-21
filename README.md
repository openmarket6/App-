# One Contractor Solutions — Backend API

Multi-tenant backend for a Florida permitting and drafting platform: contractor
accounts, projects and permits, drafting orders with revisions and approvals,
document storage, license and insurance expiry tracking, client messaging,
payments, and scheduled municipal status checks.

Built to keep one contractor's data unreachable from another's — enforced by the
database, not by remembering to write the right `WHERE` clause.

**New to deploying?** Start with **[HOSTING.md](HOSTING.md)** — a step-by-step
setup guide written for someone who has not hosted a backend before.

---

## Architecture

```mermaid
flowchart TB
    subgraph client [Browser]
        FE["Contractor portal<br/>(existing frontend on Netlify)"]
    end

    subgraph render [Render]
        API["ocs-api<br/>Fastify + TypeScript"]
        WORKER["ocs-worker<br/>background jobs"]
    end

    subgraph supabase [Supabase]
        AUTH["Auth<br/>passwords, reset, MFA"]
        DB[("Postgres<br/>row-level security")]
        STORE["Storage<br/>private buckets"]
    end

    STRIPE["Stripe"]
    MUNI["Municipal portals<br/>(adapters — none verified yet)"]
    MAIL["Resend<br/>(optional)"]

    FE -->|"login"| AUTH
    FE -->|"Bearer JWT + X-Company-Id"| API
    FE -->|"PUT file via signed URL"| STORE
    FE -->|"card details — never touch our server"| STRIPE

    API -->|"verify JWT (JWKS)"| AUTH
    API -->|"ocs_app role, one tenant"| DB
    API -->|"mint short-lived signed URLs"| STORE
    API -->|"create intent / refund"| STRIPE
    STRIPE -->|"webhook (signature verified)"| API

    WORKER -->|"ocs_service role"| DB
    WORKER --> MUNI
    WORKER --> MAIL
    WORKER --> STORE

    API -.->|"enqueue in same transaction"| DB
    DB -.->|"job queue"| WORKER
```

**Stack:** Node 22 · TypeScript · Fastify 5 · Postgres 16 (Supabase) · Zod · Stripe

---

## How tenant isolation works

This is the part worth understanding before anything else.

Every request opens a transaction and sets the caller's company as a
Postgres session variable. Row-level security policies then filter *every*
statement against it:

```sql
using (company_id = ocs.current_company_id() or ocs.is_service_context())
```

Three consequences:

1. **A forgotten filter is safe.** A query missing `WHERE company_id = ...`
   returns only the current tenant's rows anyway.
2. **Fetching by a guessed id returns nothing.** The classic IDOR bug is closed
   at the database, so it returns 404 rather than someone else's permit.
3. **Forgetting to set context shows nothing, not everything.** With no context,
   `company_id = NULL` is never true, so the query returns zero rows. The
   failure mode of a mistake is an empty screen, never a data leak.

Writes are covered too: `WITH CHECK` mirrors `USING`, so a tenant cannot insert
or move a row into another company.

### Two database roles

| Role | Used by | Can cross tenants? |
|---|---|---|
| `ocs_app` | API request handling | **No** — ever |
| `ocs_service` | Worker, payment webhooks | Only with an explicit flag |

The service flag is guarded by `pg_has_role(current_user, 'ocs_service', ...)`,
not by the session variable alone.

> **This mattered.** An earlier version of the policies gated cross-tenant access
> on the session variable by itself. Under that version the API role could set
> the flag on its own connection and read every tenant's data — meaning any SQL
> injection reaching a `SET` would have been a full breach. It was caught by a
> test before any of this ran anywhere. That test is now
> `tests/tenant-isolation.test.ts` → *"does NOT let the API role escalate by
> setting the service-context flag"*, and it must never be deleted or skipped.

**`ocs_app` must never be granted membership in `ocs_service`.** The whole
separation rests on that one fact.

---

## Setup

### 1. Supabase (database, auth, file storage)

1. Create a project at [supabase.com](https://supabase.com). Save the database
   password somewhere safe — it is shown once.
2. **Settings → Database → Connection string → Session pooler.** Copy it.

   > Use the **Session** pooler (port 5432), *not* the Transaction pooler.
   > Isolation depends on `SET LOCAL` and the statements after it running on the
   > same connection; the transaction pooler can split them across backends.

3. **SQL Editor** — create login passwords for the two application roles. The
   roles themselves are created by the migrations; this grants them login:

   ```sql
   -- Use two DIFFERENT strong passwords. Generate with: openssl rand -base64 24
   alter role ocs_app     login password 'FIRST_GENERATED_PASSWORD';
   alter role ocs_service login password 'SECOND_GENERATED_PASSWORD';
   ```

   Run this *after* the first migration (step 5), since the roles must exist.

4. **Storage → New bucket** → name `ocs-documents`, and leave it **Private**.
   Public would make every approved plan and license permanently downloadable by
   anyone with the link.

5. **Authentication → Providers** → enable Email. Turn on "Confirm email".
   Under **Multi-Factor Authentication**, enable TOTP — the API already requires
   a second factor for refunds and for changing who has access.

### 2. Run the migrations

From your machine, pointed at Supabase:

```bash
npm install
DATABASE_MIGRATION_URL="postgresql://postgres:PASSWORD@db.YOUR-PROJECT.supabase.co:5432/postgres" \
  npm run migrate
```

This creates the `ocs` schema, all tables, the RLS policies, both roles, all 67
Florida counties plus major cities, and the recurring job schedules.

> Tables live in schema `ocs`, not `public`. Supabase's auto-generated REST API
> only exposes `public`, so these tables are not reachable over HTTP with an
> anon key — the only way in is through this API.

Then go back and run the `alter role ... login password` statements from step 3.

### 3. Deploy to Render

1. Push this repository to GitHub (see *Deploying your changes* below).
2. [render.com](https://render.com) → **New → Blueprint** → connect the repo.
   `render.yaml` defines both services; Render will prompt for each secret.
3. Fill in the prompted values:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | Session pooler string, user `ocs_app` |
   | `DATABASE_SERVICE_URL` | Same string, user `ocs_service` |
   | `DATABASE_MIGRATION_URL` | Same string, user `postgres` |
   | `SUPABASE_URL` | `https://YOUR-PROJECT.supabase.co` |
   | `SUPABASE_SERVICE_ROLE_KEY` | Settings → API → `service_role` |
   | `APP_BASE_URL` | `https://one-contractor-solutions.netlify.app` |
   | `API_BASE_URL` | Your Render URL |
   | `CORS_ALLOWED_ORIGINS` | Your Netlify origin(s), comma-separated |
   | `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | From Stripe |

   `INTEGRATION_ENCRYPTION_KEY` is generated by Render. **Copy the API's value
   into the worker** — they must match, or stored municipal credentials become
   undecryptable.

4. Deploy. `/readyz` should return `{"status":"ready"}`.

### 4. Stripe webhook

Stripe Dashboard → **Developers → Webhooks → Add endpoint**

- URL: `https://YOUR-API.onrender.com/v1/webhooks/stripe`
- Events: `payment_intent.succeeded`, `payment_intent.payment_failed`,
  `payment_intent.processing`, `payment_intent.canceled`, `charge.refunded`

Copy the signing secret into `STRIPE_WEBHOOK_SECRET` on **both** services.

Forged webhooks are rejected with 400 and recorded as unverified — verified by
sending one with a bogus signature.

### 5. Point the Netlify frontend at the API

The frontend stays on Netlify. It needs to:

1. Authenticate with Supabase Auth (`@supabase/supabase-js`) using the **anon**
   key — never the service role key.
2. Send the access token to this API:

```js
const { data: { session } } = await supabase.auth.getSession();

const res = await fetch(`${API_BASE_URL}/v1/projects`, {
  headers: {
    authorization: `Bearer ${session.access_token}`,
    // Only needed when the user belongs to more than one company.
    'x-company-id': activeCompanyId,
  },
});
```

Start with `GET /v1/me` — it returns the user, their companies, and their role,
and works before they have a company (so it drives onboarding).

---

## API

All routes are under `/v1`. Authentication is `Authorization: Bearer <token>`.

| Area | Routes |
|---|---|
| Identity | `GET/PATCH /me`, `POST /companies`, `GET/PATCH /company`, `GET/POST/PATCH /company/members` |
| Projects | `GET/POST /projects`, `GET/PATCH/DELETE /projects/:id` |
| Permits | `GET/POST /permits`, `GET/PATCH/DELETE /permits/:id`, `POST /permits/:id/status`, `GET /municipalities` |
| Permit intake | `GET /permit-intake/form-schema`, `GET/POST /permit-applications`, `GET/PATCH /permit-applications/:id`, `POST .../submit`, `POST .../review`, `POST .../convert`, subcontractors, document links |
| White-glove supervision | `GET /trades`, `GET /supervision/catalogue`, `GET/POST /supervision/engagements`, `GET /supervision/engagements/:id`, `POST .../accept-terms`, `POST .../activate`, `POST .../complete`, `POST /supervision/visits/:id/schedule`, `POST .../check-in`, `POST .../sign-off`, `POST .../waive`, `GET /supervision/my-visits`, incidents, admin licenses/supervisors/availability |
| Municipal integration | `GET /admin/integrations/coverage`, `GET /admin/integrations/platforms`, `PATCH /admin/municipalities/:id/integration`, `POST .../test-connection`, `POST .../verify`, `PUT /municipalities/:id/credentials` |
| Drafting | `GET/POST /drafting-orders`, `GET /drafting-orders/:id`, `POST /drafting-orders/:id/assign`, `POST /drafting-orders/:id/revisions`, `POST .../revisions/:id/decision`, markups |
| Documents | `GET /documents`, `POST /documents/upload-init`, `POST /documents/:id/versions/:vid/complete`, `GET /documents/:id/download`, `DELETE`/`restore`, `GET/POST /folders` |
| Compliance | `GET/POST/PATCH /licenses`, `GET/POST /insurance-policies`, `GET/POST /qualifiers`, `GET /compliance/summary` |
| Messaging | `GET/POST /threads`, `GET/POST /threads/:id/messages`, `POST /threads/:id/close`, `GET /notifications`, `POST /notifications/read` |
| Payments | `GET/POST /invoices`, `GET /invoices/:id`, `GET /payments`, `POST /payments/intent`, `POST /payments/:id/refund`, `POST /payments/:id/reconcile` |
| Webhooks | `POST /webhooks/stripe` (public, signature-verified) |
| Admin | `GET /audit-log`, `GET /admin/queue`, `GET /admin/jobs/dead`, `POST /admin/jobs/:id/retry`, `GET /admin/webhooks`, `GET /admin/companies`, `GET /admin/integrations`, `PATCH /admin/municipalities/:id` |
| Health | `GET /healthz`, `GET /readyz`, `GET /healthz/queue` |

### File uploads

Files never pass through the API — a 150 MB drawing set would tie up a request
worker and sit in memory.

```
POST /v1/documents/upload-init   → returns a signed URL
PUT  <signed url>                → browser uploads straight to Supabase
POST /v1/documents/:id/versions/:vid/complete
```

The size the client declares is a hint; the size recorded is read back from
storage, because the client can lie about the first one.

Downloads mint a fresh 5-minute signed URL per request, so access is re-checked
every time rather than frozen into a stored link.

### Payments

- `Idempotency-Key` is **required** on payment creation and refunds. A repeated
  key replays the first response instead of charging twice.
- Amounts come from our invoice row, never from the request body.
- Refunds require MFA.
- No card data reaches this server at any point.

---

## Permit intake

`POST /v1/permit-applications` starts an application; the response carries a
**live required-document checklist** and a readiness assessment. Both are
recomputed on every save from `src/domain/permitIntake.ts`, so they always
reflect the current answers rather than a snapshot taken at creation.

The Florida rules encoded there are the ones applications actually get rejected
for:

| Rule | Effect |
|---|---|
| Notice of Commencement over $2,500 (Fla. Stat. 713.13) | Becomes required the moment valuation crosses the threshold |
| HVHZ — Miami-Dade and Broward | Requires a Miami-Dade NOA; a statewide Florida Product Approval is **not** accepted |
| FEMA flood zone / 50% substantial improvement | Requires an elevation certificate (zone X correctly does not) |
| Owner-builder | Swaps contractor license + insurance for the owner-builder affidavit |
| Demolition | Requires an asbestos survey |
| Subcontractors | Each trade sub must be named, licensed, and carry workers' comp or a filed exemption |

HVHZ is **derived from the county**, never taken from the form — whether HVHZ
rules apply is a fact about the address, not something an applicant asserts. The
same is true of the NOC threshold. Both are database triggers, so every write
path gets them.

A ready-to-use form lives at **`public/permit-intake.html`** — self-contained,
no build step, no dependencies. Open it, point it at your API, and it works.

Flow: `draft → submitted → in_review → accepted → converted` (to a permit), with
`info_requested` returning it to the contractor and `rejected` requiring a
reason they can act on.

---

## Municipal integrations

**There is no single API for Florida permitting, and there will not be one.**
Roughly 400 jurisdictions issue permits, and they buy from about a dozen
software vendors — Accela, Tyler EnerGov, OpenGov, CentralSquare, CityView,
MyGovernmentOnline and a handful of others. Many publish no API at all.

So integration is modelled **per vendor, configured per jurisdiction**. The
status-check adapter is configuration-driven: a jurisdiction's `api_config`
says where to call, how to authenticate, which response field holds the status,
and how that vendor's wording maps onto ours. Onboarding is a configuration
task performed while looking at a real response — not a code change based on a
guess.

Every jurisdiction is **manual until verified**, enforced three ways:

1. `resolveForMunicipality()` returns a portal-link adapter unless
   `adapter_verified_at` is set.
2. A `CHECK` constraint refuses to enable checking without it.
3. `POST .../verify` requires the permit number you actually tested against.

An unrecognised status maps to `unknown` and is reported as an error, never
guessed. `GET /v1/admin/integrations/coverage` shows what is automated and what
is configured but never verified.

---

## White-glove qualifying & on-site supervision

One Contractor Solutions holds licenses across Florida trades. A contractor
without a license in a trade engages OCS to pull the permit under an OCS
qualifier, and OCS puts a supervisor on site.

**This subsystem is an evidence system, not a scheduling system.** In Florida a
qualifier who lets their license be used on work they do not actually supervise
is committing an offence, not a paperwork error (Fla. Stat. 489.129, 489.127 on
aiding unlicensed activity). What separates a legitimate qualifying service from
"renting a license" is whether supervision really happened and can be proven
afterwards. Every table in `0012_supervision.sql` exists to answer, months later
and to someone hostile: who qualified this, who supervised it, which visits were
required, did they happen, and was the supervisor actually there.

The database refuses to record states it cannot stand behind:

| Rule | Enforced by |
|---|---|
| Cannot qualify work under an expired license | `check_engagement_compliance` trigger |
| Cannot qualify a trade the license doesn't cover | same trigger |
| Cannot activate without an assigned supervisor and license | CHECK + trigger |
| Cannot activate before the contractor accepts terms | CHECK constraint |
| Qualifier and supervisor caseload caps | trigger — an unbounded caseload makes "real supervisory control" indefensible |
| Cannot complete with mandatory visits outstanding | `check_engagement_completion` trigger |
| A visit isn't "completed" without a check-in **and** a sign-off | CHECK constraint |
| A visit cannot be signed off without its **photographs** | `check_visit_photo_evidence` trigger |
| Required photo *types* must each be present (e.g. site overview + completed work) | same trigger |
| A signed-off visit's photo set cannot be altered afterwards | route guard + audit |
| Waiving a required visit needs a reason, and is audited | CHECK + audit log |

**Photographs are part of what makes a visit complete, not an attachment to it.**
100% supervision means every visit is photographed, so the database refuses to
mark a visit signed off until the required photos exist — the same way an
engagement refuses to complete while required visits are outstanding. A GPS
check-in shows someone was at the address; photos show what they saw when they
got there. Final inspections require 4 photos including a site overview and the
completed work; other milestones require 3. Images go through the normal
document pipeline, so they inherit private storage, signed URLs and retention.
`taken_at` and `uploaded_at` are stored separately on purpose: a large gap
between them is the signature of photos assembled after the fact.

Check-in records GPS coordinates and the computed distance from the job site
(`src/domain/geo.ts`). A check-in outside the 250 m radius is **accepted but
flagged**, not rejected — phone GPS is unreliable beside steel framing, and
blocking honest supervisors would push them off the app, leaving no evidence
trail at all. The distance is always stored, so anomalies stay visible.

23 Florida trades and 63 milestone templates are seeded (footer, slab, framing,
dry-in, rough-in, top-out, final, and trade-specific ones). Activation copies the
template rather than referencing it, so editing a template never rewrites the
requirements of a job already under way.

---

## Frontend

**Deployment: Netlify serves the frontend, Render runs the API and the worker.**
`netlify.toml` proxies `/api/*` to Render as a `status = 200` rewrite, keeping
everything same-origin — which the `SameSite=Strict` refresh cookie requires,
and which removes CORS entirely. The background worker is why the backend is not
on Netlify: it runs continuously, and Netlify Functions are short-lived.

The API also serves the frontend itself, so the Render URL works standalone:
`/` is the portal, `/intake` is the standalone intake form, `/v1/*` is the API.
That removes CORS from the picture entirely and makes it impossible for the UI
and the API to be different versions of each other. Unknown non-API paths fall
back to the shell so deep links work; unknown `/v1/*` paths still return a JSON
404 rather than a page of HTML.

Both pages remain self-contained single files with no build step, no framework
and no CDN, so they can still be dropped straight onto Netlify if the frontend
is ever split out again.

- **`portal.html`** — the full contractor portal: dashboard, permit
  applications with the live Florida checklist, permits, projects, white-glove
  engagements with the visit evidence trail, compliance, notifications.
- **`permit-intake.html`** — the intake form on its own, for embedding or
  standalone use.

Both authenticate with Supabase using the **anon** key and send the resulting
access token to the API. Styling is driven entirely by CSS custom properties in
`:root` — change those and the whole thing follows.

> These are deliberately neutral in appearance. The existing live site could not
> be reached from the environment this was built in (network egress is
> restricted), so nothing here attempts to imitate its look.

---

## Background jobs

The worker polls a Postgres-backed queue (`for update skip locked`). Jobs are
enqueued **in the same transaction as the change that caused them**, so a job can
never reference a rolled-back row, and a committed change never loses its
follow-up.

| Schedule | Every | Does |
|---|---|---|
| `permit-status-sweep` | 1 hour | Queues a status check per due permit |
| `expiration-scan` | 24 hours | Licenses, insurance and permits nearing expiry |
| `reap-stuck-jobs` | 5 min | Reclaims jobs whose worker died |
| `retry-failed-webhooks` | 15 min | Re-drives webhooks that failed to apply |
| `purge-deleted-documents` | 24 hours | Deletes storage past its retention window |
| `cleanup-idempotency-keys` | 1 hour | Removes expired keys |
| `payment-reconciliation` | 24 hours | Flags unreconciled payments |
| `service-license-watch` | 12 hours | OCS's own qualifying licenses nearing expiry; auto-expires lapsed ones |
| `supervision-visit-watch` | 24 hours | Missed site visits and stalled engagements |
| `integration-coverage-report` | 24 hours | Jurisdictions configured but never verified |

Failures retry with exponential backoff and jitter. After `max_attempts` a job
becomes **dead** rather than looping forever, and appears in
`GET /v1/admin/jobs/dead` — visible, never silently dropped.

---

## Running the tests

```bash
createdb ocs_test
TEST_DATABASE_URL="postgresql://postgres@localhost:5432/ocs_test" \
TEST_APP_DATABASE_URL="postgresql://ocs_app:PASSWORD@localhost:5432/ocs_test" \
TEST_SERVICE_DATABASE_URL="postgresql://ocs_service:PASSWORD@localhost:5432/ocs_test" \
  npm test
```

69 tests. The database ones run against a **real Postgres**, because RLS is a
database behaviour — a mock would return whatever the test told it to and prove
nothing.

- `tenant-isolation.test.ts` (12) — cross-tenant reads, writes, IDOR, privilege
  escalation, append-only audit log, and a check that **every** table in the
  schema has RLS forced (a new table added without it fails here).
- `idempotency.test.ts` (4) — replay, mismatched body, retry after failure,
  per-company key scoping.
- `business-rules.test.ts` (8) — status history, folder cycles, per-company
  numbering under concurrency, refund limits, job dedup.
- `permit-intake.test.ts` (28) — every Florida rule above, submission readiness,
  adapter status mapping and URL escaping, and the verification gate that keeps
  an unverified jurisdiction from ever running automated checks.
- `supervision.test.ts` (17) — every compliance gate in the table above,
  including all four photo-evidence gates, plus site-proximity maths and
  cross-tenant isolation of supervision records.

Tests skip cleanly when the `TEST_*` variables are unset.

---

## Before production

Honest list of what is **not** done. Nothing here blocks getting the system
running, but each should be settled before real customer data depends on it.

| Gap | Impact | Fix |
|---|---|---|
| **No malware scanning.** Uploads are marked `scan_status = 'skipped'`. | A contractor could upload an infected file and another user could download it. | Wire a scanner into `documents.purge_expired`'s sibling job; the schema, statuses and the download-time `infected` block already exist. |
| **Rate limiting is per-instance.** | Scaling to N API instances multiplies the effective limit by N. | Point `@fastify/rate-limit` at a shared Redis store. |
| **No jurisdiction is verified yet.** All 103 seeded jurisdictions are `manual`. | Permit status is not checked automatically yet; staff get a portal link instead. | Onboard them one at a time with test-connection → verify. The framework is built; each jurisdiction needs its real endpoint confirmed. |
| **Permit submission and fee lookup are not implemented.** Only status *checking* is. | Applications are still filed by hand with the jurisdiction. | Add per-vendor submission once at least one jurisdiction's status check is proven in production. |
| **No error tracking or alerting.** | A dead job or a spike of failed webhooks is only visible if someone looks. | Add Sentry; alert on `GET /v1/admin/jobs/dead` being non-empty. |
| **Backups are Supabase defaults, restore untested.** | An untested restore is not a backup. | Do a real restore into a scratch project and time it. |
| **Email is optional and unconfigured.** | Notifications appear in-app; delivery rows record `failed` with a reason. | Set `RESEND_API_KEY` and `EMAIL_FROM`. |
| **MFA is enforced only on refunds and membership changes.** | Other sensitive actions accept a password-only session. | Widen `requireMfa()` once TOTP enrolment is rolled out to users. |
| **No load testing.** | Real concurrency behaviour is unmeasured. | Run a load test against staging before onboarding many contractors. |
| **The white-glove model needs legal review.** | The rules encoded in `0012_supervision.sql` are a floor, not a compliance opinion. | Have a Florida construction attorney review the qualifying-and-supervision model and the contractor terms text before selling it. |
| **Frontend does not match the existing site.** | The live site was unreachable from the build environment (egress policy returns 403 for the Netlify domain). | Send the current `index.html` — Netlify → Deploys → latest → **Download deploy** — and the portal can be restyled to match. |
| **Inline script/style require `unsafe-inline` in the page CSP.** | Slightly weaker than a nonce-based policy for the two HTML pages. The JSON API keeps `default-src 'none'`. | Split the CSS/JS out of the HTML and drop `unsafe-inline`, if the single-file property is no longer needed. |

---

## Local development

```bash
npm install
cp .env.example .env      # fill in values; .env is gitignored
npm run migrate
npm run dev               # API on :8080
npm run dev:worker        # worker, separate terminal
```

## Deploying your changes

```bash
git add -A
git commit -m "describe the change"
git push -u origin main
```

`render.yaml` is set to deploy from `main`. This code was developed on a feature
branch, so either merge it to `main` first, or change the branch in Render's
service settings to match. Render redeploys on push to the configured branch. Migrations run in the
pre-deploy step, so a schema change ships with the code that needs it. Applied
migrations are immutable — the runner refuses to start if one was edited after
being applied. Fix forward with a new numbered file.

## Security notes

- No secrets in this repository. Every credential is an environment variable.
- Logs redact tokens, passwords, card and payment fields, and encrypted secrets.
- The audit log is append-only: the application has `INSERT` and `SELECT` and no
  `UPDATE` or `DELETE`, so it cannot rewrite its own history.
- CORS is an exact-origin allow-list; `*` is rejected outright in production.
- Municipal portal credentials are encrypted at rest (pgcrypto) with a key held
  in the environment, not the database — a database dump alone does not yield
  usable credentials, and the API never returns a decrypted value.

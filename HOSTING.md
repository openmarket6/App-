# Getting the backend hosted — step by step

Written for someone who has not deployed a backend before. Follow it top to
bottom. Nothing here needs the command line except two commands in Step 3, and
both are copy-paste.

**Time:** about an hour the first time.
**Cost:** free to start. Around $14/month once you outgrow the free tiers.

---

## What you are building

You currently have one Netlify site doing everything. You are splitting it into
three pieces, each doing one job:

| Piece | What it does | Where it lives | Cost |
|---|---|---|---|
| **App (frontend + API)** | The portal people use, and the rules behind it | Render — new | Free, then $7/mo |
| **Worker** | Scheduled checks, emails | Render — new | Free, then $7/mo |
| **Database + files + logins** | Where everything is stored | Supabase — new | Free, then $25/mo |

**The frontend ships inside the backend.** The Render service serves the
contractor portal at `/` and the permit intake form at `/intake`, so there is
one deployment on one domain. That removes the two things most likely to break
a split setup: CORS configuration, and a frontend running against an API it no
longer matches. Your existing Netlify site keeps working and is untouched.

**Why split it up?** Right now everything runs inside one Netlify Function.
That function has no real database, so data does not reliably persist, and it
cannot run anything on a schedule — which is why permit status checks and expiry
reminders don't work. Separating them means each piece can do its job properly.

Your Netlify site keeps working the whole time. Nothing you have now gets
deleted or turned off.

---

## Step 1 — Supabase (about 15 minutes)

This is your database, your login system, and your file storage.

1. Go to **supabase.com** → **Start your project** → sign in with GitHub.
2. **New project.**
   - Name: `one-contractor-solutions`
   - Database password: click **Generate**, then **copy it into a password
     manager immediately**. Supabase shows it once and cannot show it again.
   - Region: **East US (North Virginia)** — closest to Florida.
3. Wait about two minutes while it builds.

### Get your connection string

Click **Connect** at the top of the dashboard → **Session pooler** tab → copy
the URI. It looks like:

```
postgresql://postgres.abcdefgh:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:5432/postgres
```

Replace `[YOUR-PASSWORD]` with the password you saved. Keep this somewhere safe
for Step 3.

> ⚠️ **Use the Session pooler, not the Transaction pooler.** They look almost
> identical. The Transaction pooler breaks the security that keeps each
> contractor's data separate from every other contractor's. If you are unsure
> later, the Session pooler is the one on port **5432**.

### Create the file storage bucket

**Storage** → **New bucket** → name it `ocs-documents` → leave **Public**
switched **OFF** → Create.

> Public would mean anyone who ever gets a link to an approved plan or a license
> can download it forever, with no login. Private means every download is
> re-checked against who is asking.

### Turn on logins

**Authentication** → **Providers** → make sure **Email** is enabled.
Then **Authentication** → **Multi-Factor Authentication** → enable **TOTP**
(authenticator app). The backend already requires a second factor for refunds
and for changing who has access to an account.

---

## Step 2 — Put the code on GitHub

The code is already pushed to your repository, on a branch. You need it on the
`main` branch so Render can deploy it.

1. Go to **github.com/openmarket6/App-**
2. You will see a banner about the recent branch → click **Compare & pull
   request** → **Create pull request** → **Merge pull request**.

That is it. The code is now on `main`.

---

## Step 3 — Set up the database tables (about 10 minutes)

This creates every table, plus all 67 Florida counties and 35 major cities.

On your own computer, open Terminal (Mac) or PowerShell (Windows):

```bash
git clone https://github.com/openmarket6/App-.git
cd App-
npm install
```

Then run this, pasting your connection string from Step 1 in place of the one
shown, with `postgres:` as the username:

```bash
DATABASE_MIGRATION_URL="postgresql://postgres.abcdefgh:YOURPASSWORD@aws-0-us-east-1.pooler.supabase.com:5432/postgres" npm run migrate
```

You should see about eleven lines saying `applying ... ok`.

### Create the two database users

Back in Supabase → **SQL Editor** → **New query**. Paste this, replacing both
passwords with two **different** strong ones (make them up, save them both):

```sql
alter role ocs_app     login password 'FIRST-PASSWORD-HERE';
alter role ocs_service login password 'SECOND-PASSWORD-HERE';
```

Click **Run**.

> **Why two users?** `ocs_app` handles web requests and is locked to one
> contractor's data at a time — it physically cannot read another customer's
> records. `ocs_service` runs the background jobs that legitimately need to see
> across customers. Keeping them apart means a bug on the website side cannot
> reach everyone's data.

You now have three connection strings — the same URL, three different usernames:

| Variable | Username in the string |
|---|---|
| `DATABASE_URL` | `ocs_app` + first password |
| `DATABASE_SERVICE_URL` | `ocs_service` + second password |
| `DATABASE_MIGRATION_URL` | `postgres` + original password |

---

## Step 4 — Render (about 15 minutes)

1. Go to **render.com** → **Get Started** → sign in with GitHub.
2. **New** → **Blueprint** → select **openmarket6/App-** → **Connect**.
3. Render reads `render.yaml` and finds two services: `one-contractor-solutions` and
   `one-contractor-worker`. It will ask you for each secret value.

Fill in:

| Variable | What to paste |
|---|---|
| `DATABASE_URL` | The `ocs_app` connection string |
| `DATABASE_SERVICE_URL` | The `ocs_service` connection string |
| `DATABASE_MIGRATION_URL` | The `postgres` connection string |
| `SUPABASE_URL` | Supabase → Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Same page → `service_role` key |
| `APP_BASE_URL` | `https://one-contractor-solutions.netlify.app` |
| `API_BASE_URL` | Leave blank, fill in after deploy |
| `CORS_ALLOWED_ORIGINS` | `https://one-contractor-solutions.netlify.app` |
| `STRIPE_SECRET_KEY` | Leave blank for now |
| `STRIPE_WEBHOOK_SECRET` | Leave blank for now |
| `RESEND_API_KEY` | Leave blank for now |
| `EMAIL_FROM` | Leave blank for now |

4. Click **Apply**. It takes about five minutes.

5. When it finishes, copy your API URL from the top of the `one-contractor-solutions` page
   (something like `https://ocs-api.onrender.com`). Go to **Environment**, set
   `API_BASE_URL` to it, and save.

6. **Copy `INTEGRATION_ENCRYPTION_KEY` from `one-contractor-solutions` into `one-contractor-worker`.**
   Render generates it for the API; the worker needs the identical value or
   stored portal passwords cannot be read back.

### Check it worked

Visit `https://one-contractor-solutions.onrender.com/readyz`. You want:

```json
{"status":"ready","checks":{"database":"ok","database_service_role":"ok"}}
```

If it says `not_ready`, the database connection strings are wrong — that is
almost always the pooler (must be **Session**) or a password typo.

> **Free tier note:** free Render services sleep after 15 minutes idle, so the
> first request afterwards takes ~30 seconds. Fine for testing; upgrade to
> Starter ($7/service) before real customers use it.

---

## Step 5 — Open the app and create your account

**Visit your Render URL.** Your existing 1 Contractor Solutions application is
served there:

- `https://one-contractor-solutions.onrender.com/` — the app
- `https://one-contractor-solutions.onrender.com/intake` — the standalone permit intake form

The very first visit shows a **first-run setup form**, because the system has no
administrator yet. Enter your email, your name, and a password of at least 12
characters. That creates the first ADMIN account and signs you in.

> This setup screen works **once**. After an administrator exists it returns a
> 409 and shows the normal sign-in box. Everyone else gets in by invitation:
> **Users & access → Invite**. There is no self-service signup, by design.

You do **not** need to create users in Supabase. Sign-in is email and password
against this backend; Supabase provides the database and file storage.

### The five roles

| Role | What they see |
|---|---|
| **Administrator** | Everything: users, billing, credentials, connectors |
| **Permit technician** | Day-to-day permit work across all contractors |
| **Site supervisor** | Their assigned visits. Photographs the work and signs off. Cannot file permits or touch billing |
| **Viewer** | Read-only across the firm |
| **Contractor** | Only their own company's permits, documents and invoices |
| *Awaiting authorization* | Nothing, until an administrator assigns a role |

### What works tonight, and what does not

Migrated to the new backend: **sign-in, dashboard, permits, contractors,
jurisdictions, users and roles, supervision visits and photographs**.

Not migrated yet: corrections, inspections, signing, notary, billing, Google
Drive sync, connectors, admin. Those screens return a clear *"not migrated
yet"* message rather than failing silently, and still work on your existing
Netlify deployment. `GET /api/_migration-status` lists both sets.

The first thing you will see is that the checklist on the right changes as you
type. Set the county to Broward and the required document switches from Florida
Product Approval to a Miami-Dade NOA. Put the job valuation above $2,500 and a
Notice of Commencement requirement appears. That is the backend applying Florida
rules, not the form guessing.

If you'd rather keep the UI on Netlify, both pages are still self-contained
single files — drag `public/portal.html` or `public/permit-intake.html` onto
Netlify and set `CORS_ALLOWED_ORIGINS` on Render to that site's URL.

---

## Step 6 — Stripe (only when you are ready to take payments)

1. **stripe.com** → Developers → **API keys** → copy the **Secret key**.
2. Developers → **Webhooks** → **Add endpoint**
   - URL: `https://one-contractor-solutions.onrender.com/v1/webhooks/stripe`
   - Events: `payment_intent.succeeded`, `payment_intent.payment_failed`,
     `payment_intent.processing`, `payment_intent.canceled`, `charge.refunded`
3. Copy the **Signing secret** (starts `whsec_`).
4. In Render, set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` on **both**
   services.

Start with Stripe's **test mode** keys. Everything works identically, with fake
card numbers.

---

## Step 7 — (Optional) Point your existing Netlify site at the API

Only needed if you want to keep the current Netlify frontend rather than using
the built-in portal. It needs two changes:

1. Sign in through Supabase instead of whatever it does now.
2. Call the new API instead of `/api/*`.

```js
const API = 'https://one-contractor-solutions.onrender.com';

const { data: { session } } = await supabase.auth.getSession();

const res = await fetch(`${API}/v1/projects`, {
  headers: { authorization: `Bearer ${session.access_token}` },
});
```

`GET /v1/me` is the right first call — it tells you who the user is, which
companies they belong to, and works even before they have a company, so it can
drive signup.

`public/permit-intake.html` is a complete working example of both steps.

---

## What to do when something breaks

| Symptom | Almost always |
|---|---|
| `/readyz` says `not_ready` | Wrong connection string, or Transaction pooler instead of Session |
| Everything returns 401 | `SUPABASE_URL` wrong, or the frontend is sending the anon key instead of the user's access token |
| Browser console says CORS | Your Netlify URL is missing from `CORS_ALLOWED_ORIGINS` (exact, with `https://`, no trailing slash) |
| Queries return nothing at all | The `ocs_app` password is wrong, so it connected as the wrong user |
| Emails never arrive | `RESEND_API_KEY` not set — check `GET /v1/admin/jobs/dead` |
| First request very slow | Free Render tier sleeping — upgrade to Starter |

**Logs:** Render → your service → **Logs**. Every error carries a `requestId`;
search for it to see the whole request.

---

## Turning on automated permit status checks

This is the one thing you should **not** rush, and the system deliberately will
not let you.

Every Florida jurisdiction starts as **manual** — the system gives your permit
tech a direct link to the portal instead of guessing a status. To automate one:

1. `PATCH /v1/admin/municipalities/:id/integration` — record the platform and
   how to read a status from its response.
2. `POST /v1/admin/municipalities/:id/test-connection` — run it against a **real
   permit number** and look at what actually comes back.
3. `POST /v1/admin/municipalities/:id/verify` — record that you saw it work.
   Only now can automated checking be switched on, and the database enforces
   that with a constraint.

**Why the ceremony:** an integration built from documentation instead of a real
response returns confidently wrong statuses. A contractor who is told a permit
was issued when it was not sends a crew to a job site they are not permitted to
work. Being wrong here is far worse than being silent.

`GET /v1/admin/integrations/coverage` shows how many jurisdictions are
automated, and which are configured but never verified.

---

## Costs as you grow

| Stage | Setup | Monthly |
|---|---|---|
| Testing | Free tiers everywhere | $0 |
| First real customers | Render Starter ×2 | $14 |
| Growing (8 GB DB, daily backups) | + Supabase Pro | $39 |
| Email | Resend free covers 3,000/month | $0–20 |

Stripe takes 2.9% + 30¢ per transaction; there is no monthly fee.

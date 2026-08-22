/**
 * What the API actually puts on the wire, checked against the convention the
 * frontend reads by.
 *
 * Every type in web/src is camelCase. Postgres columns are snake_case. The
 * translation happens in hand-written `as "camelName"` aliases, one per column
 * per query, and when one is forgotten the result is not an error anywhere: the
 * response is a valid JSON object, the request succeeds, and the page renders a
 * blank cell.
 *
 * That is not hypothetical. /api/clients selected raw columns while
 * /api/clients/:id aliased them, so four columns on the contractors screen were
 * empty — and `service_line` was not selected at all, which meant every
 * contractor was badged Expediting, the managed-licence count read zero and the
 * filter matched nothing. On that line this firm's licence goes on the permit.
 *
 * A static scan of the SQL cannot decide this. Plenty of queries select
 * snake_case deliberately and map it in TypeScript before returning, and
 * buildFolderTree takes snake_case by contract. The only thing that settles it
 * is the response, so this test seeds rows, calls the endpoints the frontend
 * calls, and walks the JSON that comes back.
 *
 * It only proves anything about endpoints that return data, which is why the
 * seed matters and why each case asserts it got a non-empty payload first. An
 * empty list has no keys and would pass while proving nothing.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { dbConfigured, applyMigrations, client, ownerUrl, ALPHA } from './helpers/db.js';

const describeIfDb = dbConfigured ? describe : describe.skip;

const ADMIN = { email: 'shape2-admin@test.invalid', password: 'ShapeTwo2026!' };
const PORTAL_USER = { email: 'shape2-client@test.invalid', password: 'ShapeClient2026!' };
const PROJECT = 'cccc1111-0000-0000-0000-0000000000c1';
const PERMIT = 'cccc2222-0000-0000-0000-0000000000c2';
const DOCUMENT = 'cccc3333-0000-0000-0000-0000000000c3';
const ENGAGEMENT = 'cccc4444-0000-0000-0000-0000000000c4';
const VISIT = 'cccc5555-0000-0000-0000-0000000000c5';
const LICENSE = 'cccc6666-0000-0000-0000-0000000000c6';
const SUPERVISOR = 'cccc7777-0000-0000-0000-0000000000c7';

async function server() {
  process.env['AUTH_JWT_SECRET'] ||= 'test-access-secret-000000000000000000000000';
  process.env['AUTH_REFRESH_SECRET'] ||= 'test-refresh-secret-00000000000000000000000';
  const { buildServer } = await import('../src/index.js');
  const app = await buildServer();
  await app.ready();
  return app;
}

/**
 * Keys anywhere in the response that are not camelCase.
 *
 * Walks the whole tree rather than the top level: a list endpoint's rows are
 * one level down, and a nested object is exactly where a forgotten alias hides
 * longest because nobody scrolls that far in a response body.
 */
function snakeKeys(value: unknown, path = '$', found: string[] = []): string[] {
  if (Array.isArray(value)) {
    // Index 0 only. Every row of a list comes from the same query, so a
    // hundred rows would report the same key a hundred times.
    if (value.length > 0) snakeKeys(value[0], `${path}[0]`, found);
    return found;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (/[a-z0-9]_[a-z]/.test(k)) found.push(`${path}.${k}`);
      snakeKeys(v, `${path}.${k}`, found);
    }
  }
  return found;
}

/**
 * Values that must never leave the building.
 *
 * The users list selects password_hash and invite_token on purpose --
 * publicUser reduces the first to a `hasPassword` boolean and the second to
 * `invitePending`, because the UI needs to know whether an invitation is
 * outstanding without being told what it is. That is correct, and it is one
 * `...r` away from not being correct: spreading the row instead of mapping it
 * would put a bcrypt hash and a live invitation token in a response, and
 * nothing would fail.
 *
 * So rather than trusting the mapping, look at what actually came back.
 */
function leakedSecrets(value: unknown, path = '$', found: string[] = []): string[] {
  if (Array.isArray(value)) {
    if (value.length > 0) leakedSecrets(value[0], `${path}[0]`, found);
    return found;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const here = `${path}.${k}`;
      // A key that names the secret itself, carrying anything but a boolean or
      // null. `hasPassword: false` is a fact about an account; `password: "…"`
      // is the account.
      if (/^(password|password_?hash|secret|.*_?secret|invite_?token|reset_?token|api_?key|private_?key|mfa_?secret|.*encrypted)$/i.test(k)
          && v !== null && typeof v !== 'boolean') {
        found.push(`${here} (key names a credential)`);
      }
      if (typeof v === 'string') {
        // bcrypt, and anything shaped like a signed token.
        if (/^\$2[aby]\$\d{2}\$/.test(v)) found.push(`${here} (bcrypt hash)`);
        else if (/^ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(v)) found.push(`${here} (JWT)`);
      }
      leakedSecrets(v, here, found);
    }
  }
  return found;
}

describeIfDb('what the API puts on the wire', () => {
  beforeAll(async () => {
    await applyMigrations();
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query('create extension if not exists pgcrypto');
      /*
       * Cascade takes the company's rows, but supervision licences and
       * supervisors are firm-level: they are ours, not a contractor's, so
       * nothing deletes them with the company and a second run collides.
       */
      await c.query('delete from ocs.supervision_visits where id = $1', [VISIT]);
      await c.query('delete from ocs.supervision_engagements where id = $1', [ENGAGEMENT]);
      await c.query('delete from ocs.supervisors where id = $1', [SUPERVISOR]);
      await c.query('delete from ocs.service_licenses where id = $1', [LICENSE]);
      await c.query('delete from ocs.companies where id = $1', [ALPHA]);
      await c.query(
        `insert into ocs.companies
           (id, name, legal_name, email, phone, license_number, service_line,
            address_line1, city, state, postal_code, status)
         values ($1,'Alpha Roofing','Alpha Roofing LLC','ana@alpha.test','8135551000',
                 'CCC1330000','MANAGED_LICENSE','88 Industrial Way','Tampa','FL','33619','active')`,
        [ALPHA],
      );
      await c.query('delete from ocs.app_users where email in ($1,$2)',
        [ADMIN.email, PORTAL_USER.email]);
      await c.query(
        `insert into ocs.app_users (email, name, app_role, is_active, password_hash, client_id)
         values ($1,'Admin','ADMIN',true, crypt($2, gen_salt('bf',10)), null),
                ($3,'Ana Reyes','CLIENT',true, crypt($4, gen_salt('bf',10)), $5)`,
        [ADMIN.email, ADMIN.password, PORTAL_USER.email, PORTAL_USER.password, ALPHA],
      );
      await c.query(
        `insert into ocs.projects (id, company_id, name, address_line1, city, state, postal_code)
         values ($1,$2,'Bay Street Reroof','1200 Bay Street','Tampa','FL','33606')`,
        [PROJECT, ALPHA],
      );
      await c.query(
        `insert into ocs.permits (id, company_id, project_id, permit_type, status)
         values ($1,$2,$3,'ROOFING','draft')`,
        [PERMIT, ALPHA, PROJECT],
      );
      await c.query(
        `insert into ocs.compliance_items
           (company_id, kind, carrier, policy_number, expires_at, decision)
         values ($1,'GENERAL_LIABILITY','Citizens','GL-99',
                 now() + interval '200 days','accepted')`,
        [ALPHA],
      );

      /*
       * The heavier entities. These carry the longest select lists in the
       * codebase, which is exactly where a forgotten alias survives longest --
       * nobody reads to the bottom of a forty-column query.
       */
      await c.query(
        `insert into ocs.documents (id, company_id, project_id, permit_id, name, category)
         values ($1,$2,$3,$4,'roof-plan.pdf','approved_plan')`,
        [DOCUMENT, ALPHA, PROJECT, PERMIT],
      );
      await c.query(
        `insert into ocs.invoices (id, company_id, permit_id, invoice_number,
                                   subtotal_cents, total_cents, status,
                                   issued_on, due_on)
         values (gen_random_uuid(),$1,$2,9001,45000,45000,'open',
                 current_date, current_date + 30)`,
        [ALPHA, PERMIT],
      );
      await c.query(
        `insert into ocs.support_tickets (company_id, reference, subject, permit_id)
         values ($1,'SUP-9001','Inspection was not called in',$2)`,
        [ALPHA, PERMIT],
      );
      await c.query(
        `insert into ocs.drafting_orders (company_id, project_id, permit_id,
                                          order_number, title)
         values ($1,$2,$3,9001,'Truss layout')`,
        [ALPHA, PROJECT, PERMIT],
      );
      await c.query(
        `insert into ocs.permit_inspections (company_id, permit_id, inspection_type, scheduled_for)
         values ($1,$2,'SHEATHING', now() + interval '3 days')`,
        [ALPHA, PERMIT],
      );
      await c.query(
        `insert into ocs.permit_corrections (company_id, permit_id, cycle, discipline, body)
         values ($1,$2,1,'STRUCTURAL','Missing truss layout'),
                ($1,$2,1,'STRUCTURAL','Uplift values not shown'),
                ($1,$2,2,'ELECTRICAL','Panel schedule missing')`,
        [ALPHA, PERMIT],
      );

      // Supervision: the managed-licence chain, end to end.
      const trade = await c.query(`select id from ocs.trades limit 1`);
      const tradeId = trade.rows[0]?.id ?? null;
      if (tradeId) {
        await c.query(
          `insert into ocs.service_licenses (id, trade_id, license_number, qualifier_name,
                                             license_type, status, expires_on)
           values ($1,$2,'CGC1500000','Ray Okonjo','state_certified','active',
                   current_date + 300)`,
          [LICENSE, tradeId],
        );
        await c.query(`delete from ocs.app_users where email = $1`,
          ['shape2-super@test.invalid']);
        const sup = await c.query(
          `insert into ocs.app_users (email, name, app_role, is_active)
           values ('shape2-super@test.invalid','Ray Okonjo','SITE_SUPERVISOR',true)
           returning id`,
        );
        await c.query(
          `insert into ocs.supervisors (id, user_id, display_name, is_active)
           values ($1,$2,'Ray Okonjo',true)`,
          [SUPERVISOR, sup.rows[0].id],
        );
        await c.query(
          `insert into ocs.supervision_engagements
             (id, company_id, engagement_number, project_id, permit_id, trade_id,
              service_license_id, supervisor_id, status, site_address, site_city,
              terms_accepted_at, activated_at)
           values ($1,$2,9001,$3,$4,$5,$6,$7,'active','1200 Bay Street','Tampa',
                   now(), now())`,
          [ENGAGEMENT, ALPHA, PROJECT, PERMIT, tradeId, LICENSE, SUPERVISOR],
        );
        await c.query(
          `insert into ocs.supervision_visits
             (id, company_id, engagement_id, milestone_code, milestone_name,
              status, supervisor_id, scheduled_for)
           values ($1,$2,$3,'progress','Progress inspection','scheduled',$4,
                   now() + interval '2 days')`,
          [VISIT, ALPHA, ENGAGEMENT, SUPERVISOR],
        );
      }
    } finally {
      await c.end();
    }
  });

  type App = Awaited<ReturnType<typeof server>>;

  /*
   * The endpoints the frontend reads lists and records from. Each says what a
   * non-empty response looks like, so a case cannot pass by returning nothing.
   */
  const CASES: Array<{
    url: string;
    expect: (body: any) => unknown;
    /*
     * Sub-trees keyed by DATA rather than by field name.
     *
     * A histogram like byPlatform is keyed by platform id -- `oracle_pscs` is a
     * value from the jurisdiction dataset, not a column somebody forgot to
     * alias. The walker cannot tell the difference, so a case that returns one
     * has to say so. Each entry needs a reason; without that this becomes the
     * place failures go to be silenced.
     */
    dataKeyed?: RegExp[];
  }> = [
    { url: '/api/clients', expect: (b) => b.clients?.length },
    { url: `/api/clients/${ALPHA}`, expect: (b) => b.id },
    { url: '/api/permits', expect: (b) => b.permits?.length },
    { url: `/api/permits/${PERMIT}`, expect: (b) => b.permit?.id },
    { url: '/api/projects', expect: (b) => b.projects?.length },
    { url: `/api/compliance?clientId=${ALPHA}`, expect: (b) => b.items?.length },
    { url: '/api/dashboard', expect: (b) => b.pipelineByStage },
    { url: '/api/jurisdictions', expect: (b) => b.jurisdictions?.length },
    { url: '/api/users', expect: (b) => b.users?.length },
    { url: `/api/signing/status/${ALPHA}`, expect: (b) => b.verdict },
    { url: '/api/documents', expect: (b) => b.documents?.length },
    { url: '/api/billing/invoices', expect: (b) => b.invoices?.length },
    { url: '/api/billing/plans', expect: (b) => b.plans?.length },
    { url: '/api/billing/rates', expect: (b) => b.rates?.length ?? b.trades?.length },
    { url: '/api/support', expect: (b) => b.tickets?.length },
    { url: '/api/drafting', expect: (b) => b.requests?.length ?? b.orders?.length },
    { url: '/api/inspections', expect: (b) => b.inspections?.length },
    { url: '/api/corrections', expect: (b) => b.corrections?.length },
    { url: '/api/supervision/visits', expect: (b) => b.visits?.length },
    { url: '/api/supervision/licenses', expect: (b) => b.licenses?.length },
    /*
     * Not listed here: /api/supervision/engagements and .../supervisors.
     * Both exist as POST only. An administrator can register a supervisor or
     * open an engagement and has no way to read either back — the list
     * handlers live on /v1, which the application cannot reach. No screen
     * calls them today, so this is a gap rather than a break, and inventing
     * endpoints to satisfy a test would be the wrong way round.
     */
    { url: `/api/supervision/verdict/${PERMIT}`, expect: (b) => b.permitId },
    { url: '/api/generated-documents/kinds', expect: (b) => b.kinds?.length },
    {
      url: '/api/integrations/summary',
      expect: (b) => b.totalJurisdictions,
      // byPlatform is keyed by platform id and byTier by tier name; both are
      // values out of the jurisdiction dataset.
      dataKeyed: [/^\$\.byPlatform\./, /^\$\.byTier\./],
    },
    { url: '/api/integrations/roadmap', expect: (b) => b.items?.length },
  ];

  it.each(CASES)('$url returns camelCase keys only', async ({ url, expect: hasData, dataKeyed }) => {
    const app = await server();
    try {
      const login = await app.inject({
        method: 'POST', url: '/api/auth/login', payload: ADMIN,
      });
      expect(login.statusCode).toBe(200);
      const token = JSON.parse(login.body).accessToken as string;

      const res = await app.inject({
        method: 'GET', url, headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode, `${url} -> ${res.body.slice(0, 300)}`).toBe(200);

      const body = JSON.parse(res.body);
      expect(hasData(body), `${url} returned nothing, so this proves nothing`).toBeTruthy();

      const leaked = leakedSecrets(body);
      expect(
        leaked,
        leaked.length
          ? `${url} put credential material in a response:\n  ${leaked.join('\n  ')}\n` +
            'Map the row instead of spreading it. A hash or a live invitation ' +
            'token in a response body is not visible from any screen and not ' +
            'an error anywhere.'
          : '',
      ).toEqual([]);

      const bad = snakeKeys(body)
        .filter((path) => !(dataKeyed ?? []).some((rx) => rx.test(path)));
      expect(
        bad,
        bad.length
          ? `${url} returns snake_case keys the frontend does not read:\n  ${bad.join('\n  ')}\n` +
            'Alias them in the SELECT (`c.legal_name as "legalName"`) or map them ' +
            'before returning. A missing alias is not an error anywhere — the ' +
            'page just renders a blank cell.'
          : '',
      ).toEqual([]);
    } finally {
      await app.close();
    }
  });

  /*
   * The three fields the permits list was inventing.
   *
   * Each was a literal of the right type in the right place, so nothing about
   * the response looked wrong -- which is exactly why they survived. The seed
   * puts a managed-licence contractor and three correction cycles behind one
   * permit so a hard-coded answer cannot accidentally be the right one.
   */
  it('reports a permit\'s service line and correction cycles, rather than guessing', async () => {
    const app = await server();
    try {
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: ADMIN });
      const token = JSON.parse(login.body).accessToken as string;
      const auth = { authorization: `Bearer ${token}` };

      const list = JSON.parse(
        (await app.inject({ method: 'GET', url: '/api/permits', headers: auth })).body,
      );
      const row = list.permits.find((p: { id: string }) => p.id === PERMIT);
      expect(row).toBeTruthy();

      // The contractor is on the managed line. This was the literal
      // 'EXPEDITING' for every permit in the system.
      expect(row.serviceLine).toBe('MANAGED_LICENSE');

      /*
       * Three corrections, three cycles -- apply_correction_effects assigns a
       * fresh cycle per row, so the cycle numbers in the INSERT above are
       * overwritten. This was the literal 0 for every permit, and the reports
       * page counts zero as a first-pass approval, so the first-pass rate on
       * that page was always 100%.
       */
      expect(row.correctionCycles).toBe(3);

      // toTrade was reading a column name that does not exist in the result.
      expect(row.trade).not.toBe('SPECIALTY');

      // Read by the reports page to place a decision in a month. Absent, a
      // denial has no month and drops out of the report entirely.
      expect(row.updatedAt).toBeTruthy();

      const detail = JSON.parse(
        (await app.inject({ method: 'GET', url: `/api/permits/${PERMIT}`, headers: auth })).body,
      );
      // The detail screen prints this as a "Service line" fact.
      expect(detail.permit.serviceLine).toBe('MANAGED_LICENSE');
      expect(detail.permit.correctionCycles).toBe(3);
    } finally {
      await app.close();
    }
  });

  /*
   * The portal, which a contractor sees and staff never do.
   *
   * Worth its own pass because the scoping is different -- these run under a
   * CLIENT session pinned to one tenant -- and because a contractor who finds a
   * blank field has no colleague to ask and no way to tell whether the value is
   * missing or the screen is broken.
   */
  const PORTAL_CASES: Array<{ url: string; expect: (b: any) => unknown }> = [
    /*
     * Each expectation names something that only exists when the endpoint
     * actually assembled a payload. `(b) => b` would pass on `{}` and prove
     * nothing, which is the failure mode of a check like this.
     */
    { url: '/api/portal/actions', expect: (b) => b.actions?.length },
    { url: '/api/portal/folders', expect: (b) => b.tree },
    { url: '/api/portal/team', expect: (b) => b.members?.length },
    { url: '/api/portal/permit-requests', expect: (b) => Array.isArray(b.requests) },
    { url: '/api/permits', expect: (b) => b.permits?.length },
    { url: '/api/documents', expect: (b) => b.documents?.length },
  ];

  it.each(PORTAL_CASES)('$url returns camelCase keys to a contractor', async ({ url, expect: hasData }) => {
    const app = await server();
    try {
      const login = await app.inject({
        method: 'POST', url: '/api/auth/login', payload: PORTAL_USER,
      });
      expect(login.statusCode, login.body.slice(0, 200)).toBe(200);
      const token = JSON.parse(login.body).accessToken as string;

      const res = await app.inject({
        method: 'GET', url, headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode, `${url} -> ${res.body.slice(0, 300)}`).toBe(200);

      const body = JSON.parse(res.body);
      expect(hasData(body), `${url} returned nothing, so this proves nothing`).toBeTruthy();

      const leaked = leakedSecrets(body);
      expect(leaked, `${url} put credential material in a response: ${leaked.join(', ')}`)
        .toEqual([]);

      const bad = snakeKeys(body);
      expect(
        bad,
        bad.length
          ? `${url} returns snake_case keys the portal does not read:\n  ${bad.join('\n  ')}`
          : '',
      ).toEqual([]);
    } finally {
      await app.close();
    }
  });

  /*
   * The invoice status filter, which accepted a value and ignored it.
   *
   * Worth a runtime test rather than only the static one: the filter has to run
   * against the DERIVED status, and the two statuses people actually ask for --
   * OVERDUE and PARTIAL -- are not values the status column can hold. A filter
   * written in SQL would have passed a static check and still matched nothing.
   */
  it('filters invoices by the status a caller can actually see', async () => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query('delete from ocs.invoices where company_id = $1', [ALPHA]);
      await c.query(
        `insert into ocs.invoices (company_id, invoice_number, subtotal_cents,
                                   total_cents, amount_paid_cents, status,
                                   issued_on, due_on, paid_at)
         values
           -- paid in full
           ($1, 9101, 10000, 10000, 10000, 'paid', current_date - 40,
            current_date - 10, now()),
           -- open, part paid: PARTIAL, which no column holds
           ($1, 9102, 20000, 20000,  5000, 'open', current_date - 40,
            current_date + 10, null),
           -- open, unpaid, past its due date: OVERDUE, likewise derived
           ($1, 9103, 30000, 30000,     0, 'open', current_date - 40,
            current_date - 5, null)`,
        [ALPHA],
      );
    } finally {
      await c.end();
    }

    const app = await server();
    try {
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: ADMIN });
      const token = JSON.parse(login.body).accessToken as string;
      const auth = { authorization: `Bearer ${token}` };
      const list = async (qs: string) => JSON.parse(
        (await app.inject({ method: 'GET', url: `/api/billing/invoices${qs}`, headers: auth })).body,
      );

      const all = await list(`?clientId=${ALPHA}`);
      expect(all.invoices).toHaveLength(3);

      const paid = await list(`?clientId=${ALPHA}&status=PAID`);
      expect(paid.invoices).toHaveLength(1);
      expect(paid.invoices[0].status).toBe('PAID');

      const partial = await list(`?clientId=${ALPHA}&status=PARTIAL`);
      expect(partial.invoices).toHaveLength(1);
      expect(partial.invoices[0].amountPaidCents).toBe(5000);

      const overdue = await list(`?clientId=${ALPHA}&status=OVERDUE`);
      expect(overdue.invoices).toHaveLength(1);
      expect(overdue.invoices[0].totalCents).toBe(30000);

      // Totals describe the set that was asked for, not the whole book.
      expect(overdue.outstandingCents).toBe(30000);

      // A status nobody uses is a 400 now, rather than being accepted and
      // quietly returning everything.
      const bad = await app.inject({
        method: 'GET', url: `/api/billing/invoices?status=WHATEVER`, headers: auth,
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

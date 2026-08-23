/**
 * Can one contractor see another one's data through the API?
 *
 * tests/tenant-isolation.test.ts answers this for the DATABASE: row-level
 * security, exercised with direct SQL, twelve ways. It does not send a single
 * HTTP request, and it cannot, because the thing it proves is a property of the
 * ocs_app role.
 *
 * That leaves a gap the size of the API. Staff endpoints run under
 * withServiceContext, which sets a flag that turns row-level security OFF --
 * deliberately, because a coordinator has to read every contractor. Which mode
 * a request runs in is decided in TypeScript by the scoped() helper, and any
 * route that reaches for withServiceContext directly has opted out of the one
 * thing standing between two tenants. invoices.ts has six routes and one call
 * to scoped(); supervision.ts has sixteen routes and eleven direct service
 * contexts. Every one of those is correct or catastrophic, and RLS will not be
 * the thing that tells you which.
 *
 * So: two contractors, both with real rows, and a session belonging to one of
 * them. Then ask for everything.
 *
 * The check is on the RAW RESPONSE TEXT, not on parsed fields. A leak does not
 * have to arrive as a tidy `clientId` -- it can be a permit number in a label,
 * an id inside a nested document, a name in a message thread. Searching the
 * text for the other tenant's identifiers catches all of those, including the
 * shapes nobody thought to assert on.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { dbConfigured, applyMigrations, client, ownerUrl, ALPHA, BETA } from './helpers/db.js';

const describeIfDb = dbConfigured ? describe : describe.skip;

const ANA = { email: 'xt-ana@test.invalid', password: 'CrossAna2026!' };
const ADMIN = { email: 'xt-admin@test.invalid', password: 'CrossAdmin2026!' };

/** Beta's rows. Nothing Ana asks for may contain any of these. */
const BETA_PROJECT = 'bbbb1111-0000-0000-0000-0000000000b1';
const BETA_PERMIT = 'bbbb2222-0000-0000-0000-0000000000b2';
const BETA_DOCUMENT = 'bbbb3333-0000-0000-0000-0000000000b3';
const BETA_TICKET = 'bbbb4444-0000-0000-0000-0000000000b4';
const BETA_SECRET_TEXT = 'BetaConfidentialScopeOfWork';
const BETA_PERMIT_NUMBER = 'BETA-PERMIT-8801';

const ALPHA_PROJECT = 'aaaa1111-0000-0000-0000-0000000000a1';
const ALPHA_PERMIT = 'aaaa2222-0000-0000-0000-0000000000a2';

async function server() {
  process.env['AUTH_JWT_SECRET'] ||= 'test-access-secret-000000000000000000000000';
  process.env['AUTH_REFRESH_SECRET'] ||= 'test-refresh-secret-00000000000000000000000';
  const { buildServer } = await import('../src/index.js');
  const app = await buildServer();
  await app.ready();
  return app;
}

describeIfDb('one contractor asking for another one\'s data', () => {
  beforeAll(async () => {
    await applyMigrations();
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query('create extension if not exists pgcrypto');
      await c.query('delete from ocs.companies where id in ($1,$2)', [ALPHA, BETA]);
      await c.query('delete from ocs.app_users where email in ($1,$2)', [ANA.email, ADMIN.email]);

      await c.query(
        `insert into ocs.companies (id, name, legal_name, email, service_line, status)
         values ($1,'Alpha Roofing','Alpha Roofing LLC','ana@alpha.test','EXPEDITING','active'),
                ($2,'Beta Builders','Beta Builders Inc','ben@beta.test','MANAGED_LICENSE','active')`,
        [ALPHA, BETA],
      );
      await c.query(
        `insert into ocs.app_users (email, name, app_role, is_active, password_hash, client_id)
         values ($1,'Ana Reyes','CLIENT',true, crypt($2, gen_salt('bf',10)), $5),
                ($3,'Admin','ADMIN',true, crypt($4, gen_salt('bf',10)), null)`,
        [ANA.email, ANA.password, ADMIN.email, ADMIN.password, ALPHA],
      );

      for (const [proj, permit, company, num, scope] of [
        [ALPHA_PROJECT, ALPHA_PERMIT, ALPHA, 'ALPHA-PERMIT-7701', 'Alpha reroof'],
        [BETA_PROJECT, BETA_PERMIT, BETA, BETA_PERMIT_NUMBER, BETA_SECRET_TEXT],
      ] as const) {
        await c.query(
          `insert into ocs.projects (id, company_id, name, address_line1, city, state, postal_code)
           values ($1,$2,$3,'1 Main Street','Tampa','FL','33606')`,
          [proj, company, `${scope} site`],
        );
        await c.query(
          `insert into ocs.permits (id, company_id, project_id, permit_type, status,
                                    permit_number, scope_of_work)
           values ($1,$2,$3,'ROOFING','draft',$4,$5)`,
          [permit, company, proj, num, scope],
        );
        await c.query(
          `insert into ocs.invoices (company_id, permit_id, invoice_number, subtotal_cents,
                                     total_cents, status, issued_on, due_on)
           values ($1,$2,$3,50000,50000,'open',current_date,current_date + 30)`,
          [company, permit, company === ALPHA ? 7701 : 8801],
        );
        await c.query(
          `insert into ocs.compliance_items (company_id, kind, carrier, policy_number,
                                             expires_at, decision)
           values ($1,'GENERAL_LIABILITY',$2,'POL-1', now() + interval '100 days','accepted')`,
          [company, scope],
        );
      }

      await c.query(
        `insert into ocs.documents (id, company_id, project_id, permit_id, name, category)
         values ($1,$2,$3,$4,$5,'approved_plan')`,
        [BETA_DOCUMENT, BETA, BETA_PROJECT, BETA_PERMIT, `${BETA_SECRET_TEXT}.pdf`],
      );
      await c.query(
        `insert into ocs.support_tickets (id, company_id, reference, subject, permit_id)
         values ($1,$2,'SUP-8801',$3,$4)`,
        [BETA_TICKET, BETA, BETA_SECRET_TEXT, BETA_PERMIT],
      );
    } finally {
      await c.end();
    }
  });

  type App = Awaited<ReturnType<typeof server>>;
  const tokenFor = async (app: App, who: { email: string; password: string }) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: who });
    expect(res.statusCode, who.email).toBe(200);
    return JSON.parse(res.body).accessToken as string;
  };

  /** Every identifier that belongs to Beta and must never reach Ana. */
  const BETA_MARKERS: Array<[string, string]> = [
    ['company id', BETA],
    ['project id', BETA_PROJECT],
    ['permit id', BETA_PERMIT],
    ['document id', BETA_DOCUMENT],
    ['ticket id', BETA_TICKET],
    ['permit number', BETA_PERMIT_NUMBER],
    ['scope of work', BETA_SECRET_TEXT],
    ['contact email', 'ben@beta.test'],
    ['company name', 'Beta Builders'],
  ];

  /*
   * Everything a contractor session can ask for. Listing them by hand rather
   * than deriving them is deliberate: a derived list quietly shrinks when a
   * route is renamed, and this is the check that must not quietly shrink.
   */
  const READS: string[] = [
    '/api/dashboard',
    '/api/clients',
    `/api/clients/${BETA}`,
    '/api/permits',
    `/api/permits/${BETA_PERMIT}`,
    '/api/projects',
    '/api/documents',
    `/api/documents?clientId=${BETA}`,
    `/api/documents?permitId=${BETA_PERMIT}`,
    '/api/compliance',
    `/api/compliance?clientId=${BETA}`,
    '/api/billing/invoices',
    `/api/billing/invoices?clientId=${BETA}`,
    '/api/support',
    '/api/drafting',
    '/api/inspections',
    '/api/corrections',
    '/api/notary',
    '/api/supervision/visits',
    '/api/supervision/my-visits',
    `/api/supervision/verdict/${BETA_PERMIT}`,
    '/api/generated-documents',
    `/api/generated-documents?clientId=${BETA}`,
    '/api/portal/actions',
    '/api/portal/folders',
    '/api/portal/team',
    '/api/portal/permit-requests',
    '/api/signing/requests',
    `/api/signing/requests?clientId=${BETA}`,
    `/api/signing/status/${BETA}`,
    '/api/users',
    '/api/jurisdictions',
    '/api/me',
  ];

  it.each(READS)('%s leaks nothing of Beta\'s to a contractor at Alpha', async (url) => {
    const app = await server();
    try {
      const token = await tokenFor(app, ANA);
      const res = await app.inject({
        method: 'GET', url, headers: { authorization: `Bearer ${token}` },
      });

      /*
       * A refusal is a pass, and so is a 404. What is NOT a pass is a 200
       * carrying somebody else's rows -- which is the only outcome this is
       * looking for. A 500 fails, because a handler that throws on a
       * cross-tenant id has not decided anything.
       */
      expect([200, 400, 401, 403, 404, 501], `${url} -> ${res.statusCode}`)
        .toContain(res.statusCode);
      if (res.statusCode !== 200) return;

      const found = BETA_MARKERS
        .filter(([, marker]) => res.body.includes(marker))
        .map(([what, marker]) => `${what} (${marker})`);

      expect(
        found,
        found.length
          ? `${url} returned Beta's data to a session belonging to Alpha:\n  ` +
            `${found.join('\n  ')}\n` +
            'Row-level security does not cover this: staff routes run under ' +
            'withServiceContext, which turns it off. Route the read through ' +
            'scoped() so a CLIENT is pinned to their own company.'
          : '',
      ).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('lets an administrator see both, so the check above is not passing by accident', async () => {
    const app = await server();
    try {
      const token = await tokenFor(app, ADMIN);
      const res = await app.inject({
        method: 'GET', url: '/api/permits', headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);

      /*
       * Without this, every assertion above would still pass if the endpoints
       * were simply returning nothing at all.
       */
      expect(res.body).toContain(BETA_PERMIT_NUMBER);
      expect(res.body).toContain('ALPHA-PERMIT-7701');
    } finally {
      await app.close();
    }
  });

  /*
   * Writes, which are the half that does lasting damage.
   *
   * A read that leaks is a disclosure. A write that lands in the wrong tenant
   * puts a document in a stranger's file, an invoice against a stranger's
   * account, or a correction on a stranger's permit -- and it stays there,
   * looking exactly like something they did themselves.
   *
   * Each case names a Beta resource in a body or a path from a session that
   * belongs to Alpha.
   *
   * TWO DIFFERENT FAILURES are being looked for, and they are not the same
   * size. The severe one -- a row landing in Beta -- is caught by the row
   * counts in the test below, and nothing here ever did it: the scoping pins a
   * CLIENT to its own company and the isolation held everywhere.
   *
   * The other is a success answered to a request that was not carried out.
   * Compliance and support both returned 201 to "create this for Beta" having
   * created it for Alpha, silently substituting the caller's own company. Safe,
   * and still wrong: a contractor who mistypes an id gets a success and a
   * record filed where they did not ask for it.
   */
  const WRITES: Array<{ what: string; method: 'POST' | 'PATCH' | 'DELETE'; url: string; payload?: object }> = [
    {
      what: 'file a permit under Beta',
      method: 'POST', url: '/api/permits',
      payload: { clientId: BETA, projectId: BETA_PROJECT, permitType: 'ROOFING' },
    },
    {
      what: "change Beta's permit",
      method: 'PATCH', url: `/api/permits/${BETA_PERMIT}`,
      payload: { scopeOfWork: 'rewritten by a stranger' },
    },
    {
      what: "put a project on Beta's books",
      method: 'POST', url: '/api/projects',
      payload: { clientId: BETA, name: 'Planted', addressLine1: '1 Main', city: 'Tampa', state: 'FL', zip: '33606' },
    },
    {
      what: "attach a photo to Beta's permit",
      method: 'POST', url: '/api/documents/photos',
      payload: {
        permitId: BETA_PERMIT, fileName: 'planted.jpg', contentType: 'image/jpeg',
        sizeBytes: 3, dataBase64: Buffer.from('abc').toString('base64'),
      },
    },
    {
      what: "raise a compliance item against Beta",
      method: 'POST', url: '/api/compliance',
      payload: { clientId: BETA, kind: 'GENERAL_LIABILITY', carrier: 'Planted' },
    },
    {
      what: "invoice Beta",
      method: 'POST', url: '/api/billing/invoices',
      payload: { clientId: BETA, lines: [{ description: 'Planted', quantity: 1, unitCents: 100000 }] },
    },
    {
      what: "open a support ticket as Beta",
      method: 'POST', url: '/api/support',
      payload: { clientId: BETA, subject: 'Planted', body: 'Planted' },
    },
    {
      what: "send Beta an agreement",
      method: 'POST', url: '/api/signing/requests',
      payload: { clientId: BETA, kind: 'MASTER_SERVICE_AGREEMENT' },
    },
    {
      what: "invite themselves into Beta",
      method: 'POST', url: '/api/users/invite',
      payload: { email: 'planted@test.invalid', role: 'CLIENT', clientId: BETA },
    },
    {
      what: 'promote themselves to administrator',
      method: 'POST', url: '/api/users/invite',
      payload: { email: 'planted2@test.invalid', role: 'ADMIN' },
    },
  ];

  it.each(WRITES)('refuses to let Alpha $what', async ({ method, url, payload }) => {
    const app = await server();
    try {
      const token = await tokenFor(app, ANA);
      const res = await app.inject({
        method, url, payload: payload ?? {},
        headers: { authorization: `Bearer ${token}` },
      });

      const accepted = [200, 201, 204].includes(res.statusCode);
      expect(
        accepted,
        `${method} ${url} answered ${res.statusCode} to a write naming another ` +
        'tenant. Either it wrote there — check the row counts below — or it ' +
        'substituted the caller\'s own company and reported success for a ' +
        'request nobody made. Refuse the mismatch instead; see ' +
        `resolveClientId in client-scope.ts.\n${res.body.slice(0, 300)}`,
      ).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('leaves Beta exactly as it was', async () => {
    /*
     * The assertion that actually covers the severe case, and the reason the
     * status checks above are not the whole story: a handler could refuse with
     * a 403 having already written, and every status assertion would pass.
     *
     * This is what establishes that none of the attempts above reached Beta.
     */
    const c = client(ownerUrl!);
    await c.connect();
    try {
      for (const [table, expected] of [
        ['permits', 1], ['projects', 1], ['invoices', 1],
        ['documents', 1], ['support_tickets', 1], ['compliance_items', 1],
        ['signature_requests', 0],
      ] as const) {
        const { rows } = await c.query(
          `select count(*)::int as n from ocs.${table} where company_id = $1`,
          [BETA],
        );
        expect(rows[0].n, `ocs.${table} for Beta`).toBe(expected);
      }
      const { rows: users } = await c.query(
        `select count(*)::int as n from ocs.app_users where client_id = $1`, [BETA],
      );
      expect(users[0].n, 'app_users planted into Beta').toBe(0);
    } finally {
      await c.end();
    }
  });
});

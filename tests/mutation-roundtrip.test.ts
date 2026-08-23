/**
 * A PATCH that reports success and changes nothing.
 *
 * This is the failure that started the whole audit: a compliance reviewer
 * corrected an expiry date, watched it save, and the value came back the old
 * one. Zod had dropped the field, the handler updated nothing, and the response
 * was a cheerful 200.
 *
 * Unknown keys are logged now, and tests/request-fields.test.ts catches a
 * declared field the handler never mentions. Neither catches the third shape:
 * a field that is declared, read, put into an UPDATE — and still does not
 * arrive, because the column is wrong, the WHERE misses, or a coalesce keeps
 * the old value. Nothing but writing and reading back settles that.
 *
 * So each case below sends a change through the API the screen uses, then asks
 * the API what the value is now. Both halves go over HTTP on purpose: reading
 * the row straight out of Postgres would pass while the endpoint that renders
 * it still returns the stale one.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { dbConfigured, applyMigrations, client, ownerUrl, ALPHA } from './helpers/db.js';

const describeIfDb = dbConfigured ? describe : describe.skip;

const ADMIN = { email: 'rt-admin@test.invalid', password: 'RoundTrip2026!' };
const PROJECT = 'dddd1111-0000-0000-0000-0000000000d1';
const PERMIT = 'dddd2222-0000-0000-0000-0000000000d2';
const TICKET = 'dddd3333-0000-0000-0000-0000000000d3';

async function server() {
  process.env['AUTH_JWT_SECRET'] ||= 'test-access-secret-000000000000000000000000';
  process.env['AUTH_REFRESH_SECRET'] ||= 'test-refresh-secret-00000000000000000000000';
  const { buildServer } = await import('../src/index.js');
  const app = await buildServer();
  await app.ready();
  return app;
}

describeIfDb('a change made through the API', () => {
  beforeAll(async () => {
    await applyMigrations();
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query('create extension if not exists pgcrypto');
      await c.query('delete from ocs.companies where id = $1', [ALPHA]);
      await c.query(
        `insert into ocs.companies (id, name, legal_name, email, service_line,
                                    license_number, status)
         values ($1,'Alpha Roofing','Alpha Roofing LLC','ana@alpha.test',
                 'EXPEDITING','CCC1330000','active')`,
        [ALPHA],
      );
      await c.query('delete from ocs.app_users where email = $1', [ADMIN.email]);
      await c.query(
        `insert into ocs.app_users (email, name, app_role, is_active, password_hash)
         values ($1,'Admin','ADMIN',true, crypt($2, gen_salt('bf',10)))`,
        [ADMIN.email, ADMIN.password],
      );
      await c.query(
        `insert into ocs.projects (id, company_id, name, address_line1, city, state, postal_code)
         values ($1,$2,'Bay Street','1200 Bay Street','Tampa','FL','33606')`,
        [PROJECT, ALPHA],
      );
      await c.query(
        `insert into ocs.permits (id, company_id, project_id, permit_type, status)
         values ($1,$2,$3,'ROOFING','draft')`,
        [PERMIT, ALPHA, PROJECT],
      );
      await c.query(
        `insert into ocs.support_tickets (id, company_id, reference, subject, permit_id)
         values ($1,$2,'SUP-5001','Inspection not called in',$3)`,
        [TICKET, ALPHA, PERMIT],
      );
    } finally {
      await c.end();
    }
  });

  type App = Awaited<ReturnType<typeof server>>;
  const auth = async (app: App) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: ADMIN });
    expect(res.statusCode).toBe(200);
    return { authorization: `Bearer ${JSON.parse(res.body).accessToken}` };
  };

  /** Follow a dotted path, so a case can name a value nested in a response. */
  const at = (body: unknown, path: string): unknown =>
    path.split('.').reduce<unknown>(
      (v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined),
      body,
    );

  const CASES: Array<{
    what: string;
    patch: string;
    body: Record<string, unknown>;
    read: string;
    path: string;
    expected: unknown;
  }> = [
    {
      what: "a contractor's legal name",
      patch: `/api/clients/${ALPHA}`,
      body: { legalName: 'Alpha Roofing and Sheet Metal LLC' },
      read: `/api/clients/${ALPHA}`,
      path: 'legalName',
      expected: 'Alpha Roofing and Sheet Metal LLC',
    },
    {
      what: 'the service line a contractor is on',
      patch: `/api/clients/${ALPHA}`,
      body: { serviceLine: 'MANAGED_LICENSE' },
      read: `/api/clients/${ALPHA}`,
      path: 'serviceLine',
      expected: 'MANAGED_LICENSE',
    },
    {
      what: 'a filing hold, with its reason',
      patch: `/api/clients/${ALPHA}`,
      body: { filingHold: true, filingHoldReason: 'General liability lapsed 3 March' },
      read: `/api/clients/${ALPHA}`,
      path: 'filingHoldReason',
      expected: 'General liability lapsed 3 March',
    },
    {
      what: 'a support ticket moving to resolved',
      patch: `/api/support/${TICKET}`,
      body: { status: 'RESOLVED' },
      read: '/api/support',
      path: 'tickets.0.status',
      expected: 'RESOLVED',
    },
  ];

  it.each(CASES)('persists $what', async ({ patch, body, read, path, expected }) => {
    const app = await server();
    try {
      const headers = await auth(app);

      const wrote = await app.inject({ method: 'PATCH', url: patch, payload: body, headers });
      expect(
        wrote.statusCode,
        `PATCH ${patch} -> ${wrote.statusCode} ${wrote.body.slice(0, 250)}`,
      ).toBe(200);

      const back = await app.inject({ method: 'GET', url: read, headers });
      expect(back.statusCode).toBe(200);
      const actual = at(JSON.parse(back.body), path);

      expect(
        actual,
        `PATCH ${patch} answered 200 and ${path} still reads ${JSON.stringify(actual)}. ` +
        'A save that reports success and changes nothing is the worst of the ' +
        'three failure shapes: the person who made the change has no reason to ' +
        'check, and finds out when a decision is made on the old value.',
      ).toEqual(expected);
    } finally {
      await app.close();
    }
  });

  it('refuses a filing hold with no reason, rather than storing one nobody can clear', async () => {
    const app = await server();
    try {
      const headers = await auth(app);
      const res = await app.inject({
        method: 'PATCH', url: `/api/clients/${ALPHA}`,
        payload: { filingHold: true, filingHoldReason: '   ' }, headers,
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

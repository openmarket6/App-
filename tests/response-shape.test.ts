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
const PROJECT = 'cccc1111-0000-0000-0000-0000000000c1';
const PERMIT = 'cccc2222-0000-0000-0000-0000000000c2';

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

describeIfDb('what the API puts on the wire', () => {
  beforeAll(async () => {
    await applyMigrations();
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query('create extension if not exists pgcrypto');
      await c.query('delete from ocs.companies where id = $1', [ALPHA]);
      await c.query(
        `insert into ocs.companies
           (id, name, legal_name, email, phone, license_number, service_line,
            address_line1, city, state, postal_code, status)
         values ($1,'Alpha Roofing','Alpha Roofing LLC','ana@alpha.test','8135551000',
                 'CCC1330000','MANAGED_LICENSE','88 Industrial Way','Tampa','FL','33619','active')`,
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
    } finally {
      await c.end();
    }
  });

  type App = Awaited<ReturnType<typeof server>>;

  /*
   * The endpoints the frontend reads lists and records from. Each says what a
   * non-empty response looks like, so a case cannot pass by returning nothing.
   */
  const CASES: Array<{ url: string; expect: (body: any) => unknown }> = [
    { url: '/api/clients', expect: (b) => b.clients?.length },
    { url: `/api/clients/${ALPHA}`, expect: (b) => b.id },
    { url: '/api/permits', expect: (b) => b.permits?.length },
    { url: `/api/permits/${PERMIT}`, expect: (b) => b.permit?.id },
    { url: '/api/projects', expect: (b) => b.projects?.length },
    { url: `/api/compliance?clientId=${ALPHA}`, expect: (b) => b.items?.length },
    { url: '/api/dashboard', expect: (b) => b },
    { url: '/api/jurisdictions', expect: (b) => b.jurisdictions?.length },
    { url: '/api/users', expect: (b) => b.users?.length },
    { url: `/api/signing/status/${ALPHA}`, expect: (b) => b.verdict },
  ];

  it.each(CASES)('$url returns camelCase keys only', async ({ url, expect: hasData }) => {
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

      const bad = snakeKeys(body);
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
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query('delete from ocs.permit_corrections where permit_id = $1', [PERMIT]);
      await c.query(
        `insert into ocs.permit_corrections (company_id, permit_id, cycle, discipline, body)
         values ($1,$2,1,'STRUCTURAL','Missing truss layout'),
                ($1,$2,1,'STRUCTURAL','Uplift values not shown'),
                ($1,$2,2,'ELECTRICAL','Panel schedule missing')`,
        [ALPHA, PERMIT],
      );
    } finally {
      await c.end();
    }

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
});

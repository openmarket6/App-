/**
 * Opening a supervision engagement.
 *
 * The only route that created one was POST /v1/supervision/engagements, which
 * authenticates SUPABASE tokens. The application signs in natively, so no
 * screen could reach it — and an engagement is the row a site visit hangs off.
 * No engagement meant no visit, which meant the supervision record this
 * business sells could not be STARTED, never mind completed. The whole symptom
 * was one sentence: "That permit has no supervision engagement yet, so there is
 * nothing to attach a visit to."
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbConfigured, applyMigrations, client, ownerUrl, ALPHA } from './helpers/db.js';

const ROOT_SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');

const describeIfDb = dbConfigured ? describe : describe.skip;
const STAFF = { email: 'eng-staff@test.invalid', password: 'EngagementStaff2026!' };

async function server() {
  process.env['AUTH_JWT_SECRET'] ||= 'test-access-secret-000000000000000000000000';
  process.env['AUTH_REFRESH_SECRET'] ||= 'test-refresh-secret-00000000000000000000000';
  const { buildServer } = await import('../src/index.js');
  const app = await buildServer();
  await app.ready();
  return app;
}

describeIfDb('opening a supervision engagement', () => {
  let tradeId = '';
  let projectId = '';

  beforeAll(async () => {
    await applyMigrations();
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query('create extension if not exists pgcrypto');
      await c.query('delete from ocs.companies where id = $1', [ALPHA]);
      await c.query(`insert into ocs.companies (id, name) values ($1,'Alpha Roofing LLC')`, [ALPHA]);
      await c.query('delete from ocs.app_users where email = $1', [STAFF.email]);
      await c.query(
        `insert into ocs.app_users (email, name, app_role, is_active, password_hash)
         values ($1,'Staff','ADMIN',true, crypt($2, gen_salt('bf',10)))`,
        [STAFF.email, STAFF.password],
      );
      tradeId = (await c.query('select id from ocs.trades limit 1')).rows[0].id;
      projectId = (await c.query(
        `insert into ocs.projects (company_id, name) values ($1,'Job Site') returning id`,
        [ALPHA],
      )).rows[0].id;
    } finally {
      await c.end();
    }
  });

  beforeEach(async () => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query('delete from ocs.supervision_engagements where company_id = $1', [ALPHA]);
      await c.query('delete from ocs.service_licenses');
    } finally {
      await c.end();
    }
  });

  const licence = async (opts: { expired?: boolean } = {}) => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query(
        `insert into ocs.service_licenses
           (trade_id, license_number, license_type, qualifier_name, status, expires_on)
         values ($1,'CGC000001','state_certified','Ryan Q','active', $2::date)`,
        [tradeId, opts.expired ? '2020-01-01' : '2030-01-01'],
      );
    } finally {
      await c.end();
    }
  };

  const token = async (app: Awaited<ReturnType<typeof server>>) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: STAFF });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body).accessToken as string;
  };

  const open = (app: Awaited<ReturnType<typeof server>>, t: string, payload: unknown) =>
    app.inject({
      method: 'POST', url: '/api/supervision/engagements',
      payload: payload as object, headers: { authorization: `Bearer ${t}` },
    });

  it('is reachable on the authentication the application actually uses', async () => {
    // The whole point. A native session must be able to open one.
    await licence();
    const app = await server();
    try {
      const t = await token(app);
      const res = await open(app, t, { clientId: ALPHA, tradeId, projectId });
      expect(res.statusCode, res.body).toBe(201);
      expect(JSON.parse(res.body).engagementNumber).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it('takes the contractor from the project rather than making the caller restate it', async () => {
    await licence();
    const app = await server();
    try {
      const t = await token(app);
      const res = await open(app, t, { tradeId, projectId });
      expect(res.statusCode, res.body).toBe(201);
      expect(JSON.parse(res.body).clientId).toBe(ALPHA);
    } finally {
      await app.close();
    }
  });

  it('refuses a trade OCS holds no licence for, and says why', async () => {
    /*
     * Our licence is what goes on the permit. A trade we cannot qualify is a
     * job we cannot take, and saying so now is far cheaper than saying it after
     * a contractor has scheduled the work.
     */
    const app = await server();
    try {
      const t = await token(app);
      const res = await open(app, t, { clientId: ALPHA, tradeId, projectId });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).message).toMatch(/does not currently hold an active licence/i);
    } finally {
      await app.close();
    }
  });

  it('treats an expired licence as no licence', async () => {
    // A lapsed licence on a permit is the problem this product exists to avoid.
    await licence({ expired: true });
    const app = await server();
    try {
      const t = await token(app);
      const res = await open(app, t, { clientId: ALPHA, tradeId, projectId });
      expect(res.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  it('refuses when nothing says which contractor it is for', async () => {
    await licence();
    const app = await server();
    try {
      const t = await token(app);
      const res = await open(app, t, { tradeId });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toMatch(/must belong to a contractor/i);
    } finally {
      await app.close();
    }
  });

  it('refuses when no trade is named', async () => {
    await licence();
    const app = await server();
    try {
      const t = await token(app);
      const res = await open(app, t, { clientId: ALPHA, projectId });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toMatch(/which trade/i);
    } finally {
      await app.close();
    }
  });
});

/**
 * Recording the firm's own licences and supervisors.
 *
 * Both existed only under /v1 on Supabase auth, so neither was reachable from
 * the application — and the result was visible in production as two empty
 * tables. Every managed-licence engagement was refused for want of a licence,
 * and a SITE_SUPERVISOR opening the field screen was told their account "is not
 * linked to a supervisor record yet" with no way for anyone to link it.
 */
describeIfDb('recording what OCS itself holds', () => {
  const ADMIN = { email: 'sv-admin@test.invalid', password: 'SvAdminPass2026!' };
  const TECH = { email: 'sv-tech@test.invalid', password: 'SvTechPass2026!' };
  const FIELD = 'sv-field@test.invalid';
  let tradeId = '';
  let fieldUserId = '';

  beforeAll(async () => {
    await applyMigrations();
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query('create extension if not exists pgcrypto');
      await c.query('delete from ocs.app_users where email in ($1,$2,$3)', [
        ADMIN.email, TECH.email, FIELD,
      ]);
      await c.query(
        `insert into ocs.app_users (email, name, app_role, is_active, password_hash) values
           ($1,'Admin','ADMIN',true, crypt($2, gen_salt('bf',10))),
           ($3,'Tech','PERMIT_TECH',true, crypt($4, gen_salt('bf',10)))`,
        [ADMIN.email, ADMIN.password, TECH.email, TECH.password],
      );
      fieldUserId = (await c.query(
        `insert into ocs.app_users (email, name, app_role, is_active)
         values ($1,'Field Sam','SITE_SUPERVISOR',true) returning id`,
        [FIELD],
      )).rows[0].id;
      tradeId = (await c.query('select id from ocs.trades limit 1')).rows[0].id;
    } finally {
      await c.end();
    }
  });

  beforeEach(async () => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query('delete from ocs.service_licenses');
      await c.query('delete from ocs.supervisors where user_id = $1', [fieldUserId]);
    } finally {
      await c.end();
    }
  });

  const tok = async (
    app: Awaited<ReturnType<typeof server>>, who: { email: string; password: string },
  ) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: who });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body).accessToken as string;
  };

  it('records a qualifying licence from a native session', async () => {
    const app = await server();
    try {
      const t = await tok(app, ADMIN);
      const res = await app.inject({
        method: 'POST', url: '/api/supervision/licenses',
        headers: { authorization: `Bearer ${t}` },
        payload: {
          tradeId, licenseNumber: 'CGC1520001', licenseType: 'state_certified',
          qualifierName: 'Ryan Q', expiresOn: '2030-01-01',
        },
      });
      expect(res.statusCode, res.body).toBe(201);
    } finally {
      await app.close();
    }
  });

  it('writes the licence type instead of leaning on the default', () => {
    /*
     * The /v1 original omitted license_type and relied on the column default.
     * That is right only for as long as the default is the right answer, and a
     * county licence recorded as state-certified is the kind of wrong a
     * regulator finds rather than we do.
     */
    const src = readFileSync(join(ROOT_SRC, 'routes/compat/supervision.ts'), 'utf8');
    expect(src).toContain('::ocs.license_type');
  });

  it('refuses a permit tech — this is the firm\'s own licence', async () => {
    const app = await server();
    try {
      const t = await tok(app, TECH);
      const res = await app.inject({
        method: 'POST', url: '/api/supervision/licenses',
        headers: { authorization: `Bearer ${t}` },
        payload: { tradeId, licenseNumber: 'X', qualifierName: 'Y' },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('links a supervisor record to a login', async () => {
    const app = await server();
    try {
      const t = await tok(app, ADMIN);
      const res = await app.inject({
        method: 'POST', url: '/api/supervision/supervisors',
        headers: { authorization: `Bearer ${t}` },
        payload: { userId: fieldUserId, displayName: 'Field Sam', tradeIds: [tradeId] },
      });
      expect(res.statusCode, res.body).toBe(201);
      const body = JSON.parse(res.body);
      // Said back plainly: a supervisor record on a login that is not a
      // SITE_SUPERVISOR still will not open the field screen.
      expect(body.fieldScreenReady).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('says so when the login could not open the field screen anyway', async () => {
    const app = await server();
    try {
      const t = await tok(app, ADMIN);
      const admin = await app.inject({
        method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${t}` },
      });
      const adminId = JSON.parse(admin.body).user.id;
      const res = await app.inject({
        method: 'POST', url: '/api/supervision/supervisors',
        headers: { authorization: `Bearer ${t}` },
        payload: { userId: adminId, displayName: 'Not A Supervisor' },
      });
      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).fieldScreenReady).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('refuses a login that does not exist', async () => {
    const app = await server();
    try {
      const t = await tok(app, ADMIN);
      const res = await app.inject({
        method: 'POST', url: '/api/supervision/supervisors',
        headers: { authorization: `Bearer ${t}` },
        payload: {
          userId: '00000000-0000-0000-0000-000000000000', displayName: 'Ghost',
        },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

/**
 * The verdict: does the supervision record support our licence being on this
 * permit? The question the whole area exists to answer, and the one somebody
 * will eventually ask under oath.
 *
 * It answered 500 every single time it was ever called. The query referenced
 * e.qualifier_id twice and joined ocs.qualifiers for max_active_engagements —
 * supervision_engagements has no qualifier_id column, and ocs.qualifiers has no
 * capacity column, because that table is the CONTRACTOR's own qualifying
 * agents. A different thing with the same word on it. Invalid SQL fails at
 * parse time, so this was broken with data and without it, and nobody found it
 * because the tables were empty.
 */
describeIfDb('the supervision verdict', () => {
  const ADMIN = { email: 'vd-admin@test.invalid', password: 'VerdictAdmin2026!' };
  let permitId = '';
  let tradeId = '';

  beforeAll(async () => {
    await applyMigrations();
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query('create extension if not exists pgcrypto');
      await c.query('delete from ocs.companies where id = $1', [ALPHA]);
      await c.query(`insert into ocs.companies (id, name) values ($1,'Alpha Roofing LLC')`, [ALPHA]);
      await c.query('delete from ocs.app_users where email = $1', [ADMIN.email]);
      await c.query(
        `insert into ocs.app_users (email, name, app_role, is_active, password_hash)
         values ($1,'Admin','ADMIN',true, crypt($2, gen_salt('bf',10)))`,
        [ADMIN.email, ADMIN.password],
      );
      tradeId = (await c.query('select id from ocs.trades limit 1')).rows[0].id;
      const proj = (await c.query(
        `insert into ocs.projects (company_id, name) values ($1,'Verdict Site') returning id`,
        [ALPHA],
      )).rows[0].id;
      permitId = (await c.query(
        `insert into ocs.permits (company_id, project_id, permit_type, status)
         values ($1,$2,'ROOFING','draft') returning id`,
        [ALPHA, proj],
      )).rows[0].id;
    } finally {
      await c.end();
    }
  });

  beforeEach(async () => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query('delete from ocs.supervision_engagements where company_id = $1', [ALPHA]);
      await c.query('delete from ocs.service_licenses');
    } finally {
      await c.end();
    }
  });

  const tok = async (app: Awaited<ReturnType<typeof server>>) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: ADMIN });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body).accessToken as string;
  };

  const verdict = (app: Awaited<ReturnType<typeof server>>, t: string) =>
    app.inject({
      method: 'GET', url: `/api/supervision/verdict/${permitId}`,
      headers: { authorization: `Bearer ${t}` },
    });

  it('answers at all when there is no engagement', async () => {
    // The 500 happened here too: a bad column reference fails at parse time,
    // so an empty database did not save it.
    const app = await server();
    try {
      const res = await verdict(app, await tok(app));
      expect(res.statusCode, res.body).toBe(200);
      expect(JSON.parse(res.body).defensible).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('answers once an engagement exists', async () => {
    const app = await server();
    try {
      const t = await tok(app);
      await app.inject({
        method: 'POST', url: '/api/supervision/licenses',
        headers: { authorization: `Bearer ${t}` },
        payload: {
          tradeId, licenseNumber: 'CGC1520002', qualifierName: 'Ryan Q',
          expiresOn: '2030-01-01', maxActiveEngagements: 25,
        },
      });
      const opened = await app.inject({
        method: 'POST', url: '/api/supervision/engagements',
        headers: { authorization: `Bearer ${t}` },
        payload: { permitId, tradeId },
      });
      expect(opened.statusCode, opened.body).toBe(201);

      const res = await verdict(app, t);
      expect(res.statusCode, res.body).toBe(200);
      expect(JSON.parse(res.body).permitId).toBe(permitId);
    } finally {
      await app.close();
    }
  });

  it('records which licence is carrying the engagement', async () => {
    /*
     * Not bookkeeping. The verdict asks how many other jobs sit on this licence,
     * and an engagement that only knows a licence existed at the time cannot
     * answer that — nor say which one lapsed when one does.
     */
    const app = await server();
    try {
      const t = await tok(app);
      await app.inject({
        method: 'POST', url: '/api/supervision/licenses',
        headers: { authorization: `Bearer ${t}` },
        payload: {
          tradeId, licenseNumber: 'CGC1520003', qualifierName: 'Ryan Q',
          expiresOn: '2030-01-01',
        },
      });
      const opened = await app.inject({
        method: 'POST', url: '/api/supervision/engagements',
        headers: { authorization: `Bearer ${t}` },
        payload: { permitId, tradeId },
      });
      expect(JSON.parse(opened.body).serviceLicenseId).toBeTruthy();

      const c = client(ownerUrl!);
      await c.connect();
      try {
        const row = await c.query(
          'select service_license_id from ocs.supervision_engagements where permit_id = $1',
          [permitId],
        );
        expect(row.rows[0].service_license_id).toBeTruthy();
      } finally {
        await c.end();
      }
    } finally {
      await app.close();
    }
  });

  it('picks the licence expiring soonest', async () => {
    // The binding constraint. Choosing it means a renewal problem surfaces on
    // the first job rather than the last.
    const app = await server();
    try {
      const t = await tok(app);
      for (const [num, exp] of [['CGC-LATE', '2035-01-01'], ['CGC-SOON', '2027-01-01']]) {
        await app.inject({
          method: 'POST', url: '/api/supervision/licenses',
          headers: { authorization: `Bearer ${t}` },
          payload: { tradeId, licenseNumber: num, qualifierName: 'Ryan Q', expiresOn: exp },
        });
      }
      const opened = await app.inject({
        method: 'POST', url: '/api/supervision/engagements',
        headers: { authorization: `Bearer ${t}` },
        payload: { permitId, tradeId },
      });
      const chosen = JSON.parse(opened.body).serviceLicenseId;

      const c = client(ownerUrl!);
      await c.connect();
      try {
        const row = await c.query(
          'select license_number from ocs.service_licenses where id = $1', [chosen],
        );
        expect(row.rows[0].license_number).toBe('CGC-SOON');
      } finally {
        await c.end();
      }
    } finally {
      await app.close();
    }
  });
});

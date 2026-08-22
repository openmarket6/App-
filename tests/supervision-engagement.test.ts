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
import { dbConfigured, applyMigrations, client, ownerUrl, ALPHA } from './helpers/db.js';

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

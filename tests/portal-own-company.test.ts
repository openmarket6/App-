/**
 * A contractor can read its OWN company record, and only that one.
 *
 * This exists because of a defect that was invisible from the server side and
 * obvious from a browser: PortalShell asks for /api/clients on every render to
 * put the contractor's company name in the sidebar, and CLIENT_CAPS did not
 * carry 'client:read'. So every page a contractor opened fired a 403, and the
 * sidebar read the placeholder "Your company" for the entire session -- the
 * product could not say the customer's own name back to them.
 *
 * Granting the capability is only safe because scoped() discards the requested
 * id for a CLIENT and substitutes their own company under withTenant. That is
 * the property under test here: not that the grant exists, but that it cannot
 * reach a second tenant. If someone later routes a client:read endpoint around
 * scoped(), the third case below is what fails.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { dbConfigured, applyMigrations, seedTwoTenants, client, ownerUrl, ALPHA, BETA } from './helpers/db.js';
import { can } from '../src/shared/permissions.js';

const describeIfDb = dbConfigured ? describe : describe.skip;

const ALPHA_LOGIN = { email: 'alpha-portal@test.invalid', password: 'AlphaPortal2026!' };

describe('the capability table', () => {
  it('lets a contractor read a contractor record at all', () => {
    // The 403 that broke every portal page was exactly this returning false.
    expect(can('CLIENT', 'client:read')).toBe(true);
  });

  it('still refuses a contractor the write capabilities', () => {
    expect(can('CLIENT', 'client:create')).toBe(false);
    expect(can('CLIENT', 'client:edit')).toBe(false);
  });
});

describeIfDb('a contractor reading contractor records', () => {
  beforeAll(async () => {
    await applyMigrations();
    await seedTwoTenants();
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query('create extension if not exists pgcrypto');
      await c.query('delete from ocs.app_users where email = $1', [ALPHA_LOGIN.email]);
      await c.query(
        `insert into ocs.app_users (email, name, app_role, is_active, password_hash, client_id)
         values ($1, 'Alpha Portal', 'CLIENT', true, crypt($2, gen_salt('bf',10)), $3)`,
        [ALPHA_LOGIN.email, ALPHA_LOGIN.password, ALPHA],
      );
    } finally {
      await c.end();
    }
  });

  async function server() {
    process.env['AUTH_JWT_SECRET'] ||= 'test-access-secret-000000000000000000000000';
    process.env['AUTH_REFRESH_SECRET'] ||= 'test-refresh-secret-00000000000000000000000';
    const { buildServer } = await import('../src/index.js');
    const app = await buildServer();
    await app.ready();
    return app;
  }

  it('gets its own company back, with a name to show', async () => {
    const app = await server();
    try {
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: ALPHA_LOGIN });
      expect(login.statusCode).toBe(200);
      const token = JSON.parse(login.body).accessToken as string;

      const res = await app.inject({
        method: 'GET', url: '/api/clients',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.clients).toHaveLength(1);
      expect(body.clients[0].id).toBe(ALPHA);
      // The sidebar renders this. An empty string would still be a 200 and
      // still leave the contractor looking at a placeholder.
      expect(body.clients[0].name).toBe('Alpha Roofing LLC');
    } finally {
      await app.close();
    }
  });

  it('cannot read the other contractor by asking for it directly', async () => {
    const app = await server();
    try {
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: ALPHA_LOGIN });
      const token = JSON.parse(login.body).accessToken as string;

      const res = await app.inject({
        method: 'GET', url: `/api/clients/${BETA}`,
        headers: { authorization: `Bearer ${token}` },
      });
      // Not 200 under any circumstances. 404 is the honest answer: within this
      // caller's tenant that record does not exist.
      expect(res.statusCode).not.toBe(200);
      expect(res.body).not.toContain('Beta Builders');
    } finally {
      await app.close();
    }
  });

  it('cannot smuggle the other contractor in through the query string', async () => {
    const app = await server();
    try {
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: ALPHA_LOGIN });
      const token = JSON.parse(login.body).accessToken as string;

      const res = await app.inject({
        method: 'GET', url: `/api/clients?clientId=${BETA}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.clients).toHaveLength(1);
      expect(body.clients[0].id).toBe(ALPHA);
    } finally {
      await app.close();
    }
  });
});

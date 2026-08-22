/**
 * The contractors list and the contractor record must describe the same thing.
 *
 * They had drifted. /api/clients selected raw columns (`legal_name`, `email`)
 * while /api/clients/:id aliased them to the names the frontend reads, so the
 * list rendered blanks in four columns -- and did not select `service_line` at
 * all.
 *
 * That last one was not cosmetic. The contractors screen badges each row
 * Expediting or Managed licence from `serviceLine`, counts the managed ones,
 * and filters by it. With the field absent every contractor was badged
 * Expediting, the managed count read zero, and the filter matched nothing. On
 * the managed line this firm's licence is on the permit and supervision is a
 * legal obligation, so the screen that says which contractors those are was
 * saying there are none.
 *
 * The comparison below is between the two endpoints rather than against a
 * hard-coded list of field names, because a fixed list is a third copy that can
 * drift on its own.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { dbConfigured, applyMigrations, client, ownerUrl, ALPHA, BETA } from './helpers/db.js';

const describeIfDb = dbConfigured ? describe : describe.skip;

const ADMIN = { email: 'shape-admin@test.invalid', password: 'ShapeAdmin2026!' };

async function server() {
  process.env['AUTH_JWT_SECRET'] ||= 'test-access-secret-000000000000000000000000';
  process.env['AUTH_REFRESH_SECRET'] ||= 'test-refresh-secret-00000000000000000000000';
  const { buildServer } = await import('../src/index.js');
  const app = await buildServer();
  await app.ready();
  return app;
}

describeIfDb('the contractor shape', () => {
  beforeAll(async () => {
    await applyMigrations();
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query('create extension if not exists pgcrypto');
      await c.query('delete from ocs.companies where id in ($1,$2)', [ALPHA, BETA]);
      await c.query(
        `insert into ocs.companies
           (id, name, legal_name, email, phone, license_number, service_line,
            address_line1, city, state, postal_code)
         values ($1,'Alpha Roofing','Alpha Roofing LLC','ana@alpha.test','8135551000',
                 'CCC1330000','EXPEDITING','88 Industrial Way','Tampa','FL','33619'),
                ($2,'Beta Builders','Beta Builders Inc','ben@beta.test','9545552000',
                 null,'MANAGED_LICENSE','12 Coral Way','Miami','FL','33130')`,
        [ALPHA, BETA],
      );
      await c.query('delete from ocs.app_users where email = $1', [ADMIN.email]);
      await c.query(
        `insert into ocs.app_users (email, name, app_role, is_active, password_hash)
         values ($1,'Admin','ADMIN',true, crypt($2, gen_salt('bf',10)))`,
        [ADMIN.email, ADMIN.password],
      );
    } finally {
      await c.end();
    }
  });

  type App = Awaited<ReturnType<typeof server>>;
  const tokenFor = async (app: App) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: ADMIN });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body).accessToken as string;
  };
  const get = (app: App, token: string, url: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  it('sends the same fields from the list as from the record', async () => {
    const app = await server();
    try {
      const token = await tokenFor(app);

      const list = JSON.parse((await get(app, token, '/api/clients')).body);
      const row = list.clients.find((c: { id: string }) => c.id === BETA);
      expect(row, 'Beta should be in the list').toBeTruthy();

      const detail = JSON.parse((await get(app, token, `/api/clients/${BETA}`)).body);

      expect(Object.keys(row).sort()).toEqual(Object.keys(detail).sort());
    } finally {
      await app.close();
    }
  });

  it('says which service line each contractor is on, in the list', async () => {
    const app = await server();
    try {
      const token = await tokenFor(app);
      const list = JSON.parse((await get(app, token, '/api/clients')).body);
      const byId = new Map(list.clients.map((c: { id: string }) => [c.id, c]));

      /*
       * The whole point. Undefined here is what made every contractor read as
       * Expediting on a screen a coordinator uses to decide who needs a
       * supervision record.
       */
      expect((byId.get(BETA) as { serviceLine: string }).serviceLine).toBe('MANAGED_LICENSE');
      expect((byId.get(ALPHA) as { serviceLine: string }).serviceLine).toBe('EXPEDITING');
    } finally {
      await app.close();
    }
  });

  it('uses the names the frontend reads, not the column names', async () => {
    const app = await server();
    try {
      const token = await tokenFor(app);
      const list = JSON.parse((await get(app, token, '/api/clients')).body);
      const alpha = list.clients.find((c: { id: string }) => c.id === ALPHA);

      expect(alpha.legalName).toBe('Alpha Roofing LLC');
      expect(alpha.licenseNumber).toBe('CCC1330000');
      expect(alpha.contactEmail).toBe('ana@alpha.test');
      expect(alpha.addressLine1).toBe('88 Industrial Way');
      expect(alpha.zip).toBe('33619');

      // The snake_case spellings must be gone, not merely accompanied. A
      // response carrying both is one nobody can tell has been fixed.
      expect(alpha).not.toHaveProperty('legal_name');
      expect(alpha).not.toHaveProperty('license_number');
      expect(alpha).not.toHaveProperty('permit_count');
    } finally {
      await app.close();
    }
  });
});

/**
 * A contractor onboarding themselves.
 *
 * Found by walking the path in production: a contractor company's FIRST login
 * was created as an ordinary member, because /api/users/invite had no
 * clientAdmin field at all and silently dropped the one that was sent. The
 * damage showed up two screens later — the owner tried to add their own crew
 * and got "Only your company administrator can add logins", with no
 * administrator existing anywhere and no way to appoint one except editing the
 * database by hand. Every contractor would have depended on OCS staff for every
 * login they ever needed, forever.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { dbConfigured, applyMigrations, client, ownerUrl, ALPHA, BETA } from './helpers/db.js';

const describeIfDb = dbConfigured ? describe : describe.skip;

const STAFF = { email: 'onb-staff@test.invalid', password: 'OnboardStaff2026!' };
const OWNER = 'onb-owner@test.invalid';
const CREW = 'onb-crew@test.invalid';
const SECOND = 'onb-second@test.invalid';

async function server() {
  process.env['AUTH_JWT_SECRET'] ||= 'test-access-secret-000000000000000000000000';
  process.env['AUTH_REFRESH_SECRET'] ||= 'test-refresh-secret-00000000000000000000000';
  const { buildServer } = await import('../src/index.js');
  const app = await buildServer();
  await app.ready();
  return app;
}

describeIfDb('a contractor onboarding themselves', () => {
  beforeAll(async () => {
    await applyMigrations();
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query('create extension if not exists pgcrypto');
      await c.query('delete from ocs.companies where id in ($1,$2)', [ALPHA, BETA]);
      await c.query(
        `insert into ocs.companies (id, name) values ($1,'Alpha Roofing LLC'), ($2,'Beta Builders Inc')`,
        [ALPHA, BETA],
      );
      await c.query('delete from ocs.app_users where email = $1', [STAFF.email]);
      await c.query(
        `insert into ocs.app_users (email, name, app_role, is_active, password_hash)
         values ($1,'Staff','ADMIN',true, crypt($2, gen_salt('bf',10)))`,
        [STAFF.email, STAFF.password],
      );
    } finally {
      await c.end();
    }
  });

  beforeEach(async () => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query('delete from ocs.app_users where email in ($1,$2,$3)', [OWNER, CREW, SECOND]);
    } finally {
      await c.end();
    }
  });

  const tokenFor = async (
    app: Awaited<ReturnType<typeof server>>, who: { email: string; password: string },
  ) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: who });
    expect(res.statusCode, who.email).toBe(200);
    return JSON.parse(res.body).accessToken as string;
  };

  const invite = (
    app: Awaited<ReturnType<typeof server>>, t: string, payload: unknown,
  ) => app.inject({
    method: 'POST', url: '/api/users/invite',
    payload: payload as object, headers: { authorization: `Bearer ${t}` },
  });

  const adminFlag = async (email: string) => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      const r = await c.query('select client_admin from ocs.app_users where email = $1', [email]);
      return r.rows[0]?.client_admin as boolean | undefined;
    } finally {
      await c.end();
    }
  };

  it('makes the first login for a company its administrator', async () => {
    /*
     * The fix for the chicken-and-egg. Adding a teammate needs an
     * administrator; appointing one needs an administrator; the first person
     * has nobody above them.
     */
    const app = await server();
    try {
      const t = await tokenFor(app, STAFF);
      const res = await invite(app, t, { email: OWNER, name: 'Owner', role: 'CLIENT', clientId: ALPHA });
      expect(res.statusCode).toBe(201);
      expect(await adminFlag(OWNER)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('does not make the second one an administrator by accident', async () => {
    // "First" has to mean first. Everyone being an administrator is the same
    // failure as nobody being one, discovered later.
    const app = await server();
    try {
      const t = await tokenFor(app, STAFF);
      await invite(app, t, { email: OWNER, role: 'CLIENT', clientId: ALPHA });
      await invite(app, t, { email: CREW, role: 'CLIENT', clientId: ALPHA });
      expect(await adminFlag(CREW)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('honours clientAdmin when staff pass it explicitly', async () => {
    // The field the endpoint used to drop on the floor.
    const app = await server();
    try {
      const t = await tokenFor(app, STAFF);
      await invite(app, t, { email: OWNER, role: 'CLIENT', clientId: ALPHA });
      await invite(app, t, { email: CREW, role: 'CLIENT', clientId: ALPHA, clientAdmin: true });
      expect(await adminFlag(CREW)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('counts per company, not globally', async () => {
    // Beta's first login is Beta's administrator even though Alpha already has
    // one. A global count would leave every company after the first with none.
    const app = await server();
    try {
      const t = await tokenFor(app, STAFF);
      await invite(app, t, { email: OWNER, role: 'CLIENT', clientId: ALPHA });
      await invite(app, t, { email: SECOND, role: 'CLIENT', clientId: BETA });
      expect(await adminFlag(SECOND)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('never demotes on a re-invite', async () => {
    // Reissuing somebody's link is not a decision about their authority.
    const app = await server();
    try {
      const t = await tokenFor(app, STAFF);
      await invite(app, t, { email: OWNER, role: 'CLIENT', clientId: ALPHA });
      expect(await adminFlag(OWNER)).toBe(true);
      await invite(app, t, { email: OWNER, role: 'CLIENT', clientId: ALPHA });
      expect(await adminFlag(OWNER)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('lets the company administrator add their own crew', async () => {
    /*
     * The end-to-end point. Before the fix this was a 403 for everybody,
     * which meant OCS staff had to create every contractor login by hand.
     */
    const app = await server();
    try {
      const staff = await tokenFor(app, STAFF);
      const created = JSON.parse((await invite(app, staff, {
        email: OWNER, name: 'Owner', role: 'CLIENT', clientId: ALPHA,
      })).body);

      const accepted = await app.inject({
        method: 'POST', url: '/api/auth/accept-invite',
        payload: { token: created.inviteToken, password: 'OwnerChosenPass2026!' },
      });
      expect(accepted.statusCode).toBe(200);

      const ownerToken = await tokenFor(app, { email: OWNER, password: 'OwnerChosenPass2026!' });
      const res = await app.inject({
        method: 'POST', url: '/api/portal/team/invite',
        payload: { email: CREW, name: 'Crew Lead' },
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      expect(res.statusCode, res.body).toBe(201);
    } finally {
      await app.close();
    }
  });

  it('does not let an ordinary member appoint an administrator', async () => {
    const app = await server();
    try {
      const staff = await tokenFor(app, STAFF);
      await invite(app, staff, { email: OWNER, role: 'CLIENT', clientId: ALPHA });
      const crew = JSON.parse((await invite(app, staff, {
        email: CREW, role: 'CLIENT', clientId: ALPHA,
      })).body);
      await app.inject({
        method: 'POST', url: '/api/auth/accept-invite',
        payload: { token: crew.inviteToken, password: 'CrewChosenPass2026!' },
      });
      const crewToken = await tokenFor(app, { email: CREW, password: 'CrewChosenPass2026!' });

      const res = await app.inject({
        method: 'POST', url: '/api/users/invite',
        payload: { email: SECOND, role: 'CLIENT', clientAdmin: true },
        headers: { authorization: `Bearer ${crewToken}` },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});

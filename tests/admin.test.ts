/**
 * The admin area.
 *
 * Two things are being pinned here. The first is access: these endpoints
 * describe the shape of the system, so they are restricted to administrators by
 * role and not only by capability. The second is what the diagnostics endpoint
 * says about secrets -- it reports whether one is SET and must never leak the
 * value, its length, or a prefix. A diagnostics page is the most commonly
 * screen-shotted page in any admin panel.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { dbConfigured, applyMigrations, client, ownerUrl } from './helpers/db.js';

const describeIfDb = dbConfigured ? describe : describe.skip;

const ADMIN = { email: 'admin-tests@test.invalid', password: 'AdminPassword2026!' };
const TECH = { email: 'tech-tests@test.invalid', password: 'TechPassword2026!' };
const SECRET_VALUE = 'sk_test_thisvalueMUSTneverAPPEARinAresponse';

async function server() {
  process.env['AUTH_JWT_SECRET'] ||= 'test-access-secret-000000000000000000000000';
  process.env['AUTH_REFRESH_SECRET'] ||= 'test-refresh-secret-00000000000000000000000';
  process.env['STRIPE_SECRET_KEY'] = SECRET_VALUE;
  const { buildServer } = await import('../src/index.js');
  const app = await buildServer();
  await app.ready();
  return app;
}

describeIfDb('the admin area', () => {
  beforeAll(async () => {
    await applyMigrations();
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query(`create extension if not exists pgcrypto`);
      await c.query(`delete from ocs.app_users where email in ($1,$2)`, [ADMIN.email, TECH.email]);
      await c.query(
        `insert into ocs.app_users (email, name, app_role, is_active, password_hash) values
           ($1,'Admin','ADMIN',true, crypt($2, gen_salt('bf',10))),
           ($3,'Tech','PERMIT_TECH',true, crypt($4, gen_salt('bf',10)))`,
        [ADMIN.email, ADMIN.password, TECH.email, TECH.password],
      );
    } finally {
      await c.end();
    }
  });

  const tokenFor = async (
    app: Awaited<ReturnType<typeof server>>,
    who: { email: string; password: string },
  ) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: who });
    expect(res.statusCode, who.email).toBe(200);
    return JSON.parse(res.body).accessToken as string;
  };

  const ADMIN_ONLY = [
    '/api/admin/diagnostics',
    '/api/admin/audit',
    '/api/admin/stats',
    '/api/admin/jobs/dead',
  ];

  it('serves every admin endpoint to an administrator', async () => {
    const app = await server();
    try {
      const token = await tokenFor(app, ADMIN);
      for (const url of ADMIN_ONLY) {
        const res = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
        expect(res.statusCode, url).toBe(200);
      }
    } finally {
      await app.close();
    }
  });

  it('refuses a permit tech', async () => {
    // A permit tech is trusted staff and can do almost everything else. This
    // area is still not theirs: it describes the system rather than the work.
    const app = await server();
    try {
      const token = await tokenFor(app, TECH);
      for (const url of ADMIN_ONLY) {
        const res = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
        expect(res.statusCode, url).toBe(403);
      }
    } finally {
      await app.close();
    }
  });

  it('refuses an unauthenticated caller', async () => {
    const app = await server();
    try {
      for (const url of ADMIN_ONLY) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(401);
      }
    } finally {
      await app.close();
    }
  });

  it('reports that a secret is set without revealing any part of it', async () => {
    // The test that matters most in this file. Diagnostics exists to answer
    // "is Stripe configured", and the answer is a boolean -- never the key, a
    // prefix of it, or its length.
    const app = await server();
    try {
      const token = await tokenFor(app, ADMIN);
      const res = await app.inject({
        method: 'GET', url: '/api/admin/diagnostics',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.body;

      expect(body).not.toContain(SECRET_VALUE);
      expect(body).not.toContain(SECRET_VALUE.slice(0, 12));
      expect(body).not.toContain('sk_test');

      const stripe = JSON.parse(body).connectors.find(
        (c: { key: string }) => c.key === 'stripe',
      );
      expect(stripe.configured).toBe(true);
      // And it says what breaks while it is missing, so the reader knows
      // whether to care.
      expect(stripe.without).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it('surfaces the accounts that cannot sign in', async () => {
    // The Kat case, turned into a number an administrator can see. An account
    // with no password reports "Email or password is incorrect" exactly like a
    // wrong password, so without this it is indistinguishable from user error.
    const app = await server();
    try {
      const token = await tokenFor(app, ADMIN);

      const c = client(ownerUrl!);
      await c.connect();
      try {
        await c.query(
          `insert into ocs.app_users (email, name, app_role, is_active)
           values ('nopassword@test.invalid','No Password','PERMIT_TECH',true)
           on conflict (lower(email)) do update set password_hash = null`,
        );
      } finally {
        await c.end();
      }

      const res = await app.inject({
        method: 'GET', url: '/api/admin/stats',
        headers: { authorization: `Bearer ${token}` },
      });
      const body = JSON.parse(res.body);

      expect(Number(body.counts.usersWithoutPassword)).toBeGreaterThan(0);
      expect(body.attention.join(' ')).toMatch(/never set a password/i);
    } finally {
      await app.close();
    }
  });

  it('pages the audit log by key, not by offset', async () => {
    // An audit log is written to constantly. An offset shifts under the reader
    // while they page, so rows get skipped or shown twice.
    const app = await server();
    try {
      const token = await tokenFor(app, ADMIN);
      const first = await app.inject({
        method: 'GET', url: '/api/admin/audit?limit=1',
        headers: { authorization: `Bearer ${token}` },
      });
      const body = JSON.parse(first.body);
      expect(body.entries.length).toBeLessThanOrEqual(1);
      if (body.entries.length === 1) {
        expect(body.nextBefore).toBe(body.entries[0].id);
      }
    } finally {
      await app.close();
    }
  });
});

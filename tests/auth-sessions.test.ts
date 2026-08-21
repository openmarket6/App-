/**
 * Staying signed in.
 *
 * The React frontend holds its access token in memory only, so every page
 * reload, every new tab and every returning visit depends entirely on the
 * refresh cookie. That makes refresh the real login path -- it runs far more
 * often than the sign-in form -- and anything that breaks it looks to a user
 * like "the login doesn't work".
 *
 * Rotation is what these tests are about. Revoking the presented token on every
 * refresh is correct, but done naively it makes two tabs mutually exclusive.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { dbConfigured, applyMigrations, client, ownerUrl } from './helpers/db.js';

const describeIfDb = dbConfigured ? describe : describe.skip;

const EMAIL = 'sessions@test.invalid';
const PASSWORD = 'SessionsAreHard2026!';

async function server() {
  process.env['AUTH_JWT_SECRET'] ||= 'test-access-secret-000000000000000000000000';
  process.env['AUTH_REFRESH_SECRET'] ||= 'test-refresh-secret-00000000000000000000000';
  const { buildServer } = await import('../src/index.js');
  const app = await buildServer();
  await app.ready();
  return app;
}

const cookieFrom = (res: { headers: Record<string, unknown> }): string => {
  const raw = res.headers['set-cookie'];
  const all = (Array.isArray(raw) ? raw : [raw]).map(String);
  const rt = all.find((c) => c.startsWith('flph_rt='));
  if (!rt) throw new Error('no refresh cookie was set');
  return rt.split(';')[0]!;
};

describeIfDb('staying signed in', () => {
  beforeAll(async () => {
    await applyMigrations();
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query(`create extension if not exists pgcrypto`);
      await c.query(`delete from ocs.app_users where email = $1`, [EMAIL]);
      await c.query(
        `insert into ocs.app_users (email, name, app_role, is_active, password_hash)
         values ($1, 'Session Tester', 'PERMIT_TECH', true, crypt($2, gen_salt('bf', 10)))`,
        [EMAIL, PASSWORD],
      );
    } finally {
      await c.end();
    }
  });

  const signIn = async (app: Awaited<ReturnType<typeof server>>) => {
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: EMAIL, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return cookieFrom(res);
  };

  it('signs in and sets a refresh cookie', async () => {
    const app = await server();
    try {
      const cookie = await signIn(app);
      expect(cookie).toMatch(/^flph_rt=/);
    } finally {
      await app.close();
    }
  });

  it('refreshes on a page reload', async () => {
    const app = await server();
    try {
      const cookie = await signIn(app);
      const res = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie } });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).accessToken).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it('keeps BOTH tabs signed in when they refresh at the same moment', async () => {
    // The regression that matters. Two tabs open on the permit board both wake
    // with no access token and refresh with the same cookie. Before the grace
    // window, one was told its session had expired and dumped the user back to
    // a sign-in screen mid-task.
    const app = await server();
    try {
      const cookie = await signIn(app);
      const [a, b] = await Promise.all([
        app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie } }),
        app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie } }),
      ]);
      expect(a.statusCode).toBe(200);
      expect(b.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('survives three tabs, which is an ordinary Tuesday', async () => {
    const app = await server();
    try {
      const cookie = await signIn(app);
      const results = await Promise.all(
        [1, 2, 3].map(() =>
          app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie } }),
        ),
      );
      expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    } finally {
      await app.close();
    }
  });

  it('destroys every session when a token is reused long after rotation', async () => {
    // The grace window must not become a hole. A token presented well after it
    // was rotated away was copied, so the response is to end every session for
    // that account -- including the one the thief is holding.
    const app = await server();
    try {
      const cookie = await signIn(app);

      const rotated = await app.inject({
        method: 'POST', url: '/api/auth/refresh', headers: { cookie },
      });
      expect(rotated.statusCode).toBe(200);
      const freshCookie = cookieFrom(rotated);

      // Age the revocation past the grace window.
      const c = client(ownerUrl!);
      await c.connect();
      try {
        await c.query(
          `update ocs.refresh_tokens set revoked_at = now() - interval '10 minutes'
            where revoked_at is not null
              and user_id = (select id from ocs.app_users where email = $1)`,
          [EMAIL],
        );
      } finally {
        await c.end();
      }

      const stolen = await app.inject({
        method: 'POST', url: '/api/auth/refresh', headers: { cookie },
      });
      expect(stolen.statusCode).toBe(401);

      // And the legitimate token is dead too: an account under suspicion signs
      // everyone out rather than leaving the thief with a working session.
      const after = await app.inject({
        method: 'POST', url: '/api/auth/refresh', headers: { cookie: freshCookie },
      });
      expect(after.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('refuses a refresh with no cookie at all', async () => {
    const app = await server();
    try {
      const res = await app.inject({ method: 'POST', url: '/api/auth/refresh' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

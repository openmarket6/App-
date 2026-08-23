/**
 * Four ways in that were open, and are not now.
 *
 * Found by red-teaming rather than by reading, which matters: every one of
 * these sits under a comment describing the protection it was supposed to
 * provide. The code said what it meant to do; it just did not do it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { dbConfigured, applyMigrations, client, ownerUrl, ALPHA } from './helpers/db.js';

const describeIfDb = dbConfigured ? describe : describe.skip;

const ADMIN = { email: 'hard-admin@test.invalid', password: 'HardAdmin2026!' };
const SUPER = { email: 'hard-super@test.invalid', password: 'HardSuper2026!' };
const VIEWER = { email: 'hard-viewer@test.invalid', password: 'HardViewer2026!' };

async function server() {
  process.env['AUTH_JWT_SECRET'] ||= 'test-access-secret-000000000000000000000000';
  process.env['AUTH_REFRESH_SECRET'] ||= 'test-refresh-secret-00000000000000000000000';
  const { buildServer } = await import('../src/index.js');
  const app = await buildServer();
  await app.ready();
  return app;
}

describeIfDb('authentication hardening', () => {
  beforeAll(async () => {
    await applyMigrations();
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query('create extension if not exists pgcrypto');
      await c.query('delete from ocs.companies where id = $1', [ALPHA]);
      await c.query(
        `insert into ocs.companies (id, name, email, status)
         values ($1,'Alpha Roofing','ana@alpha.test','active')`,
        [ALPHA],
      );
      await c.query('delete from ocs.app_users where email in ($1,$2,$3)',
        [ADMIN.email, SUPER.email, VIEWER.email]);
      await c.query(
        `insert into ocs.app_users (email, name, app_role, is_active, password_hash) values
           ($1,'Admin','ADMIN',true, crypt($2, gen_salt('bf',10))),
           ($3,'Supervisor','SITE_SUPERVISOR',true, crypt($4, gen_salt('bf',10))),
           ($5,'Viewer','VIEWER',true, crypt($6, gen_salt('bf',10)))`,
        [ADMIN.email, ADMIN.password, SUPER.email, SUPER.password, VIEWER.email, VIEWER.password],
      );
    } finally {
      await c.end();
    }
  });

  type App = Awaited<ReturnType<typeof server>>;
  const login = async (app: App, who: { email: string; password: string }) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: who });
    expect(res.statusCode, `${who.email}: ${res.body.slice(0, 200)}`).toBe(200);
    return JSON.parse(res.body).accessToken as string;
  };

  it('ends a session the moment its account is revoked', async () => {
    /*
     * token_version is described at the top of auth/native.ts as "the panic
     * switch: raising it invalidates every session". It was enforced on the
     * refresh path only. An access token carried no version, so nothing could
     * compare one, and a stolen token kept working for the rest of its fifteen
     * minutes — after the victim had done the one thing they are told to do.
     *
     * Fifteen minutes is long enough for a stolen ADMIN token to invite a
     * second ADMIN, which turns a window into permanent access.
     */
    const app = await server();
    try {
      const token = await login(app, ADMIN);
      const headers = { authorization: `Bearer ${token}` };

      const before = await app.inject({ method: 'GET', url: '/api/clients', headers });
      expect(before.statusCode, 'the token should work to begin with').toBe(200);

      // What every "sign out everywhere" action does.
      const c = client(ownerUrl!);
      await c.connect();
      try {
        await c.query(
          'update ocs.app_users set token_version = token_version + 1 where email = $1',
          [ADMIN.email],
        );
      } finally {
        await c.end();
      }

      const after = await app.inject({ method: 'GET', url: '/api/clients', headers });
      expect(
        after.statusCode,
        'the token still worked after every session was revoked',
      ).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('will not enrol a second factor on a stolen password alone', async () => {
    /*
     * Without this, somebody holding only the password enrols a factor of
     * their own — and the resulting session carries mfa: true, which is the
     * only thing requireNativeMfa checks. The guard written to stop an
     * attacker with a stolen password reaching municipal credentials would
     * have been satisfied by the attacker's own enrolment.
     */
    const app = await server();
    try {
      const headers = { authorization: `Bearer ${await login(app, ADMIN)}` };

      const noPassword = await app.inject({
        method: 'POST', url: '/api/auth/mfa/setup', payload: {}, headers,
      });
      expect(noPassword.statusCode).not.toBe(200);

      const wrongPassword = await app.inject({
        method: 'POST', url: '/api/auth/mfa/setup',
        payload: { currentPassword: 'not-the-password' }, headers,
      });
      expect(wrongPassword.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('will not let a supervisor commit the firm to an engagement', async () => {
    /*
     * Accepting supervision terms is the moment this firm's licence becomes
     * answerable for a job. Every non-CLIENT holder of supervision:read passed
     * with no company scoping at all — including the role whose own
     * description says it is "the account most likely to be left unlocked in a
     * truck".
     */
    const app = await server();
    try {
      const headers = { authorization: `Bearer ${await login(app, SUPER)}` };
      const res = await app.inject({
        method: 'POST',
        url: '/api/supervision/engagements/00000000-0000-4000-8000-000000000001/accept-terms',
        payload: {
          acknowledgement:
            'I understand that One Contractor Solutions qualifies and supervises this permitted work.',
        },
        headers,
      });
      // 403 for the role, not 404 for the id — the refusal must come before
      // the lookup, or a supervisor learns which engagement ids exist.
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).message).toMatch(/coordinator|administrator/i);
    } finally {
      await app.close();
    }
  });

  it('lets a read-only account read support, and not write to it', async () => {
    const app = await server();
    try {
      const headers = { authorization: `Bearer ${await login(app, VIEWER)}` };

      const read = await app.inject({ method: 'GET', url: '/api/support', headers });
      expect(read.statusCode, 'a viewer must still be able to read').toBe(200);

      const write = await app.inject({
        method: 'POST', url: '/api/support',
        payload: { clientId: ALPHA, subject: 'x', body: 'x' }, headers,
      });
      expect(write.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});

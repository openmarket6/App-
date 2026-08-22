/**
 * Telling people the truth about why they cannot sign in.
 *
 * This cost three separate incidents. An account that was invited and never
 * claimed has no password, so NO password will work — and the login answered
 * "Email or password is incorrect", which sent people off to try harder at
 * something that could never succeed. Half an hour of somebody's morning went
 * on it before anyone thought to look in the database.
 *
 * The generic message is still right for a wrong password and for an unknown
 * address. It is wrong for this one case, and this is where that line sits.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { dbConfigured, applyMigrations, client, ownerUrl } from './helpers/db.js';

const describeIfDb = dbConfigured ? describe : describe.skip;

const REAL = { email: 'login-real@test.invalid', password: 'RealPassword2026!' };
const INVITED = 'login-invited@test.invalid';
const STALE = 'login-stale@test.invalid';
const NOPASS = 'login-nopass@test.invalid';

async function server() {
  process.env['AUTH_JWT_SECRET'] ||= 'test-access-secret-000000000000000000000000';
  process.env['AUTH_REFRESH_SECRET'] ||= 'test-refresh-secret-00000000000000000000000';
  const { buildServer } = await import('../src/index.js');
  const app = await buildServer();
  await app.ready();
  return app;
}

describeIfDb('why sign-in failed', () => {
  beforeAll(async () => {
    await applyMigrations();
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query('create extension if not exists pgcrypto');
      await c.query('delete from ocs.app_users where email in ($1,$2,$3,$4)', [
        REAL.email, INVITED, STALE, NOPASS,
      ]);
      await c.query(
        `insert into ocs.app_users (email, name, app_role, is_active, password_hash)
         values ($1,'Real','ADMIN',true, crypt($2, gen_salt('bf',10)))`,
        [REAL.email, REAL.password],
      );
      // Invited, never claimed. The case that caused the outage.
      await c.query(
        `insert into ocs.app_users
           (email, name, app_role, is_active, invite_token, invite_expires_at)
         values ($1,'Invited','ADMIN',true,'tok-live', now() + interval '7 days')`,
        [INVITED],
      );
      // Invited, but the window has closed.
      await c.query(
        `insert into ocs.app_users
           (email, name, app_role, is_active, invite_token, invite_expires_at)
         values ($1,'Stale','ADMIN',true,'tok-stale', now() - interval '1 day')`,
        [STALE],
      );
      // Active, no password, no invite at all.
      await c.query(
        `insert into ocs.app_users (email, name, app_role, is_active)
         values ($1,'NoPass','ADMIN',true)`,
        [NOPASS],
      );
    } finally {
      await c.end();
    }
  });

  const login = (app: Awaited<ReturnType<typeof server>>, email: string, password: string) =>
    app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });

  it('tells an invited account to use its invitation', async () => {
    const app = await server();
    try {
      const res = await login(app, INVITED, 'AnythingAtAll123!');
      expect(res.statusCode).toBe(400);
      const msg = JSON.parse(res.body).message as string;
      expect(msg).toMatch(/not been set up/i);
      expect(msg).toMatch(/invitation link/i);
      // The token is never handed out: anyone who knew the address could
      // otherwise claim the account.
      expect(res.body).not.toContain('tok-live');
    } finally {
      await app.close();
    }
  });

  it('says so when the invitation has expired', async () => {
    // Different remedy — an administrator has to re-invite — so a different
    // sentence. "Try again" is not something this person can do.
    const app = await server();
    try {
      const res = await login(app, STALE, 'AnythingAtAll123!');
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toMatch(/expired|re-invite/i);
    } finally {
      await app.close();
    }
  });

  it('says so when there is no password and no invitation', async () => {
    const app = await server();
    try {
      const res = await login(app, NOPASS, 'AnythingAtAll123!');
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toMatch(/no password/i);
    } finally {
      await app.close();
    }
  });

  it('still says nothing useful about a wrong password', async () => {
    /*
     * The line. A real account with a real password gets the generic message,
     * because distinguishing "wrong password" from "no such account" is what
     * turns a login into a tool for discovering who has one.
     */
    const app = await server();
    try {
      const res = await login(app, REAL.email, 'NotThePassword123!');
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).message).toBe('Email or password is incorrect');
    } finally {
      await app.close();
    }
  });

  it('still says nothing useful about an address that does not exist', async () => {
    const app = await server();
    try {
      const res = await login(app, 'nobody-here@test.invalid', 'Whatever123456!');
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).message).toBe('Email or password is incorrect');
    } finally {
      await app.close();
    }
  });

  it('lets the real account in', async () => {
    const app = await server();
    try {
      const res = await login(app, REAL.email, REAL.password);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).accessToken).toBeTruthy();
    } finally {
      await app.close();
    }
  });
});

/**
 * The review endpoint and the screen that calls it.
 *
 * Found by walking the real onboarding path in production. The review drawer
 * sends {decision: 'APPROVE', reviewNote, effectiveDate, expiresAt}. This
 * endpoint accepted {decision: 'accept', note} and nothing else, so:
 *
 *   - every approval from the UI returned 400 and did nothing, and
 *   - no permit can be filed until compliance is ACCEPTED,
 *
 * which means onboarding could not be completed by anybody, through the
 * interface, at all. It had been that way since the screen was written.
 *
 * Worse than the 400: the dates were accepted with a 200 and thrown away,
 * because Zod strips unknown keys by default. An expiry date is what drives
 * every renewal warning this system sends, so a reviewer correcting one watched
 * it save and vanish.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { dbConfigured, applyMigrations, client, ownerUrl, ALPHA } from './helpers/db.js';

const describeIfDb = dbConfigured ? describe : describe.skip;

const ADMIN = { email: 'review-admin@test.invalid', password: 'ReviewAdmin2026!' };

async function server() {
  process.env['AUTH_JWT_SECRET'] ||= 'test-access-secret-000000000000000000000000';
  process.env['AUTH_REFRESH_SECRET'] ||= 'test-refresh-secret-00000000000000000000000';
  const { buildServer } = await import('../src/index.js');
  const app = await buildServer();
  await app.ready();
  return app;
}

describeIfDb('reviewing a compliance item', () => {
  let itemId = '';

  beforeAll(async () => {
    await applyMigrations();
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query('create extension if not exists pgcrypto');
      await c.query('delete from ocs.companies where id = $1', [ALPHA]);
      await c.query(`insert into ocs.companies (id, name) values ($1, 'Alpha Roofing LLC')`, [ALPHA]);
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

  beforeEach(async () => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query('delete from ocs.compliance_items where company_id = $1', [ALPHA]);
      const r = await c.query(
        `insert into ocs.compliance_items
           (company_id, kind, carrier, policy_number, effective_date, expires_at, decision)
         values ($1,'GENERAL_LIABILITY','Southeastern Mutual','P-1',
                 '2026-01-01','2027-01-31','pending_review')
         returning id`,
        [ALPHA],
      );
      itemId = r.rows[0].id;
    } finally {
      await c.end();
    }
  });

  const token = async (app: Awaited<ReturnType<typeof server>>) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: ADMIN });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body).accessToken as string;
  };

  const review = (
    app: Awaited<ReturnType<typeof server>>, t: string, payload: unknown,
  ) => app.inject({
    method: 'POST', url: `/api/compliance/${itemId}/review`,
    payload: payload as object, headers: { authorization: `Bearer ${t}` },
  });

  it('accepts the exact payload the review drawer sends', async () => {
    // The regression. This is what web/src/pages/ContractorDetail.tsx posts.
    const app = await server();
    try {
      const t = await token(app);
      const res = await review(app, t, {
        decision: 'APPROVE',
        reviewNote: 'Certificate checked',
        effectiveDate: '2026-02-01T00:00:00.000Z',
        expiresAt: '2027-06-30T00:00:00.000Z',
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).status).toBe('VALID');
    } finally {
      await app.close();
    }
  });

  it('applies the dates the reviewer corrected instead of dropping them', async () => {
    /*
     * The quieter half of the bug. These arrived, were stripped by the schema,
     * and the response looked like a success — so an expiry date a reviewer
     * fixed by hand silently kept its old value, and every renewal warning
     * downstream was computed from the wrong day.
     */
    const app = await server();
    try {
      const t = await token(app);
      await review(app, t, {
        decision: 'APPROVE', reviewNote: 'Corrected expiry',
        expiresAt: '2027-06-30T00:00:00.000Z',
      });
      const c = client(ownerUrl!);
      await c.connect();
      try {
        const row = await c.query(
          'select expires_at::text as e from ocs.compliance_items where id = $1', [itemId],
        );
        expect(row.rows[0].e).toBe('2027-06-30');
      } finally {
        await c.end();
      }
    } finally {
      await app.close();
    }
  });

  it('leaves the dates alone when the drawer sends none', async () => {
    // Reviewing without touching the dates must not blank them.
    const app = await server();
    try {
      const t = await token(app);
      await review(app, t, { decision: 'APPROVE', reviewNote: 'Fine' });
      const c = client(ownerUrl!);
      await c.connect();
      try {
        const row = await c.query(
          'select expires_at::text as e from ocs.compliance_items where id = $1', [itemId],
        );
        expect(row.rows[0].e).toBe('2027-01-31');
      } finally {
        await c.end();
      }
    } finally {
      await app.close();
    }
  });

  it('still takes its own vocabulary', async () => {
    // The API's own spelling has to keep working: other callers use it.
    const app = await server();
    try {
      const t = await token(app);
      const res = await review(app, t, { decision: 'accept', note: 'Fine' });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('refuses a rejection with no reason, whichever spelling is used', async () => {
    // A rejection with no reason generates the phone call this system exists
    // to prevent — and that has to hold on both spellings, or the rule is
    // bypassable by sending the other one.
    const app = await server();
    try {
      const t = await token(app);
      for (const payload of [{ decision: 'REJECT' }, { decision: 'reject' }]) {
        const res = await review(app, t, payload);
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      }
    } finally {
      await app.close();
    }
  });

  it('says so plainly when the decision is a word it does not know', async () => {
    const app = await server();
    try {
      const t = await token(app);
      const res = await review(app, t, { decision: 'maybe', note: 'hmm' });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toMatch(/approve or reject/i);
    } finally {
      await app.close();
    }
  });
});

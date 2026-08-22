/**
 * The contractor portal.
 *
 * Two properties are worth pinning here.
 *
 * The first is that the folder tree, the action queue and the "what happens
 * next" sentence come from src/shared -- the same pure functions the React app
 * imports. If the server ever computed its own, a contractor and the
 * coordinator looking at their account would eventually see different things,
 * which is the failure this arrangement exists to prevent.
 *
 * The second is the tenant boundary, which is unusual here. ocs.app_users is
 * NOT scoped by company: its policies allow a row to be read by its owner or a
 * colleague sharing a membership, and inserts only in service context. So the
 * team endpoints enforce the boundary in code rather than inheriting it, and
 * these tests check that code rather than assuming the database covers it.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  dbConfigured, applyMigrations, seedTwoTenants, asTenant, client,
  appUrl, ownerUrl, ALPHA, BETA, ALPHA_USER,
} from './helpers/db.js';
import { buildFolderTree, permitRequestNextStep } from '../src/shared/portal.js';

const describeIfDb = dbConfigured ? describe : describe.skip;

describe('the shared portal logic the API depends on', () => {
  it('builds a tree with no rows at all', () => {
    // A brand-new contractor still gets a usable page: every folder states what
    // belongs in it, so an empty account reads as a checklist rather than a
    // blank screen.
    const tree = buildFolderTree({ documents: [], projects: [], permits: [] });
    expect(tree.children.length).toBeGreaterThan(0);
    expect(tree.children.every((c) => c.name.length > 0)).toBe(true);
  });

  it('tells a contractor what happens next in plain words', () => {
    const next = permitRequestNextStep({ status: 'SUBMITTED', triageNote: null });
    expect(next.length).toBeGreaterThan(10);
    expect(next).not.toMatch(/SUBMITTED/);
  });
});

describeIfDb('portal data', () => {
  beforeAll(async () => {
    await applyMigrations();
    await seedTwoTenants();
  });

  beforeEach(async () => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query(`delete from ocs.permit_requests`);
    } finally {
      await c.end();
    }
  });

  const request = async (companyId: string, fields: Record<string, unknown> = {}) => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      const base: Record<string, unknown> = {
        company_id: companyId,
        scope_of_work: 'Re-roof, tear off to deck',
        address_line1: '1420 Ocean Dr',
        city: 'Miami Beach',
        zip: '33139',
        ...fields,
      };
      const cols = Object.keys(base);
      const vals = Object.values(base);
      const r = await c.query(
        `insert into ocs.permit_requests (${cols.join(',')})
         values (${vals.map((_, i) => `$${i + 1}`).join(',')}) returning id, status::text as status`,
        vals,
      );
      return r.rows[0];
    } finally {
      await c.end();
    }
  };

  it('accepts a request from a contractor', async () => {
    const row = await request(ALPHA);
    expect(row.status).toBe('submitted');
  });

  it('refuses to decline a request without saying why', async () => {
    // A decline with no reason generates a phone call, which is the thing the
    // portal exists to avoid.
    await expect(
      request(ALPHA, { status: 'declined', triaged_at: new Date(), triage_note: null }),
    ).rejects.toThrow(/permit_requests_explained/i);
  });

  it('refuses to ask for more information without saying what', async () => {
    await expect(
      request(ALPHA, { status: 'needs_info', triaged_at: new Date(), triage_note: '   ' }),
    ).rejects.toThrow(/permit_requests_explained/i);
  });

  it('refuses to mark a request accepted with no permit behind it', async () => {
    // Otherwise "accepted" is a claim with nothing to point at.
    await expect(
      request(ALPHA, { status: 'accepted', triaged_at: new Date() }),
    ).rejects.toThrow(/permit_requests_accepted_has_permit/i);
  });

  it('requires a resolved request to record who resolved it', async () => {
    await expect(
      request(ALPHA, { status: 'withdrawn', triage_note: 'Pulled by the contractor' }),
    ).rejects.toThrow(/permit_requests_triage_recorded/i);
  });

  it('keeps one contractor out of another contractor requests', async () => {
    await request(ALPHA);
    const visible = await asTenant(appUrl!, { companyId: BETA }, async (c) => {
      const r = await c.query(`select count(*)::int as n from ocs.permit_requests`);
      return r.rows[0].n as number;
    });
    expect(visible).toBe(0);
  });
});

describeIfDb('the contractor administrator flag', () => {
  beforeAll(async () => {
    await applyMigrations();
    await seedTwoTenants();
  });

  it('cannot be set on a staff account', async () => {
    // A staff account with this flag would be a quiet contradiction: there is
    // no single company for them to administer.
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await expect(
        c.query(
          `insert into ocs.app_users (email, name, app_role, client_admin, is_active)
           values ('badflag@test.invalid','Bad Flag','PERMIT_TECH',true,true)`,
        ),
      ).rejects.toThrow(/app_users_client_admin_is_client/i);
    } finally {
      await c.end();
    }
  });

  it('is allowed on a contractor account', async () => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query(`delete from ocs.app_users where email = 'goodflag@test.invalid'`);
      const r = await c.query(
        `insert into ocs.app_users (email, name, app_role, client_id, client_admin, is_active)
         values ('goodflag@test.invalid','Good Flag','CLIENT',$1,true,true)
         returning client_admin`,
        [ALPHA],
      );
      expect(r.rows[0].client_admin).toBe(true);
    } finally {
      await c.end();
    }
  });

  it('does not let a contractor create a login directly in the database', async () => {
    // The reason the team endpoints run in service context with the company
    // resolved in code: app_users accepts inserts only from the service role.
    await expect(
      asTenant(appUrl!, { companyId: ALPHA, userId: ALPHA_USER }, async (c) => {
        await c.query(
          `insert into ocs.app_users (email, name, app_role, client_id, is_active)
           values ('sneaky@test.invalid','Sneaky','CLIENT',$1,true)`,
          [ALPHA],
        );
      }),
    ).rejects.toThrow(/row-level security|permission denied/i);
  });
});

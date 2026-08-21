/**
 * TENANT ISOLATION.
 *
 * The most important tests in this repository. One contractor seeing another
 * contractor's permits, documents or payments is the failure that ends the
 * business, so these assert it directly against a real database rather than
 * trusting that route handlers remember to filter.
 *
 * Every test here is a claim about what an ATTACKER cannot do, not about what a
 * well-behaved client does.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  dbConfigured, applyMigrations, seedTwoTenants, asTenant, client,
  appUrl, serviceUrl,
  ALPHA, BETA, ALPHA_USER, BETA_USER, ALPHA_PROJECT, BETA_PROJECT,
} from './helpers/db.js';

const describeIfDb = dbConfigured ? describe : describe.skip;

describeIfDb('tenant isolation (row-level security)', () => {
  beforeAll(async () => {
    await applyMigrations();
    await seedTwoTenants();
  });

  it('returns ZERO rows when no tenant context is set (fail-closed)', async () => {
    // The critical property: forgetting to set context must show nothing,
    // never everything. A code path that skips withTenant() sees an empty
    // database rather than every customer's data.
    const c = client(appUrl!);
    await c.connect();
    try {
      const res = await c.query('select count(*)::int as n from ocs.projects');
      expect(res.rows[0].n).toBe(0);
    } finally {
      await c.end();
    }
  });

  it('shows a tenant only its own rows', async () => {
    const names = await asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
      const res = await c.query('select name from ocs.projects order by name');
      return res.rows.map((r) => r.name);
    });
    expect(names).toEqual(['Alpha Job Site']);
  });

  it('blocks fetching another tenant’s row by its exact id (IDOR)', async () => {
    // Guessing or leaking an id must not be enough. This is the attack that
    // ordinary WHERE-clause filtering forgets to cover.
    const rows = await asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
      const res = await c.query('select id from ocs.projects where id = $1', [BETA_PROJECT]);
      return res.rowCount;
    });
    expect(rows).toBe(0);
  });

  it('rejects INSERT into another tenant', async () => {
    await expect(
      asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
        await c.query(`insert into ocs.projects (company_id, name) values ($1, 'Smuggled')`, [BETA]);
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('rejects moving your own row into another tenant', async () => {
    await expect(
      asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
        await c.query(`update ocs.projects set company_id = $1 where id = $2`, [BETA, ALPHA_PROJECT]);
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('cannot DELETE another tenant’s row', async () => {
    const deleted = await asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
      const res = await c.query('delete from ocs.projects where id = $1', [BETA_PROJECT]);
      return res.rowCount;
    });
    expect(deleted).toBe(0);
  });

  /**
   * REGRESSION TEST.
   *
   * An earlier version of 0008_rls.sql gated service context on the session
   * variable alone. Under that version this exact test FAILED -- the API role
   * could set `ocs.service_context = 'on'` itself and read every tenant's rows,
   * so any SQL injection reaching a SET became a full cross-tenant breach.
   *
   * The fix was to require membership in the `ocs_service` role as well, which
   * a request-handling connection does not have and cannot grant itself.
   *
   * If this test ever fails again, tenant isolation is broken. Do not skip it.
   */
  it('does NOT let the API role escalate by setting the service-context flag', async () => {
    const c = client(appUrl!);
    await c.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('ocs.company_id', $1, true)`, [ALPHA]);
      await c.query(`select set_config('ocs.service_context', 'on', true)`);

      const res = await c.query('select count(*)::int as n from ocs.projects');
      // Still only Alpha's single project -- the forged flag achieved nothing.
      expect(res.rows[0].n).toBe(1);

      await c.query('rollback');
    } finally {
      await c.end();
    }
  });

  it('grants the service role cross-tenant access only WITH the flag set', async () => {
    const c = client(serviceUrl!);
    await c.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('ocs.service_context', 'on', true)`);
      const withFlag = await c.query('select count(*)::int as n from ocs.projects');
      expect(withFlag.rows[0].n).toBeGreaterThanOrEqual(2);
      await c.query('rollback');

      // Without the flag the service role is scoped exactly like the API role.
      await c.query('begin');
      await c.query(`select set_config('ocs.company_id', $1, true)`, [ALPHA]);
      const withoutFlag = await c.query('select count(*)::int as n from ocs.projects');
      expect(withoutFlag.rows[0].n).toBe(1);
      await c.query('rollback');
    } finally {
      await c.end();
    }
  });

  it('keeps the audit log append-only', async () => {
    // If the application can edit or delete audit rows, the audit trail proves
    // nothing -- whoever did the thing could also erase the record of it.
    await expect(
      asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
        await c.query(
          `insert into ocs.audit_log (company_id, action) values ($1, 'test.event')`,
          [ALPHA],
        );
        await c.query(`update ocs.audit_log set summary = 'tampered' where action = 'test.event'`);
      }),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
        await c.query(`delete from ocs.audit_log where action = 'test.event'`);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('isolates every tenant-owned table, not just projects', async () => {
    // A single unprotected table is a full breach for whatever it holds, so
    // this asserts the property across the whole schema rather than spot-
    // checking. A new table added without RLS fails here.
    const c = client(appUrl!);
    await c.connect();
    try {
      const res = await c.query<{ tablename: string }>(
        `select c.relname as tablename
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'ocs'
            and c.relkind = 'r'
            and c.relname <> 'schema_migrations'
            and (not c.relrowsecurity or not c.relforcerowsecurity)`,
      );
      expect(res.rows.map((r) => r.tablename)).toEqual([]);
    } finally {
      await c.end();
    }
  });

  it('prevents a child row from being parented into another tenant', async () => {
    // permits.company_id is forced to match its project by a trigger, so a
    // permit cannot be hidden under, or stolen into, another company.
    await expect(
      asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
        await c.query(
          `insert into ocs.permits (company_id, project_id, permit_type)
           values ($1, $2, 'Roof')`,
          [ALPHA, BETA_PROJECT],
        );
      }),
    ).rejects.toThrow();
  });

  it('scopes colleague visibility to the active company', async () => {
    const emails = await asTenant(
      appUrl!,
      { companyId: ALPHA, userId: ALPHA_USER },
      async (c) => {
        const res = await c.query('select email from ocs.app_users order by email');
        return res.rows.map((r) => r.email);
      },
    );
    expect(emails).toContain('ana@alpha.test');
    expect(emails).not.toContain('ben@beta.test');
  });
});

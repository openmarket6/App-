/**
 * Database-enforced business rules.
 *
 * These are invariants held by triggers and constraints rather than by
 * application code, so they survive a new code path that forgets them.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  dbConfigured, applyMigrations, seedTwoTenants, asTenant, client,
  appUrl, ownerUrl, ALPHA, ALPHA_PROJECT,
} from './helpers/db.js';

const describeIfDb = dbConfigured ? describe : describe.skip;

describeIfDb('business rules enforced by the database', () => {
  beforeAll(async () => {
    await applyMigrations();
    await seedTwoTenants();
  });

  it('records permit status history automatically', async () => {
    const history = await asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
      const inserted = await c.query(
        `insert into ocs.permits (company_id, project_id, permit_type)
         values ($1, $2, 'Roof Replacement') returning id`,
        [ALPHA, ALPHA_PROJECT],
      );
      const permitId = inserted.rows[0].id;

      await c.query(`update ocs.permits set status = 'ready_to_submit' where id = $1`, [permitId]);
      await c.query(`update ocs.permits set status = 'submitted' where id = $1`, [permitId]);

      const res = await c.query(
        `select from_status::text, to_status::text from ocs.permit_status_history
          where permit_id = $1 order by id`,
        [permitId],
      );
      return res.rows;
    });

    // Written by a trigger, so no code path can change a status without
    // leaving a record of it.
    expect(history).toEqual([
      { from_status: null, to_status: 'draft' },
      { from_status: 'draft', to_status: 'ready_to_submit' },
      { from_status: 'ready_to_submit', to_status: 'submitted' },
    ]);
  });

  it('refuses to create a cycle in the folder tree', async () => {
    await expect(
      asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
        const a = await c.query(
          `insert into ocs.folders (company_id, project_id, name) values ($1,$2,'A') returning id`,
          [ALPHA, ALPHA_PROJECT],
        );
        const b = await c.query(
          `insert into ocs.folders (company_id, parent_id, name) values ($1,$2,'B') returning id`,
          [ALPHA, a.rows[0].id],
        );
        // Make A a child of its own descendant.
        await c.query(`update ocs.folders set parent_id = $1 where id = $2`, [
          b.rows[0].id,
          a.rows[0].id,
        ]);
      }),
    ).rejects.toThrow(/cycle/i);
  });

  it('numbers projects per company, starting at 1 for each', async () => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      const alpha = await c.query(
        `select project_number from ocs.projects where company_id = $1 order by project_number`,
        [ALPHA],
      );
      const beta = await c.query(
        `select project_number from ocs.projects where company_id = $1 order by project_number`,
        ['22222222-2222-2222-2222-222222222222'],
      );
      // Each contractor sees their own 1, 2, 3... A global sequence would leak
      // how many customers the platform has and how active they are.
      expect(alpha.rows[0].project_number).toBe(1);
      expect(beta.rows[0].project_number).toBe(1);
    } finally {
      await c.end();
    }
  });

  it('assigns distinct project numbers under concurrent inserts', async () => {
    // The advisory lock in assign_project_number() is what makes this hold.
    // Without it two simultaneous inserts both read max()+1 and collide.
    const inserts = Array.from({ length: 8 }, (_, i) =>
      (async () => {
        const c = client(appUrl!);
        await c.connect();
        try {
          await c.query('begin');
          await c.query(`select set_config('ocs.company_id', $1, true)`, [ALPHA]);
          const res = await c.query(
            `insert into ocs.projects (company_id, name) values ($1, $2)
             returning project_number`,
            [ALPHA, `Concurrent ${i}`],
          );
          await c.query('commit');
          return res.rows[0].project_number as number;
        } finally {
          await c.end();
        }
      })(),
    );

    const numbers = await Promise.all(inserts);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('keeps a permit’s company locked to its project', async () => {
    const companyId = await asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
      const res = await c.query(
        `insert into ocs.permits (company_id, project_id, permit_type)
         values ($1, $2, 'Electrical') returning company_id`,
        [ALPHA, ALPHA_PROJECT],
      );
      return res.rows[0].company_id;
    });
    expect(companyId).toBe(ALPHA);
  });

  it('rejects a refund larger than the payment', async () => {
    await expect(
      asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
        await c.query(
          `insert into ocs.payments
             (company_id, amount_cents, amount_refunded_cents, currency)
           values ($1, 1000, 2000, 'usd')`,
          [ALPHA],
        );
      }),
    ).rejects.toThrow(/payments_refund_within_amount/i);
  });

  it('allows only one primary qualifier per company', async () => {
    await expect(
      asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
        await c.query(
          `insert into ocs.qualifiers (company_id, full_name, is_primary)
           values ($1, 'First Qualifier', true), ($1, 'Second Qualifier', true)`,
          [ALPHA],
        );
      }),
    ).rejects.toThrow(/qualifiers_one_primary/i);
  });

  it('deduplicates jobs sharing a dedupe key', async () => {
    const count = await asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
      for (let i = 0; i < 3; i++) {
        await c.query(
          `insert into ocs.jobs (company_id, job_type, dedupe_key)
           values ($1, 'permit.status_check', 'permit_check:same')
           on conflict (queue, dedupe_key)
             where dedupe_key is not null and status in ('queued','running','failed')
             do nothing`,
          [ALPHA],
        );
      }
      const res = await c.query(
        `select count(*)::int as n from ocs.jobs where dedupe_key = 'permit_check:same'`,
      );
      return res.rows[0].n;
    });
    // An hourly sweep running while the previous one is still working must not
    // pile up duplicate checks for the same permit.
    expect(count).toBe(1);
  });
});

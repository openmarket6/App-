/**
 * Corrections and inspections: the two clocks a permit runs on.
 *
 * Both record the same kind of event -- an authority looked at the work and was
 * not satisfied -- and both are expensive, so the rules below exist to make the
 * count of them impossible to understate. Every one of these is enforced in the
 * database rather than in a route handler, which is what makes them true no
 * matter which code path did the writing: a route, the background worker, or a
 * hand-run query during an incident.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  dbConfigured, applyMigrations, seedTwoTenants, asTenant, client,
  appUrl, ownerUrl, ALPHA, BETA, ALPHA_PROJECT, BETA_PROJECT,
} from './helpers/db.js';

const describeIfDb = dbConfigured ? describe : describe.skip;

const ALPHA_PERMIT = 'cccc1111-0000-0000-0000-000000000001';
const ALPHA_CLOSED = 'cccc1111-0000-0000-0000-000000000002';
const BETA_PERMIT = 'cccc2222-0000-0000-0000-000000000003';

describeIfDb('correction cycles', () => {
  beforeAll(async () => {
    await applyMigrations();
    await seedTwoTenants();

    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query(
        `insert into ocs.permits (id, company_id, project_id, permit_type, status)
         values ($1, $2, $3, 'reroof', 'submitted'),
                ($4, $2, $3, 'reroof', 'closed'),
                ($5, $6, $7, 'reroof', 'submitted')`,
        [ALPHA_PERMIT, ALPHA, ALPHA_PROJECT, ALPHA_CLOSED, BETA_PERMIT, BETA, BETA_PROJECT],
      );
    } finally {
      await c.end();
    }
  });

  const logCorrection = (permitId: string, body: string) =>
    asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
      const inserted = await c.query(
        `insert into ocs.permit_corrections (permit_id, body) values ($1, $2)
         returning cycle`,
        [permitId, body],
      );
      const permit = await c.query(
        `select status::text as status, correction_cycles from ocs.permits where id = $1`,
        [permitId],
      );
      return { cycle: inserted.rows[0].cycle, permit: permit.rows[0] };
    });

  it('numbers cycles from one and keeps counting', async () => {
    // The cycle number is assigned by the database, not the caller. A caller
    // that could choose it could also reset it, and the count of cycles is the
    // sharpest available measure of how well a filing was prepared.
    const result = await asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
      const first = await c.query(
        `insert into ocs.permit_corrections (permit_id, body)
         values ($1, 'Missing truss layout') returning cycle`,
        [ALPHA_PERMIT],
      );
      const second = await c.query(
        `insert into ocs.permit_corrections (permit_id, body)
         values ($1, 'Wind load calcs unsigned') returning cycle`,
        [ALPHA_PERMIT],
      );
      const permit = await c.query(
        `select status::text as status, correction_cycles from ocs.permits where id = $1`,
        [ALPHA_PERMIT],
      );
      return { first: first.rows[0].cycle, second: second.rows[0].cycle, permit: permit.rows[0] };
    });

    expect(result.first).toBe(1);
    expect(result.second).toBe(2);
    expect(result.permit.correction_cycles).toBe(2);
    expect(result.permit.status).toBe('corrections_required');
  });

  it('moves an open permit into corrections_required', async () => {
    const { permit } = await logCorrection(ALPHA_PERMIT, 'Roof deck nailing pattern');
    expect(permit.status).toBe('corrections_required');
  });

  it('does not drag a closed permit back open', async () => {
    // A late-arriving correction on a finished job is a record to keep, not a
    // reason to reopen it. Recording the comment and reopening the permit are
    // separate decisions, and only the first one is automatic.
    const { permit, cycle } = await logCorrection(ALPHA_CLOSED, 'Filed after closeout');
    expect(cycle).toBe(1);
    expect(permit.status).toBe('closed');
    expect(permit.correction_cycles).toBe(1);
  });

  it('confines corrections to the tenant that owns the permit', async () => {
    // company_id on a correction is derived from its permit, so a correction
    // cannot be filed into someone else's account even by naming their permit.
    await expect(
      asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
        await c.query(
          `insert into ocs.permit_corrections (permit_id, body)
           values ($1, 'Cross-tenant write')`,
          [BETA_PERMIT],
        );
      }),
    ).rejects.toThrow();
  });
});

describeIfDb('inspections', () => {
  beforeAll(async () => {
    await applyMigrations();
    await seedTwoTenants();

    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query(
        `insert into ocs.permits (id, company_id, project_id, permit_type, status)
         values ($1, $2, $3, 'reroof', 'issued'),
                ($4, $5, $6, 'reroof', 'issued')`,
        [ALPHA_PERMIT, ALPHA, ALPHA_PROJECT, BETA_PERMIT, BETA, BETA_PROJECT],
      );
    } finally {
      await c.end();
    }
  });

  const schedule = (c: import('pg').Client, permitId: string, type = 'sheathing') =>
    c
      .query(
        `insert into ocs.permit_inspections (permit_id, inspection_type, scheduled_for)
         values ($1, $2, now() - interval '1 hour') returning id`,
        [permitId, type],
      )
      .then((r) => r.rows[0].id as string);

  it('links a re-inspection to the attempt it repeats', async () => {
    const chain = await asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
      const first = await schedule(c, ALPHA_PERMIT);
      await c.query(`update ocs.permit_inspections set result = 'failed' where id = $1`, [first]);
      const second = await c.query(
        `insert into ocs.permit_inspections
           (permit_id, inspection_type, scheduled_for, reinspection_of_id)
         values ($1, 'sheathing', now() + interval '3 days', $2) returning id`,
        [ALPHA_PERMIT, first],
      );
      return { first, second: second.rows[0].id };
    });
    expect(chain.second).toBeTruthy();
  });

  it('refuses a re-inspection on a different permit', async () => {
    // Without this the attempt chain could span two jobs and the count of
    // attempts on either one would be wrong in both directions.
    await expect(
      asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
        const other = await schedule(c, ALPHA_PERMIT, 'final');
        const secondPermit = await c.query(
          `insert into ocs.permits (company_id, project_id, permit_type, status)
           values ($1, $2, 'plumbing', 'issued') returning id`,
          [ALPHA, ALPHA_PROJECT],
        );
        await c.query(
          `insert into ocs.permit_inspections
             (permit_id, inspection_type, reinspection_of_id)
           values ($1, 'final', $2)`,
          [secondPermit.rows[0].id, other],
        );
      }),
    ).rejects.toThrow(/same permit/i);
  });

  it('refuses to record a result on an inspection still in the future', async () => {
    // A result describes something that already happened. Allowing a future
    // date would let "passed" be recorded before anyone visited the site --
    // exactly the claim this business cannot afford to have unfounded.
    await expect(
      asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
        const future = await c.query(
          `insert into ocs.permit_inspections (permit_id, inspection_type, scheduled_for)
           values ($1, 'final', now() + interval '10 days') returning id`,
          [ALPHA_PERMIT],
        );
        await c.query(`update ocs.permit_inspections set result = 'passed' where id = $1`, [
          future.rows[0].id,
        ]);
      }),
    ).rejects.toThrow(/inspections_completed_not_future/i);
  });

  it('derives the tenant from the permit, not from the caller', async () => {
    await expect(
      asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
        await c.query(
          `insert into ocs.permit_inspections (permit_id, inspection_type)
           values ($1, 'final')`,
          [BETA_PERMIT],
        );
      }),
    ).rejects.toThrow();
  });

  it('keeps one tenant from reading another tenant inspections', async () => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query(
        `insert into ocs.permit_inspections (permit_id, inspection_type, scheduled_for)
         values ($1, 'beta-only', now() - interval '2 hours')`,
        [BETA_PERMIT],
      );
    } finally {
      await c.end();
    }

    const visible = await asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
      const r = await c.query(
        `select count(*)::int as n from ocs.permit_inspections where inspection_type = 'beta-only'`,
      );
      return r.rows[0].n as number;
    });
    expect(visible).toBe(0);
  });
});

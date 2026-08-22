/**
 * Support tickets.
 *
 * One rule dominates this area: what staff say to each other about a contractor
 * must never reach that contractor. Internal notes are candid by design -- "this
 * client keeps sending the same wrong drawings", "waive it, they are threatening
 * to leave" -- and a leak is a business catastrophe rather than a bug report.
 *
 * These tests go through the DATABASE rather than the routes wherever possible,
 * because that is where the rule is enforced. A test that only proved the route
 * filtered correctly would still pass on the day someone adds a second route
 * that forgets to.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  dbConfigured, applyMigrations, seedTwoTenants, asTenant, client,
  appUrl, ownerUrl, ALPHA, BETA, ALPHA_USER,
} from './helpers/db.js';

const describeIfDb = dbConfigured ? describe : describe.skip;

describeIfDb('support tickets', () => {
  let ticketId: string;

  beforeAll(async () => {
    await applyMigrations();
    await seedTwoTenants();

    const c = client(ownerUrl!);
    await c.connect();
    try {
      const t = await c.query(
        `insert into ocs.support_tickets (company_id, subject, opened_by)
         values ($1, 'Broward re-roof stuck', $2) returning id`,
        [ALPHA, ALPHA_USER],
      );
      ticketId = t.rows[0].id;

      await c.query(
        `insert into ocs.support_messages
           (ticket_id, company_id, author_user_id, body, is_internal, is_opening)
         values ($1, $2, $3, 'We are chasing the county today.', false, true),
                ($1, $2, $3, 'They keep sending the same wrong drawings.', true, false)`,
        [ticketId, ALPHA, ALPHA_USER],
      );
    } finally {
      await c.end();
    }
  });

  it('hides internal notes from the contractor', async () => {
    // The test this whole file exists for.
    const visible = await asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
      const r = await c.query(`select body, is_internal from ocs.support_messages`);
      return r.rows as Array<{ body: string; is_internal: boolean }>;
    });

    expect(visible).toHaveLength(1);
    expect(visible[0]!.is_internal).toBe(false);
    expect(visible.map((m) => m.body).join(' ')).not.toContain('wrong drawings');
  });

  it('shows both kinds to staff', async () => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      const r = await c.query(`select count(*)::int as n from ocs.support_messages`);
      expect(r.rows[0].n).toBe(2);
    } finally {
      await c.end();
    }
  });

  it('refuses to let a contractor WRITE an internal note', async () => {
    // Without this, a portal user could post a note, watch it disappear from
    // their own view, and use the endpoint to slip messages into a staff
    // conversation they cannot otherwise reach.
    await expect(
      asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
        await c.query(
          `insert into ocs.support_messages (ticket_id, company_id, author_user_id, body, is_internal)
           values ($1, $2, $3, 'sneaky', true)`,
          [ticketId, ALPHA, ALPHA_USER],
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('keeps one contractor out of another contractor tickets', async () => {
    const visible = await asTenant(appUrl!, { companyId: BETA }, async (c) => {
      const r = await c.query(`select count(*)::int as n from ocs.support_tickets`);
      return r.rows[0].n as number;
    });
    expect(visible).toBe(0);
  });

  it('does not move a ticket on its opening message', async () => {
    // A brand-new ticket is OPEN. Advancing on the first message would mark it
    // "waiting on the client" the moment staff raise one for a contractor, or
    // "in progress" before anybody has read it.
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query('begin');
      const t = await c.query(
        `insert into ocs.support_tickets (company_id, subject, opened_by)
         values ($1, 'Fresh ticket', $2) returning id`,
        [ALPHA, ALPHA_USER],
      );
      await c.query(
        `insert into ocs.support_messages
           (ticket_id, company_id, author_user_id, body, is_opening)
         values ($1, $2, $3, 'Opening text', true)`,
        [t.rows[0].id, ALPHA, ALPHA_USER],
      );
      const after = await c.query(
        `select status::text as status from ocs.support_tickets where id = $1`,
        [t.rows[0].id],
      );
      expect(after.rows[0].status).toBe('open');
      await c.query('rollback');
    } finally {
      await c.end();
    }
  });

  it('does not move a ticket on an internal note', async () => {
    // Staff talking to each other does not move the ball. Marking a ticket
    // "waiting on client" over a note the client cannot see would strand it.
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query('begin');
      await c.query(
        `insert into ocs.support_messages (ticket_id, company_id, author_user_id, body, is_internal)
         values ($1, $2, $3, 'Internal only', true)`,
        [ticketId, ALPHA, ALPHA_USER],
      );
      const after = await c.query(
        `select status::text as status from ocs.support_tickets where id = $1`,
        [ticketId],
      );
      expect(after.rows[0].status).toBe('open');
      await c.query('rollback');
    } finally {
      await c.end();
    }
  });

  it('reopens a resolved ticket when someone writes again', async () => {
    // A resolved ticket receiving a new message was evidently not finished.
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query('begin');
      await c.query(
        `update ocs.support_tickets set status='resolved', resolved_at=now() where id=$1`,
        [ticketId],
      );
      await c.query(
        `insert into ocs.support_messages (ticket_id, company_id, author_user_id, body)
         values ($1, $2, $3, 'Actually it is still stuck.')`,
        [ticketId, ALPHA, ALPHA_USER],
      );
      const after = await c.query(
        `select status::text as status, resolved_at from ocs.support_tickets where id = $1`,
        [ticketId],
      );
      expect(after.rows[0].status).not.toBe('resolved');
      expect(after.rows[0].resolved_at).toBeNull();
      await c.query('rollback');
    } finally {
      await c.end();
    }
  });

  it('will not let a resolved ticket lose its resolution time', async () => {
    // A CHECK constraint keeps the two in step, so a ticket can never be
    // resolved with no record of when.
    await expect(
      (async () => {
        const c = client(ownerUrl!);
        await c.connect();
        try {
          await c.query(
            `insert into ocs.support_tickets (company_id, subject, status, resolved_at)
             values ($1, 'Bad state', 'resolved', null)`,
            [ALPHA],
          );
        } finally {
          await c.end();
        }
      })(),
    ).rejects.toThrow(/tickets_resolved_at_matches_status/i);
  });

  it('allows only one opening message per ticket', async () => {
    // Two would mean two different accounts of what the ticket is about.
    await expect(
      (async () => {
        const c = client(ownerUrl!);
        await c.connect();
        try {
          await c.query(
            `insert into ocs.support_messages
               (ticket_id, company_id, author_user_id, body, is_opening)
             values ($1, $2, $3, 'A second opening', true)`,
            [ticketId, ALPHA, ALPHA_USER],
          );
        } finally {
          await c.end();
        }
      })(),
    ).rejects.toThrow(/support_messages_one_opening/i);
  });

  it('gives every ticket a reference a person can read out', async () => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      const r = await c.query(`select reference from ocs.support_tickets where id = $1`, [ticketId]);
      expect(r.rows[0].reference).toMatch(/^TKT-\d{6}$/);
    } finally {
      await c.end();
    }
  });
});

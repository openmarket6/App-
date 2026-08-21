/**
 * The public demo form: the only place a stranger can write to this database.
 *
 * That makes it the one table where the interesting property is not tenant
 * isolation but direction. A visitor must be able to put a row in and must
 * never be able to get one back out -- otherwise the form on the marketing site
 * becomes a way to enumerate every contractor who has enquired, including their
 * names, phone numbers and what they said about their business.
 *
 * These tests pin that one-way boundary at the database level, where it is
 * enforced, rather than in the route that happens to call it today.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { dbConfigured, applyMigrations, client, appUrl, ownerUrl } from './helpers/db.js';

const describeIfDb = dbConfigured ? describe : describe.skip;

/** As the API serves an anonymous visitor: ocs_app, with no context set. */
async function asVisitor<T>(fn: (c: import('pg').Client) => Promise<T>): Promise<T> {
  const c = client(appUrl!);
  await c.connect();
  try {
    await c.query('begin');
    const result = await fn(c);
    await c.query('rollback');
    return result;
  } finally {
    await c.end();
  }
}

const submit = (c: import('pg').Client, email: string, company = 'Gulf Coast Roofing') =>
  c.query(
    `select ocs.submit_demo_request($1, $2, $3, null, null, null, null, null,
                                    '/demo', null, null, null, 10) as id`,
    [company, 'Dana Reyes', email],
  );

describeIfDb('public demo requests', () => {
  beforeAll(async () => {
    await applyMigrations();
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query(`delete from ocs.demo_requests where email like '%@test.invalid'`);
    } finally {
      await c.end();
    }
  });

  it('lets an anonymous visitor submit the form', async () => {
    const id = await asVisitor(async (c) => {
      const r = await submit(c, 'new@test.invalid');
      return r.rows[0].id as string;
    });
    expect(id).toBeTruthy();
  });

  it('never lets that visitor read a lead back', async () => {
    // The whole point. If this ever returns rows, the marketing form has become
    // a directory of everyone who has enquired.
    await expect(
      asVisitor(async (c) => {
        await submit(c, 'reader@test.invalid');
        return c.query(`select email from ocs.demo_requests`);
      }),
    ).resolves.toMatchObject({ rowCount: 0 });
  });

  it('refuses a direct insert, so the function is the only way in', async () => {
    // There is no INSERT grant and no INSERT policy. A future route that tries
    // to bypass the function fails here rather than quietly working with the
    // wrong privileges.
    await expect(
      asVisitor(async (c) => {
        await c.query(
          `insert into ocs.demo_requests (company_name, contact_name, email)
           values ('Direct', 'Direct', 'direct@test.invalid')`,
        );
      }),
    ).rejects.toThrow(/permission denied|row-level security/i);
  });

  it('refuses a status change by a visitor', async () => {
    const owner = client(ownerUrl!);
    await owner.connect();
    let id: string;
    try {
      const r = await owner.query(
        `insert into ocs.demo_requests (company_name, contact_name, email)
         values ('Target', 'Target', 'target@test.invalid') returning id`,
      );
      id = r.rows[0].id;
    } finally {
      await owner.end();
    }

    const changed = await asVisitor(async (c) => {
      const r = await c.query(`update ocs.demo_requests set status = 'won' where id = $1`, [id]);
      return r.rowCount;
    });
    // No error, no effect: the update policy simply matches no rows.
    expect(changed).toBe(0);
  });

  it('collapses a rapid resubmission into one lead', async () => {
    // Someone double-clicking Send should not become two leads for sales to
    // work. The address is matched case-insensitively, because a person
    // retyping their email does not reproduce their own capitalisation.
    const ids = await asVisitor(async (c) => {
      const first = await submit(c, 'dupe@test.invalid');
      const second = await submit(c, 'DUPE@Test.Invalid');
      return [first.rows[0].id, second.rows[0].id];
    });
    expect(ids[0]).toBe(ids[1]);
  });

  it('treats a submission outside the window as a new lead', async () => {
    // The same company enquiring again months later is a real second lead.
    // Refusing it would lose a customer, so the guard is a window, not a
    // unique constraint.
    const ids = await asVisitor(async (c) => {
      const first = await c.query(
        `select ocs.submit_demo_request('Later Co', 'Dana', 'later@test.invalid',
           null, null, null, null, null, '/demo', null, null, null, 10) as id`,
      );
      const second = await c.query(
        `select ocs.submit_demo_request('Later Co', 'Dana', 'later@test.invalid',
           null, null, null, null, null, '/demo', null, null, null, 0) as id`,
      );
      return [first.rows[0].id, second.rows[0].id];
    });
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('normalises the address it stores', async () => {
    // Trimmed and lowercased on the way in, so the duplicate check above sees
    // "A@x.com " and "a@x.com" as one person rather than two leads.
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query('begin');
      const r = await c.query(
        `insert into ocs.demo_requests (company_name, contact_name, email)
         values ('  Spaced Co  ', '  Dana  ', '  MiXeD@Test.Invalid  ')
         returning email, company_name as "companyName", contact_name as "contactName"`,
      );
      expect(r.rows[0].email).toBe('mixed@test.invalid');
      expect(r.rows[0].companyName).toBe('Spaced Co');
      expect(r.rows[0].contactName).toBe('Dana');
      await c.query('rollback');
    } finally {
      await c.end();
    }
  });
});

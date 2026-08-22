/**
 * Engineering: the quote gate and the seal.
 *
 * Two rules carry real weight here.
 *
 * Work does not start before the quote is approved. That is what prevents the
 * argument where work is done, an invoice is sent, and the contractor says they
 * never agreed to the price.
 *
 * And a seal is a professional act, not a file property. When an engineer seals
 * a drawing they stake their own licence on the statement that it is sound, so
 * it is treated like the notarial record in 0019: licence details copied onto
 * the record, an expired licence refused, and no rewriting afterwards.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  dbConfigured, applyMigrations, seedTwoTenants, asTenant, client,
  appUrl, ownerUrl, ALPHA, BETA,
} from './helpers/db.js';
import { ROLES, ROLE_CAPABILITIES, can } from '../src/domain/capabilities.js';

const describeIfDb = dbConfigured ? describe : describe.skip;

const DOC = 'eeee3333-0000-0000-0000-000000000001';

describe('the engineer role', () => {
  it('exists, and is staff', () => {
    expect(ROLES).toContain('ENGINEER');
    expect(ROLE_CAPABILITIES.ENGINEER.length).toBeGreaterThan(0);
  });

  it('can produce, quote and seal', () => {
    expect(can('ENGINEER', 'drafting:produce')).toBe(true);
    expect(can('ENGINEER', 'drafting:quote')).toBe(true);
    expect(can('ENGINEER', 'engineering:seal')).toBe(true);
  });

  it('cannot assign work to itself', () => {
    // An engineer works their queue. Who gets which job is an admin's
    // decision; letting engineers assign to themselves makes workload
    // invisible to the person managing it.
    expect(can('ENGINEER', 'drafting:assign')).toBe(false);
  });

  it('is not an administrator who happens to draw', () => {
    for (const cap of ['user:invite', 'billing:manage', 'settings:edit', 'credential:write'] as const) {
      expect(can('ENGINEER', cap), cap).toBe(false);
    }
  });

  it('does not let a permit tech seal', () => {
    // Sealing is a personal professional act, not seniority.
    expect(can('PERMIT_TECH', 'engineering:seal')).toBe(false);
    expect(can('SITE_SUPERVISOR', 'engineering:seal')).toBe(false);
  });
});

describeIfDb('the quote gate', () => {
  let engineerId: string;

  beforeAll(async () => {
    await applyMigrations();
    await seedTwoTenants();
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query(`delete from ocs.engineers where license_number like 'TESTQ%'`);
      const e = await c.query(
        `insert into ocs.engineers
           (display_name, license_type, license_number, license_state, license_expires_on)
         values ('Test Engineer','PE','TESTQ-1','FL', current_date + 365) returning id`,
      );
      engineerId = e.rows[0].id;
      await c.query(`delete from ocs.documents where id = $1`, [DOC]);
      await c.query(
        `insert into ocs.documents (id, company_id, name, category)
         values ($1, $2, 'Truss layout', 'other')`,
        [DOC, ALPHA],
      );
    } finally {
      await c.end();
    }
  });

  beforeEach(async () => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query(`delete from ocs.document_seals`);
      await c.query(`delete from ocs.drafting_deliverables`);
      await c.query(`delete from ocs.drafting_orders`);
    } finally {
      await c.end();
    }
  });

  const order = async (fields: Record<string, unknown>) => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      const cols = ['company_id', 'order_number', 'title', ...Object.keys(fields)];
      const vals = [ALPHA, 1, 'Test order', ...Object.values(fields)];
      const r = await c.query(
        `insert into ocs.drafting_orders (${cols.join(',')})
         values (${vals.map((_, i) => `$${i + 1}`).join(',')})
         returning id, started_at`,
        vals,
      );
      return r.rows[0];
    } finally {
      await c.end();
    }
  };

  it('refuses to start work on an unapproved quote', async () => {
    await expect(
      order({ status: 'in_progress', quote_status: 'sent', quoted_cents: 250000 }),
    ).rejects.toThrow(/has not been approved/i);
  });

  it('refuses to start work on a rejected quote', async () => {
    await expect(
      order({ status: 'in_progress', quote_status: 'rejected', quoted_cents: 250000 }),
    ).rejects.toThrow(/quote was rejected/i);
  });

  it('allows work once the quote is approved, and stamps when it started', async () => {
    const row = await order({
      status: 'in_progress', quote_status: 'approved',
      quoted_cents: 250000, quote_approved_at: new Date(),
    });
    expect(row.started_at).toBeTruthy();
  });

  it('allows work when no quote was required', async () => {
    // 'none' is a deliberate decision that this job needs no quote, not an
    // absence of one.
    const row = await order({ status: 'in_progress', quote_status: 'none' });
    expect(row.started_at).toBeTruthy();
  });

  it('refuses to send a quote with no price', async () => {
    await expect(order({ status: 'requested', quote_status: 'sent' }))
      .rejects.toThrow(/drafting_quote_has_amount/i);
  });

  it('refuses to re-price an approved quote', async () => {
    // Re-quoting after approval, without the customer approving again, is how
    // a job quietly becomes more expensive than what was agreed.
    const row = await order({
      status: 'accepted', quote_status: 'approved',
      quoted_cents: 250000, quote_approved_at: new Date(),
    });
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await expect(
        c.query(`update ocs.drafting_orders set quoted_cents = 400000 where id = $1`, [row.id]),
      ).rejects.toThrow(/cannot be re-priced/i);
    } finally {
      await c.end();
    }
  });
});

describeIfDb('the seal', () => {
  let engineerId: string;

  beforeAll(async () => {
    await applyMigrations();
    await seedTwoTenants();
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query(`delete from ocs.engineers where license_number like 'TESTS%'`);
      const e = await c.query(
        `insert into ocs.engineers
           (display_name, license_type, license_number, license_state, license_expires_on)
         values ('Seal Engineer','PE','TESTS-1','FL', current_date + 365) returning id`,
      );
      engineerId = e.rows[0].id;
      await c.query(
        `insert into ocs.documents (id, company_id, name, category)
         values ($1, $2, 'Truss layout', 'other') on conflict (id) do nothing`,
        [DOC, ALPHA],
      );
    } finally {
      await c.end();
    }
  });

  beforeEach(async () => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query(`delete from ocs.document_seals`);
    } finally {
      await c.end();
    }
  });

  const seal = async (extra: Record<string, unknown> = {}) => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      const base: Record<string, unknown> = {
        company_id: ALPHA,
        document_id: DOC,
        engineer_id: engineerId,
        sealed_by_name: 'Seal Engineer',
        license_type: 'PE',
        license_number: 'TESTS-1',
        license_state: 'FL',
        license_expires_on: '2030-01-01',
        ...extra,
      };
      const cols = Object.keys(base);
      const vals = Object.values(base);
      const r = await c.query(
        `insert into ocs.document_seals (${cols.join(',')})
         values (${vals.map((_, i) => `$${i + 1}`).join(',')}) returning id, sealed_at`,
        vals,
      );
      return r.rows[0];
    } finally {
      await c.end();
    }
  };

  it('refuses a seal applied after the licence expired', async () => {
    // A seal applied on an expired licence is void. A building official who
    // spots it rejects the permit; a lawyer who spots it has the whole defence.
    await expect(seal({ license_expires_on: '2020-01-01' }))
      .rejects.toThrow(/expired on .* and cannot seal/i);
  });

  it('records a valid seal', async () => {
    const row = await seal();
    expect(row.id).toBeTruthy();
  });

  it('will not let a seal be rewritten', async () => {
    await seal();
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await expect(
        c.query(`update ocs.document_seals set sealed_by_name = 'Someone Else'`),
      ).rejects.toThrow(/finished record/i);
    } finally {
      await c.end();
    }
  });

  it('still allows the external reference to be attached afterwards', async () => {
    // A signing tool often returns its reference after the act.
    await seal();
    const c = client(ownerUrl!);
    await c.connect();
    try {
      const r = await c.query(
        `update ocs.document_seals set seal_reference = 'sig://abc' returning seal_reference`,
      );
      expect(r.rows[0].seal_reference).toBe('sig://abc');
    } finally {
      await c.end();
    }
  });

  it('allows only one seal per document version', async () => {
    // Two would mean two engineers each believing they took responsibility.
    const c = client(ownerUrl!);
    await c.connect();
    let versionId: string;
    try {
      const v = await c.query(
        `insert into ocs.document_versions
           (company_id, document_id, version_number, storage_bucket, storage_key,
            file_name, content_type, byte_size)
         values ($1, $2, 1, 'documents', 'test/key', 'truss.pdf', 'application/pdf', 1024)
         returning id`,
        [ALPHA, DOC],
      );
      versionId = v.rows[0].id;
    } finally {
      await c.end();
    }

    await seal({ document_version_id: versionId });
    await expect(seal({ document_version_id: versionId }))
      .rejects.toThrow(/document_seals_one_per_version/i);
  });

  it('does not let the application delete a seal', async () => {
    await seal();
    await expect(
      asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
        await c.query(`delete from ocs.document_seals`);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('keeps one contractor out of another contractor seals', async () => {
    await seal();
    const visible = await asTenant(appUrl!, { companyId: BETA }, async (c) => {
      const r = await c.query(`select count(*)::int as n from ocs.document_seals`);
      return r.rows[0].n as number;
    });
    expect(visible).toBe(0);
  });
});

/**
 * One role list, not two.
 *
 * A second copy of the roles is what made ENGINEER real on the server and
 * unselectable in the product: every endpoint enforced it, and the React app —
 * which reads src/shared — had never heard of it. SITE_SUPERVISOR was invisible
 * for the same reason.
 *
 * These tests fail the moment the two drift again.
 */
describe('roles are defined once', () => {
  it('offers every role the API knows to the screen that assigns them', async () => {
    const shared = await import('../src/shared/enums.js');
    const domain = await import('../src/domain/capabilities.js');
    expect([...domain.ROLES]).toEqual([...shared.ROLES]);
  });

  it('includes the two roles that were missing from the product', () => {
    expect(ROLES).toContain('ENGINEER');
    expect(ROLES).toContain('SITE_SUPERVISOR');
  });

  it('gives every role a label and a description', async () => {
    // A role with no label reaches a dropdown as a blank line.
    const { ROLE_LABELS, ROLE_DESCRIPTIONS } = await import('../src/shared/enums.js');
    for (const role of ROLES) {
      expect(ROLE_LABELS[role], role).toBeTruthy();
      expect(ROLE_DESCRIPTIONS[role], role).toBeTruthy();
    }
  });

  it('gives every role a capability set', async () => {
    // A role missing from ROLE_CAPABILITIES throws on the first permission
    // check rather than simply denying, so the account 500s instead of 403s.
    const { ROLE_CAPABILITIES } = await import('../src/shared/permissions.js');
    for (const role of ROLES) {
      expect(ROLE_CAPABILITIES[role], role).toBeDefined();
    }
  });

  it('lists both new roles in the catalogue an administrator picks from', async () => {
    const { roleCatalogue } = await import('../src/domain/capabilities.js');
    const values = roleCatalogue().map((r) => r.value);
    expect(values).toContain('ENGINEER');
    expect(values).toContain('SITE_SUPERVISOR');
    expect(roleCatalogue().every((r) => r.label && r.description)).toBe(true);
  });
});

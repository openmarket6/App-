/**
 * Compliance and projects.
 *
 * The compliance rules are the ones that decide whether this business may
 * lawfully file for a contractor at all, so they are tested at the database
 * where they cannot be bypassed, and against the same shared status function
 * the contractor's own screen uses.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  dbConfigured, applyMigrations, seedTwoTenants, asTenant, client,
  appUrl, ownerUrl, ALPHA, BETA,
} from './helpers/db.js';
import { computeComplianceStatus } from '../src/shared/compliance.js';

const describeIfDb = dbConfigured ? describe : describe.skip;
const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

describe('the shared compliance status function', () => {
  it('treats a human decision as final over date arithmetic', () => {
    // A waived requirement stays waived even if the certificate behind it
    // expired: somebody decided that, and a date cannot un-decide it.
    expect(computeComplianceStatus({
      kind: 'GENERAL_LIABILITY', expiresAt: day(-100), status: 'WAIVED',
    })).toBe('WAIVED');
    expect(computeComplianceStatus({
      kind: 'GENERAL_LIABILITY', expiresAt: day(400), status: 'REJECTED',
    })).toBe('REJECTED');
  });

  it('warns before it blocks', () => {
    expect(computeComplianceStatus({
      kind: 'GENERAL_LIABILITY', expiresAt: day(400), status: 'VALID',
    })).toBe('VALID');
    expect(computeComplianceStatus({
      kind: 'GENERAL_LIABILITY', expiresAt: day(10), status: 'VALID',
    })).toBe('EXPIRING_SOON');
    expect(computeComplianceStatus({
      kind: 'GENERAL_LIABILITY', expiresAt: day(-1), status: 'VALID',
    })).toBe('EXPIRED');
  });

  it('does not expire a document that has no expiry', () => {
    // A W9 does not go stale. Treating it as expired would put every
    // contractor on a filing hold for no reason.
    expect(computeComplianceStatus({ kind: 'W9', expiresAt: null, status: 'VALID' })).toBe('VALID');
  });
});

describeIfDb('can we file for this contractor', () => {
  beforeAll(async () => {
    await applyMigrations();
    await seedTwoTenants();
  });

  beforeEach(async () => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query(`delete from ocs.compliance_items`);
    } finally {
      await c.end();
    }
  });

  const record = async (kind: string, expires: string | null, decision = 'accepted', company = ALPHA) => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      const r = await c.query(
        `insert into ocs.compliance_items (company_id, kind, expires_at, decision, decision_note, decided_by, decided_at)
         values ($1, $2::ocs.compliance_kind, $3::date, $4::ocs.compliance_decision,
                 case when $4 in ('rejected','waived') then 'test' else null end,
                 case when $4 = 'waived' then (select id from ocs.app_users limit 1) else null end,
                 case when $4 = 'waived' then now() else null end)
         returning id`,
        [company, kind, expires, decision],
      );
      return r.rows[0].id as string;
    } finally {
      await c.end();
    }
  };

  const canFile = async (company = ALPHA) => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      const r = await c.query(`select ocs.can_file_for($1) as ok`, [company]);
      return r.rows[0].ok as boolean;
    } finally {
      await c.end();
    }
  };

  it('refuses with nothing on file', async () => {
    expect(await canFile()).toBe(false);
  });

  it('refuses while a certificate is still awaiting review', async () => {
    // An uploaded certificate nobody has looked at is not cover. Treating it as
    // valid would let a contractor file on a document we have not read.
    await record('GENERAL_LIABILITY', day(400), 'pending_review');
    await record('WORKERS_COMP', day(400), 'pending_review');
    await record('STATE_LICENSE', day(400), 'pending_review');
    expect(await canFile()).toBe(false);
  });

  it('allows once all three blocking requirements are accepted and current', async () => {
    await record('GENERAL_LIABILITY', day(400));
    await record('WORKERS_COMP', day(400));
    await record('STATE_LICENSE', day(400));
    expect(await canFile()).toBe(true);
  });

  it('refuses the moment one of them expires', async () => {
    await record('GENERAL_LIABILITY', day(400));
    await record('WORKERS_COMP', day(400));
    await record('STATE_LICENSE', day(-1));
    expect(await canFile()).toBe(false);
  });

  it('accepts a workers-comp exemption in place of the policy', async () => {
    // How Florida actually works for a qualifying officer. Without this, an
    // exempt contractor is permanently blocked for a policy they cannot hold.
    await record('GENERAL_LIABILITY', day(400));
    await record('WORKERS_COMP_EXEMPTION', day(400));
    await record('STATE_LICENSE', day(400));
    expect(await canFile()).toBe(true);
  });

  it('lets a waiver clear a block', async () => {
    await record('GENERAL_LIABILITY', day(400));
    await record('WORKERS_COMP', day(-30), 'waived');
    await record('STATE_LICENSE', day(400));
    expect(await canFile()).toBe(true);
  });

  it('refuses to record a rejection without a reason', async () => {
    await expect(record('BOND', day(400), 'rejected')).resolves.toBeTruthy();
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await expect(
        c.query(
          `insert into ocs.compliance_items (company_id, kind, decision, decision_note)
           values ($1, 'W9', 'rejected', null)`,
          [ALPHA],
        ),
      ).rejects.toThrow(/compliance_rejection_explained/i);
    } finally {
      await c.end();
    }
  });

  it('allows only one live record per kind', async () => {
    // Two general liability policies means two answers to "are they covered",
    // and nothing decides which wins.
    await record('GENERAL_LIABILITY', day(400));
    await expect(record('GENERAL_LIABILITY', day(200))).rejects.toThrow(/duplicate key/i);
  });

  it('judges each contractor separately', async () => {
    await record('GENERAL_LIABILITY', day(400));
    await record('WORKERS_COMP', day(400));
    await record('STATE_LICENSE', day(400));
    expect(await canFile(ALPHA)).toBe(true);
    expect(await canFile(BETA)).toBe(false);
  });

  it('keeps one contractor out of another contractor certificates', async () => {
    await record('GENERAL_LIABILITY', day(400));
    const visible = await asTenant(appUrl!, { companyId: BETA }, async (c) => {
      const r = await c.query(`select count(*)::int as n from ocs.compliance_items`);
      return r.rows[0].n as number;
    });
    expect(visible).toBe(0);
  });
});

describeIfDb('project site facts', () => {
  beforeAll(async () => {
    await applyMigrations();
    await seedTwoTenants();
  });

  it('stores valuation in integer cents', async () => {
    // This number decides whether the FEMA 50% rule applies, so a rounding
    // error here decides whether a whole rebuild must meet current flood code.
    const c = client(ownerUrl!);
    await c.connect();
    try {
      const r = await c.query(
        `insert into ocs.projects (company_id, name, valuation_cents)
         values ($1, 'Cents test', 12345678) returning valuation_cents`,
        [ALPHA],
      );
      expect(Number(r.rows[0].valuation_cents)).toBe(12345678);
      expect(Number.isInteger(Number(r.rows[0].valuation_cents))).toBe(true);
    } finally {
      await c.end();
    }
  });

  it('refuses a negative valuation', async () => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await expect(
        c.query(
          `insert into ocs.projects (company_id, name, valuation_cents)
           values ($1, 'Negative', -1)`,
          [ALPHA],
        ),
      ).rejects.toThrow(/valuation_cents/i);
    } finally {
      await c.end();
    }
  });
});

/**
 * Invoicing.
 *
 * One rule dominates: our fee and the agency's fee are never blended. A permit
 * invoice carries two kinds of money -- what this firm charged for its work,
 * and what the building department charged, which we advanced and recover at
 * cost. A contractor who finds a $412 county fee billed at $495 stops believing
 * every other number on the invoice, and they are right to.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  dbConfigured, applyMigrations, seedTwoTenants, asTenant, client,
  appUrl, ownerUrl, ALPHA, BETA,
} from './helpers/db.js';
import { invoiceTotals } from '../src/shared/billing.js';

const describeIfDb = dbConfigured ? describe : describe.skip;

describe('invoice arithmetic', () => {
  it('sums our fee and the agency fee separately', () => {
    const totals = invoiceTotals([
      { description: 'Permit expediting', quantity: 1, unitCents: 30000, passThrough: false, permitId: null },
      { description: 'Miami-Dade permit fee', quantity: 1, unitCents: 41200, passThrough: true, permitId: null },
    ]);
    expect(totals.subtotalCents).toBe(30000);
    expect(totals.passThroughCents).toBe(41200);
    expect(totals.totalCents).toBe(71200);
  });

  it('keeps the two apart however many lines there are', () => {
    // The property that matters: no amount of mixing collapses them into one
    // number, because the split is what the contractor is owed an account of.
    const totals = invoiceTotals([
      { description: 'a', quantity: 2, unitCents: 15000, passThrough: false, permitId: null },
      { description: 'b', quantity: 1, unitCents: 41200, passThrough: true, permitId: null },
      { description: 'c', quantity: 3, unitCents: 5000, passThrough: false, permitId: null },
      { description: 'd', quantity: 1, unitCents: 8800, passThrough: true, permitId: null },
    ]);
    expect(totals.subtotalCents).toBe(45000);
    expect(totals.passThroughCents).toBe(50000);
    expect(totals.totalCents).toBe(95000);
  });
});

describeIfDb('invoices at the database', () => {
  beforeAll(async () => {
    await applyMigrations();
    await seedTwoTenants();
  });

  beforeEach(async () => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query(`delete from ocs.invoice_line_items`);
      await c.query(`delete from ocs.invoices`);
    } finally {
      await c.end();
    }
  });

  const invoice = async (company = ALPHA) => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      const r = await c.query(
        `insert into ocs.invoices (company_id, subtotal_cents, pass_through_cents, total_cents)
         values ($1, 30000, 41200, 71200) returning id`,
        [company],
      );
      return r.rows[0].id as string;
    } finally {
      await c.end();
    }
  };

  it('refuses a pass-through line that is not a government fee', async () => {
    /*
     * The constraint exists because the mistake is not malice -- it is somebody
     * marking up an agency fee to cover the card processing on it, which is
     * exactly how a contractor discovers a $412 fee billed at $495.
     */
    const id = await invoice();
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await expect(
        c.query(
          `insert into ocs.invoice_line_items
             (company_id, invoice_id, description, quantity, unit_price_cents,
              amount_cents, charge_kind, pass_through)
           values ($1,$2,'Marked-up county fee',1,49500,49500,'monthly_service',true)`,
          [ALPHA, id],
        ),
      ).rejects.toThrow(/pass_through_is_government_fee/i);
    } finally {
      await c.end();
    }
  });

  it('accepts a pass-through line recorded as a government fee', async () => {
    const id = await invoice();
    const c = client(ownerUrl!);
    await c.connect();
    try {
      const r = await c.query(
        `insert into ocs.invoice_line_items
           (company_id, invoice_id, description, quantity, unit_price_cents,
            amount_cents, charge_kind, pass_through)
         values ($1,$2,'Miami-Dade permit fee',1,41200,41200,'government_fee',true)
         returning pass_through`,
        [ALPHA, id],
      );
      expect(r.rows[0].pass_through).toBe(true);
    } finally {
      await c.end();
    }
  });

  it('refuses a negative pass-through total', async () => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await expect(
        c.query(
          `insert into ocs.invoices (company_id, pass_through_cents, total_cents)
           values ($1, -100, 0)`,
          [ALPHA],
        ),
      ).rejects.toThrow(/pass_through_cents/i);
    } finally {
      await c.end();
    }
  });

  it('keeps one contractor out of another contractor invoices', async () => {
    await invoice(ALPHA);
    const visible = await asTenant(appUrl!, { companyId: BETA }, async (c) => {
      const r = await c.query(`select count(*)::int as n from ocs.invoices`);
      return r.rows[0].n as number;
    });
    expect(visible).toBe(0);
  });

  it('gives each contractor one Stripe customer at most', async () => {
    // Two customers for one company means a card stored against one and
    // charged against the other, which fails at exactly the wrong moment.
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await c.query(`update ocs.companies set stripe_customer_id = 'cus_test_1' where id = $1`, [ALPHA]);
      await expect(
        c.query(`update ocs.companies set stripe_customer_id = 'cus_test_1' where id = $1`, [BETA]),
      ).rejects.toThrow(/stripe_customer_id/i);
    } finally {
      await c.end();
    }
  });
});

describeIfDb('the rate book', () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  it('is seeded with every trade the pricing logic knows', async () => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      const r = await c.query(`select count(*)::int as n from ocs.trade_rates`);
      expect(r.rows[0].n).toBeGreaterThanOrEqual(7);
    } finally {
      await c.end();
    }
  });

  it('refuses a negative fee', async () => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await expect(
        c.query(`insert into ocs.trade_rates (trade, fee_cents) values ('BAD', -1)`),
      ).rejects.toThrow(/fee_cents/i);
    } finally {
      await c.end();
    }
  });
});

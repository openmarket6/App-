/**
 * Billing, at the database.
 *
 * The arithmetic is already covered by pricing.test.ts, which is pure and can
 * be checked against the price list by reading it. What is tested here is the
 * part arithmetic cannot protect: that the rules survive contact with a
 * database, and that the compliance retainer stays out of revenue no matter
 * what anybody writes later.
 *
 * That last point is the reason this file exists. The retainer is money HELD,
 * not money EARNED. Counting it would overstate the business by the entire
 * retainer balance -- every month, growing with every customer -- and that is
 * the number an owner uses to decide whether they can afford to hire.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  dbConfigured, applyMigrations, seedTwoTenants, asTenant, client,
  appUrl, ownerUrl, ALPHA, BETA, ALPHA_USER,
} from './helpers/db.js';

const describeIfDb = dbConfigured ? describe : describe.skip;

const SNAP = JSON.stringify({ planKey: 'TWO_TRADES' });

describeIfDb('billing', () => {
  beforeAll(async () => {
    await applyMigrations();
    await seedTwoTenants();
  });

  beforeEach(async () => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      // TRUNCATE, because the ledger refuses DELETE by design.
      await c.query(`truncate ocs.retainer_ledger, ocs.subscription_changes cascade`);
      await c.query(`delete from ocs.subscriptions`);
    } finally {
      await c.end();
    }
  });

  const newSubscription = async (fields: Record<string, unknown> = {}) => {
    const c = client(ownerUrl!);
    await c.connect();
    try {
      const r = await c.query(
        `insert into ocs.subscriptions
           (company_id, plan_key, trade_count, status, pricing_snapshot,
            monthly_price_cents, onboarding_paid_cents, retainer_required_cents)
         values ($1,'TWO_TRADES',2,'active',$2::jsonb,275000,125000,250000)
         returning id`,
        [fields['companyId'] ?? ALPHA, SNAP],
      );
      return r.rows[0].id as string;
    } finally {
      await c.end();
    }
  };

  describe('subscriptions', () => {
    it('demands a pricing snapshot', async () => {
      // Without one, changing the published price list silently rewrites what
      // every existing customer owes and a signed agreement no longer says
      // what it said when it was signed.
      const c = client(ownerUrl!);
      await c.connect();
      try {
        await expect(
          c.query(
            `insert into ocs.subscriptions (company_id, plan_key, monthly_price_cents)
             values ($1,'TWO_TRADES',275000)`,
            [ALPHA],
          ),
        ).rejects.toThrow(/pricing_snapshot/i);
      } finally {
        await c.end();
      }
    });

    it('allows only one live subscription per contractor', async () => {
      // Two would mean two monthly charges and two different answers to
      // "what plan are they on".
      await newSubscription();
      const c = client(ownerUrl!);
      await c.connect();
      try {
        await expect(
          c.query(
            `insert into ocs.subscriptions
               (company_id, plan_key, status, pricing_snapshot, monthly_price_cents)
             values ($1,'ONE_TRADE','active',$2::jsonb,150000)`,
            [ALPHA, SNAP],
          ),
        ).rejects.toThrow(/subscriptions_one_live_per_company/i);
      } finally {
        await c.end();
      }
    });

    it('keeps a cancelled subscription so the history survives', async () => {
      const id = await newSubscription();
      const c = client(ownerUrl!);
      await c.connect();
      try {
        await c.query(
          `update ocs.subscriptions set status='cancelled', cancelled_at=now() where id=$1`,
          [id],
        );
        // The partial index only covers live rows, so a new one is now allowed.
        await c.query(
          `insert into ocs.subscriptions
             (company_id, plan_key, status, pricing_snapshot, monthly_price_cents)
           values ($1,'ONE_TRADE','active',$2::jsonb,150000)`,
          [ALPHA, SNAP],
        );
        const r = await c.query(
          `select count(*)::int as n from ocs.subscriptions where company_id=$1`, [ALPHA],
        );
        expect(r.rows[0].n).toBe(2);
      } finally {
        await c.end();
      }
    });

    it('never lets onboarding already paid go down', async () => {
      // A downgrade refunds no onboarding. If this could fall, a customer could
      // downgrade and re-upgrade to be charged the difference twice.
      const id = await newSubscription();
      const c = client(ownerUrl!);
      await c.connect();
      try {
        await expect(
          c.query(`update ocs.subscriptions set onboarding_paid_cents=100000 where id=$1`, [id]),
        ).rejects.toThrow(/cannot decrease/i);
      } finally {
        await c.end();
      }
    });
  });

  describe('the compliance retainer', () => {
    const ledger = async (fields: Record<string, unknown>) => {
      const c = client(ownerUrl!);
      await c.connect();
      try {
        const cols = ['company_id', ...Object.keys(fields)];
        const vals = [ALPHA, ...Object.values(fields)];
        return await c.query(
          `insert into ocs.retainer_ledger (${cols.join(',')})
           values (${vals.map((_, i) => `$${i + 1}`).join(',')}) returning id`,
          vals,
        );
      } finally {
        await c.end();
      }
    };

    it('refuses a release nobody approved', async () => {
      // Releasing money held against risk we may still be carrying is a
      // judgement about open jobs, not arithmetic.
      await expect(
        ledger({ movement: 'release', amount_cents: -50000, reason: 'downgrade' }),
      ).rejects.toThrow(/retainer_release_needs_approval/i);
    });

    it('refuses a release whose sign would INCREASE the balance', async () => {
      await expect(
        ledger({
          movement: 'release', amount_cents: 50000,
          reason: 'sneaky', approved_by: ALPHA_USER,
        }),
      ).rejects.toThrow(/retainer_sign_matches_movement/i);
    });

    it('derives the balance from the movements', async () => {
      // Derived, not stored. A stored balance and a ledger that disagree is
      // the classic accounting bug, and the stored one is always wrong.
      await ledger({ movement: 'collect', amount_cents: 250000, reason: 'activation' });
      await ledger({
        movement: 'release', amount_cents: -50000,
        reason: 'downgrade', approved_by: ALPHA_USER,
      });

      const c = client(ownerUrl!);
      await c.connect();
      try {
        const r = await c.query(`select ocs.retainer_balance_cents($1) as balance`, [ALPHA]);
        expect(r.rows[0].balance).toBe(200000);
      } finally {
        await c.end();
      }
    });

    it('cannot be edited, by anyone', async () => {
      // A ledger you can edit is not a ledger. A correction is another row
      // with a reason, which leaves the mistake visible. Enforced by a trigger,
      // so it holds for the owner too.
      await ledger({ movement: 'collect', amount_cents: 250000, reason: 'activation' });

      const c = client(ownerUrl!);
      await c.connect();
      try {
        await expect(
          c.query(`update ocs.retainer_ledger set amount_cents = 1 where company_id = $1`, [ALPHA]),
        ).rejects.toThrow(/append-only/i);
      } finally {
        await c.end();
      }
    });

    it('cannot be deleted from by the application', async () => {
      /*
       * Deletion is blocked by the absent grant rather than by a trigger, and
       * the distinction is deliberate. A trigger would block the OWNER too, and
       * the owner is what a cascading delete runs as when a company is
       * genuinely removed -- which would make an erasure request impossible to
       * honour. The application, which is what an attacker reaches, has no
       * DELETE at all.
       */
      await ledger({ movement: 'collect', amount_cents: 250000, reason: 'activation' });

      await expect(
        asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
          await c.query(`delete from ocs.retainer_ledger`);
        }),
      ).rejects.toThrow(/permission denied/i);
    });

    it('records an approval against a change without rewriting the change', async () => {
      /*
       * A column-level grant, and the narrowness is the point. "Pending
       * approval" means an approval gets written afterwards -- but the plan it
       * moved between, the amounts, and who asked for it must stay fixed, so an
       * approval can never quietly become a different change.
       */
      const subId = await newSubscription();
      const c = client(ownerUrl!);
      await c.connect();
      try {
        await c.query(
          `insert into ocs.subscription_changes
             (company_id, subscription_id, to_plan_key, to_trade_count,
              retainer_delta_cents, requires_approval, pricing_snapshot)
           values ($1, $2, 'ONE_TRADE', 1, -100000, true, $3::jsonb)`,
          [ALPHA, subId, SNAP],
        );
      } finally {
        await c.end();
      }

      // The approval is allowed.
      await asTenant(appUrl!, { companyId: ALPHA }, async (t) => {
        await t.query(
          `update ocs.subscription_changes set approved_by = $1, approved_at = now()
            where company_id = $2`,
          [ALPHA_USER, ALPHA],
        );
      });

      // Rewriting the change itself is not.
      await expect(
        asTenant(appUrl!, { companyId: ALPHA }, async (t) => {
          await t.query(
            `update ocs.subscription_changes set retainer_delta_cents = 0 where company_id = $1`,
            [ALPHA],
          );
        }),
      ).rejects.toThrow(/permission denied/i);
    });

    it('keeps one contractor out of another contractor ledger', async () => {
      await ledger({ movement: 'collect', amount_cents: 250000, reason: 'activation' });
      const visible = await asTenant(appUrl!, { companyId: BETA }, async (c) => {
        const r = await c.query(`select count(*)::int as n from ocs.retainer_ledger`);
        return r.rows[0].n as number;
      });
      expect(visible).toBe(0);
    });
  });

  describe('what counts as revenue', () => {
    it('excludes the retainer from the revenue view', async () => {
      // The whole point of the charge_kind column. Summing revenue must not
      // depend on every future query remembering which kind to leave out --
      // the one that forgets is the one that overstates the business.
      const c = client(ownerUrl!);
      await c.connect();
      try {
        await c.query('begin');
        const inv = await c.query(
          `insert into ocs.invoices (company_id, subtotal_cents, total_cents)
           values ($1, 665000, 665000) returning id`,
          [ALPHA],
        );
        const invoiceId = inv.rows[0].id;

        await c.query(
          `insert into ocs.invoice_line_items
             (company_id, invoice_id, description, quantity, unit_price_cents, amount_cents, charge_kind)
           values ($1,$2,'Monthly service',1,275000,275000,'monthly_service'),
                  ($1,$2,'Onboarding',1,125000,125000,'onboarding'),
                  ($1,$2,'Supervisor visit',1,15000,15000,'supervisor_visit'),
                  ($1,$2,'Compliance retainer',1,250000,250000,'compliance_retainer')`,
          [ALPHA, invoiceId],
        );

        const billed = await c.query(
          `select sum(amount_cents)::int as t from ocs.invoice_line_items where invoice_id=$1`,
          [invoiceId],
        );
        const revenue = await c.query(
          `select sum(amount_cents)::int as t from ocs.invoice_revenue_line_items where invoice_id=$1`,
          [invoiceId],
        );

        expect(billed.rows[0].t).toBe(665000);
        expect(revenue.rows[0].t).toBe(415000);
        expect(billed.rows[0].t - revenue.rows[0].t).toBe(250000);

        await c.query('rollback');
      } finally {
        await c.end();
      }
    });

    it('bills a supervisor visit only once', async () => {
      // Without this, re-running the billing job charges the contractor again
      // for the same visit.
      const c = client(ownerUrl!);
      await c.connect();
      try {
        await c.query('begin');
        const inv = await c.query(
          `insert into ocs.invoices (company_id, subtotal_cents, total_cents)
           values ($1, 15000, 15000) returning id`,
          [ALPHA],
        );
        const visit = await c.query(
          `select id from ocs.supervision_visits limit 1`,
        );

        if (visit.rowCount === 0) {
          await c.query('rollback');
          return;
        }

        const line = (n: number) =>
          c.query(
            `insert into ocs.invoice_line_items
               (company_id, invoice_id, description, quantity, unit_price_cents,
                amount_cents, charge_kind, supervision_visit_id)
             values ($1,$2,$3,1,15000,15000,'supervisor_visit',$4)`,
            [ALPHA, inv.rows[0].id, `Visit ${n}`, visit.rows[0].id],
          );

        await line(1);
        await expect(line(2)).rejects.toThrow(/invoice_line_items_one_per_visit/i);
        await c.query('rollback');
      } finally {
        await c.end();
      }
    });
  });
});

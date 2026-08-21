/**
 * Pricing rules.
 *
 * These are the calculations a customer will check against their own
 * arithmetic, and the ones that cost real money when they are wrong in either
 * direction: overcharge and you lose the account, undercharge and you carry
 * licensing risk you were not paid for.
 *
 * No database here on purpose. Every rule below is pure arithmetic over the
 * published table, which means it can be verified against the price list by
 * reading it.
 */
import { describe, it, expect } from 'vitest';
import {
  PLANS, planFor, planForTradeCount, snapshot, onboardingDueCents,
  retainerChange, activationCharges, supervisorVisitCharge, isRevenue,
  SUPERVISOR_VISIT_CENTS, ALL_TRADES_THRESHOLD,
} from '../src/domain/pricing.js';

describe('the published price list', () => {
  it('matches the agreed figures', () => {
    // Written out rather than derived, so a typo in pricing.json fails here
    // instead of reaching an invoice.
    const expected: Record<string, [number, number, number]> = {
      ONE_TRADE:    [150_000, 100_000, 200_000],
      TWO_TRADES:   [275_000, 125_000, 250_000],
      THREE_TRADES: [400_000, 150_000, 300_000],
      FOUR_TRADES:  [525_000, 175_000, 350_000],
      FIVE_TRADES:  [650_000, 200_000, 400_000],
      SIX_TRADES:   [800_000, 225_000, 450_000],
      ALL_TRADES:   [1_000_000, 250_000, 500_000],
    };

    for (const [key, [monthly, onboarding, retainer]] of Object.entries(expected)) {
      const plan = planFor(key as never);
      expect(plan.monthlyPriceCents, key).toBe(monthly);
      expect(plan.onboardingFeeCents, key).toBe(onboarding);
      expect(plan.complianceRetainerCents, key).toBe(retainer);
    }

    const own = planFor('OWN_LICENSE');
    expect(own.pricePerPermitCents).toBe(19_900);
    expect(own.onboardingFeeCents).toBe(0);
    expect(own.complianceRetainerCents).toBe(0);
    expect(SUPERVISOR_VISIT_CENTS).toBe(15_000);
  });

  it('is stored in whole cents', () => {
    // A fractional cent means a float crept into the table, and float money
    // drifts. In a retainer ledger that drift becomes an argument.
    for (const p of PLANS) {
      for (const v of [
        p.monthlyPriceCents, p.onboardingFeeCents,
        p.complianceRetainerCents, p.pricePerPermitCents,
      ]) {
        expect(Number.isInteger(v), p.key).toBe(true);
      }
    }
  });
});

describe('choosing a plan', () => {
  it('maps a trade count to its tier', () => {
    expect(planForTradeCount(1).key).toBe('ONE_TRADE');
    expect(planForTradeCount(4).key).toBe('FOUR_TRADES');
    expect(planForTradeCount(6).key).toBe('SIX_TRADES');
  });

  it('offers All-Trades at seven or more classifications', () => {
    expect(ALL_TRADES_THRESHOLD).toBe(7);
    expect(planForTradeCount(7).key).toBe('ALL_TRADES');
    expect(planForTradeCount(12).key).toBe('ALL_TRADES');
  });

  it('never charges more than All-Trades for seven classifications', () => {
    // The rule protects the customer, not the packaging: if six trades plus one
    // more ever undercut All-Trades, the rule would be quietly overcharging.
    const six = planFor('SIX_TRADES');
    const all = planFor('ALL_TRADES');
    expect(all.monthlyPriceCents).toBeLessThan(six.monthlyPriceCents * 2);
    expect(planForTradeCount(7).monthlyPriceCents).toBe(all.monthlyPriceCents);
  });

  it('refuses a nonsense trade count', () => {
    expect(() => planForTradeCount(-1)).toThrow();
    expect(() => planForTradeCount(1.5)).toThrow();
  });
});

describe('onboarding', () => {
  it('charges the full fee on first activation', () => {
    expect(onboardingDueCents(planFor('ONE_TRADE'), 0)).toBe(100_000);
  });

  it('charges only the difference on an upgrade', () => {
    // One trade to three: $1,000 already paid against a $1,500 fee.
    expect(onboardingDueCents(planFor('THREE_TRADES'), 100_000)).toBe(50_000);
  });

  it('charges nothing twice when the fee is unchanged', () => {
    expect(onboardingDueCents(planFor('ONE_TRADE'), 100_000)).toBe(0);
  });

  it('refunds nothing on a downgrade', () => {
    // Six trades down to one: $2,250 paid against a $1,000 fee. Not -$1,250.
    expect(onboardingDueCents(planFor('ONE_TRADE'), 225_000)).toBe(0);
  });

  it('uses what was actually collected, not the old list price', () => {
    // A customer given a discounted onboarding fee must not have the discount
    // silently clawed back at the next upgrade.
    expect(onboardingDueCents(planFor('TWO_TRADES'), 50_000)).toBe(75_000);
  });
});

describe('the compliance retainer', () => {
  it('collects the shortfall on an upgrade', () => {
    const change = retainerChange(planFor('THREE_TRADES'), 200_000);
    expect(change).toEqual({ action: 'collect', requiredCents: 300_000, collectCents: 100_000 });
  });

  it('does nothing when it already matches', () => {
    expect(retainerChange(planFor('TWO_TRADES'), 250_000).action).toBe('none');
  });

  it('never releases money on a downgrade without approval', () => {
    // Releasing funds held against risk we may still be carrying is a judgement
    // about open jobs, not arithmetic. It is proposed, then a person decides.
    const change = retainerChange(planFor('ONE_TRADE'), 500_000);
    expect(change.action).toBe('needs_approval');
    expect(change).toMatchObject({ requiredCents: 200_000, releaseCents: 300_000 });
  });
});

describe('charges raised on activation', () => {
  it('bills a first-time customer three separate lines', () => {
    const { lines } = activationCharges({
      toPlan: planFor('TWO_TRADES'),
      onboardingAlreadyPaidCents: 0,
      retainerHeldCents: 0,
    });

    expect(lines.map((l) => l.kind)).toEqual([
      'monthly_service', 'onboarding', 'compliance_retainer',
    ]);
    expect(lines.map((l) => l.amountCents)).toEqual([275_000, 125_000, 250_000]);
  });

  it('bills an upgrade as the differences only', () => {
    const { lines } = activationCharges({
      toPlan: planFor('THREE_TRADES'),
      onboardingAlreadyPaidCents: 125_000,
      retainerHeldCents: 250_000,
    });

    const byKind = Object.fromEntries(lines.map((l) => [l.kind, l.amountCents]));
    expect(byKind['monthly_service']).toBe(400_000);
    expect(byKind['onboarding']).toBe(25_000);
    expect(byKind['compliance_retainer']).toBe(50_000);
  });

  it('raises no retainer line on a downgrade, and flags it for a person', () => {
    const { lines, retainer } = activationCharges({
      toPlan: planFor('ONE_TRADE'),
      onboardingAlreadyPaidCents: 225_000,
      retainerHeldCents: 450_000,
    });

    expect(lines.map((l) => l.kind)).toEqual(['monthly_service']);
    expect(retainer.action).toBe('needs_approval');
  });

  it('raises no monthly or onboarding line for a bring-your-own-license customer', () => {
    const { lines } = activationCharges({
      toPlan: planFor('OWN_LICENSE'),
      onboardingAlreadyPaidCents: 0,
      retainerHeldCents: 0,
    });
    expect(lines).toEqual([]);
  });
});

describe('revenue recognition', () => {
  it('does not treat the compliance retainer as revenue', () => {
    // The retainer is money held, not money earned. Counting it would overstate
    // what the business has made by the entire retainer balance.
    expect(isRevenue('compliance_retainer')).toBe(false);
  });

  it('treats every other charge as revenue', () => {
    for (const kind of [
      'monthly_service', 'onboarding', 'government_fee', 'supervisor_visit', 'per_permit',
    ] as const) {
      expect(isRevenue(kind), kind).toBe(true);
    }
  });
});

describe('supervisor visits', () => {
  it('charges $150 per completed visit', () => {
    const charge = supervisorVisitCharge('1420 Ocean Dr — re-roof');
    expect(charge.amountCents).toBe(15_000);
    expect(charge.kind).toBe('supervisor_visit');
    expect(charge.description).toContain('1420 Ocean Dr');
  });
});

describe('pricing snapshots', () => {
  it('freezes every figure a customer agreed to', () => {
    // Without this, changing the published price list would silently rewrite
    // what existing customers owe and what a signed agreement says.
    const snap = snapshot(planFor('FOUR_TRADES'), '2026-08-21T00:00:00.000Z');
    expect(snap).toEqual({
      planKey: 'FOUR_TRADES',
      planName: 'White Glove — 4 trades',
      tradeCount: 4,
      monthlyPriceCents: 525_000,
      onboardingFeeCents: 175_000,
      complianceRetainerCents: 350_000,
      pricePerPermitCents: 0,
      supervisorVisitCents: 15_000,
      capturedAt: '2026-08-21T00:00:00.000Z',
    });
  });
});

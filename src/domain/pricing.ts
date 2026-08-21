/**
 * Pricing, and the rules for moving between plans.
 *
 * The figures live in pricing.json, which the public site reads too. One copy,
 * because a marketing page quoting a number the system does not charge is a
 * promise somebody then has to honour.
 *
 * Everything here is pure: no database, no clock, no money moved. The functions
 * decide what SHOULD be charged; recording it is the billing layer's job. That
 * separation is what makes these rules testable, and they are the rules most
 * expensive to get wrong.
 *
 * Money is in integer cents throughout. A float dollar amount accumulates
 * rounding drift, and drift in a retainer ledger is an argument with a customer
 * that nobody can win.
 */
import table from './pricing.json' with { type: 'json' };

export type PlanKey =
  | 'OWN_LICENSE'
  | 'ONE_TRADE'
  | 'TWO_TRADES'
  | 'THREE_TRADES'
  | 'FOUR_TRADES'
  | 'FIVE_TRADES'
  | 'SIX_TRADES'
  | 'ALL_TRADES';

export interface Plan {
  key: PlanKey;
  name: string;
  kind: 'per_permit' | 'white_glove';
  tradeCount: number;
  pricePerPermitCents: number;
  monthlyPriceCents: number;
  onboardingFeeCents: number;
  complianceRetainerCents: number;
}

export const PLANS: readonly Plan[] = table.plans as readonly Plan[];

/** What a completed supervisor visit costs, per active job site. */
export const SUPERVISOR_VISIT_CENTS = table.supervisorVisitCents;

/** At or above this many classifications, the All-Trades plan applies. */
export const ALL_TRADES_THRESHOLD = table.allTradesThreshold;

const byKey = new Map<PlanKey, Plan>(PLANS.map((p) => [p.key, p]));

export function planFor(key: PlanKey): Plan {
  const plan = byKey.get(key);
  if (!plan) throw new Error(`Unknown plan: ${key}`);
  return plan;
}

/**
 * The plan a given number of trade classifications requires.
 *
 * Seven or more must be offered All-Trades. That is not only a packaging rule:
 * at seven classifications the All-Trades plan is cheaper than the six-trade
 * tier plus anything else, so selling the customer a stack of individual trades
 * would be charging them more for less.
 */
export function planForTradeCount(tradeCount: number): Plan {
  if (!Number.isInteger(tradeCount) || tradeCount < 0) {
    throw new Error('Trade count must be a whole number, zero or more');
  }
  if (tradeCount === 0) return planFor('OWN_LICENSE');
  if (tradeCount >= ALL_TRADES_THRESHOLD) return planFor('ALL_TRADES');

  const tier = PLANS.find((p) => p.kind === 'white_glove' && p.tradeCount === tradeCount);
  if (!tier) throw new Error(`No plan covers ${tradeCount} trades`);
  return tier;
}

/**
 * A frozen copy of the figures a customer agreed to.
 *
 * Stored on every subscription and every signed agreement. Without it, changing
 * the published price list would silently rewrite what existing customers owe,
 * and a signed agreement would no longer say what it said when it was signed.
 * `capturedAt` is supplied by the caller rather than read from the clock here,
 * so this stays pure and a snapshot can be reconstructed for a past date.
 */
export interface PricingSnapshot {
  planKey: PlanKey;
  planName: string;
  tradeCount: number;
  monthlyPriceCents: number;
  onboardingFeeCents: number;
  complianceRetainerCents: number;
  pricePerPermitCents: number;
  supervisorVisitCents: number;
  capturedAt: string;
}

export function snapshot(plan: Plan, capturedAt: string): PricingSnapshot {
  return {
    planKey: plan.key,
    planName: plan.name,
    tradeCount: plan.tradeCount,
    monthlyPriceCents: plan.monthlyPriceCents,
    onboardingFeeCents: plan.onboardingFeeCents,
    complianceRetainerCents: plan.complianceRetainerCents,
    pricePerPermitCents: plan.pricePerPermitCents,
    supervisorVisitCents: SUPERVISOR_VISIT_CENTS,
    capturedAt,
  };
}

/**
 * What onboarding to charge when a customer changes plan.
 *
 * Onboarding is charged once, on first activation of a White Glove plan. On an
 * upgrade the customer pays only the gap between what they have already paid
 * and what the new tier costs, so nobody pays the full fee twice.
 *
 * `onboardingAlreadyPaidCents` is the running total actually collected, not the
 * previous plan's list price. Those differ the moment a customer is given a
 * discount, and using the list price would quietly re-charge the difference.
 *
 * Never negative: a downgrade refunds nothing.
 */
export function onboardingDueCents(
  toPlan: Plan,
  onboardingAlreadyPaidCents: number,
): number {
  if (onboardingAlreadyPaidCents < 0) {
    throw new Error('Onboarding already paid cannot be negative');
  }
  return Math.max(0, toPlan.onboardingFeeCents - onboardingAlreadyPaidCents);
}

/**
 * What should happen to the compliance retainer on a plan change.
 *
 * Up is automatic: the licensing risk we carry has grown, and the retainer must
 * cover it before the larger plan is active. Down is not, and deliberately so.
 * Releasing money held against risk we may still be carrying is a judgement
 * about open jobs and unresolved liability, not arithmetic — so it is proposed
 * here and approved by a person.
 */
export type RetainerChange =
  | { action: 'none'; requiredCents: number }
  | { action: 'collect'; requiredCents: number; collectCents: number }
  | { action: 'needs_approval'; requiredCents: number; releaseCents: number };

export function retainerChange(toPlan: Plan, heldCents: number): RetainerChange {
  if (heldCents < 0) throw new Error('Retainer held cannot be negative');

  const required = toPlan.complianceRetainerCents;
  if (heldCents === required) return { action: 'none', requiredCents: required };

  if (heldCents < required) {
    return { action: 'collect', requiredCents: required, collectCents: required - heldCents };
  }
  return {
    action: 'needs_approval',
    requiredCents: required,
    releaseCents: heldCents - required,
  };
}

/**
 * Every kind of charge, kept apart.
 *
 * These are shown to the customer as separate lines and, more importantly, are
 * accounted for separately. `compliance_retainer` is money held, not money
 * earned: rolling it into subscription revenue would overstate what the
 * business has actually made by the entire retainer balance.
 */
export const CHARGE_KINDS = [
  'monthly_service',
  'onboarding',
  'compliance_retainer',
  'government_fee',
  'supervisor_visit',
  'per_permit',
] as const;

export type ChargeKind = (typeof CHARGE_KINDS)[number];

/** Charge kinds that count as revenue. Notably absent: the retainer. */
export const REVENUE_KINDS: readonly ChargeKind[] = [
  'monthly_service',
  'onboarding',
  'government_fee',
  'supervisor_visit',
  'per_permit',
];

export function isRevenue(kind: ChargeKind): boolean {
  return REVENUE_KINDS.includes(kind);
}

export interface ChargeLine {
  kind: ChargeKind;
  description: string;
  quantity: number;
  unitCents: number;
  amountCents: number;
}

const line = (
  kind: ChargeKind,
  description: string,
  unitCents: number,
  quantity = 1,
): ChargeLine => ({
  kind,
  description,
  quantity,
  unitCents,
  amountCents: unitCents * quantity,
});

/**
 * The charges raised when a customer activates or changes a plan.
 *
 * Returned as separate lines rather than a total, because the caller has to
 * record them on different ledgers and show them on different invoice rows.
 * Handing back one number would force it to take them apart again, and that is
 * where a retainer ends up misfiled as revenue.
 */
export function activationCharges(input: {
  toPlan: Plan;
  onboardingAlreadyPaidCents: number;
  retainerHeldCents: number;
}): { lines: ChargeLine[]; retainer: RetainerChange } {
  const { toPlan, onboardingAlreadyPaidCents, retainerHeldCents } = input;
  const lines: ChargeLine[] = [];

  if (toPlan.kind === 'white_glove') {
    lines.push(line('monthly_service', `${toPlan.name} — monthly service`, toPlan.monthlyPriceCents));

    const onboarding = onboardingDueCents(toPlan, onboardingAlreadyPaidCents);
    if (onboarding > 0) {
      lines.push(
        line(
          'onboarding',
          onboardingAlreadyPaidCents > 0
            ? `Onboarding — difference to ${toPlan.name}`
            : `Onboarding — ${toPlan.name}`,
          onboarding,
        ),
      );
    }
  }

  const retainer = retainerChange(toPlan, retainerHeldCents);
  if (retainer.action === 'collect') {
    lines.push(
      line('compliance_retainer', `Compliance retainer — top up to ${toPlan.name}`, retainer.collectCents),
    );
  }

  return { lines, retainer };
}

/** A completed supervisor visit on an active job site. */
export function supervisorVisitCharge(siteLabel: string): ChargeLine {
  return line('supervisor_visit', `Supervisor visit — ${siteLabel}`, SUPERVISOR_VISIT_CENTS);
}

/** Formats cents for display. Presentation only; never used for arithmetic. */
export function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

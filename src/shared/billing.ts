import type { PermitType } from './enums.js';
import type { Cents, ID } from './types.js';

/**
 * Two service lines, deliberately modelled as one dimension on every permit
 * rather than as two products in a trench coat.
 *
 *   EXPEDITING      — per-trade fee. The contractor holds the license and is
 *                     the contractor of record. We file and chase.
 *   MANAGED_LICENSE — monthly subscription. We are the contractor of record,
 *                     our qualifier's license is on the permit, and one of our
 *                     PMs actually supervises the job. See supervision.ts —
 *                     the supervision record is what makes this line lawful,
 *                     so the schema treats it as required, not optional.
 */
export const SERVICE_LINES = ['EXPEDITING', 'MANAGED_LICENSE'] as const;
export type ServiceLine = (typeof SERVICE_LINES)[number];

export const SERVICE_LINE_LABELS: Record<ServiceLine, string> = {
  EXPEDITING: 'Permit expediting',
  MANAGED_LICENSE: 'Managed license — white glove',
};

/** Trade categories we price against. Maps many permit types onto one price. */
export const TRADES = [
  'BUILDING',
  'ROOFING',
  'ELECTRICAL',
  'PLUMBING',
  'MECHANICAL',
  'POOL',
  'SOLAR',
  'SPECIALTY',
] as const;
export type Trade = (typeof TRADES)[number];

export const PERMIT_TYPE_TRADE: Record<PermitType, Trade> = {
  RESIDENTIAL_NEW: 'BUILDING',
  RESIDENTIAL_ALTERATION: 'BUILDING',
  RESIDENTIAL_ADDITION: 'BUILDING',
  COMMERCIAL_NEW: 'BUILDING',
  COMMERCIAL_ALTERATION: 'BUILDING',
  ROOFING: 'ROOFING',
  WINDOWS_DOORS: 'BUILDING',
  MECHANICAL: 'MECHANICAL',
  ELECTRICAL: 'ELECTRICAL',
  PLUMBING: 'PLUMBING',
  POOL: 'POOL',
  SOLAR: 'SOLAR',
  FENCE: 'SPECIALTY',
  DEMOLITION: 'SPECIALTY',
  SIGN: 'SPECIALTY',
  SHUTTERS: 'SPECIALTY',
  DOCK_SEAWALL: 'SPECIALTY',
};

export interface TradeRate {
  trade: Trade;
  /** Our fee, integer cents. Agency fees pass through separately and are never marked up silently. */
  feeCents: Cents;
  /** Charged when a jurisdiction requires paper or counter filing. */
  manualSurchargeCents: Cents;
  /** Charged per correction cycle beyond the first, if the firm bills that way. */
  resubmittalCents: Cents;
  active: boolean;
}

/** Starting price book. Every number is editable in settings — these are placeholders, not market rates. */
export const DEFAULT_TRADE_RATES: TradeRate[] = TRADES.map((trade) => ({
  trade,
  feeCents: trade === 'BUILDING' ? 45_000 : trade === 'SPECIALTY' ? 20_000 : 30_000,
  manualSurchargeCents: 15_000,
  resubmittalCents: 12_500,
  active: true,
}));

export interface SubscriptionPlan {
  id: ID;
  name: string;
  serviceLine: 'MANAGED_LICENSE';
  monthlyCents: Cents;
  /** Permits included per month before per-permit overage applies. */
  includedPermitsPerMonth: number;
  overagePerPermitCents: Cents;
  /** Site visits included. Supervision is the product here, so it is metered. */
  includedSiteVisitsPerPermit: number;
  overagePerSiteVisitCents: Cents;
  /** Stripe price id once billing is live. Null while the plan is a draft. */
  stripePriceId: string | null;
  active: boolean;
}

export const DEFAULT_PLANS: Omit<SubscriptionPlan, 'id'>[] = [
  {
    name: 'Managed — Starter',
    serviceLine: 'MANAGED_LICENSE',
    monthlyCents: 1_500_00,
    includedPermitsPerMonth: 2,
    overagePerPermitCents: 60_000,
    includedSiteVisitsPerPermit: 2,
    overagePerSiteVisitCents: 22_500,
    stripePriceId: null,
    active: true,
  },
  {
    name: 'Managed — Growth',
    serviceLine: 'MANAGED_LICENSE',
    monthlyCents: 3_500_00,
    includedPermitsPerMonth: 6,
    overagePerPermitCents: 50_000,
    includedSiteVisitsPerPermit: 3,
    overagePerSiteVisitCents: 20_000,
    stripePriceId: null,
    active: true,
  },
  {
    name: 'Managed — Full Service',
    serviceLine: 'MANAGED_LICENSE',
    monthlyCents: 7_500_00,
    includedPermitsPerMonth: 15,
    overagePerPermitCents: 40_000,
    includedSiteVisitsPerPermit: 4,
    overagePerSiteVisitCents: 17_500,
    stripePriceId: null,
    active: true,
  },
];

export interface Subscription {
  id: ID;
  clientId: ID;
  planId: ID;
  status: 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'PAUSED' | 'CANCELLED';
  startedAt: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelledAt: string | null;
  stripeSubscriptionId: string | null;
  stripeCustomerId: string | null;
}

export interface InvoiceLine {
  description: string;
  quantity: number;
  unitCents: Cents;
  /** Agency fees we advanced on the client's behalf. Shown separately, never marked up quietly. */
  passThrough: boolean;
  permitId: ID | null;
}

export interface Invoice {
  id: ID;
  clientId: ID;
  number: string;
  serviceLine: ServiceLine;
  status: 'DRAFT' | 'SENT' | 'PAID' | 'PARTIAL' | 'OVERDUE' | 'VOID';
  issuedAt: string | null;
  dueAt: string | null;
  paidAt: string | null;
  lines: InvoiceLine[];
  subtotalCents: Cents;
  passThroughCents: Cents;
  totalCents: Cents;
  amountPaidCents: Cents;
  /** Set once pushed to QuickBooks. Null means it has not synced. */
  quickbooksInvoiceId: string | null;
  stripeInvoiceId: string | null;
  createdAt: string;
}

export function invoiceTotals(lines: InvoiceLine[]): Pick<Invoice, 'subtotalCents' | 'passThroughCents' | 'totalCents'> {
  let subtotal = 0;
  let passThrough = 0;
  for (const l of lines) {
    const amount = l.quantity * l.unitCents;
    if (l.passThrough) passThrough += amount;
    else subtotal += amount;
  }
  return { subtotalCents: subtotal, passThroughCents: passThrough, totalCents: subtotal + passThrough };
}

export function rateForPermit(
  rates: TradeRate[],
  permitType: PermitType,
  opts: { manualJurisdiction: boolean; correctionCycles: number },
): { trade: Trade; lines: InvoiceLine[] } {
  const trade = PERMIT_TYPE_TRADE[permitType];
  const rate = rates.find((r) => r.trade === trade && r.active);
  const lines: InvoiceLine[] = [];
  if (!rate) return { trade, lines };

  lines.push({ description: `Permit expediting — ${trade.toLowerCase()}`, quantity: 1, unitCents: rate.feeCents, passThrough: false, permitId: null });

  if (opts.manualJurisdiction && rate.manualSurchargeCents > 0) {
    lines.push({
      description: 'Manual filing surcharge (jurisdiction accepts paper or counter filing only)',
      quantity: 1,
      unitCents: rate.manualSurchargeCents,
      passThrough: false,
      permitId: null,
    });
  }

  const billableResubmittals = Math.max(0, opts.correctionCycles - 1);
  if (billableResubmittals > 0 && rate.resubmittalCents > 0) {
    lines.push({
      description: 'Resubmittal after correction cycle',
      quantity: billableResubmittals,
      unitCents: rate.resubmittalCents,
      passThrough: false,
      permitId: null,
    });
  }

  return { trade, lines };
}

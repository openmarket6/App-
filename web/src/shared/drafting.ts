import type { Cents, ID, PermitType } from './index.ts';

/**
 * In-house drafting and engineering.
 *
 * Offered as an add-on rather than a separate product, because the thing that
 * makes it valuable is that it lands inside the same permit package: a plan
 * set produced here arrives already knowing the jurisdiction's requirements,
 * the wind zone and the correction history for that plans examiner. A drafting
 * request is therefore attached to a project and flows into the permit's
 * document set on delivery, not emailed as a PDF and re-uploaded by hand.
 */

export const DRAFTING_SERVICES = [
  'ARCHITECTURAL_PLANS',
  'STRUCTURAL_ENGINEERING',
  'SITE_PLAN',
  'TRUSS_LAYOUT',
  'ENERGY_CALCS',
  'WIND_LOAD_CALCS',
  'MEP_DESIGN',
  'AS_BUILT',
  'REVISION',
] as const;
export type DraftingService = (typeof DRAFTING_SERVICES)[number];

export const DRAFTING_LABELS: Record<DraftingService, string> = {
  ARCHITECTURAL_PLANS: 'Architectural plan set',
  STRUCTURAL_ENGINEERING: 'Structural engineering (signed & sealed)',
  SITE_PLAN: 'Site plan',
  TRUSS_LAYOUT: 'Truss layout & engineering',
  ENERGY_CALCS: 'Energy code calculations',
  WIND_LOAD_CALCS: 'Wind load calculations',
  MEP_DESIGN: 'MEP design',
  AS_BUILT: 'As-built drawings',
  REVISION: 'Plan revision',
};

/** Which requirement keys a delivered service is expected to satisfy. */
export const DRAFTING_SATISFIES: Record<DraftingService, string[]> = {
  ARCHITECTURAL_PLANS: ['structural_plans', 'scope_of_work'],
  STRUCTURAL_ENGINEERING: ['structural_plans', 'attachment_detail'],
  SITE_PLAN: ['site_plan'],
  TRUSS_LAYOUT: ['truss_engineering'],
  ENERGY_CALCS: ['energy_calc'],
  WIND_LOAD_CALCS: ['wind_calc', 'hvhz_wind_calc', 'roof_uplift'],
  MEP_DESIGN: ['electrical_one_line'],
  AS_BUILT: [],
  REVISION: [],
};

export const DRAFTING_STATUSES = [
  'REQUESTED',
  'QUOTED',
  'AWAITING_CLIENT_APPROVAL',
  'IN_PRODUCTION',
  'INTERNAL_REVIEW',
  'AWAITING_SEAL',
  'DELIVERED',
  'REVISION_REQUESTED',
  'CANCELLED',
] as const;
export type DraftingStatus = (typeof DRAFTING_STATUSES)[number];

export interface DraftingRequest {
  id: ID;
  clientId: ID;
  projectId: ID;
  /** Null until the permit this feeds has been created. */
  permitId: ID | null;
  services: DraftingService[];
  permitType: PermitType | null;
  /** What the contractor told us they need, in their words. */
  brief: string;
  /** Files the contractor gave us to work from — sketches, surveys, photos. */
  inputDocumentIds: ID[];
  status: DraftingStatus;
  /** Quoted price, integer cents. Null until a designer has scoped it. */
  quotedCents: Cents | null;
  quoteNote: string | null;
  quotedAt: string | null;
  quotedBy: ID | null;
  approvedAt: string | null;
  /** In-house designer or engineer assigned. */
  assignedToUserId: ID | null;
  /** The engineer of record who seals it, when a seal is required. */
  sealedByUserId: ID | null;
  sealedAt: string | null;
  targetDeliveryAt: string | null;
  deliveredAt: string | null;
  /** The produced plan set, once delivered. Flows into the permit package. */
  outputDocumentIds: ID[];
  revisionOfId: ID | null;
  createdAt: string;
  updatedAt: string;
}

export interface DraftingRate {
  service: DraftingService;
  /** Base price, integer cents. Most of these are scoped per job, so treat as a starting quote. */
  baseCents: Cents;
  /** True when the price genuinely cannot be published and a human must scope it. */
  quoteRequired: boolean;
  typicalTurnaroundDays: number;
  /** Does this need a Florida PE or RA seal? Drives the AWAITING_SEAL step. */
  requiresSeal: boolean;
  active: boolean;
}

/** Placeholder price book. Replace with your real numbers in settings. */
export const DEFAULT_DRAFTING_RATES: DraftingRate[] = [
  { service: 'ARCHITECTURAL_PLANS', baseCents: 2_500_00, quoteRequired: true, typicalTurnaroundDays: 10, requiresSeal: true, active: true },
  { service: 'STRUCTURAL_ENGINEERING', baseCents: 1_800_00, quoteRequired: true, typicalTurnaroundDays: 8, requiresSeal: true, active: true },
  { service: 'SITE_PLAN', baseCents: 450_00, quoteRequired: false, typicalTurnaroundDays: 4, requiresSeal: false, active: true },
  { service: 'TRUSS_LAYOUT', baseCents: 900_00, quoteRequired: true, typicalTurnaroundDays: 7, requiresSeal: true, active: true },
  { service: 'ENERGY_CALCS', baseCents: 350_00, quoteRequired: false, typicalTurnaroundDays: 3, requiresSeal: false, active: true },
  { service: 'WIND_LOAD_CALCS', baseCents: 650_00, quoteRequired: false, typicalTurnaroundDays: 4, requiresSeal: true, active: true },
  { service: 'MEP_DESIGN', baseCents: 1_200_00, quoteRequired: true, typicalTurnaroundDays: 9, requiresSeal: true, active: true },
  { service: 'AS_BUILT', baseCents: 750_00, quoteRequired: true, typicalTurnaroundDays: 6, requiresSeal: false, active: true },
  { service: 'REVISION', baseCents: 300_00, quoteRequired: false, typicalTurnaroundDays: 3, requiresSeal: false, active: true },
];

/** Steps that still stand between a request and a plan set in the permit package. */
export function draftingNextStep(r: Pick<DraftingRequest, 'status' | 'quotedCents' | 'sealedAt'>): string {
  switch (r.status) {
    case 'REQUESTED':
      return 'Scope it and send a quote.';
    case 'QUOTED':
    case 'AWAITING_CLIENT_APPROVAL':
      return 'Waiting on the contractor to approve the quote.';
    case 'IN_PRODUCTION':
      return 'In production with the assigned designer.';
    case 'INTERNAL_REVIEW':
      return 'Internal check before it goes for seal.';
    case 'AWAITING_SEAL':
      return 'Waiting on the engineer of record to sign and seal.';
    case 'REVISION_REQUESTED':
      return 'Revision requested — reassign and reissue.';
    case 'DELIVERED':
      return 'Delivered. Confirm it satisfied the requirement it was ordered for.';
    case 'CANCELLED':
      return 'Cancelled.';
    default:
      return '';
  }
}

/**
 * A full-service job is one where we hold the licence, supervise the work AND
 * produced the plans. Worth surfacing plainly, because it is both the highest
 * revenue configuration and the highest exposure one.
 */
export function isFullServiceJob(input: {
  serviceLine: 'EXPEDITING' | 'MANAGED_LICENSE';
  draftingDelivered: boolean;
}): boolean {
  return input.serviceLine === 'MANAGED_LICENSE' && input.draftingDelivered;
}

import type { Cents, ID, PermitType } from './index.js';

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

import {
  AS_BUILT_TRADES, AS_BUILT_TRADE_LABELS, asBuiltLetterService,
} from './asBuiltTrades.js';

/**
 * ONE definition per service: key, label, group, price, turnaround, seal, and
 * which requirement keys a delivered one satisfies.
 *
 * Previously these were four parallel structures — a key list, a label map, a
 * satisfies map and a price book — and a service added to three of them was a
 * service that rendered without a price, or priced without a label. With
 * forty-odd entries that stops being a theoretical risk. One record each, and
 * the four shapes below are derived from it.
 *
 * The database catalogue in ocs.drafting_services is generated FROM this list
 * by scripts/drafting-catalogue-sql.ts, because the create handler validates
 * against the table while the screen renders from here, and the two disagreeing
 * means a contractor picks something the server then refuses.
 *
 * PRICES ARE PLACEHOLDERS and almost all are quote-required. A discipline
 * package, an inspection or a recertification is scoped per job; a published
 * price would be a number nobody could honour. They are editable in Settings.
 */
export interface DraftingServiceSpec {
  key: string;
  label: string;
  group: string;
  baseCents: number;
  quoteRequired: boolean;
  turnaroundDays: number;
  requiresSeal: boolean;
  /** Requirement keys a delivered one is expected to satisfy. Empty is honest. */
  satisfies: string[];
  /** Shown under the label when it is not obvious what is being bought. */
  note?: string;
}

const C: DraftingServiceSpec[] = [
  // --- Architectural & site -------------------------------------------------
  { key: 'ARCHITECTURAL_PLANS', label: 'Architectural plan set', group: 'architectural',
    baseCents: 2_500_00, quoteRequired: true, turnaroundDays: 10, requiresSeal: true,
    satisfies: ['structural_plans', 'scope_of_work'] },
  { key: 'SITE_PLAN', label: 'Site plan', group: 'architectural',
    baseCents: 450_00, quoteRequired: false, turnaroundDays: 4, requiresSeal: false,
    satisfies: ['site_plan'] },
  { key: 'FLOOR_PLAN', label: 'Floor plan', group: 'architectural',
    baseCents: 600_00, quoteRequired: false, turnaroundDays: 4, requiresSeal: false,
    satisfies: [] },
  { key: 'DEMOLITION_PLAN', label: 'Demolition plan', group: 'architectural',
    baseCents: 550_00, quoteRequired: true, turnaroundDays: 5, requiresSeal: true,
    satisfies: [] },
  { key: 'ACCESSIBILITY_PLAN', label: 'Accessibility / ADA compliance plan', group: 'architectural',
    baseCents: 850_00, quoteRequired: true, turnaroundDays: 6, requiresSeal: true,
    satisfies: ['accessibility', 'barrier_compliance'],
    note: 'Chapter 11 of the Florida Building Code and the ADA standards.' },
  { key: 'INTERIOR_BUILDOUT', label: 'Interior build-out / tenant improvement', group: 'architectural',
    baseCents: 1_800_00, quoteRequired: true, turnaroundDays: 9, requiresSeal: true,
    satisfies: ['scope_of_work'] },

  // --- Structural -----------------------------------------------------------
  { key: 'STRUCTURAL_ENGINEERING', label: 'Structural engineering (signed & sealed)', group: 'structural',
    baseCents: 1_800_00, quoteRequired: true, turnaroundDays: 8, requiresSeal: true,
    satisfies: ['structural_plans', 'attachment_detail'] },
  { key: 'FOUNDATION_PLAN', label: 'Foundation plan', group: 'structural',
    baseCents: 950_00, quoteRequired: true, turnaroundDays: 7, requiresSeal: true,
    satisfies: ['structural_plans'] },
  { key: 'TRUSS_LAYOUT', label: 'Truss layout & engineering', group: 'structural',
    baseCents: 900_00, quoteRequired: true, turnaroundDays: 7, requiresSeal: true,
    satisfies: ['truss_engineering'] },
  { key: 'WIND_LOAD_CALCS', label: 'Wind load calculations', group: 'structural',
    baseCents: 650_00, quoteRequired: false, turnaroundDays: 4, requiresSeal: true,
    satisfies: ['wind_calc', 'hvhz_wind_calc', 'roof_uplift'] },
  { key: 'OPENING_PROTECTION', label: 'Opening protection / shutter plans', group: 'structural',
    baseCents: 700_00, quoteRequired: true, turnaroundDays: 5, requiresSeal: true,
    satisfies: ['opening_protection', 'opening_schedule'] },
  { key: 'RETAINING_WALL', label: 'Retaining wall design', group: 'structural',
    baseCents: 900_00, quoteRequired: true, turnaroundDays: 7, requiresSeal: true,
    satisfies: [] },
  { key: 'STRUCTURAL_LETTER', label: 'Structural engineer letter', group: 'structural',
    baseCents: 450_00, quoteRequired: true, turnaroundDays: 4, requiresSeal: true,
    satisfies: ['structural_letter'],
    note: 'A sealed letter of opinion, where a department will take one instead of a full set.' },

  // --- Mechanical, electrical & plumbing ------------------------------------
  { key: 'MECHANICAL_PLANS', label: 'Mechanical plans (HVAC)', group: 'mep',
    baseCents: 850_00, quoteRequired: true, turnaroundDays: 7, requiresSeal: true, satisfies: [] },
  { key: 'ELECTRICAL_PLANS', label: 'Electrical plans', group: 'mep',
    baseCents: 850_00, quoteRequired: true, turnaroundDays: 7, requiresSeal: true,
    satisfies: ['electrical_one_line', 'electrical_bonding'] },
  { key: 'PLUMBING_PLANS', label: 'Plumbing plans', group: 'mep',
    baseCents: 750_00, quoteRequired: true, turnaroundDays: 7, requiresSeal: true, satisfies: [] },
  { key: 'MEP_DESIGN', label: 'MEP design (combined)', group: 'mep',
    baseCents: 1_200_00, quoteRequired: true, turnaroundDays: 9, requiresSeal: true,
    satisfies: ['electrical_one_line'] },
  { key: 'GAS_PIPING', label: 'Gas piping plans', group: 'mep',
    baseCents: 650_00, quoteRequired: true, turnaroundDays: 6, requiresSeal: true, satisfies: [] },
  { key: 'GENERATOR_PLANS', label: 'Standby generator plans', group: 'mep',
    baseCents: 900_00, quoteRequired: true, turnaroundDays: 7, requiresSeal: true, satisfies: [] },
  { key: 'SOLAR_PV_PLANS', label: 'Solar PV / battery storage plans', group: 'mep',
    baseCents: 850_00, quoteRequired: true, turnaroundDays: 6, requiresSeal: true, satisfies: [] },
  { key: 'ELEVATOR_PLANS', label: 'Elevator / lift plans', group: 'mep',
    baseCents: 1_100_00, quoteRequired: true, turnaroundDays: 9, requiresSeal: true, satisfies: [] },
  { key: 'LOW_VOLTAGE_PLANS', label: 'Low voltage / data / security plans', group: 'mep',
    baseCents: 600_00, quoteRequired: true, turnaroundDays: 6, requiresSeal: false, satisfies: [] },

  // --- Fire & life safety ---------------------------------------------------
  { key: 'LIFE_SAFETY_PLANS', label: 'Life safety plans', group: 'life_safety',
    baseCents: 950_00, quoteRequired: true, turnaroundDays: 8, requiresSeal: true,
    satisfies: ['fire_review'] },
  { key: 'FIRE_SPRINKLER_PLANS', label: 'Fire sprinkler plans (NFPA 13/13D/13R)', group: 'life_safety',
    baseCents: 1_400_00, quoteRequired: true, turnaroundDays: 9, requiresSeal: true,
    satisfies: ['fire_review'] },
  { key: 'FIRE_ALARM_PLANS', label: 'Fire alarm plans (NFPA 72)', group: 'life_safety',
    baseCents: 1_200_00, quoteRequired: true, turnaroundDays: 9, requiresSeal: true,
    satisfies: ['fire_review'] },
  { key: 'FIRE_PUMP_PLANS', label: 'Fire pump plans', group: 'life_safety',
    baseCents: 1_300_00, quoteRequired: true, turnaroundDays: 9, requiresSeal: true, satisfies: [] },
  { key: 'HOOD_SUPPRESSION', label: 'Kitchen hood & suppression plans', group: 'life_safety',
    baseCents: 1_100_00, quoteRequired: true, turnaroundDays: 8, requiresSeal: true, satisfies: [] },

  // --- Civil & site engineering ---------------------------------------------
  { key: 'CIVIL_ENGINEERING', label: 'Civil engineering', group: 'civil',
    baseCents: 2_200_00, quoteRequired: true, turnaroundDays: 12, requiresSeal: true, satisfies: [] },
  { key: 'DRAINAGE_GRADING', label: 'Drainage & grading plan', group: 'civil',
    baseCents: 1_100_00, quoteRequired: true, turnaroundDays: 8, requiresSeal: true, satisfies: [] },
  { key: 'STORMWATER_PLAN', label: 'Stormwater management plan', group: 'civil',
    baseCents: 1_400_00, quoteRequired: true, turnaroundDays: 10, requiresSeal: true,
    satisfies: ['environmental_permit'] },
  { key: 'PAVING_PLAN', label: 'Paving & parking plan', group: 'civil',
    baseCents: 900_00, quoteRequired: true, turnaroundDays: 7, requiresSeal: true, satisfies: [] },
  { key: 'UTILITY_PLAN', label: 'Utility connection plan', group: 'civil',
    baseCents: 850_00, quoteRequired: true, turnaroundDays: 7, requiresSeal: true, satisfies: [] },
  { key: 'LANDSCAPE_IRRIGATION', label: 'Landscape & irrigation plan', group: 'civil',
    baseCents: 700_00, quoteRequired: true, turnaroundDays: 6, requiresSeal: false, satisfies: [] },
  { key: 'SURVEY_COORDINATION', label: 'Survey coordination', group: 'civil',
    baseCents: 400_00, quoteRequired: true, turnaroundDays: 5, requiresSeal: false,
    satisfies: ['proof_of_ownership'],
    note: 'We commission and coordinate the surveyor; the survey itself is theirs.' },

  // --- Specialty structures -------------------------------------------------
  { key: 'POOL_SPA_PLANS', label: 'Pool & spa plans', group: 'specialty',
    baseCents: 950_00, quoteRequired: true, turnaroundDays: 7, requiresSeal: true, satisfies: [] },
  { key: 'SCREEN_ENCLOSURE', label: 'Screen enclosure plans', group: 'specialty',
    baseCents: 650_00, quoteRequired: true, turnaroundDays: 6, requiresSeal: true, satisfies: [] },
  { key: 'DOCK_SEAWALL', label: 'Dock, seawall & marine structures', group: 'specialty',
    baseCents: 1_600_00, quoteRequired: true, turnaroundDays: 12, requiresSeal: true,
    satisfies: ['submerged_lands', 'ccl_permit'] },
  { key: 'MODULAR_PLACEMENT', label: 'Modular / mobile home placement plans', group: 'specialty',
    baseCents: 700_00, quoteRequired: true, turnaroundDays: 6, requiresSeal: true, satisfies: [] },
  { key: 'SIGNAGE_PLANS', label: 'Signage plans', group: 'specialty',
    baseCents: 500_00, quoteRequired: true, turnaroundDays: 5, requiresSeal: true, satisfies: [] },

  // --- Calculations & product approval --------------------------------------
  { key: 'ENERGY_CALCS', label: 'Energy code calculations', group: 'calculations',
    baseCents: 350_00, quoteRequired: false, turnaroundDays: 3, requiresSeal: false,
    satisfies: ['energy_calc'] },
  { key: 'MANUAL_J_S_D', label: 'Manual J / S / D load calculations', group: 'calculations',
    baseCents: 450_00, quoteRequired: false, turnaroundDays: 4, requiresSeal: false,
    satisfies: ['energy_calc'] },
  { key: 'PRODUCT_APPROVAL_PACKAGE', label: 'Product approval / NOA package', group: 'calculations',
    baseCents: 350_00, quoteRequired: false, turnaroundDays: 3, requiresSeal: false,
    satisfies: ['product_approval'],
    note: 'Compiling the approvals and NOAs the department will ask for, matched to what was installed.' },
  { key: 'FLOOD_ELEVATION', label: 'Flood elevation certificate coordination', group: 'calculations',
    baseCents: 500_00, quoteRequired: true, turnaroundDays: 6, requiresSeal: false,
    satisfies: ['flood_elevation_cert', 'flood_vents'] },

  // --- Inspections & recertification ----------------------------------------
  { key: 'MILESTONE_INSPECTION_PHASE_1', label: 'Milestone inspection — phase one', group: 'inspections',
    baseCents: 3_500_00, quoteRequired: true, turnaroundDays: 21, requiresSeal: true,
    satisfies: [],
    note: 'Fla. Stat. 553.899. Condominium and cooperative buildings three storeys or more, at 30 years (25 within three miles of the coast), then every 10. Visual inspection by a Florida-licensed architect or engineer; sealed report to the association and the local building official.' },
  { key: 'MILESTONE_INSPECTION_PHASE_2', label: 'Milestone inspection — phase two', group: 'inspections',
    baseCents: 7_500_00, quoteRequired: true, turnaroundDays: 35, requiresSeal: true,
    satisfies: [],
    note: 'Only when phase one finds substantial structural deterioration. Includes destructive or non-destructive testing as the engineer directs.' },
  { key: 'BUILDING_RECERTIFICATION', label: 'Building recertification (40/50-year)', group: 'inspections',
    baseCents: 4_500_00, quoteRequired: true, turnaroundDays: 28, requiresSeal: true,
    satisfies: [],
    note: 'Miami-Dade and Broward county ordinance — structural AND electrical, by a Florida-licensed PE or architect. Distinct from the statewide milestone inspection; a building may owe both.' },
  { key: 'STRUCTURAL_INTEGRITY_RESERVE_STUDY', label: 'Structural integrity reserve study (SIRS)', group: 'inspections',
    baseCents: 5_500_00, quoteRequired: true, turnaroundDays: 30, requiresSeal: true,
    satisfies: [],
    note: 'Fla. Stat. 718.112(2)(g). Reserve funding study for the structural components; may be run alongside a milestone inspection.' },
  { key: 'THRESHOLD_INSPECTION', label: 'Threshold inspection services', group: 'inspections',
    baseCents: 6_000_00, quoteRequired: true, turnaroundDays: 30, requiresSeal: true,
    satisfies: ['threshold_inspector'],
    note: 'Continuous inspection of a threshold building by a special inspector, for the life of the structural work.' },
  { key: 'SPECIAL_INSPECTOR', label: 'Special inspector services', group: 'inspections',
    baseCents: 2_500_00, quoteRequired: true, turnaroundDays: 14, requiresSeal: true, satisfies: [] },
  { key: 'PRIVATE_PROVIDER_INSPECTION', label: 'Private provider plan review & inspection', group: 'inspections',
    baseCents: 3_000_00, quoteRequired: true, turnaroundDays: 14, requiresSeal: true,
    satisfies: [],
    note: 'Fla. Stat. 553.791. Plan review and inspections by a private provider instead of the building department.' },
  { key: 'WIND_MITIGATION_INSPECTION', label: 'Wind mitigation inspection (OIR-B1-1802)', group: 'inspections',
    baseCents: 250_00, quoteRequired: false, turnaroundDays: 5, requiresSeal: false, satisfies: [] },
  { key: 'FOUR_POINT_INSPECTION', label: 'Four-point inspection', group: 'inspections',
    baseCents: 250_00, quoteRequired: false, turnaroundDays: 5, requiresSeal: false,
    satisfies: [],
    note: 'Roof, electrical, plumbing and HVAC condition, for an insurer.' },
  { key: 'ROOF_CERTIFICATION', label: 'Roof condition certification', group: 'inspections',
    baseCents: 250_00, quoteRequired: false, turnaroundDays: 5, requiresSeal: false, satisfies: [] },
  { key: 'BALCONY_RAILING_INSPECTION', label: 'Balcony & railing inspection', group: 'inspections',
    baseCents: 1_800_00, quoteRequired: true, turnaroundDays: 14, requiresSeal: true, satisfies: [] },
  { key: 'ELEVATOR_RECERTIFICATION', label: 'Elevator recertification coordination', group: 'inspections',
    baseCents: 900_00, quoteRequired: true, turnaroundDays: 14, requiresSeal: false, satisfies: [] },

  // --- Revisions & resubmittals ---------------------------------------------
  { key: 'REVISION', label: 'Plan revision', group: 'revisions',
    baseCents: 300_00, quoteRequired: false, turnaroundDays: 3, requiresSeal: false, satisfies: [] },
  { key: 'DELTA_REVISION', label: 'Delta revision (post-permit)', group: 'revisions',
    baseCents: 450_00, quoteRequired: true, turnaroundDays: 5, requiresSeal: true,
    satisfies: [],
    note: 'A change to plans already approved, clouded and deltaed for the reviewer.' },
  { key: 'CORRECTION_RESPONSE', label: 'Correction response package', group: 'revisions',
    baseCents: 350_00, quoteRequired: false, turnaroundDays: 4, requiresSeal: false,
    satisfies: [],
    note: 'Answering a plan reviewer\u2019s comments, item by item, with the revised sheets.' },
];

/*
 * As-built records, generated from the shared trade list.
 *
 * The PLAN SET and the LETTER are different deliverables and both are
 * orderable: a department asking for one will not take the other. The letter
 * services are derived per trade so the catalogue cannot offer a letter the
 * document generator has no template for.
 */
const AS_BUILT_SERVICES: DraftingServiceSpec[] = [
  { key: 'AS_BUILT', label: 'As-built plan set (all trades)', group: 'as_built',
    baseCents: 750_00, quoteRequired: true, turnaroundDays: 6, requiresSeal: false,
    satisfies: [],
    note: 'The approved drawings revised to show what was actually built.' },
  ...AS_BUILT_TRADES.map((trade) => ({
    key: `AS_BUILT_PLANS_${trade}`,
    label: `As-built plans \u2014 ${AS_BUILT_TRADE_LABELS[trade]}`,
    group: 'as_built',
    baseCents: 550_00,
    quoteRequired: true,
    turnaroundDays: 6,
    requiresSeal: false,
    satisfies: [] as string[],
  })),
  ...AS_BUILT_TRADES.map((trade) => ({
    key: asBuiltLetterService(trade),
    label: `As-built letter \u2014 ${AS_BUILT_TRADE_LABELS[trade]}`,
    group: 'as_built',
    baseCents: 150_00,
    quoteRequired: false,
    turnaroundDays: 3,
    requiresSeal: false,
    satisfies: [] as string[],
    note: 'Signed by the licensed trade contractor, certifying the work against the approved plans.',
  })),
];

export const DRAFTING_CATALOGUE: readonly DraftingServiceSpec[] = [...C, ...AS_BUILT_SERVICES];

export const DRAFTING_SERVICES = DRAFTING_CATALOGUE.map((s) => s.key);
export type DraftingService = string;

export const DRAFTING_LABELS: Record<string, string> = Object.fromEntries(
  DRAFTING_CATALOGUE.map((s) => [s.key, s.label]),
);

/** Which requirement keys a delivered service is expected to satisfy. */
export const DRAFTING_SATISFIES: Record<string, string[]> = Object.fromEntries(
  DRAFTING_CATALOGUE.map((s) => [s.key, s.satisfies]),
);

/**
 * How the catalogue is grouped when somebody is choosing from it.
 *
 * Grouping is not decoration: on the other side of the counter the work is
 * assigned by discipline, one plans examiner each, and life safety goes to the
 * fire marshal entirely. With sixty-odd services a flat list is unusable.
 */
const GROUP_ORDER: Array<{ key: string; label: string; hint: string }> = [
  { key: 'architectural', label: 'Architectural & site', hint: 'The plan set and what it sits on.' },
  { key: 'structural', label: 'Structural', hint: 'Anything a Florida PE has to seal for load or uplift.' },
  { key: 'mep', label: 'Mechanical, electrical & plumbing', hint: 'Reviewed as separate disciplines. Order them separately, or take the combined package.' },
  { key: 'life_safety', label: 'Fire & life safety', hint: 'Reviewed by the fire marshal, not the building department.' },
  { key: 'civil', label: 'Civil & site engineering', hint: 'Drainage, paving, utilities and what the county water district wants.' },
  { key: 'specialty', label: 'Specialty structures', hint: 'Pools, docks, enclosures and signs.' },
  { key: 'calculations', label: 'Calculations & product approval', hint: 'The supporting arithmetic a reviewer asks for.' },
  { key: 'as_built', label: 'As-built records', hint: 'Plans show what was built; letters certify it. Departments ask for one or the other, and sometimes both.' },
  { key: 'inspections', label: 'Inspections & recertification', hint: 'Milestone, recertification, threshold and the insurer\u2019s reports.' },
  { key: 'revisions', label: 'Revisions & resubmittals', hint: '' },
];

export const DRAFTING_GROUPS: ReadonlyArray<{
  key: string;
  label: string;
  hint: string;
  services: readonly string[];
}> = GROUP_ORDER.map((g) => ({
  ...g,
  services: DRAFTING_CATALOGUE.filter((s) => s.group === g.key).map((s) => s.key),
}));

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

/**
 * The price book, derived from the one catalogue above.
 *
 * Was a second hand-maintained list; a service present in one and not the
 * other rendered on the screen with no price and no turnaround beside it.
 */
export const DEFAULT_DRAFTING_RATES: DraftingRate[] = DRAFTING_CATALOGUE.map((s) => ({
  service: s.key,
  baseCents: s.baseCents,
  quoteRequired: s.quoteRequired,
  typicalTurnaroundDays: s.turnaroundDays,
  requiresSeal: s.requiresSeal,
  active: true,
}));

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

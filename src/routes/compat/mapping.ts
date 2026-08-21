/**
 * Translation between this backend's schema and the contract the existing
 * React frontend expects.
 *
 * The frontend is a compiled bundle: its field names, enum spellings and
 * response shapes are fixed and cannot be changed from here. So this file
 * adapts, and it is the ONLY place that does. Every compatibility handler
 * translates through these helpers rather than hand-rolling its own mapping,
 * because a second, slightly different mapping somewhere else is how two
 * screens end up disagreeing about what "issued" means.
 *
 * All names and values below were read from the previous implementation
 * (netlify/functions/api.mjs), not guessed.
 */

/** The stage vocabulary compiled into the frontend. Order is significant. */
export const PERMIT_STAGES = [
  'DRAFT',
  'READY_TO_SUBMIT',
  'SUBMITTED',
  'INTAKE_REVIEW',
  'IN_REVIEW',
  'CORRECTIONS_REQUIRED',
  'RESUBMITTED',
  'APPROVED',
  'ISSUED',
  'INSPECTIONS',
  'CLOSED',
  'EXPIRED',
  'WITHDRAWN',
  'DENIED',
] as const;

export type PermitStage = (typeof PERMIT_STAGES)[number];

/** Stages a permit does not come back from. Mirrors their TERMINAL_STAGES. */
export const TERMINAL_STAGES: PermitStage[] = ['CLOSED', 'EXPIRED', 'WITHDRAWN', 'DENIED'];

export const SERVICE_LINES = ['EXPEDITING', 'MANAGED_LICENSE'] as const;

/**
 * ocs.permit_status -> the frontend's stage.
 *
 * INTAKE_REVIEW has no counterpart in this schema; it stays reachable in the
 * vocabulary (the frontend renders a column for it) but nothing maps onto it.
 * `rejected` maps to DENIED, which is the word the frontend uses.
 */
const STATUS_TO_STAGE: Record<string, PermitStage> = {
  draft: 'DRAFT',
  ready_to_submit: 'READY_TO_SUBMIT',
  submitted: 'SUBMITTED',
  under_review: 'IN_REVIEW',
  corrections_required: 'CORRECTIONS_REQUIRED',
  resubmitted: 'RESUBMITTED',
  approved: 'APPROVED',
  issued: 'ISSUED',
  inspections: 'INSPECTIONS',
  closed: 'CLOSED',
  expired: 'EXPIRED',
  withdrawn: 'WITHDRAWN',
  rejected: 'DENIED',
};

export function toStage(status: string | null | undefined): PermitStage {
  return STATUS_TO_STAGE[String(status ?? '').toLowerCase()] ?? 'DRAFT';
}

/** The reverse, for writes coming from the frontend. */
export function fromStage(stage: string): string | null {
  const found = Object.entries(STATUS_TO_STAGE).find(([, s]) => s === stage.toUpperCase());
  return found?.[0] ?? null;
}

export function isActiveStage(stage: PermitStage): boolean {
  return !TERMINAL_STAGES.includes(stage);
}

/**
 * A pipeline histogram with EVERY stage present, including the empty ones.
 *
 * This is load-bearing. The frontend reads stage buckets by name
 * (`pipelineByStage.CLOSED` and similar) and crashes on undefined — the blank
 * dashboard that appeared during integration was exactly this. Returning only
 * the non-zero buckets is not a smaller answer, it is a broken one.
 */
export function emptyPipeline(): Record<PermitStage, number> {
  return Object.fromEntries(PERMIT_STAGES.map((s) => [s, 0])) as Record<PermitStage, number>;
}

/** Our trade / permit_type text -> their TRADES vocabulary. */
const TRADE_PATTERNS: Array<[RegExp, string]> = [
  [/roof/i, 'ROOFING'],
  [/electric/i, 'ELECTRICAL'],
  [/plumb/i, 'PLUMBING'],
  [/mechanical|hvac|air.?condition/i, 'MECHANICAL'],
  [/pool|spa/i, 'POOL'],
  [/solar|photovolt/i, 'SOLAR'],
  [/building|construction|addition|alteration|residential/i, 'BUILDING'],
];

export function toTrade(permitType: string | null | undefined): string {
  const value = String(permitType ?? '');
  for (const [pattern, trade] of TRADE_PATTERNS) {
    if (pattern.test(value)) return trade;
  }
  return 'SPECIALTY';
}

/**
 * Days a permit has sat in its current stage.
 *
 * Uses updated_at as the entry time. That is an approximation: this schema
 * records exact transitions in ocs.permit_status_history, and a later pass
 * should read them. It is called out here rather than left silent so the number
 * is not mistaken for exact.
 */
export function daysInStage(updatedAt: string | Date | null): number {
  if (!updatedAt) return 0;
  const t = updatedAt instanceof Date ? updatedAt.getTime() : Date.parse(updatedAt);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

/**
 * How overdue a permit looks, and why.
 *
 * A simplified version of their risk model: theirs weights against measured
 * per-jurisdiction review times, which this backend has not accumulated yet.
 * Until it has, the baselines below are stated conservatively rather than
 * dressed up as measurements — an invented median review time would make the
 * dashboard look authoritative about something it does not know.
 */
const STAGE_BASELINE_DAYS: Partial<Record<PermitStage, number>> = {
  SUBMITTED: 10,
  INTAKE_REVIEW: 5,
  IN_REVIEW: 21,
  CORRECTIONS_REQUIRED: 14,
  RESUBMITTED: 14,
  APPROVED: 7,
};

export interface RiskAssessment {
  level: 'ON_TRACK' | 'WATCH' | 'AT_RISK' | 'CRITICAL';
  score: number;
  daysInStage: number;
  baselineDays: number | null;
  reasons: string[];
}

export function assessRisk(permit: {
  stage: PermitStage;
  updatedAt: string | Date | null;
  expiresAt: string | Date | null;
}): RiskAssessment {
  const days = daysInStage(permit.updatedAt);
  const baseline = STAGE_BASELINE_DAYS[permit.stage] ?? null;
  const reasons: string[] = [];
  let score = 0;

  if (baseline !== null && days > baseline) {
    const over = days - baseline;
    score += Math.min(60, over * 2);
    reasons.push(`${over} day(s) past the typical ${baseline}-day ${permit.stage.toLowerCase().replace(/_/g, ' ')} window`);
  }

  if (permit.stage === 'CORRECTIONS_REQUIRED') {
    // Corrections start a clock the contractor owns, so they outrank a permit
    // simply waiting on a reviewer.
    score += 25;
    reasons.push('Corrections are outstanding with the jurisdiction');
  }

  if (permit.expiresAt) {
    const expiry = permit.expiresAt instanceof Date ? permit.expiresAt.getTime() : Date.parse(permit.expiresAt);
    if (Number.isFinite(expiry)) {
      const daysLeft = Math.floor((expiry - Date.now()) / 86_400_000);
      if (daysLeft < 0) {
        score += 50;
        reasons.push('Permit has expired');
      } else if (daysLeft <= 30) {
        score += 20;
        reasons.push(`Expires in ${daysLeft} day(s)`);
      }
    }
  }

  const level =
    score >= 60 ? 'CRITICAL' : score >= 35 ? 'AT_RISK' : score >= 15 ? 'WATCH' : 'ON_TRACK';

  return { level, score, daysInStage: days, baselineDays: baseline, reasons };
}

/** ocs.permit_platform -> the frontend's platform label. */
export function toPlatformLabel(platform: string | null | undefined): string {
  return platform && platform !== 'none' ? platform : 'unknown';
}

/**
 * Integration tier for a jurisdiction.
 *
 * 'manual' unless automated checking is actually verified and switched on —
 * the same conservative rule the status-check adapter applies. A jurisdiction
 * that merely has configuration is not automated.
 */
export function toIntegrationTier(row: {
  status_check_enabled?: boolean;
  adapter_verified_at?: string | null;
  platform?: string | null;
}): string {
  if (row.status_check_enabled && row.adapter_verified_at) return 'api';
  if (row.platform && row.platform !== 'none') return 'portal';
  return 'manual';
}

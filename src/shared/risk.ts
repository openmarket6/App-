import { AGENCY_HELD_STAGES, APPLICANT_HELD_STAGES, TERMINAL_STAGES } from './enums.js';
import type { Jurisdiction, Permit, RiskAssessment } from './types.js';

/**
 * Risk is jurisdiction-relative.
 *
 * 30 days in review in Miami-Dade is normal; 30 days in a small county is a
 * problem. Scoring against a global constant produces a dashboard that is
 * either all red or all green depending on your client mix, which is useless.
 * We score against each jurisdiction's OWN measured median review time,
 * recomputed from our real submittal history.
 */

/** Used only until a jurisdiction has enough of our own submittals to measure. */
const FALLBACK_BASELINE_DAYS = 21;
const MIN_SAMPLE_FOR_MEASURED_BASELINE = 5;

const DAY_MS = 86_400_000;

export function daysBetween(a: string | Date, b: string | Date = new Date()): number {
  const t1 = typeof a === 'string' ? Date.parse(a) : a.getTime();
  const t2 = typeof b === 'string' ? Date.parse(b) : b.getTime();
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return 0;
  return Math.max(0, Math.floor((t2 - t1) / DAY_MS));
}

export function baselineFor(j: Pick<Jurisdiction, 'medianReviewDays' | 'reviewSampleSize'>): number | null {
  if (j.medianReviewDays != null && j.reviewSampleSize >= MIN_SAMPLE_FOR_MEASURED_BASELINE) {
    return j.medianReviewDays;
  }
  return null;
}

export interface RiskInput {
  permit: Pick<
    Permit,
    'stage' | 'submittedAt' | 'expiresAt' | 'updatedAt' | 'correctionCycles' | 'unmappedStatus' | 'lastSyncedAt'
  >;
  jurisdiction: Pick<Jurisdiction, 'medianReviewDays' | 'reviewSampleSize' | 'paperOnly'>;
  now?: Date;
}

export function assessRisk({ permit, jurisdiction, now = new Date() }: RiskInput): RiskAssessment {
  const reasons: string[] = [];
  const measured = baselineFor(jurisdiction);
  const baseline = measured ?? FALLBACK_BASELINE_DAYS;
  const anchor = permit.submittedAt ?? permit.updatedAt;
  const daysInStage = daysBetween(anchor, now);

  // Short-circuits. These are facts, not scores — an expired permit is CRITICAL
  // regardless of what an additive score would have concluded. An earlier
  // version let the score decide and graded an already-expired permit AT_RISK.
  if (permit.expiresAt && Date.parse(permit.expiresAt) < now.getTime() && !TERMINAL_STAGES.includes(permit.stage)) {
    return {
      level: 'CRITICAL',
      score: 100,
      reasons: ['Permit is past its expiration date and not closed out'],
      daysInStage,
      baselineDays: measured,
    };
  }

  if (TERMINAL_STAGES.includes(permit.stage)) {
    return { level: 'ON_TRACK', score: 0, reasons: ['Terminal stage'], daysInStage, baselineDays: measured };
  }

  let score = 0;

  if (AGENCY_HELD_STAGES.includes(permit.stage)) {
    const ratio = daysInStage / baseline;
    if (ratio >= 2) {
      score += 45;
      reasons.push(
        `${daysInStage}d with the agency — ${ratio.toFixed(1)}x this jurisdiction's ${baseline}d median`,
      );
    } else if (ratio >= 1.5) {
      score += 30;
      reasons.push(`${daysInStage}d with the agency vs a ${baseline}d median here`);
    } else if (ratio >= 1) {
      score += 15;
      reasons.push(`Past this jurisdiction's ${baseline}d median review time`);
    }
  }

  if (APPLICANT_HELD_STAGES.includes(permit.stage)) {
    if (daysInStage >= 14) {
      score += 35;
      reasons.push(`${daysInStage}d sitting on our side of the desk`);
    } else if (daysInStage >= 7) {
      score += 20;
      reasons.push(`${daysInStage}d awaiting action from us or the client`);
    }
  }

  if (permit.correctionCycles >= 3) {
    score += 30;
    reasons.push(`${permit.correctionCycles} correction cycles — escalate to the plans examiner`);
  } else if (permit.correctionCycles === 2) {
    score += 15;
    reasons.push('Second correction cycle');
  }

  if (permit.expiresAt) {
    const daysToExpiry = Math.floor((Date.parse(permit.expiresAt) - now.getTime()) / DAY_MS);
    if (daysToExpiry <= 14) {
      score += 30;
      reasons.push(`Expires in ${daysToExpiry}d`);
    } else if (daysToExpiry <= 30) {
      score += 15;
      reasons.push(`Expires in ${daysToExpiry}d`);
    }
  }

  if (permit.unmappedStatus) {
    score += 10;
    reasons.push(`Agency status "${permit.unmappedStatus}" is not mapped — stage may be stale`);
  }

  // Staleness of our own data is a risk in its own right, and it is worse in
  // paper-only jurisdictions where nothing polls.
  if (permit.lastSyncedAt) {
    const staleDays = daysBetween(permit.lastSyncedAt, now);
    const staleLimit = jurisdiction.paperOnly ? 10 : 5;
    if (staleDays > staleLimit * 2) {
      score += 15;
      reasons.push(`No status update in ${staleDays}d`);
    } else if (staleDays > staleLimit) {
      score += 8;
      reasons.push(`Status ${staleDays}d old`);
    }
  }

  const level = score >= 70 ? 'CRITICAL' : score >= 45 ? 'AT_RISK' : score >= 20 ? 'WATCH' : 'ON_TRACK';
  if (reasons.length === 0) reasons.push('Within normal parameters for this jurisdiction');

  return { level, score: Math.min(100, score), reasons, daysInStage, baselineDays: measured };
}

/** Recompute a jurisdiction's median review time from our own observed submittals. */
export function recomputeJurisdictionMetrics(
  observations: Array<{ submittedAt: string; decidedAt: string }>,
): { medianReviewDays: number | null; reviewSampleSize: number } {
  const spans = observations
    .map((o) => daysBetween(o.submittedAt, o.decidedAt))
    .filter((d) => Number.isFinite(d) && d >= 0)
    .sort((a, b) => a - b);
  if (spans.length === 0) return { medianReviewDays: null, reviewSampleSize: 0 };
  const mid = Math.floor(spans.length / 2);
  const median =
    spans.length % 2 === 0 ? Math.round(((spans[mid - 1] ?? 0) + (spans[mid] ?? 0)) / 2) : (spans[mid] ?? 0);
  return { medianReviewDays: median, reviewSampleSize: spans.length };
}

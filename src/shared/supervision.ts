import type { ID } from './types.js';

/**
 * Supervision evidence.
 *
 * On the managed-license service line our qualifier's licence is on the
 * permit, which makes us the contractor of record and makes supervision a
 * legal obligation rather than a service feature. Florida prosecutes
 * qualifiers who lend a licence to work they do not actually supervise, and
 * the defence is not a sworn statement — it is a contemporaneous record.
 *
 * So this module exists to produce that record as a by-product of the PM
 * doing their job: who supervised, when they were on site, what they saw,
 * and photographs stamped at the moment of capture. If supervision was real,
 * this should be printable. If it was not, no schema should be able to make
 * it look like it was — which is why every field here is an observation and
 * none of them are back-datable through the API.
 */

export const SITE_VISIT_PURPOSES = [
  'PRE_CONSTRUCTION',
  'PROGRESS',
  'PRE_INSPECTION',
  'INSPECTION_ATTENDANCE',
  'CORRECTIVE',
  'FINAL',
] as const;
export type SiteVisitPurpose = (typeof SITE_VISIT_PURPOSES)[number];

export const SITE_VISIT_PURPOSE_LABELS: Record<SiteVisitPurpose, string> = {
  PRE_CONSTRUCTION: 'Pre-construction walk',
  PROGRESS: 'Progress supervision',
  PRE_INSPECTION: 'Pre-inspection check',
  INSPECTION_ATTENDANCE: 'Attended agency inspection',
  CORRECTIVE: 'Corrective direction',
  FINAL: 'Final walk',
};

export interface GeoPoint {
  lat: number;
  lng: number;
  /** Metres. Browser geolocation accuracy, recorded so a reviewer can judge it. */
  accuracyM: number | null;
}

export interface SiteVisit {
  id: ID;
  permitId: ID;
  projectId: ID;
  clientId: ID;
  /** The PM who was physically present. Not the person who typed it in. */
  supervisorUserId: ID;
  purpose: SiteVisitPurpose;
  /** When the PM says they arrived. */
  occurredAt: string;
  /** When the record was actually written. A wide gap between these two is
   *  itself a signal, so we keep both rather than one "date" field. */
  recordedAt: string;
  location: GeoPoint | null;
  /** What was observed and what was directed. Free text, required, no template. */
  observations: string;
  /** Direction given to the trades on site. */
  directionGiven: string | null;
  photoDocumentIds: ID[];
  /** Set if a coordinator edited the narrative after the fact. Never silent. */
  amendedAt: string | null;
  amendedBy: ID | null;
  amendmentReason: string | null;
}

export interface QualifyingAgent {
  id: ID;
  name: string;
  /** DBPR licence number, e.g. CGC1234567. */
  licenseNumber: string;
  licenseType: string;
  licenseExpiresAt: string | null;
  /** Our internal user record for this person, when they log in. */
  userId: ID | null;
  active: boolean;
  /** Hard cap on concurrent managed permits under this licence. A qualifier who
   *  cannot physically supervise 200 jobs should not be on 200 permits. */
  maxConcurrentPermits: number | null;
}

export interface SupervisionRequirement {
  /** Minimum visits before we will let the permit reach INSPECTIONS. */
  minVisitsBeforeInspections: number;
  /** Must a PM attend agency inspections in person? */
  requireInspectionAttendance: boolean;
  /** Longest acceptable gap between site visits on an active job, in days. */
  maxDaysBetweenVisits: number;
  /** Photos required per visit for the record to count. */
  minPhotosPerVisit: number;
}

export const DEFAULT_SUPERVISION_REQUIREMENT: SupervisionRequirement = {
  minVisitsBeforeInspections: 2,
  requireInspectionAttendance: true,
  maxDaysBetweenVisits: 14,
  minPhotosPerVisit: 2,
};

export interface SupervisionGap {
  kind: 'no_supervisor' | 'too_few_visits' | 'visit_overdue' | 'thin_photo_record' | 'qualifier_over_capacity' | 'license_expired';
  severity: 'blocking' | 'warning';
  detail: string;
}

export interface SupervisionVerdict {
  /** Whether the supervision record currently supports the licence being on this permit. */
  defensible: boolean;
  gaps: SupervisionGap[];
  visitCount: number;
  lastVisitAt: string | null;
  daysSinceLastVisit: number | null;
}

const DAY_MS = 86_400_000;

export function assessSupervision(input: {
  visits: SiteVisit[];
  supervisorUserId: ID | null;
  qualifier: Pick<QualifyingAgent, 'licenseExpiresAt' | 'maxConcurrentPermits'> | null;
  qualifierActivePermits: number;
  stage: string;
  requirement?: SupervisionRequirement;
  now?: Date;
}): SupervisionVerdict {
  const req = input.requirement ?? DEFAULT_SUPERVISION_REQUIREMENT;
  const now = input.now ?? new Date();
  const visits = [...input.visits].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  const gaps: SupervisionGap[] = [];

  if (!input.supervisorUserId) {
    gaps.push({
      kind: 'no_supervisor',
      severity: 'blocking',
      detail: 'No project manager assigned. A managed-licence permit without a named supervisor has no defensible basis.',
    });
  }

  if (input.qualifier?.licenseExpiresAt) {
    const exp = Date.parse(input.qualifier.licenseExpiresAt);
    if (Number.isFinite(exp) && exp < now.getTime()) {
      gaps.push({ kind: 'license_expired', severity: 'blocking', detail: "The qualifying agent's licence has expired." });
    }
  }

  if (input.qualifier?.maxConcurrentPermits != null && input.qualifierActivePermits > input.qualifier.maxConcurrentPermits) {
    gaps.push({
      kind: 'qualifier_over_capacity',
      severity: 'blocking',
      detail: `This qualifier is on ${input.qualifierActivePermits} active permits against a self-imposed cap of ${input.qualifier.maxConcurrentPermits}. Capacity you cannot supervise is the exact pattern regulators look for.`,
    });
  }

  const activeStages = ['ISSUED', 'INSPECTIONS'];
  if (activeStages.includes(input.stage) && visits.length < req.minVisitsBeforeInspections) {
    gaps.push({
      kind: 'too_few_visits',
      severity: 'blocking',
      detail: `${visits.length} site visit${visits.length === 1 ? '' : 's'} logged against a minimum of ${req.minVisitsBeforeInspections} before inspections.`,
    });
  }

  const last = visits[0] ?? null;
  const daysSince = last ? Math.floor((now.getTime() - Date.parse(last.occurredAt)) / DAY_MS) : null;
  if (activeStages.includes(input.stage) && daysSince != null && daysSince > req.maxDaysBetweenVisits) {
    gaps.push({
      kind: 'visit_overdue',
      severity: 'warning',
      detail: `${daysSince} days since the last site visit, against a ${req.maxDaysBetweenVisits}-day standard.`,
    });
  }

  const thin = visits.filter((v) => v.photoDocumentIds.length < req.minPhotosPerVisit).length;
  if (thin > 0) {
    gaps.push({
      kind: 'thin_photo_record',
      severity: 'warning',
      detail: `${thin} visit${thin === 1 ? '' : 's'} logged with fewer than ${req.minPhotosPerVisit} photos. Photographs are the part of this record that is hard to dispute.`,
    });
  }

  return {
    defensible: !gaps.some((g) => g.severity === 'blocking'),
    gaps,
    visitCount: visits.length,
    lastVisitAt: last?.occurredAt ?? null,
    daysSinceLastVisit: daysSince,
  };
}

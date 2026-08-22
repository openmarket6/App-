import type { Cents, ID } from './types.js';

/**
 * Contractor compliance.
 *
 * The operational point of this module is not filing cabinets — it is the
 * blocking rule at the bottom. A permit filed under a contractor whose general
 * liability lapsed three weeks ago is a problem that surfaces at the worst
 * possible moment, usually at inspection. So expiration is not a reminder
 * feature, it is a gate: the pipeline asks this module whether a contractor is
 * clear to file, and the answer is computed from documents we actually hold.
 */

export const COMPLIANCE_KINDS = [
  'GENERAL_LIABILITY',
  'WORKERS_COMP',
  'WORKERS_COMP_EXEMPTION',
  'AUTO_LIABILITY',
  'EXCESS_UMBRELLA',
  'PROFESSIONAL_LIABILITY',
  'STATE_LICENSE',
  'LOCAL_REGISTRATION',
  'BUSINESS_TAX_RECEIPT',
  'W9',
  'CERT_OF_INSURANCE',
  'BOND',
] as const;
export type ComplianceKind = (typeof COMPLIANCE_KINDS)[number];

export const COMPLIANCE_LABELS: Record<ComplianceKind, string> = {
  GENERAL_LIABILITY: 'General liability insurance',
  WORKERS_COMP: "Workers' compensation insurance",
  WORKERS_COMP_EXEMPTION: "Workers' comp exemption certificate",
  AUTO_LIABILITY: 'Commercial auto liability',
  EXCESS_UMBRELLA: 'Excess / umbrella liability',
  PROFESSIONAL_LIABILITY: 'Professional liability (E&O)',
  STATE_LICENSE: 'State contractor license',
  LOCAL_REGISTRATION: 'Local registration',
  BUSINESS_TAX_RECEIPT: 'Business tax receipt',
  W9: 'IRS Form W-9',
  CERT_OF_INSURANCE: 'Certificate of insurance (ACORD)',
  BOND: 'Surety bond',
};

/**
 * Items without an expiry are point-in-time records. A W-9 does not expire on
 * a date; it goes stale when the business details change, which is a different
 * kind of problem and should not be modelled as an expiration.
 */
export const NON_EXPIRING_KINDS: readonly ComplianceKind[] = ['W9'];

export const COMPLIANCE_STATUSES = [
  'MISSING',
  'PENDING_REVIEW',
  'VALID',
  'EXPIRING_SOON',
  'EXPIRED',
  'REJECTED',
  'WAIVED',
] as const;
export type ComplianceStatus = (typeof COMPLIANCE_STATUSES)[number];

export interface ComplianceItem {
  id: ID;
  clientId: ID;
  kind: ComplianceKind;
  /** Insurer or issuing authority. */
  carrier: string | null;
  policyNumber: string | null;
  /** Per-occurrence limit, integer cents. */
  limitPerOccurrenceCents: Cents | null;
  /** Aggregate limit, integer cents. */
  limitAggregateCents: Cents | null;
  effectiveDate: string | null;
  expiresAt: string | null;
  /** The uploaded artifact backing this record. */
  documentId: ID | null;
  status: ComplianceStatus;
  /** Set when a coordinator rejects an upload, so the contractor sees why. */
  reviewNote: string | null;
  reviewedBy: ID | null;
  reviewedAt: string | null;
  /** Deliberate exception, e.g. an owner-operator with a filed WC exemption. */
  waivedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What we require before a contractor may have permits filed under their license. */
export interface ComplianceRequirementSpec {
  kind: ComplianceKind;
  required: boolean;
  /** Minimum per-occurrence limit we will accept, integer cents. Null = no minimum. */
  minLimitPerOccurrenceCents: Cents | null;
  /** Does an expired copy block filing, or only warn? */
  blocksFiling: boolean;
  note: string | null;
}

/**
 * Firm default policy. Editable per firm in settings — these numbers are a
 * starting point drawn from what Florida jurisdictions and most GCs ask for,
 * not a legal minimum. Confirm against your own carrier and counsel.
 */
export const DEFAULT_COMPLIANCE_POLICY: ComplianceRequirementSpec[] = [
  { kind: 'GENERAL_LIABILITY', required: true, minLimitPerOccurrenceCents: 1_000_000_00, blocksFiling: true, note: 'Most FL jurisdictions and GCs expect $1M per occurrence / $2M aggregate.' },
  { kind: 'WORKERS_COMP', required: true, minLimitPerOccurrenceCents: null, blocksFiling: true, note: 'Or a filed exemption certificate — see below.' },
  { kind: 'WORKERS_COMP_EXEMPTION', required: false, minLimitPerOccurrenceCents: null, blocksFiling: false, note: 'Satisfies the workers comp requirement for qualifying officers with a state-filed exemption.' },
  { kind: 'STATE_LICENSE', required: true, minLimitPerOccurrenceCents: null, blocksFiling: true, note: 'Active DBPR or county competency card.' },
  { kind: 'AUTO_LIABILITY', required: true, minLimitPerOccurrenceCents: 1_000_000_00, blocksFiling: false, note: 'Commercial auto — required on file, warns rather than blocks.' },
  { kind: 'W9', required: true, minLimitPerOccurrenceCents: null, blocksFiling: false, note: 'Needed for 1099 reporting.' },
  { kind: 'CERT_OF_INSURANCE', required: false, minLimitPerOccurrenceCents: null, blocksFiling: false, note: 'ACORD certificate naming the firm as certificate holder.' },
  { kind: 'EXCESS_UMBRELLA', required: false, minLimitPerOccurrenceCents: null, blocksFiling: false, note: null },
  { kind: 'PROFESSIONAL_LIABILITY', required: false, minLimitPerOccurrenceCents: null, blocksFiling: false, note: null },
  { kind: 'LOCAL_REGISTRATION', required: false, minLimitPerOccurrenceCents: null, blocksFiling: false, note: 'Some jurisdictions require separate contractor registration before they will accept a filing.' },
  { kind: 'BUSINESS_TAX_RECEIPT', required: false, minLimitPerOccurrenceCents: null, blocksFiling: false, note: null },
  { kind: 'BOND', required: false, minLimitPerOccurrenceCents: null, blocksFiling: false, note: null },
];

export const EXPIRING_SOON_DAYS = 30;

const DAY_MS = 86_400_000;

export function computeComplianceStatus(
  item: Pick<ComplianceItem, 'kind' | 'expiresAt' | 'status'>,
  now: Date = new Date(),
): ComplianceStatus {
  // Human decisions win over date math.
  if (item.status === 'REJECTED' || item.status === 'WAIVED' || item.status === 'PENDING_REVIEW') return item.status;
  if (item.status === 'MISSING') return 'MISSING';
  if (NON_EXPIRING_KINDS.includes(item.kind) || !item.expiresAt) return 'VALID';

  const exp = Date.parse(item.expiresAt);
  if (!Number.isFinite(exp)) return 'VALID';
  const daysLeft = Math.floor((exp - now.getTime()) / DAY_MS);
  if (daysLeft < 0) return 'EXPIRED';
  if (daysLeft <= EXPIRING_SOON_DAYS) return 'EXPIRING_SOON';
  return 'VALID';
}

export function daysUntilExpiry(item: Pick<ComplianceItem, 'expiresAt'>, now: Date = new Date()): number | null {
  if (!item.expiresAt) return null;
  const exp = Date.parse(item.expiresAt);
  if (!Number.isFinite(exp)) return null;
  return Math.floor((exp - now.getTime()) / DAY_MS);
}

export interface ComplianceGap {
  kind: ComplianceKind;
  label: string;
  status: ComplianceStatus;
  blocksFiling: boolean;
  daysUntilExpiry: number | null;
  detail: string;
}

export interface ComplianceVerdict {
  /** False when anything blocking is missing, expired or rejected. */
  clearedToFile: boolean;
  gaps: ComplianceGap[];
  /** Everything on file and current, expressed 0-100 for the onboarding meter. */
  completeness: number;
  nextExpiry: { kind: ComplianceKind; expiresAt: string; days: number } | null;
}

export function assessCompliance(
  items: ComplianceItem[],
  policy: ComplianceRequirementSpec[] = DEFAULT_COMPLIANCE_POLICY,
  now: Date = new Date(),
): ComplianceVerdict {
  const byKind = new Map<ComplianceKind, ComplianceItem>();
  for (const it of items) {
    const current = byKind.get(it.kind);
    // Keep the copy that expires latest — contractors upload renewals alongside
    // the old certificate rather than replacing it.
    if (!current) byKind.set(it.kind, it);
    else if ((Date.parse(it.expiresAt ?? '') || 0) > (Date.parse(current.expiresAt ?? '') || 0)) byKind.set(it.kind, it);
  }

  const hasValidExemption = (() => {
    const ex = byKind.get('WORKERS_COMP_EXEMPTION');
    if (!ex) return false;
    const st = computeComplianceStatus(ex, now);
    return st === 'VALID' || st === 'EXPIRING_SOON';
  })();

  const gaps: ComplianceGap[] = [];
  let satisfied = 0;
  let requiredCount = 0;

  for (const spec of policy) {
    if (!spec.required) continue;
    requiredCount++;

    // A filed exemption certificate stands in for a workers comp policy.
    if (spec.kind === 'WORKERS_COMP' && hasValidExemption) {
      satisfied++;
      continue;
    }

    const item = byKind.get(spec.kind);
    const status = item ? computeComplianceStatus(item, now) : 'MISSING';
    const days = item ? daysUntilExpiry(item, now) : null;

    const limitShort =
      spec.minLimitPerOccurrenceCents != null &&
      item?.limitPerOccurrenceCents != null &&
      item.limitPerOccurrenceCents < spec.minLimitPerOccurrenceCents;

    if (status === 'VALID' && !limitShort) {
      satisfied++;
      continue;
    }
    if (status === 'EXPIRING_SOON' && !limitShort) {
      satisfied++;
      gaps.push({
        kind: spec.kind,
        label: COMPLIANCE_LABELS[spec.kind],
        status,
        blocksFiling: false,
        daysUntilExpiry: days,
        detail: `Expires in ${days} day${days === 1 ? '' : 's'} — request the renewal certificate now.`,
      });
      continue;
    }

    gaps.push({
      kind: spec.kind,
      label: COMPLIANCE_LABELS[spec.kind],
      status: limitShort && status === 'VALID' ? 'REJECTED' : status,
      blocksFiling: spec.blocksFiling,
      daysUntilExpiry: days,
      detail: limitShort
        ? `On file, but the per-occurrence limit is below the ${(spec.minLimitPerOccurrenceCents! / 100_000_0).toFixed(0)}M minimum.`
        : status === 'MISSING'
          ? 'Not on file.'
          : status === 'EXPIRED'
            ? `Expired ${Math.abs(days ?? 0)} day${Math.abs(days ?? 0) === 1 ? '' : 's'} ago.`
            : status === 'PENDING_REVIEW'
              ? 'Uploaded, awaiting review by a coordinator.'
              : status === 'REJECTED'
                ? (item?.reviewNote ?? 'Rejected on review.')
                : 'Not satisfied.',
    });
  }

  // Optional items still count toward the completeness meter, at half weight,
  // so a fully-papered contractor reads as complete rather than stuck at 70%.
  const optional = policy.filter((p) => !p.required);
  let optionalScore = 0;
  for (const spec of optional) {
    const item = byKind.get(spec.kind);
    if (item && ['VALID', 'EXPIRING_SOON'].includes(computeComplianceStatus(item, now))) optionalScore += 0.5;
  }

  const denom = requiredCount + optional.length * 0.5;
  const completeness = denom > 0 ? Math.round(((satisfied + optionalScore) / denom) * 100) : 100;

  let nextExpiry: ComplianceVerdict['nextExpiry'] = null;
  for (const it of byKind.values()) {
    if (!it.expiresAt || NON_EXPIRING_KINDS.includes(it.kind)) continue;
    const d = daysUntilExpiry(it, now);
    if (d == null || d < 0) continue;
    if (!nextExpiry || d < nextExpiry.days) nextExpiry = { kind: it.kind, expiresAt: it.expiresAt, days: d };
  }

  return {
    clearedToFile: !gaps.some((g) => g.blocksFiling),
    gaps,
    completeness: Math.min(100, completeness),
    nextExpiry,
  };
}

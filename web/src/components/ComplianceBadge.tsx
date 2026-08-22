import type { ComplianceStatus } from '@flph/shared';

/**
 * Compliance status pill.
 *
 * Seven states, four colours, and the mapping is the point: MISSING, EXPIRED
 * and REJECTED all mean "we cannot file behind this", so they read the same
 * way at a glance even though they need different fixes.
 */
export const COMPLIANCE_STATUS_LABELS: Record<ComplianceStatus, string> = {
  MISSING: 'Missing',
  PENDING_REVIEW: 'Awaiting review',
  VALID: 'Valid',
  EXPIRING_SOON: 'Expiring soon',
  EXPIRED: 'Expired',
  REJECTED: 'Rejected',
  WAIVED: 'Waived',
};

const CLASS: Record<ComplianceStatus, string> = {
  MISSING: 'badge-red',
  PENDING_REVIEW: 'badge-blue',
  VALID: 'badge-green',
  EXPIRING_SOON: 'badge-amber',
  EXPIRED: 'badge-red',
  REJECTED: 'badge-red',
  WAIVED: 'badge-gray',
};

/** Row tint for a table: expired reads red, expiring-soon amber. */
export function complianceRowClass(status: ComplianceStatus): string {
  if (status === 'EXPIRED' || status === 'MISSING' || status === 'REJECTED') return 'bg-danger-soft/40';
  if (status === 'EXPIRING_SOON') return 'bg-warn-soft/50';
  return '';
}

/** "Expired 12 days ago" / "Expires in 9 days" / "Does not expire". */
export function expiryPhrase(days: number | null | undefined): string {
  if (days == null) return 'No expiry date';
  if (days < 0) {
    const n = Math.abs(days);
    return `Expired ${n} day${n === 1 ? '' : 's'} ago`;
  }
  if (days === 0) return 'Expires today';
  return `Expires in ${days} day${days === 1 ? '' : 's'}`;
}

export default function ComplianceBadge({
  status,
  title,
  className = '',
}: {
  status: ComplianceStatus;
  title?: string;
  className?: string;
}) {
  return (
    <span className={`${CLASS[status]} ${className}`} title={title}>
      {COMPLIANCE_STATUS_LABELS[status]}
    </span>
  );
}

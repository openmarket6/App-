import type { RiskLevel } from '@flph/shared';

export const RISK_LABELS: Record<RiskLevel, string> = {
  ON_TRACK: 'On track',
  WATCH: 'Watch',
  AT_RISK: 'At risk',
  CRITICAL: 'Critical',
};

const RISK_CLASS: Record<RiskLevel, string> = {
  ON_TRACK: 'badge-green',
  WATCH: 'badge-gray',
  AT_RISK: 'badge-amber',
  CRITICAL: 'badge-red',
};

/**
 * Risk is jurisdiction-relative — the score behind it was computed against that
 * jurisdiction's own measured median. The reasons are passed through as the
 * tooltip so hovering a badge always answers "why".
 */
export default function RiskBadge({
  level,
  score,
  reasons,
  className = '',
}: {
  level: RiskLevel | null | undefined;
  score?: number;
  reasons?: string[];
  className?: string;
}) {
  if (!level) return <span className={`badge-gray ${className}`}>Unscored</span>;
  const title = [
    typeof score === 'number' ? `Risk score ${score}/100` : null,
    ...(reasons ?? []),
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <span className={`${RISK_CLASS[level]} ${className}`} title={title || undefined}>
      {RISK_LABELS[level]}
    </span>
  );
}

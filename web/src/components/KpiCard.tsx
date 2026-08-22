import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

export type KpiAccent = 'none' | 'danger' | 'warn' | 'good' | 'brand';

const ACCENT_CLASS: Record<KpiAccent, string> = {
  none: '',
  danger: 'border-l-4 border-danger',
  warn: 'border-l-4 border-warn',
  good: 'border-l-4 border-good',
  brand: 'border-l-4 border-brand',
};

/**
 * A KPI card is a number plus the sentence that stops someone misreading it.
 * `hint` is not decoration: "median 14d across 62 measured filings" and
 * "median 14d" are different claims, and only one of them is true.
 */
export default function KpiCard({
  label,
  value,
  hint,
  accent = 'none',
  to,
  className = '',
}: {
  label: string;
  /** Pre-formatted. Pass '—' when there is genuinely nothing to show. */
  value: ReactNode;
  hint?: ReactNode;
  accent?: KpiAccent;
  /** When set the whole card is a link. */
  to?: string;
  className?: string;
}) {
  const body = (
    <>
      <div className="label">{label}</div>
      <div className="mt-1.5 text-2xl font-semibold tabular-nums leading-none">{value}</div>
      {hint && <div className="mt-2 text-[12px] text-ink-soft leading-snug">{hint}</div>}
    </>
  );

  const classes = `card card-pad ${ACCENT_CLASS[accent]} ${to ? 'block hover:border-brand/40 transition-colors' : ''} ${className}`;

  if (to) {
    return (
      <Link to={to} className={classes}>
        {body}
      </Link>
    );
  }
  return <div className={classes}>{body}</div>;
}

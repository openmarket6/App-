/**
 * A small completeness bar.
 *
 * Used for the compliance completeness score and the onboarding progress
 * strip. The number is always rendered next to the bar: a bar on its own tells
 * you roughly, and "roughly 80% papered" is not a thing a coordinator can act
 * on.
 */
export default function Meter({
  value,
  label,
  hint,
  tone,
  size = 'md',
  className = '',
}: {
  /** 0-100. */
  value: number;
  label?: string;
  hint?: string;
  /** Overrides the automatic colour, e.g. to keep a blocked step red at 90%. */
  tone?: 'brand' | 'good' | 'warn' | 'danger';
  size?: 'sm' | 'md';
  className?: string;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  const auto = pct >= 100 ? 'good' : pct >= 60 ? 'brand' : pct >= 30 ? 'warn' : 'danger';
  const colour = tone ?? auto;
  const fill = {
    brand: 'bg-brand',
    good: 'bg-good',
    warn: 'bg-warn',
    danger: 'bg-danger',
  }[colour];

  return (
    <div className={className}>
      {(label || hint) && (
        <div className="flex items-baseline justify-between gap-2 mb-1">
          {label && <span className="label">{label}</span>}
          {hint && <span className="text-[12px] text-ink-soft">{hint}</span>}
        </div>
      )}
      <div className="flex items-center gap-2">
        <div
          className={`flex-1 rounded bg-page overflow-hidden ${size === 'sm' ? 'h-1.5' : 'h-2'}`}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={label ?? 'Completeness'}
        >
          <div className={`h-full ${fill} transition-[width]`} style={{ width: `${pct}%` }} />
        </div>
        <span className="text-[12px] font-semibold tabular-nums text-ink-soft w-9 text-right">{pct}%</span>
      </div>
    </div>
  );
}

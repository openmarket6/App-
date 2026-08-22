/**
 * Loading indicator. Deliberately quiet — a coordinator refreshing a permit
 * board twenty times an hour should not get a flashing animation each time.
 */
export default function Spinner({ label, className = '' }: { label?: string; className?: string }) {
  return (
    <div className={`flex items-center gap-2 text-sm text-ink-mute ${className}`} role="status" aria-live="polite">
      <span className="inline-block h-3.5 w-3.5 rounded-full border-2 border-line border-t-brand animate-spin" />
      <span>{label ?? 'Loading…'}</span>
    </div>
  );
}

/** Full-panel loading state, sized so a card does not collapse while fetching. */
export function LoadingPanel({ label, rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div className="card card-pad">
      <Spinner label={label} />
      <div className="mt-4 space-y-2" aria-hidden>
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="h-3 rounded bg-page" style={{ width: `${90 - i * 12}%` }} />
        ))}
      </div>
    </div>
  );
}

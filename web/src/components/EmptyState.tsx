import type { ReactNode } from 'react';

/**
 * An empty list is a question — "is this broken, or is there genuinely nothing
 * here?" — so every empty state says which, and what to do next.
 */
export default function EmptyState({
  title,
  hint,
  action,
  compact = false,
}: {
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`text-center ${compact ? 'py-6' : 'py-12'} px-6`}>
      <div className="text-sm font-medium text-ink">{title}</div>
      {hint && <div className="mt-1.5 text-sm text-ink-soft max-w-md mx-auto leading-relaxed">{hint}</div>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

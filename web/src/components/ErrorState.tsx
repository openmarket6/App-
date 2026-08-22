import { ApiError } from '../lib/api.ts';

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  if (typeof err === 'string' && err.trim()) return err;
  return 'Something went wrong.';
}

export function errorCode(err: unknown): string | null {
  return err instanceof ApiError ? err.code : null;
}

/**
 * Error state. Shows what the server actually said rather than "an error
 * occurred", because a permit tech reading "Your role does not allow:
 * permit:edit" can act on it and a generic message wastes a support ticket.
 */
export default function ErrorState({
  error,
  onRetry,
  title = 'Could not load this',
  compact = false,
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
  compact?: boolean;
}) {
  const status = error instanceof ApiError ? error.status : null;
  return (
    <div className={`rounded-md border border-danger/20 bg-danger-soft px-4 ${compact ? 'py-2.5' : 'py-4'}`}>
      <div className="text-sm font-semibold text-danger">
        {status === 403 ? 'Not permitted' : status === 404 ? 'Not found' : title}
      </div>
      <div className="mt-1 text-sm text-ink-soft">{errorMessage(error)}</div>
      {onRetry && (
        <button type="button" onClick={onRetry} className="btn-ghost mt-3">
          Try again
        </button>
      )}
    </div>
  );
}

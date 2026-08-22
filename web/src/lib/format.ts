/** Small presentation helpers. No domain logic — that lives in @flph/shared. */

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function daysAgo(iso: string | null | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((now - t) / 86_400_000);
}

export function fmtDays(n: number | null | undefined): string {
  return n == null ? '—' : `${n}d`;
}

export function fmtPercent(n: number | null | undefined, digits = 0): string {
  return n == null ? '—' : `${n.toFixed(digits)}%`;
}

/** A 0-1 share rendered as a percentage. */
export function fmtShare(share: number | null | undefined, digits = 1): string {
  return share == null ? '—' : `${(share * 100).toFixed(digits)}%`;
}

export function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/[\s_]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}

/** ENUM_LIKE_THIS -> "Enum like this". */
export function humanEnum(s: string | null | undefined): string {
  if (!s) return '—';
  const lower = s.toLowerCase().replace(/_/g, ' ');
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function greeting(d: Date = new Date()): string {
  const h = d.getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export function firstName(name: string | null | undefined): string {
  if (!name) return 'there';
  return name.trim().split(/\s+/)[0] ?? 'there';
}

/** Median of a numeric list, rounded. Null on an empty list. */
export function median(values: number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 0 ? Math.round(((xs[mid - 1] ?? 0) + (xs[mid] ?? 0)) / 2) : (xs[mid] ?? 0);
}

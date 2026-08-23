/** Small presentation helpers. No domain logic — that lives in @flph/shared. */

/**
 * A date with no time and no zone: '2026-06-01'.
 *
 * Half the date-bearing columns in this schema are `date` — an insurance
 * expiry, an invoice due date, a licence expiry — and they arrive spelled
 * exactly like this.
 */
const BARE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Render a date.
 *
 * `Date.parse('2026-06-01')` is midnight UTC, and `toLocaleDateString` then
 * converts that to the reader's zone — which in Florida is 8pm on 31 May. So
 * every bare date in this application rendered ONE DAY EARLY for every user:
 * a policy expiring on 1 June was shown as "May 31, 2026".
 *
 * It was on every screen, all the time, and that is why it lasted. A date that
 * is consistently wrong by one day does not look like a bug; it looks like the
 * data. Somebody reads an expiry off the screen, writes it in a calendar, and
 * chases a renewal a day early forever without ever suspecting the software.
 *
 * A bare date has no zone to convert FROM, so it is formatted from its own
 * digits. A real timestamp still converts, because an instant genuinely did
 * happen at a moment and the reader wants it in their own time.
 */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';

  const bare = typeof iso === 'string' ? BARE_DATE.exec(iso.trim()) : null;
  if (bare) {
    // Constructed in local time from the parts, so no conversion can occur.
    const d = new Date(Number(bare[1]), Number(bare[2]) - 1, Number(bare[3]));
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';

  // A bare date has no time to show. Rendering "May 31, 2026 at 8:00 PM" for a
  // value that says only "1 June" invents both the hour and the day.
  const bare = typeof iso === 'string' ? BARE_DATE.exec(iso.trim()) : null;
  if (bare) return fmtDate(iso);

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

/**
 * Calendar dates, and why they cannot be compared to instants.
 *
 * A deadline in Florida law falls on a DAY. "Within 45 days of first
 * furnishing" and "the policy expires on 1 June" are statements about the
 * calendar, and the person they concern is standing in Florida looking at a
 * Florida calendar.
 *
 * The database agrees: compliance_items.expires_at, invoices.due_on and
 * service_licenses.expires_on are all `date` columns. They arrive as
 * '2026-06-01', and `Date.parse('2026-06-01')` is midnight UTC — which is 8pm
 * on 31 May in Florida. Comparing that against `Date.now()`, an instant, made
 * every date boundary in the system move four or five hours early:
 *
 *   A Notice to Owner served on the evening of the 45th day was reported as
 *   beyond the window. That is the one that costs something — a contractor
 *   told at 8pm on the last day that they are too late may not serve at all,
 *   and the lien goes with it.
 *
 *   An insurance policy expiring on 1 June read as EXPIRED from 8pm on 31 May,
 *   and compliance gates filing, so a contractor lost an evening of work they
 *   were entitled to.
 *
 *   An invoice due today read as OVERDUE from 8pm yesterday.
 *
 * None of this is visible from a screen. It is correct all morning, correct
 * all afternoon, and wrong after dinner, which is exactly the shape of bug
 * that survives for years and is blamed on the person reporting it.
 *
 * The fix is to stop mixing the two kinds of value. A calendar date is reduced
 * to a day number; an instant is reduced to the day number it falls on IN
 * FLORIDA; and the comparison happens between two integers.
 */

/**
 * The timezone the business operates in.
 *
 * Not the server's — Render runs in UTC — and not the browser's, because a
 * deadline does not move when a contractor's project manager opens the app
 * from a hotel in Denver. Florida is where the property is and where the
 * clerk's office is, so Florida is the calendar that governs.
 */
export const OPERATING_TIMEZONE = 'America/New_York';

const DAY_MS = 86_400_000;
const BARE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const partsOf = new Intl.DateTimeFormat('en-CA', {
  timeZone: OPERATING_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Which calendar day a value falls on, as a whole number of days from the
 * epoch. Null when the value is not a date at all.
 *
 * A bare 'YYYY-MM-DD' is taken at face value and NOT converted. It is already
 * a calendar date; running it through a timezone would shift it by a day and
 * invent a precision it never had. Anything else is an instant, and is asked
 * which Florida day it landed on.
 */
export function calendarDay(value: string | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'string') {
    const bare = BARE_DATE.exec(value.trim());
    if (bare) {
      return Math.floor(
        Date.UTC(Number(bare[1]), Number(bare[2]) - 1, Number(bare[3])) / DAY_MS,
      );
    }
  }

  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) return null;

  // en-CA formats as YYYY-MM-DD, which is why it is used here rather than a
  // locale that would hand back 6/1/2026 and need parsing.
  const [y, m, d] = partsOf.format(instant).split('-').map(Number);
  return Math.floor(Date.UTC(y!, m! - 1, d!) / DAY_MS);
}

/**
 * Whole days from `from` to `to`, counted on the calendar.
 *
 * Positive means `to` is later. Null if either side is unreadable — a caller
 * that cannot tell a missing date from a zero-day gap will make the wrong
 * decision, so this refuses to guess.
 */
export function daysBetween(
  from: string | Date | null | undefined,
  to: string | Date | null | undefined,
): number | null {
  const a = calendarDay(from);
  const b = calendarDay(to);
  if (a === null || b === null) return null;
  return b - a;
}

/** Today, in Florida. */
export function today(now: Date = new Date()): number {
  return calendarDay(now)!;
}

/**
 * Is `date` strictly before today in Florida?
 *
 * The question behind "is this invoice overdue" and "has this policy lapsed",
 * and the reason both were answering it four hours early.
 */
export function isPast(
  date: string | Date | null | undefined,
  now: Date = new Date(),
): boolean {
  const d = calendarDay(date);
  return d !== null && d < today(now);
}

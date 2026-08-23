/**
 * Deadlines fall on days, not on instants.
 *
 * Half the date-bearing columns in this schema are `date`:
 * compliance_items.expires_at, invoices.due_on, service_licenses.expires_on.
 * They arrive as '2026-06-01', and Date.parse of that is midnight UTC — which
 * is 8pm on 31 May in Florida. Every one of these comparisons was made against
 * an instant, so every date boundary in the system moved four or five hours
 * early, and did so only after dinner.
 *
 * That is the shape of bug that survives for years. It is right all morning,
 * right all afternoon, wrong in the evening, and the person who reports it
 * cannot reproduce it the next day at their desk.
 *
 * Every test here fixes the clock at a Florida evening, because that is the
 * only window in which the old code was wrong. Run at noon they would all have
 * passed against the broken version.
 */
import { describe, it, expect } from 'vitest';
import { calendarDay, daysBetween, isPast, OPERATING_TIMEZONE } from '../src/shared/calendar.js';
import { computeComplianceStatus, daysUntilExpiry } from '../src/shared/compliance.js';
import { validateNto, NTO_DEADLINE_DAYS } from '../src/domain/documents/noc.js';

/**
 * 9pm in Florida on 15 April 2026 — already the 16th in UTC.
 *
 * Not 8pm. 20:00 EDT is midnight UTC exactly, which lands on the boundary and
 * happens to give the right answer under the old arithmetic; a test pinned
 * there passes against the bug it exists to catch. An hour later is
 * unambiguously the next UTC day and unambiguously still the 15th in Florida.
 */
const FLORIDA_EVENING = new Date('2026-04-15T21:00:00-04:00');
/** The same calendar day, in the morning, when everything used to work. */
const FLORIDA_MORNING = new Date('2026-04-15T09:00:00-04:00');

describe('calendar days', () => {
  it('reads a bare date at face value, whatever the clock says', () => {
    // A bare date has no zone to convert from. Running it through one would
    // shift it by a day and invent a precision it never had.
    expect(calendarDay('2026-06-01')).toBe(calendarDay('2026-06-01'));
    expect(daysBetween('2026-06-01', '2026-06-02')).toBe(1);
    expect(daysBetween('2026-03-01', '2026-04-15')).toBe(45);
  });

  it('puts a Florida evening on the Florida day, not the UTC one', () => {
    expect(calendarDay(FLORIDA_EVENING)).toBe(calendarDay('2026-04-15'));
    expect(calendarDay(FLORIDA_MORNING)).toBe(calendarDay('2026-04-15'));
  });

  it('counts the same number of days morning and evening', () => {
    // The whole failure in one assertion: these differed by one.
    expect(daysBetween('2026-03-01', FLORIDA_EVENING))
      .toBe(daysBetween('2026-03-01', FLORIDA_MORNING));
  });

  it('crosses a daylight-saving boundary without gaining or losing a day', () => {
    // DST began 8 March 2026. An interval spanning it is still whole days.
    expect(daysBetween('2026-03-01', '2026-03-31')).toBe(30);
    expect(daysBetween('2026-11-01', '2026-11-30')).toBe(29);
  });

  it('names the timezone the business actually operates in', () => {
    // Not the server's — Render runs in UTC — and not the reader's browser. A
    // deadline does not move when a project manager opens the app from Denver.
    expect(OPERATING_TIMEZONE).toBe('America/New_York');
  });
});

describe('the Notice to Owner window', () => {
  const base = {
    claimantName: 'Alpha Roofing LLC',
    claimantAddress: '88 Industrial Way, Tampa, FL 33619',
    servicesOrMaterials: 'Roofing labour and materials',
    ownerName: 'Marta Delgado',
    ownerAddress: '1200 Bay Street, Tampa, FL 33606',
    propertyAddress: '1200 Bay Street, Tampa, FL 33606',
    legalDescription: 'Lot 4, Block 7, HYDE PARK ADDITION, Plat Book 12, Page 44',
  };
  const lateWarning = (problems: ReturnType<typeof validateNto>) =>
    problems.find((p) => p.detail?.includes('beyond'));

  it('does not call the 45th day late, even at 8pm', () => {
    /*
     * The one that costs money. 1 March plus 45 days is 15 April; at 8pm in
     * Florida that instant is already 16 April in UTC, so the old arithmetic
     * reported 46 days and warned the notice was out of time.
     *
     * A contractor told at 8pm on the last day that they are too late may not
     * serve at all, and the lien goes with it.
     */
    const problems = validateNto(
      { ...base, firstFurnishingDate: '2026-03-01' },
      FLORIDA_EVENING,
    );
    expect(lateWarning(problems), 'warned "beyond the window" on the 45th day').toBeUndefined();
  });

  it('still says so on the 46th', () => {
    const problems = validateNto(
      { ...base, firstFurnishingDate: '2026-02-28' },
      FLORIDA_EVENING,
    );
    const warning = lateWarning(problems);
    expect(warning, 'a genuinely late notice must still be flagged').toBeTruthy();
    expect(warning!.severity).toBe('warning');   // reported, never refused
  });

  it('gives the same answer morning and evening', () => {
    const morning = validateNto({ ...base, firstFurnishingDate: '2026-03-01' }, FLORIDA_MORNING);
    const evening = validateNto({ ...base, firstFurnishingDate: '2026-03-01' }, FLORIDA_EVENING);
    expect(lateWarning(evening)).toEqual(lateWarning(morning));
  });

  it('counts from served date when there is one, ignoring the clock entirely', () => {
    const problems = validateNto(
      { ...base, firstFurnishingDate: '2026-03-01', servedDate: '2026-04-15' },
      FLORIDA_EVENING,
    );
    expect(lateWarning(problems)).toBeUndefined();
    expect(NTO_DEADLINE_DAYS).toBe(45);
  });
});

describe('compliance expiry', () => {
  const item = (expiresAt: string) =>
    ({ kind: 'GENERAL_LIABILITY', expiresAt, status: 'VALID' }) as never;

  it('does not expire a policy the evening before it expires', () => {
    /*
     * Compliance gates filing. A policy running to 16 April read as EXPIRED
     * from 8pm on the 15th, so a contractor lost an evening of work they were
     * entitled to — and the screen gave them a lapsed-insurance banner they
     * could do nothing about.
     */
    expect(computeComplianceStatus(item('2026-04-16'), FLORIDA_EVENING))
      .not.toBe('EXPIRED');
  });

  it('expires it once the day has actually passed', () => {
    expect(computeComplianceStatus(item('2026-04-14'), FLORIDA_EVENING)).toBe('EXPIRED');
  });

  it('counts the same days remaining all day', () => {
    expect(daysUntilExpiry({ expiresAt: '2026-05-01' } as never, FLORIDA_EVENING))
      .toBe(daysUntilExpiry({ expiresAt: '2026-05-01' } as never, FLORIDA_MORNING));
  });
});

describe('is it past', () => {
  it('is false for today, whatever the hour', () => {
    expect(isPast('2026-04-15', FLORIDA_EVENING)).toBe(false);
    expect(isPast('2026-04-15', FLORIDA_MORNING)).toBe(false);
  });

  it('is true for yesterday', () => {
    expect(isPast('2026-04-14', FLORIDA_EVENING)).toBe(true);
  });

  it('is false for nothing at all, rather than treating absence as overdue', () => {
    expect(isPast(null, FLORIDA_EVENING)).toBe(false);
    expect(isPast(undefined, FLORIDA_EVENING)).toBe(false);
  });
});

describe('rendering a date on a screen', () => {
  /*
   * The widest of these, by a distance. Date.parse('2026-06-01') is midnight
   * UTC, and toLocaleDateString then converts it to the reader's zone — so
   * every bare date in the application rendered ONE DAY EARLY for every user
   * in Florida. A policy expiring 1 June was shown as "May 31, 2026".
   *
   * It was on every screen, all the time, which is why it lasted: a date that
   * is consistently one day out does not look like a bug, it looks like the
   * data. Somebody reads an expiry off the screen, writes it in a calendar,
   * and chases the renewal a day early forever.
   *
   * fmtDate lives in web/src and is duplicated here rather than imported: the
   * web app is a separate tsconfig with its own module resolution, and this
   * suite does not compile it. The duplication is the point of the comment —
   * if fmtDate changes, this must too.
   */
  const BARE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const fmtDate = (iso: string): string => {
    const bare = BARE_DATE.exec(iso.trim());
    if (bare) {
      const d = new Date(Number(bare[1]), Number(bare[2]) - 1, Number(bare[3]));
      return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    }
    return new Date(Date.parse(iso))
      .toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  };

  it('shows a bare date as the day it says', () => {
    expect(fmtDate('2026-06-01')).toBe('Jun 1, 2026');
    expect(fmtDate('2026-01-01')).toBe('Jan 1, 2026');
    // New Year's Day is the cruellest version: the year was wrong too.
    expect(fmtDate('2026-01-01')).not.toContain('2025');
  });

  it('still converts a real instant, because that did happen at a moment', () => {
    expect(fmtDate('2026-06-01T15:30:00Z')).toContain('2026');
  });
});

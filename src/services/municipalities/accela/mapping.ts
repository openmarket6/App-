/**
 * Translating Accela's vocabulary into ours.
 *
 * Every agency configures its own status names. "Plan Review", "In Plan
 * Review", "Plans Routed", "Under Review" and "Reviewing" all mean the same
 * thing and all appear in the wild, because each agency wrote its own list. So
 * matching is on normalised substrings rather than an exact table -- an exact
 * table would be wrong for the first agency onboarded that spells it
 * differently.
 *
 * WHEN IN DOUBT, 'unknown'.
 *
 * That is the whole design rule here. An unrecognised status must not be
 * guessed into the nearest familiar one. Reporting "issued" for a status we did
 * not understand sends a crew to a job site they may not lawfully work; showing
 * "unknown" makes a person look, which is slow and correct. The cost of the two
 * mistakes is not remotely symmetrical.
 */
import type { DetectedStatus } from '../adapter.js';

/**
 * Ordered, and the order carries meaning: the FIRST match wins, so more
 * specific phrases must come before the general ones they contain.
 *
 * "corrections required" has to be tested before "review", or a status reading
 * "Plan Review - Corrections Required" is filed as an ordinary review and the
 * contractor is never told there is work to do.
 */
const RULES: Array<{ match: string[]; status: DetectedStatus }> = [
  // Genuinely terminal states first: these are unambiguous.
  { match: ['void', 'cancelled', 'canceled', 'withdrawn'], status: 'closed' },
  { match: ['expired', 'lapsed'], status: 'expired' },
  { match: ['finaled', 'final complete', 'certificate of occupancy', 'co issued', 'closed', 'completed'], status: 'closed' },

  /**
   * Corrections BEFORE both review and rejection, and the rejection case is the
   * one that matters.
   *
   * "Rejected Plans - Resubmit" is not a refused application. It is a live
   * application whose drawings need fixing, and the difference is everything: a
   * contractor told their permit was REJECTED believes the job is dead and
   * stops working it, when what was actually needed was a resubmission.
   *
   * So anything that asks for more work is a correction, whatever verb the
   * agency chose to say it with. Only a refusal with no route back -- a plain
   * "Denied", a "Revoked" -- reaches the rejection rule below.
   */
  {
    match: [
      'correction', 'resubmit', 'revision required', 'incomplete', 'deficient',
      'on hold', 'insufficient', 'additional information', 'rejected plans',
    ],
    status: 'corrections_required',
  },

  { match: ['denied', 'rejected', 'refused', 'revoked'], status: 'rejected' },

  { match: ['inspection', 'field', 'ready to inspect'], status: 'inspections' },

  // Issued before approved: an issued permit is approved AND collected, and the
  // contractor may start work. Reporting the weaker of the two understates it.
  { match: ['issued', 'permit issued', 'active permit'], status: 'issued' },
  { match: ['approved', 'ready to issue', 'ready for issuance', 'passed review'], status: 'approved' },

  {
    match: ['review', 'routed', 'in process', 'in progress', 'processing', 'pending', 'assigned'],
    status: 'under_review',
  },
  { match: ['submitted', 'received', 'accepted', 'intake', 'applied', 'application'], status: 'submitted' },
];

const normalise = (raw: string): string =>
  raw.toLowerCase().replace(/[_\-/]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Map an agency's status text onto ours.
 *
 * Returns 'unknown' for anything unrecognised, which routes the permit to a
 * person rather than to a guess.
 */
export function toDetectedStatus(raw: string | null | undefined): DetectedStatus {
  if (!raw) return 'unknown';
  const text = normalise(raw);
  if (!text) return 'unknown';

  for (const rule of RULES) {
    if (rule.match.some((needle) => text.includes(needle))) return rule.status;
  }
  return 'unknown';
}

/**
 * Inspection results.
 *
 * Separate from permit statuses because the words overlap and mean different
 * things: "approved" on an inspection is a pass, "approved" on a permit is not
 * yet an issued permit.
 *
 * A partial pass is NOT rounded to a pass. "Passed with conditions" means work
 * remains, and recording it as a clean pass is how a condition gets forgotten
 * until the final inspection fails over it.
 */
export type InspectionOutcome =
  | 'scheduled' | 'passed' | 'failed' | 'partial' | 'cancelled' | 'no_show';

const INSPECTION_RULES: Array<{ match: string[]; outcome: InspectionOutcome }> = [
  { match: ['partial', 'conditional', 'with conditions', 'corrections noted'], outcome: 'partial' },
  { match: ['no show', 'no-show', 'not ready', 'nobody on site', 'no access'], outcome: 'no_show' },
  { match: ['cancel', 'void', 'withdrawn', 'rescheduled'], outcome: 'cancelled' },
  { match: ['fail', 'denied', 'rejected', 'disapproved', 'not approved', 'correction'], outcome: 'failed' },
  { match: ['pass', 'approved', 'complete', 'satisfactory', 'ok'], outcome: 'passed' },
  { match: ['schedul', 'pending', 'requested', 'assigned', 'upcoming'], outcome: 'scheduled' },
];

export function toInspectionOutcome(raw: string | null | undefined): InspectionOutcome | 'unknown' {
  if (!raw) return 'unknown';
  const text = normalise(raw);
  if (!text) return 'unknown';

  for (const rule of INSPECTION_RULES) {
    if (rule.match.some((needle) => text.includes(needle))) return rule.outcome;
  }
  return 'unknown';
}

/**
 * Does this plan-review comment read like a correction?
 *
 * A heuristic, and treated as one: it decides whether a comment is SURFACED for
 * a permit tech to read, never whether a correction cycle is recorded. Logging
 * a cycle from a guess would corrupt the number this business measures its own
 * filing quality by.
 */
export function looksLikeCorrection(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = normalise(text);
  return [
    'correction', 'revise', 'resubmit', 'provide', 'missing', 'required',
    'deficien', 'clarif', 'incomplete', 'not shown', 'unable to verify',
  ].some((needle) => t.includes(needle));
}

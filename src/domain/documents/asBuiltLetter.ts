/**
 * As-built letters.
 *
 * WHAT THESE ARE, because it is easy to conflate two different deliverables.
 *
 * An as-built PLAN SET is a drawing: the approved set revised to show what was
 * actually built, field deviations included, sealed by the design professional
 * of record. That is drafting work, and it is already in this system as the
 * AS_BUILT drafting service.
 *
 * An as-built LETTER is a page. The licensed trade contractor states, over
 * their own signature and licence number, that the work they installed is what
 * the approved plans called for and complies with the code edition in force.
 * Building departments ask for these at closeout, usually alongside the final
 * inspections, and often per trade — the roofer signs for the roof, the
 * electrician for the electrical.
 *
 * The two are not interchangeable. A department asking for a letter will not
 * accept drawings, and vice versa.
 *
 * ON SOURCING. Florida has no single statewide form for these; the requirement
 * and the wording come from each building department's closeout checklist, and
 * the ones published vary. What is common to all of them, and what this
 * template is built from:
 *
 *   - the permit it closes, by number, and the property by address and parcel
 *   - who is certifying: legal name, licence number, and their role on the job
 *   - what was installed, described specifically enough to be checked
 *   - that it matches the APPROVED plans, naming the revision where relevant
 *   - the code edition it complies with
 *   - a signature block, and space for a notary where the department wants one
 *
 * Have the templates reviewed before they go out, and confirm the wording
 * against the checklists of the departments you file in most. This module is
 * the mechanism and the structure; it is not a legal opinion, and a department
 * that publishes its own form will want theirs.
 */
import type { FieldProblem } from './noc.js';

/**
 * The trades a letter can be issued for.
 *
 * Separate rather than one generic letter because the certification sentence is
 * not the same: a roofer certifies an assembly and its attachment, an
 * electrician certifies an installation against NEC as adopted, a window
 * installer certifies product approval numbers and anchoring. A generic
 * sentence covering all of them says nothing a plans examiner can check.
 */
export const AS_BUILT_TRADES = [
  'ROOFING',
  'ELECTRICAL',
  'PLUMBING',
  'MECHANICAL',
  'STRUCTURAL',
  'BUILDING',
  'WINDOWS_AND_DOORS',
] as const;
export type AsBuiltTrade = (typeof AS_BUILT_TRADES)[number];

export const AS_BUILT_TRADE_LABELS: Record<AsBuiltTrade, string> = {
  ROOFING: 'Roofing',
  ELECTRICAL: 'Electrical',
  PLUMBING: 'Plumbing',
  MECHANICAL: 'Mechanical (HVAC)',
  STRUCTURAL: 'Structural',
  BUILDING: 'Building (general)',
  WINDOWS_AND_DOORS: 'Windows & doors',
};

/**
 * What each trade actually certifies, and what a plans examiner will look for.
 *
 * `certifies` becomes the operative sentence. `prompts` are the specifics that
 * make the letter checkable rather than a formality — they appear on the page
 * as a short list the contractor completes, because a letter that says only
 * "installed per plans" is one a reviewer cannot verify and may reject.
 */
export const AS_BUILT_TRADE_SPEC: Record<AsBuiltTrade, {
  certifies: string;
  codeChapter: string;
  prompts: string[];
}> = {
  ROOFING: {
    certifies:
      'the roof assembly was installed in accordance with the approved plans, '
      + 'the manufacturer\'s published installation instructions, and the Florida '
      + 'Product Approval or Miami-Dade Notice of Acceptance under which it was permitted',
    codeChapter: 'Florida Building Code, Chapter 15 (Roof Assemblies)',
    prompts: [
      'Roof covering system and manufacturer',
      'Florida Product Approval or NOA number',
      'Deck type, and nailing pattern used',
      'Underlayment and secondary water barrier',
    ],
  },
  ELECTRICAL: {
    certifies:
      'the electrical installation was completed in accordance with the approved '
      + 'plans and specifications and complies with the National Electrical Code '
      + 'as adopted by the Florida Building Code',
    codeChapter: 'Florida Building Code, Chapter 27 / NFPA 70 as adopted',
    prompts: [
      'Service size and voltage',
      'Panel schedule as installed, where it differs from the approved plans',
      'Grounding and bonding method',
      'Any circuits added, removed or relocated in the field',
    ],
  },
  PLUMBING: {
    certifies:
      'the plumbing installation was completed in accordance with the approved '
      + 'plans and complies with the Florida Building Code, Plumbing',
    codeChapter: 'Florida Building Code, Plumbing',
    prompts: [
      'Fixture count as installed',
      'Water supply and drain material and sizes',
      'Water heater type, capacity and location',
      'Any routing changed in the field',
    ],
  },
  MECHANICAL: {
    certifies:
      'the mechanical installation was completed in accordance with the approved '
      + 'plans and complies with the Florida Building Code, Mechanical and the '
      + 'energy code as adopted',
    codeChapter: 'Florida Building Code, Mechanical',
    prompts: [
      'Equipment installed: make, model and capacity',
      'Duct material, insulation R-value and routing',
      'Condensate disposal',
      'Any equipment substituted for what was approved',
    ],
  },
  STRUCTURAL: {
    certifies:
      'the structural work was constructed in accordance with the approved plans '
      + 'and the structural engineering of record',
    codeChapter: 'Florida Building Code, Chapter 16 (Structural Design)',
    prompts: [
      'Structural elements covered by this letter',
      'Connectors and fasteners as installed',
      'Any field deviation, and the engineer who accepted it',
    ],
  },
  BUILDING: {
    certifies:
      'the work was constructed in accordance with the approved plans and the '
      + 'Florida Building Code edition under which the permit was issued',
    codeChapter: 'Florida Building Code, Building',
    prompts: [
      'Scope of work completed under this permit',
      'Any deviation from the approved plans, and how it was approved',
    ],
  },
  WINDOWS_AND_DOORS: {
    certifies:
      'the windows and exterior doors were installed in accordance with the '
      + 'approved plans, the manufacturer\'s installation instructions, and the '
      + 'Florida Product Approval or Miami-Dade Notice of Acceptance under which '
      + 'each unit was permitted',
    codeChapter: 'Florida Building Code, Chapter 17 / product approval',
    prompts: [
      'Each unit type, with its Florida Product Approval or NOA number',
      'Design pressures, and whether impact-rated or shuttered',
      'Anchor type, size and spacing used',
      'Substrate anchored into',
    ],
  },
};

export function isAsBuiltTrade(v: unknown): v is AsBuiltTrade {
  return typeof v === 'string' && (AS_BUILT_TRADES as readonly string[]).includes(v);
}

export interface AsBuiltLetterInput {
  trade: AsBuiltTrade;
  permitNumber: string;
  propertyAddress: string;
  parcelId?: string | null;
  /** Who is certifying. Their licence is what gives the letter weight. */
  contractorName: string;
  contractorLicenseNumber: string;
  contractorAddress?: string | null;
  qualifierName: string;
  /** What was installed, in the contractor's own words. */
  scopeDescription: string;
  /** Which approved set, when the department revised it. */
  approvedPlansRevision?: string | null;
  codeEdition: string;
  completedOn: string;
  /** Field deviations. Blank is a claim, not an omission — see the validator. */
  deviations?: string | null;
  /** Some departments want it sworn. Off by default; it is not universal. */
  notaryBlock?: boolean;
}

const blank = (v: unknown): boolean =>
  v === null || v === undefined || String(v).trim().length === 0;

/**
 * Refuse a letter that cannot do its job.
 *
 * The blocking set is short and every item is something a reviewer matches
 * against their own record: the permit, the address, who signed, their licence.
 * A letter missing any of those is one the department cannot file against the
 * permit, and it comes back.
 */
export function validateAsBuiltLetter(
  input: Partial<AsBuiltLetterInput>,
  _now: Date = new Date(),
): FieldProblem[] {
  const problems: FieldProblem[] = [];

  if (!isAsBuiltTrade(input.trade)) {
    problems.push({
      field: 'trade',
      severity: 'blocking',
      detail: 'Choose which trade this letter certifies.',
      consequence:
        'The certification sentence is different for each trade. A generic one '
        + 'says nothing a plans examiner can check against the permit.',
    });
  }

  for (const [field, label, why] of [
    ['permitNumber', 'The permit number',
      'This is how the department files the letter against the job. Without it '
      + 'the letter arrives attached to nothing.'],
    ['propertyAddress', 'The property address', ''],
    ['contractorName', 'The certifying contractor’s legal name',
      'A trade name is not a legal entity. A certification signed in one binds nobody.'],
    ['contractorLicenseNumber', 'The certifying contractor’s licence number',
      'The licence is what gives this letter its weight — it is a licensed '
      + 'professional putting their registration behind a statement of fact.'],
    ['qualifierName', 'The name of the person signing', ''],
    ['scopeDescription', 'What was installed',
      '"The work" does not tell a reviewer what is being certified.'],
    ['codeEdition', 'The code edition',
      'A certification of compliance has to say compliance with what. The '
      + 'edition in force is the one the permit was issued under, not the current one.'],
    ['completedOn', 'The date the work was completed', ''],
  ] as const) {
    if (blank(input[field as keyof AsBuiltLetterInput])) {
      problems.push({
        field,
        severity: 'blocking',
        detail: `${label} is missing.`,
        ...(why ? { consequence: why } : {}),
      });
    }
  }

  if (input.completedOn && Number.isNaN(Date.parse(String(input.completedOn)))) {
    problems.push({
      field: 'completedOn', severity: 'blocking', detail: 'That is not a valid date.',
    });
  }

  /*
   * A blank deviations field is a positive claim, and the letter says so.
   *
   * Left silent it reads as an oversight; printed as "none", it is the
   * contractor stating there were none — which is the assertion a reviewer is
   * actually relying on. Warned rather than blocked, because on most jobs
   * there genuinely are none and refusing would teach people to type "n/a".
   */
  if (blank(input.deviations)) {
    problems.push({
      field: 'deviations',
      severity: 'warning',
      detail: 'No field deviations recorded, so the letter will state there were none.',
      consequence:
        'That is a certification in itself. If anything was built differently '
        + 'from the approved plans, say so here and how it was approved.',
    });
  }

  if (blank(input.parcelId)) {
    problems.push({
      field: 'parcelId',
      severity: 'warning',
      detail: 'No parcel number.',
      consequence: 'Most departments index by parcel as well as address.',
    });
  }

  return problems;
}

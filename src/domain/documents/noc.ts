/**
 * Notice of Commencement, and Notice to Owner.
 *
 * ⚠️ THE TEMPLATES IN THIS DIRECTORY HAVE NOT BEEN REVIEWED BY A FLORIDA
 * CONSTRUCTION ATTORNEY. They encode the fields the statutes call for as this
 * file's author understands them, which is not the same as being correct. A
 * defective Notice of Commencement can stop the first inspection and bears on
 * lien rights; a defective Notice to Owner can forfeit a lien claim outright.
 * Have counsel review the output once before any of it is recorded or served.
 *
 * WHAT THIS MODULE IS FOR
 *
 * Not formatting. The formatting is the easy part and the least valuable. What
 * matters is refusing to produce an instrument that is missing something the
 * statute requires — because a document that LOOKS right and is defective is
 * far worse than no document at all. Nobody chases the one that was never
 * produced; everybody relies on the one that was.
 *
 * So every field carries whether it is required, what it is for, and what
 * happens if it is wrong. The validator returns problems in the order a person
 * should fix them, and generation is refused while any blocking problem stands.
 */

export type DocumentKind = 'NOC' | 'NTO' | 'HOLD_HARMLESS' | 'CONTRACTOR_AGREEMENT';

export const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  NOC: 'Notice of Commencement',
  NTO: 'Notice to Owner',
  HOLD_HARMLESS: 'Hold harmless agreement',
  CONTRACTOR_AGREEMENT: 'Contractor services agreement',
};

/** Where a problem sits between "cannot produce this" and "check this". */
export type Severity = 'blocking' | 'warning';

export interface FieldProblem {
  field: string;
  severity: Severity;
  /** What is wrong, in words the person filling the form can act on. */
  detail: string;
  /** Why it matters. Omitted where the field is self-explanatory. */
  consequence?: string;
}

// -----------------------------------------------------------------------------
// Notice of Commencement — Fla. Stat. 713.13
// -----------------------------------------------------------------------------

export interface NocInput {
  /** Street address of the site. Required, and not sufficient on its own. */
  propertyAddress: string;
  /**
   * The legal description — lot, block, plat book and page, or a metes and
   * bounds description.
   *
   * Required SEPARATELY from the street address, and the distinction is the
   * point: a Notice of Commencement is recorded against the parcel in the
   * public records, and a street address does not identify a parcel. An NOC
   * recorded with only an address is the classic defect.
   */
  legalDescription: string;
  /** Parcel identification number, where the county assigns one. */
  parcelId?: string | null;

  /** A general description of the improvement. "Work" is not a description. */
  improvementDescription: string;

  ownerName: string;
  ownerAddress: string;
  /** The owner's interest — fee simple, leasehold, and so on. */
  ownerInterest?: string | null;
  /** Named only when the fee simple titleholder is somebody else. */
  feeSimpleTitleholderName?: string | null;
  feeSimpleTitleholderAddress?: string | null;

  contractorName: string;
  contractorAddress: string;
  contractorPhone?: string | null;
  /** The licence the work is qualified under. */
  contractorLicenseNumber?: string | null;

  /** A payment bond surety, where one exists. All three go together. */
  suretyName?: string | null;
  suretyAddress?: string | null;
  suretyBondAmountCents?: number | null;

  lenderName?: string | null;
  lenderAddress?: string | null;

  /**
   * A person the owner designates to receive copies of notices, under
   * 713.13(1)(b). Optional, and worth prompting for: without one, notices go
   * only to the owner.
   */
  designatedPersonName?: string | null;
  designatedPersonAddress?: string | null;

  /**
   * When the notice expires.
   *
   * Left empty it defaults to one year from recording. Stated here so the
   * person filling it in knows that silence is itself a choice, and a job
   * running past it needs a new notice before work continues.
   */
  expirationDate?: string | null;

  /** Signed and sworn before a notary. Recorded without it, it is not valid. */
  ownerSignatureName?: string | null;
  notarizationId?: string | null;
}

/**
 * What is wrong with this Notice of Commencement.
 *
 * Ordered by what stops it being recordable first, then by what a reviewer
 * would query. Blocking problems refuse generation.
 */
export function validateNoc(input: Partial<NocInput>): FieldProblem[] {
  const problems: FieldProblem[] = [];
  const blank = (v: unknown): boolean =>
    v === null || v === undefined || String(v).trim().length === 0;

  if (blank(input.legalDescription)) {
    problems.push({
      field: 'legalDescription',
      severity: 'blocking',
      detail: 'The legal description of the property is missing.',
      consequence:
        'A Notice of Commencement is recorded against a parcel, and a street ' +
        'address does not identify one. Recording without a legal description is ' +
        'the most common way these are found defective.',
    });
  }
  if (blank(input.propertyAddress)) {
    problems.push({
      field: 'propertyAddress',
      severity: 'blocking',
      detail: 'The street address of the job site is missing.',
    });
  }
  if (blank(input.improvementDescription)) {
    problems.push({
      field: 'improvementDescription',
      severity: 'blocking',
      detail: 'Describe the improvement being made.',
      consequence:
        'A general description is required. "Work" or "construction" does not ' +
        'tell a reader what is being built.',
    });
  }
  if (blank(input.ownerName) || blank(input.ownerAddress)) {
    problems.push({
      field: 'ownerName',
      severity: 'blocking',
      detail: "The owner's name and address are both required.",
    });
  }
  if (blank(input.contractorName) || blank(input.contractorAddress)) {
    problems.push({
      field: 'contractorName',
      severity: 'blocking',
      detail: "The contractor's name and address are both required.",
    });
  }
  if (blank(input.ownerSignatureName)) {
    problems.push({
      field: 'ownerSignatureName',
      severity: 'blocking',
      detail: 'The notice must be signed by the owner.',
      consequence: 'It is sworn to and notarized; an unsigned notice is not recordable.',
    });
  }
  if (blank(input.notarizationId)) {
    problems.push({
      field: 'notarizationId',
      severity: 'blocking',
      detail: "The owner's signature has not been notarized.",
      consequence:
        'A Notice of Commencement is sworn. The clerk will not record one without ' +
        'a notarial certificate.',
    });
  }

  /*
   * A surety is all-or-nothing. Naming a bond without its amount, or an amount
   * with no surety, produces a notice that says something nobody can rely on --
   * and the parties most affected are exactly the ones reading it to decide
   * whether they are protected.
   */
  const suretyFields = [input.suretyName, input.suretyAddress, input.suretyBondAmountCents];
  const suretyGiven = suretyFields.filter((v) => !blank(v)).length;
  if (suretyGiven > 0 && suretyGiven < 3) {
    problems.push({
      field: 'suretyName',
      severity: 'blocking',
      detail: 'A payment bond needs the surety name, address and bond amount together.',
      consequence:
        'A partial bond entry tells subcontractors and suppliers they may be ' +
        'protected without telling them by whom or for how much.',
    });
  }

  if (!blank(input.lenderName) && blank(input.lenderAddress)) {
    problems.push({
      field: 'lenderAddress',
      severity: 'blocking',
      detail: "A lender is named but has no address. Notices must be able to reach them.",
    });
  }

  // Warnings: producible, but a reviewer would ask.
  if (blank(input.parcelId)) {
    problems.push({
      field: 'parcelId',
      severity: 'warning',
      detail: 'No parcel identification number. Most county clerks expect one.',
    });
  }
  if (blank(input.ownerInterest)) {
    problems.push({
      field: 'ownerInterest',
      severity: 'warning',
      detail: "The owner's interest in the property is not stated (fee simple, leasehold).",
    });
  }
  if (blank(input.designatedPersonName)) {
    problems.push({
      field: 'designatedPersonName',
      severity: 'warning',
      detail: 'No person designated to receive copies of notices.',
      consequence: 'Without one, notices reach only the owner.',
    });
  }
  if (blank(input.expirationDate)) {
    problems.push({
      field: 'expirationDate',
      severity: 'warning',
      detail: 'No expiration date given, so the notice runs one year from recording.',
      consequence:
        'A job still running after that needs a new notice before work continues.',
    });
  }
  if (blank(input.contractorLicenseNumber)) {
    problems.push({
      field: 'contractorLicenseNumber',
      severity: 'warning',
      detail: 'The contractor licence number is not stated.',
    });
  }

  return problems;
}

// -----------------------------------------------------------------------------
// Notice to Owner — Fla. Stat. 713.06
// -----------------------------------------------------------------------------

export interface NtoInput {
  /** Who is serving the notice — the subcontractor or supplier. */
  claimantName: string;
  claimantAddress: string;
  /** What they are providing. */
  servicesOrMaterials: string;

  ownerName: string;
  ownerAddress: string;

  propertyAddress: string;
  legalDescription: string;

  /** Who they contracted with, if not the owner. */
  contractedWithName?: string | null;

  /**
   * The date the claimant first furnished labour or materials.
   *
   * This is the field the whole notice turns on. The deadline for serving a
   * Notice to Owner runs from it, and a notice served late does not protect
   * the lien.
   */
  firstFurnishingDate: string;

  /** When the notice was actually served, and how. */
  servedDate?: string | null;
  serviceMethod?: string | null;
}

/**
 * The window for serving a Notice to Owner, in days from first furnishing.
 *
 * CONFIRM WITH COUNSEL. This is the figure most likely to be wrong here, and
 * the one where being wrong costs a lien.
 */
export const NTO_DEADLINE_DAYS = 45;

export function validateNto(
  input: Partial<NtoInput>,
  now: Date = new Date(),
): FieldProblem[] {
  const problems: FieldProblem[] = [];
  const blank = (v: unknown): boolean =>
    v === null || v === undefined || String(v).trim().length === 0;

  for (const [field, label] of [
    ['claimantName', 'The name of whoever is serving this notice'],
    ['claimantAddress', "The claimant's address"],
    ['servicesOrMaterials', 'A description of the labour or materials provided'],
    ['ownerName', "The owner's name"],
    ['ownerAddress', "The owner's address"],
    ['propertyAddress', 'The property address'],
    ['legalDescription', 'The legal description of the property'],
  ] as const) {
    if (blank(input[field as keyof NtoInput])) {
      problems.push({ field, severity: 'blocking', detail: `${label} is missing.` });
    }
  }

  if (blank(input.firstFurnishingDate)) {
    problems.push({
      field: 'firstFurnishingDate',
      severity: 'blocking',
      detail: 'The date labour or materials were first furnished is missing.',
      consequence:
        'The deadline for serving this notice runs from that date. Without it, ' +
        'nobody can say whether the notice is timely — including a court.',
    });
  } else {
    /*
     * The deadline is checked and REPORTED, never silently enforced.
     *
     * A late notice may still be worth serving: it can protect amounts furnished
     * within the window even where earlier ones are lost, and that is a
     * judgement for a lawyer, not for this function. Refusing to produce it
     * would take the decision away from the person entitled to make it. Saying
     * nothing would let it go out believing it was timely.
     */
    // Re-read through a local: blank() is a runtime check, not a type guard,
    // so the compiler still sees `string | undefined` on the else branch.
    const first = Date.parse(input.firstFurnishingDate ?? '');
    if (!Number.isFinite(first)) {
      problems.push({
        field: 'firstFurnishingDate',
        severity: 'blocking',
        detail: 'That is not a valid date.',
      });
    } else {
      const reference = input.servedDate ? Date.parse(input.servedDate) : now.getTime();
      const daysElapsed = Math.floor((reference - first) / 86_400_000);

      if (daysElapsed > NTO_DEADLINE_DAYS) {
        problems.push({
          field: 'firstFurnishingDate',
          severity: 'warning',
          detail:
            `${daysElapsed} days have passed since first furnishing, which is beyond ` +
            `the ${NTO_DEADLINE_DAYS}-day window.`,
          consequence:
            'Serving late may not protect the lien for work already furnished. This ' +
            'notice can still be produced — whether to serve it is a decision for ' +
            'counsel, not for this system.',
        });
      } else if (daysElapsed > NTO_DEADLINE_DAYS - 10) {
        problems.push({
          field: 'firstFurnishingDate',
          severity: 'warning',
          detail:
            `${NTO_DEADLINE_DAYS - daysElapsed} day(s) left to serve this notice.`,
          consequence: 'Serve it now rather than at the end of the week.',
        });
      }
    }
  }

  return problems;
}

/** Blocking problems refuse generation; warnings travel with the document. */
export function canGenerate(problems: FieldProblem[]): boolean {
  return !problems.some((p) => p.severity === 'blocking');
}

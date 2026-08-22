/**
 * Hold harmless, and the contractor services agreement.
 *
 * ⚠️ NOT REVIEWED BY A FLORIDA CONSTRUCTION ATTORNEY. See the warning at the
 * head of noc.ts, which applies here with more force: an indemnity clause that
 * reaches too far is void under Fla. Stat. 725.06, and a void indemnity is
 * worse than none — the party relying on it finds out only when they need it.
 *
 * WHAT THIS MODULE REFUSES TO DO
 *
 * It will not produce an agreement whose money is guessed. The contractor
 * services agreement carries a pricing snapshot because the prices on the
 * signed copy have to be the prices that were actually agreed, not whatever
 * pricing.json happens to say when somebody opens the document a year later.
 * That is the same rule the subscription follows, and for the same reason:
 * a signed agreement is a record of a moment, and a record that silently
 * re-renders is not a record.
 */
import type { FieldProblem } from './noc.js';
import { type PricingSnapshot } from '../pricing.js';

const blank = (v: unknown): boolean =>
  v === null || v === undefined || String(v).trim().length === 0;

// -----------------------------------------------------------------------------
// Hold harmless — the agreement OCS takes before working a job it does not run
// -----------------------------------------------------------------------------

export interface HoldHarmlessInput {
  /** The party being held harmless. In practice, OCS. */
  indemnifiedPartyName: string;
  /** The party giving the indemnity — the contractor. */
  indemnifyingPartyName: string;
  indemnifyingPartyAddress: string;
  /** Who signs for them, and in what capacity. */
  signerName: string;
  signerTitle?: string | null;

  /**
   * What the indemnity covers.
   *
   * Required, and deliberately not defaulted. A blanket "all work" indemnity
   * with no described scope is the kind a court reads narrowly or strikes; and
   * OCS reading it as covering everything is exactly the misunderstanding this
   * document exists to prevent.
   */
  scopeDescription: string;

  /** The job it attaches to, where it attaches to one. */
  propertyAddress?: string | null;
  permitNumber?: string | null;

  effectiveDate: string;

  /**
   * Whether the contractor carries general liability, and for how much.
   *
   * An indemnity from a party with no insurance is a promise, not a remedy.
   * Recorded here so the person accepting it can see which one they are taking.
   */
  generalLiabilityCarrier?: string | null;
  generalLiabilityLimitCents?: number | null;
  generalLiabilityExpiresOn?: string | null;
}

export function validateHoldHarmless(
  input: Partial<HoldHarmlessInput>,
  now: Date = new Date(),
): FieldProblem[] {
  const problems: FieldProblem[] = [];

  if (blank(input.indemnifiedPartyName)) {
    problems.push({
      field: 'indemnifiedPartyName',
      severity: 'blocking',
      detail: 'Name the party being held harmless.',
    });
  }
  if (blank(input.indemnifyingPartyName) || blank(input.indemnifyingPartyAddress)) {
    problems.push({
      field: 'indemnifyingPartyName',
      severity: 'blocking',
      detail: 'The indemnifying party needs both a legal name and an address.',
      consequence:
        'An indemnity that cannot be served on anybody cannot be enforced ' +
        'against anybody.',
    });
  }
  if (blank(input.signerName)) {
    problems.push({
      field: 'signerName',
      severity: 'blocking',
      detail: 'Nobody is named as signing for the indemnifying party.',
    });
  }
  if (blank(input.scopeDescription)) {
    problems.push({
      field: 'scopeDescription',
      severity: 'blocking',
      detail: 'Describe the work this indemnity covers.',
      consequence:
        'An indemnity with no stated scope is read narrowly when it is finally ' +
        'read, which is the one moment it needs to be read broadly.',
    });
  }
  if (blank(input.effectiveDate)) {
    problems.push({
      field: 'effectiveDate',
      severity: 'blocking',
      detail: 'The agreement has no effective date.',
    });
  } else if (!Number.isFinite(Date.parse(input.effectiveDate ?? ''))) {
    problems.push({
      field: 'effectiveDate',
      severity: 'blocking',
      detail: 'That is not a valid effective date.',
    });
  }

  if (blank(input.signerTitle)) {
    problems.push({
      field: 'signerTitle',
      severity: 'warning',
      detail: 'The signer’s title is not stated.',
      consequence:
        'Authority to bind the company is a question that comes up later. ' +
        'Stating the title now is cheaper than proving it then.',
    });
  }

  /*
   * Insurance is checked, and reported, never required.
   *
   * OCS may well decide to take an indemnity from an uninsured contractor --
   * that is a commercial judgement. What it must not do is take one without
   * noticing.
   */
  if (blank(input.generalLiabilityCarrier) || blank(input.generalLiabilityLimitCents)) {
    problems.push({
      field: 'generalLiabilityCarrier',
      severity: 'warning',
      detail: 'No general liability coverage is recorded for the indemnifying party.',
      consequence:
        'An indemnity from an uninsured party is a promise to pay, not a source ' +
        'of payment.',
    });
  } else if (!blank(input.generalLiabilityExpiresOn)) {
    const expires = Date.parse(input.generalLiabilityExpiresOn ?? '');
    if (!Number.isFinite(expires)) {
      problems.push({
        field: 'generalLiabilityExpiresOn',
        severity: 'warning',
        detail: 'The insurance expiry date could not be read.',
      });
    } else if (expires < now.getTime()) {
      problems.push({
        field: 'generalLiabilityExpiresOn',
        severity: 'warning',
        detail: 'The general liability policy on file has already expired.',
        consequence:
          'The coverage named in this agreement does not exist as of today. ' +
          'Get a current certificate before relying on it.',
      });
    }
  }

  return problems;
}

// -----------------------------------------------------------------------------
// Contractor services agreement — what OCS sells, at the price agreed
// -----------------------------------------------------------------------------

export interface ContractorAgreementInput {
  companyLegalName: string;
  companyAddress: string;
  signerName: string;
  signerTitle?: string | null;

  /** The qualifying licence the services attach to. */
  licenseNumber?: string | null;
  licenseState?: string | null;

  /** How many trade classifications the company is buying coverage for. */
  classificationCount: number;

  /**
   * The prices, as agreed, at the moment of agreement.
   *
   * Passed in rather than looked up. The agreement is a record of what was
   * agreed; re-deriving it from today's price table would rewrite history
   * every time the document is opened.
   */
  pricing: PricingSnapshot;

  /** What was actually collected up front, in cents. */
  onboardingCollectedCents: number;
  /** The compliance retainer held, in cents. Its own ledger, never revenue. */
  retainerHeldCents: number;

  effectiveDate: string;
  /** Notice period for termination, in days. */
  terminationNoticeDays?: number | null;
}

export function validateContractorAgreement(
  input: Partial<ContractorAgreementInput>,
): FieldProblem[] {
  const problems: FieldProblem[] = [];

  if (blank(input.companyLegalName) || blank(input.companyAddress)) {
    problems.push({
      field: 'companyLegalName',
      severity: 'blocking',
      detail: 'The company needs both its legal name and an address.',
      consequence:
        'A trade name is not a legal entity. An agreement signed in one may ' +
        'bind nobody.',
    });
  }
  if (blank(input.signerName)) {
    problems.push({
      field: 'signerName',
      severity: 'blocking',
      detail: 'Nobody is named as signing for the company.',
    });
  }
  if (blank(input.effectiveDate)) {
    problems.push({
      field: 'effectiveDate',
      severity: 'blocking',
      detail: 'The agreement has no effective date.',
    });
  }

  /*
   * No snapshot, no agreement. This is the one blocking rule here that is not
   * about a missing name, and it is the most important: an agreement that
   * points at a live price table promises whatever that table says next year.
   */
  if (!input.pricing) {
    problems.push({
      field: 'pricing',
      severity: 'blocking',
      detail: 'No pricing snapshot was captured for this agreement.',
      consequence:
        'Without one the document has no fixed prices. What the customer signed ' +
        'would change the next time the price list changed.',
    });
  } else {
    if (blank(input.pricing.capturedAt)) {
      problems.push({
        field: 'pricing.capturedAt',
        severity: 'blocking',
        detail: 'The pricing snapshot does not say when it was taken.',
        consequence: 'A snapshot with no timestamp cannot be shown to be the one agreed.',
      });
    }
    if (!Number.isInteger(input.pricing.monthlyPriceCents) || input.pricing.monthlyPriceCents < 0) {
      problems.push({
        field: 'pricing.monthlyPriceCents',
        severity: 'blocking',
        detail: 'The monthly service fee in the snapshot is not a whole number of cents.',
      });
    }
  }

  const collected = input.onboardingCollectedCents;
  if (collected !== undefined && collected !== null) {
    if (!Number.isInteger(collected) || collected < 0) {
      problems.push({
        field: 'onboardingCollectedCents',
        severity: 'blocking',
        detail: 'The onboarding amount collected must be a whole number of cents.',
      });
    } else if (input.pricing && collected > input.pricing.onboardingFeeCents) {
      problems.push({
        field: 'onboardingCollectedCents',
        severity: 'warning',
        detail:
          'More onboarding was collected than the snapshot price for this plan.',
        consequence:
          'Onboarding is charged once. If this is an upgrade, the difference is ' +
          'what should have been charged, not the full fee again.',
      });
    }
  }

  const retainer = input.retainerHeldCents;
  if (retainer !== undefined && retainer !== null) {
    if (!Number.isInteger(retainer) || retainer < 0) {
      problems.push({
        field: 'retainerHeldCents',
        severity: 'blocking',
        detail: 'The retainer held must be a whole number of cents.',
      });
    } else if (input.pricing && retainer < input.pricing.complianceRetainerCents) {
      problems.push({
        field: 'retainerHeldCents',
        severity: 'warning',
        detail: 'Less retainer is held than this plan calls for.',
        consequence:
          'The shortfall is collectible now. Reducing a retainer needs admin ' +
          'approval; simply never having collected it does not.',
      });
    }
  }

  if (
    input.classificationCount !== undefined &&
    input.classificationCount !== null &&
    (!Number.isInteger(input.classificationCount) || input.classificationCount < 1)
  ) {
    problems.push({
      field: 'classificationCount',
      severity: 'blocking',
      detail: 'The number of trade classifications must be at least one.',
    });
  }

  if (blank(input.licenseNumber)) {
    problems.push({
      field: 'licenseNumber',
      severity: 'warning',
      detail: 'No qualifying licence number is recorded on the agreement.',
    });
  }
  if (blank(input.terminationNoticeDays)) {
    problems.push({
      field: 'terminationNoticeDays',
      severity: 'warning',
      detail: 'No termination notice period is stated.',
      consequence:
        'Silence here means the parties argue about it at the one moment they ' +
        'have already stopped cooperating.',
    });
  }

  return problems;
}

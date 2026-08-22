/**
 * Putting an instrument in the post, and being able to prove it.
 *
 * The reason this is a domain module and not three lines inside a route: for a
 * Notice to Owner, SERVICE IS THE WHOLE POINT. A notice that was written
 * perfectly, produced perfectly, and cannot be proved to have been served is
 * worth nothing when it matters. So the rules about how a thing goes out are
 * rules, not options a caller passes in.
 *
 * Three of them drive everything below.
 *
 * 1. THE STATUTE PICKS THE CLASS, NOT THE USER. A Notice to Owner goes
 *    certified with return receipt because that is what produces proof of
 *    service. Offering "first class, it's cheaper" on that screen would let
 *    somebody save four dollars and lose a lien.
 *
 * 2. VERIFY THE ADDRESS BEFORE SPENDING THE MONEY. An undeliverable address on
 *    an NTO is a failed service that nobody notices until the return-to-sender
 *    arrives weeks later -- by which point the window has closed.
 *
 * 3. ONE LETTER PER RECIPIENT, EACH WITH ITS OWN TRACKING. "Served the owner
 *    and the contractor" is two facts, provable separately or not at all.
 */
import type { DocumentKind } from './documents/index.js';

/**
 * How a letter goes out.
 *
 * `certified_return_receipt` is the one that produces admissible proof: the
 * green card comes back signed. `certified` gives tracking and a mailing
 * receipt but no signature. `first_class` proves nothing and is for documents
 * where nothing needs proving.
 */
export type MailClass = 'first_class' | 'certified' | 'certified_return_receipt';

export const MAIL_CLASS_LABELS: Record<MailClass, string> = {
  first_class: 'First class',
  certified: 'Certified mail',
  certified_return_receipt: 'Certified mail, return receipt requested',
};

/**
 * What each instrument must go out as.
 *
 * Not a default the caller may override — see rule 1. Where the law is
 * indifferent (an agreement, an indemnity), first class is honest: pretending
 * a countersigned agreement needs a green card wastes the contractor's money.
 */
export const REQUIRED_MAIL_CLASS: Record<DocumentKind, MailClass> = {
  /*
   * 713.06(2)(a). The notice must be served, and the claimant carries the
   * burden of showing it was. A return receipt is the cheapest way to carry it.
   */
  NTO: 'certified_return_receipt',
  /*
   * An NOC is RECORDED with the clerk, not served — it is posted on the site.
   * It is mailable (owners and lenders ask for copies) but nothing turns on
   * proof of delivery, so certified would be theatre.
   */
  NOC: 'first_class',
  HOLD_HARMLESS: 'first_class',
  CONTRACTOR_AGREEMENT: 'first_class',
};

export interface MailAddress {
  name: string;
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  /** Two-letter country. Defaults to US; kept explicit so it is never guessed. */
  country?: string;
}

/** Who a copy goes to, and why they are entitled to one. */
export type RecipientRole = 'owner' | 'contractor' | 'lender' | 'claimant' | 'other';

export const RECIPIENT_ROLE_LABELS: Record<RecipientRole, string> = {
  owner: 'Owner',
  contractor: 'Contractor',
  lender: 'Lender',
  claimant: 'Claimant',
  other: 'Other',
};

export interface MailProblem {
  field: string;
  detail: string;
  consequence?: string;
}

const blank = (v: unknown): boolean =>
  v === null || v === undefined || String(v).trim().length === 0;

/** US state, two letters. A three-letter "FLA" is a returned letter. */
const STATE = /^[A-Za-z]{2}$/;
/** ZIP or ZIP+4. */
const ZIP = /^\d{5}(-\d{4})?$/;

export function validateAddress(addr: Partial<MailAddress>, field = 'address'): MailProblem[] {
  const problems: MailProblem[] = [];

  if (blank(addr.name)) {
    problems.push({ field: `${field}.name`, detail: 'The recipient has no name.' });
  }
  if (blank(addr.line1)) {
    problems.push({ field: `${field}.line1`, detail: 'The street address is missing.' });
  }
  if (blank(addr.city)) {
    problems.push({ field: `${field}.city`, detail: 'The city is missing.' });
  }
  if (blank(addr.state) || !STATE.test(String(addr.state).trim())) {
    problems.push({
      field: `${field}.state`,
      detail: 'The state must be its two-letter abbreviation.',
    });
  }
  if (blank(addr.postalCode) || !ZIP.test(String(addr.postalCode).trim())) {
    problems.push({
      field: `${field}.postalCode`,
      detail: 'The ZIP code must be five digits, or ZIP+4.',
    });
  }

  return problems;
}

/**
 * Which statuses a document may be posted from.
 *
 * A DRAFT can go out: producing and mailing are one motion for a permit tech,
 * and forcing an "issue" click in between would only teach people to click it
 * without reading. A VOID one cannot, ever — the point of voiding something is
 * that it stops being acted on.
 */
export function canMail(status: string): { ok: true } | { ok: false; reason: string } {
  if (status === 'void') {
    return {
      ok: false,
      reason:
        'This document was voided. Mailing it would put a withdrawn instrument in ' +
        'somebody’s hands. Generate a replacement and mail that.',
    };
  }
  return { ok: true };
}

/**
 * What a mailing costs, in cents, before the provider's own price.
 *
 * OCS charges these through at cost. The number here is what we EXPECT, used to
 * show a price before somebody commits and to catch a provider bill that has
 * drifted from what the screen promised. The authoritative figure is whatever
 * the provider actually charged, recorded on the row.
 */
export const EXPECTED_COST_CENTS: Record<MailClass, number> = {
  first_class: 108,
  certified: 608,
  certified_return_receipt: 1_003,
};

export interface MailRequest {
  documentKind: DocumentKind;
  to: Partial<MailAddress>;
  from: Partial<MailAddress>;
  role: RecipientRole;
  /** Overrides the statutory class ONLY upward. See assertClass. */
  requestedClass?: MailClass;
}

const STRENGTH: Record<MailClass, number> = {
  first_class: 0,
  certified: 1,
  certified_return_receipt: 2,
};

/**
 * The class this letter actually goes out as.
 *
 * A caller may ask for something STRONGER than the statute requires — sending
 * an agreement certified because a particular contractor disputes everything is
 * a legitimate business call. They may not ask for something weaker: that trade
 * is a few dollars against a lien, and it is not a trade a form should offer.
 */
export function resolveMailClass(
  kind: DocumentKind,
  requested?: MailClass,
): { mailClass: MailClass; downgradeRefused: boolean } {
  const required = REQUIRED_MAIL_CLASS[kind];
  if (!requested) return { mailClass: required, downgradeRefused: false };
  if (STRENGTH[requested] >= STRENGTH[required]) {
    return { mailClass: requested, downgradeRefused: false };
  }
  return { mailClass: required, downgradeRefused: true };
}

/** Everything wrong with a mail request, before a penny is spent. */
export function validateMailRequest(req: MailRequest): MailProblem[] {
  const problems: MailProblem[] = [
    ...validateAddress(req.to, 'to'),
    ...validateAddress(req.from, 'from'),
  ];

  /*
   * A return address is not a formality on certified mail. The green card and
   * the return-to-sender both come back to it, and those two pieces of paper
   * are the proof of service. A letter with a bad return address can be
   * delivered perfectly and still leave nothing to show for it.
   */
  if (
    REQUIRED_MAIL_CLASS[req.documentKind] === 'certified_return_receipt' &&
    problems.some((p) => p.field.startsWith('from.'))
  ) {
    problems.push({
      field: 'from',
      detail: 'A return address is required for certified mail.',
      consequence:
        'The signed receipt comes back to it. Without a good return address the ' +
        'letter can arrive and still prove nothing.',
    });
  }

  return problems;
}

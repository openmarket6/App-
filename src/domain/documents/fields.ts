/**
 * What each instrument asks for, in the order a person should answer it.
 *
 * This exists so there is ONE list, served to the screen rather than typed out
 * again in it. Two hand-maintained field lists is how a form ends up offering a
 * field the server ignores, or omitting one the server requires -- and the
 * person who finds out is a permit tech looking at a refusal for a box that was
 * never on their screen.
 *
 * `required` here means "the validator will block without it". It is derived
 * from the same reading as validateNoc / validateNto / validateHoldHarmless /
 * validateContractorAgreement, and a test asserts the two agree: every field
 * those functions can raise a BLOCKING problem about must be marked required
 * here. That test is the whole reason this file is safe to trust.
 */
import type { DocumentKind } from './noc.js';
import { AS_BUILT_TRADES, AS_BUILT_TRADE_LABELS } from './asBuiltLetter.js';

export type FieldType = 'text' | 'textarea' | 'date' | 'money' | 'number' | 'select';

export interface FieldSpec {
  name: string;
  label: string;
  type: FieldType;
  required: boolean;
  /** Shown under the input. Says why it matters, not what it is. */
  help?: string;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
  /** Fields are grouped so a long form reads as sections, not a wall. */
  group: string;
}

const NOC_FIELDS: FieldSpec[] = [
  {
    name: 'propertyAddress', label: 'Street address of the job site', type: 'text',
    required: true, group: 'The property',
    placeholder: '1200 Bay Street, Tampa, FL 33606',
  },
  {
    name: 'legalDescription', label: 'Legal description', type: 'textarea', required: true,
    group: 'The property',
    help:
      'Lot, block, plat book and page, or metes and bounds. Required separately from ' +
      'the address: this is recorded against a parcel, and a street address does not ' +
      'identify one. An NOC recorded with only an address is the classic defect.',
  },
  {
    name: 'parcelId', label: 'Parcel identification number', type: 'text', required: false,
    group: 'The property', help: 'Most county clerks expect one.',
  },
  {
    name: 'improvementDescription', label: 'General description of the improvement',
    type: 'textarea', required: true, group: 'The improvement',
    help: '"Work" or "construction" does not tell a reader what is being built.',
  },
  { name: 'ownerName', label: 'Owner name', type: 'text', required: true, group: 'Owner' },
  { name: 'ownerAddress', label: 'Owner address', type: 'text', required: true, group: 'Owner' },
  {
    name: 'ownerInterest', label: 'Owner’s interest in the property', type: 'text',
    required: false, group: 'Owner', placeholder: 'Fee simple',
  },
  {
    name: 'feeSimpleTitleholderName', label: 'Fee simple titleholder', type: 'text',
    required: false, group: 'Owner',
    help: 'Only when the titleholder is somebody other than the owner named above.',
  },
  {
    name: 'feeSimpleTitleholderAddress', label: 'Titleholder address', type: 'text',
    required: false, group: 'Owner',
  },
  {
    name: 'contractorName', label: 'Contractor name', type: 'text', required: true,
    group: 'Contractor',
  },
  {
    name: 'contractorAddress', label: 'Contractor address', type: 'text', required: true,
    group: 'Contractor',
  },
  { name: 'contractorPhone', label: 'Telephone', type: 'text', required: false, group: 'Contractor' },
  {
    name: 'contractorLicenseNumber', label: 'Licence number', type: 'text', required: false,
    group: 'Contractor',
  },
  {
    name: 'suretyName', label: 'Surety name', type: 'text', required: false,
    group: 'Payment bond (if any)',
    help: 'All three bond fields go together. A partial entry tells subcontractors they may be protected without saying by whom or for how much.',
  },
  { name: 'suretyAddress', label: 'Surety address', type: 'text', required: false, group: 'Payment bond (if any)' },
  {
    name: 'suretyBondAmountCents', label: 'Amount of bond', type: 'money', required: false,
    group: 'Payment bond (if any)',
  },
  { name: 'lenderName', label: 'Lender name', type: 'text', required: false, group: 'Lender' },
  {
    name: 'lenderAddress', label: 'Lender address', type: 'text', required: false, group: 'Lender',
    help: 'Required once a lender is named — notices have to be able to reach them.',
  },
  {
    name: 'designatedPersonName', label: 'Designated person', type: 'text', required: false,
    group: 'Designated person',
    help: 'Receives copies of notices under 713.13(1)(b). Without one, notices reach only the owner.',
  },
  {
    name: 'designatedPersonAddress', label: 'Their address', type: 'text', required: false,
    group: 'Designated person',
  },
  {
    name: 'expirationDate', label: 'Expiration date', type: 'date', required: false,
    group: 'Signature',
    help: 'Left blank it runs one year from recording. A job still going after that needs a new notice before work continues.',
  },
  {
    name: 'ownerSignatureName', label: 'Name of the owner signing', type: 'text', required: true,
    group: 'Signature',
  },
  {
    name: 'notarizationId', label: 'Notarization record', type: 'text', required: true,
    group: 'Signature',
    help: 'This is sworn. The clerk will not record one without a notarial certificate.',
  },
];

const NTO_FIELDS: FieldSpec[] = [
  { name: 'claimantName', label: 'Claimant name', type: 'text', required: true, group: 'Claimant',
    help: 'Who is serving this notice — the subcontractor or supplier.' },
  { name: 'claimantAddress', label: 'Claimant address', type: 'text', required: true, group: 'Claimant' },
  {
    name: 'servicesOrMaterials', label: 'Services or materials furnished', type: 'textarea',
    required: true, group: 'Claimant',
  },
  { name: 'ownerName', label: 'Owner name', type: 'text', required: true, group: 'Owner' },
  { name: 'ownerAddress', label: 'Owner address', type: 'text', required: true, group: 'Owner' },
  {
    name: 'contractedWithName', label: 'Contracted with', type: 'text', required: false,
    group: 'Owner', help: 'Who the claimant contracted with, if not the owner.',
  },
  { name: 'propertyAddress', label: 'Property address', type: 'text', required: true, group: 'The property' },
  { name: 'legalDescription', label: 'Legal description', type: 'textarea', required: true, group: 'The property' },
  {
    name: 'firstFurnishingDate', label: 'Date first furnished', type: 'date', required: true,
    group: 'Timing',
    help:
      'The field this whole notice turns on. The deadline for serving runs from it, and ' +
      'a notice served late does not protect the lien.',
  },
  { name: 'servedDate', label: 'Date served', type: 'date', required: false, group: 'Timing' },
  {
    name: 'serviceMethod', label: 'Method of service', type: 'text', required: false,
    group: 'Timing', placeholder: 'Certified mail, return receipt requested, no. …',
  },
];

const HOLD_HARMLESS_FIELDS: FieldSpec[] = [
  {
    name: 'indemnifiedPartyName', label: 'Party being held harmless', type: 'text',
    required: true, group: 'The parties', placeholder: 'One Contractor Solutions LLC',
  },
  {
    name: 'indemnifyingPartyName', label: 'Party giving the indemnity', type: 'text',
    required: true, group: 'The parties',
    help: 'Their legal name. A trade name is not an entity, and an agreement signed in one may bind nobody.',
  },
  {
    name: 'indemnifyingPartyAddress', label: 'Their address', type: 'text', required: true,
    group: 'The parties',
    help: 'An indemnity that cannot be served on anybody cannot be enforced against anybody.',
  },
  { name: 'signerName', label: 'Who signs for them', type: 'text', required: true, group: 'The parties' },
  {
    name: 'signerTitle', label: 'Their title', type: 'text', required: false, group: 'The parties',
    help: 'Authority to bind the company comes up later. Stating it now is cheaper than proving it then.',
  },
  {
    name: 'scopeDescription', label: 'Work this indemnity covers', type: 'textarea',
    required: true, group: 'The work',
    help: 'An indemnity with no stated scope is read narrowly at the one moment it needs to be read broadly.',
  },
  { name: 'propertyAddress', label: 'Property', type: 'text', required: false, group: 'The work' },
  { name: 'permitNumber', label: 'Permit number', type: 'text', required: false, group: 'The work' },
  { name: 'effectiveDate', label: 'Effective date', type: 'date', required: true, group: 'The work' },
  {
    name: 'generalLiabilityCarrier', label: 'General liability carrier', type: 'text',
    required: false, group: 'Their insurance',
    help: 'An indemnity from an uninsured party is a promise to pay, not a source of payment.',
  },
  {
    name: 'generalLiabilityLimitCents', label: 'Limit', type: 'money', required: false,
    group: 'Their insurance',
  },
  {
    name: 'generalLiabilityExpiresOn', label: 'Policy expires', type: 'date', required: false,
    group: 'Their insurance',
  },
];

const CONTRACTOR_AGREEMENT_FIELDS: FieldSpec[] = [
  {
    name: 'companyLegalName', label: 'Company legal name', type: 'text', required: true,
    group: 'The company',
    help: 'Not the trade name. A trade name is not a legal entity.',
  },
  { name: 'companyAddress', label: 'Company address', type: 'text', required: true, group: 'The company' },
  { name: 'signerName', label: 'Who signs', type: 'text', required: true, group: 'The company' },
  { name: 'signerTitle', label: 'Their title', type: 'text', required: false, group: 'The company' },
  {
    name: 'licenseNumber', label: 'Qualifying licence number', type: 'text', required: false,
    group: 'The company',
  },
  {
    name: 'licenseState', label: 'Licence state', type: 'text', required: false,
    group: 'The company', placeholder: 'FL',
  },
  {
    name: 'classificationCount', label: 'Trade classifications covered', type: 'number',
    required: false, group: 'Plan',
    help: 'Seven or more must be offered the One-Stop All-Trades plan.',
  },
  {
    name: 'onboardingCollectedCents', label: 'Onboarding collected on signing', type: 'money',
    required: false, group: 'Money',
    help: 'What was actually collected. On an upgrade this is the difference, not the full fee again.',
  },
  {
    name: 'retainerHeldCents', label: 'Compliance retainer held', type: 'money', required: false,
    group: 'Money',
    help: 'Held on the company’s behalf on a separate ledger. Never revenue.',
  },
  { name: 'effectiveDate', label: 'Effective date', type: 'date', required: true, group: 'Terms' },
  {
    name: 'terminationNoticeDays', label: 'Termination notice, in days', type: 'number',
    required: false, group: 'Terms',
    help: 'Silence here means the parties argue about it at the one moment they have stopped cooperating.',
  },
];

/**
 * The trade comes first, and it is a dropdown, because it changes what the rest
 * of the letter says.
 *
 * Every other field is the same whichever trade is chosen; the certification
 * sentence and the specifics a plans examiner checks are not.
 */
const AS_BUILT_LETTER_FIELDS: FieldSpec[] = [
  {
    name: 'trade', label: 'Trade this letter certifies', type: 'select', required: true,
    group: 'The letter',
    options: AS_BUILT_TRADES.map((t) => ({ value: t, label: AS_BUILT_TRADE_LABELS[t] })),
    help: 'Departments usually want one letter per trade, signed by that trade\u2019s licence holder.',
  },
  {
    name: 'permitNumber', label: 'Permit number', type: 'text', required: true,
    group: 'The letter',
    help: 'How the department files this against the job. Without it the letter arrives attached to nothing.',
  },
  {
    name: 'propertyAddress', label: 'Property address', type: 'text', required: true,
    group: 'The property', placeholder: '1200 Bay Street, Tampa, FL 33606',
  },
  {
    name: 'parcelId', label: 'Parcel identification number', type: 'text', required: false,
    group: 'The property', help: 'Most departments index by parcel as well as address.',
  },
  {
    name: 'contractorName', label: 'Certifying contractor\u2019s legal name', type: 'text',
    required: true, group: 'Who is certifying',
    help: 'A trade name is not a legal entity. A certification signed in one binds nobody.',
  },
  {
    name: 'contractorLicenseNumber', label: 'Licence number', type: 'text', required: true,
    group: 'Who is certifying', help: 'The licence is what gives this letter its weight.',
  },
  {
    name: 'contractorAddress', label: 'Contractor address', type: 'text', required: false,
    group: 'Who is certifying',
  },
  {
    name: 'qualifierName', label: 'Name of the person signing', type: 'text', required: true,
    group: 'Who is certifying',
  },
  {
    name: 'scopeDescription', label: 'What was installed', type: 'textarea', required: true,
    group: 'The work',
    help: '\u201CThe work\u201D does not tell a reviewer what is being certified.',
  },
  {
    name: 'codeEdition', label: 'Code edition', type: 'text', required: true,
    group: 'The work', placeholder: '2023 Florida Building Code, 8th Edition',
    help: 'The edition the PERMIT was issued under, not the one in force today.',
  },
  {
    name: 'approvedPlansRevision', label: 'Approved plans revision', type: 'text',
    required: false, group: 'The work',
    help: 'Only when the department approved a revision after the original set.',
  },
  {
    name: 'completedOn', label: 'Date the work was completed', type: 'date', required: true,
    group: 'The work',
  },
  {
    name: 'deviations', label: 'Deviations from the approved plans', type: 'textarea',
    required: false, group: 'The work',
    help: 'Left blank, the letter states there were none \u2014 which is a certification in itself. If anything was built differently, say so and how it was approved.',
  },
];

export const DOCUMENT_FIELDS: Record<DocumentKind, readonly FieldSpec[]> = {
  NOC: NOC_FIELDS,
  NTO: NTO_FIELDS,
  HOLD_HARMLESS: HOLD_HARMLESS_FIELDS,
  AS_BUILT_LETTER: AS_BUILT_LETTER_FIELDS,
  CONTRACTOR_AGREEMENT: CONTRACTOR_AGREEMENT_FIELDS,
};

/**
 * The plan a contractor agreement snapshots.
 *
 * Not a form field: the screen picks a plan and the SERVER takes the snapshot,
 * because a browser-supplied price list is a price list the customer could have
 * edited. `planKey` is what the screen sends.
 */
export const AGREEMENT_PLAN_FIELD = 'planKey';

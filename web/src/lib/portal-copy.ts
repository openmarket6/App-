/**
 * Contractor-facing wording, in one place.
 *
 * The staff side calls a stage `IN_REVIEW` and shows a badge. A contractor
 * standing on a roof wants a sentence: whose desk is it on, and can I work?
 * Those sentences are here rather than inside a page so the home screen, the
 * permit page and anything added later cannot describe the same permit two
 * different ways — which is exactly the sort of small inconsistency that makes
 * a portal feel like a report rather than a service.
 *
 * No domain logic lives here. Stage grouping is in `@flph/shared`.
 */
import type { DocumentStatus, PermitStage } from '@flph/shared';

/** One line: who the ball is with, said the way a contractor would say it. */
export function stageNarrative(stage: PermitStage): string {
  switch (stage) {
    case 'DRAFT':
      return 'We are putting the package together.';
    case 'READY_TO_SUBMIT':
      return 'Package is ready — we are filing it.';
    case 'SUBMITTED':
      return 'Filed. Waiting on the building department to pick it up.';
    case 'INTAKE_REVIEW':
      return 'The department is checking the application is complete.';
    case 'IN_REVIEW':
      return 'A plans examiner has it.';
    case 'CORRECTIONS_REQUIRED':
      return 'The examiner asked for changes. We are answering — you may be asked for a document.';
    case 'RESUBMITTED':
      return 'Answered and back with the examiner.';
    case 'APPROVED':
      return 'Approved. Fees and issuance next.';
    case 'ISSUED':
      return 'Permit is issued. You can work.';
    case 'INSPECTIONS':
      return 'Inspections are running.';
    case 'CLOSED':
      return 'Finished and closed out.';
    case 'EXPIRED':
      return 'This permit has expired. Talk to us before any more work happens.';
    case 'WITHDRAWN':
      return 'Withdrawn.';
    case 'DENIED':
      return 'Denied. Talk to us about what it would take to re-file.';
    default:
      return '';
  }
}

/** A document's state, without the vault's vocabulary. */
export const DOC_STATUS_LABEL: Record<DocumentStatus, string> = {
  PENDING: 'Not uploaded',
  UPLOADED: 'With us',
  SUBMITTED: 'Sent to the agency',
  ACCEPTED: 'Accepted',
  REJECTED: 'Sent back',
  SUPERSEDED: 'Replaced',
};

export const DOC_STATUS_CLASS: Record<DocumentStatus, string> = {
  PENDING: 'badge-gray',
  UPLOADED: 'badge-blue',
  SUBMITTED: 'badge-blue',
  ACCEPTED: 'badge-green',
  REJECTED: 'badge-red',
  SUPERSEDED: 'badge-gray',
};

/**
 * The permit sub-folders, mirroring `PERMIT_SECTIONS` in
 * `@flph/shared/portal.ts` — which owns the tree and does not export the list.
 * Keep the keys, names and category mapping identical to that file: the whole
 * point of grouping a permit's documents this way is that the permit page and
 * the file browser show the same shelves.
 */
export interface PermitSection {
  key: string;
  name: string;
  hint: string;
  categories: string[];
  acceptsUpload: boolean;
}

export const PERMIT_SECTIONS: PermitSection[] = [
  {
    key: 'plans',
    name: 'Plans & drawings',
    hint: 'Signed and sealed plan sets, site plans, truss layouts.',
    categories: ['PLAN_SET'],
    acceptsUpload: true,
  },
  {
    key: 'submittal',
    name: 'Submittal package',
    hint: 'Everything that went to the building department with this application.',
    categories: ['SUBMITTAL'],
    acceptsUpload: true,
  },
  {
    key: 'product-approval',
    name: 'Product approvals',
    hint: 'Florida Product Approval or Miami-Dade NOA sheets for every product in the assembly.',
    categories: ['PRODUCT_APPROVAL'],
    acceptsUpload: true,
  },
  {
    key: 'corrections',
    name: 'Correction responses',
    hint: 'What we sent back to answer the plans examiner.',
    categories: ['CORRECTION_RESPONSE'],
    acceptsUpload: true,
  },
  {
    key: 'photos',
    name: 'Job photos',
    hint: 'Site photos for the application or the inspector. Taken on your phone is fine.',
    categories: ['JOB_PHOTO', 'SUPERVISION_PHOTO'],
    acceptsUpload: true,
  },
  {
    key: 'from-agency',
    name: 'From the agency',
    hint: 'The issued permit card, correction notices, inspection results.',
    categories: ['AGENCY_ISSUED'],
    acceptsUpload: false,
  },
];

/** Requirement keys whose evidence is a drawing rather than a form. */
const PLAN_KEYS = new Set([
  'site_plan',
  'structural_plans',
  'truss_engineering',
  'wet_signed_set',
  'opening_schedule',
  'attachment_detail',
  'electrical_one_line',
  'electrical_bonding',
  'roof_uplift',
  'wind_calc',
  'hvhz_wind_calc',
  'flood_vents',
]);

/**
 * Which permit sub-folder a requirement's evidence belongs in.
 *
 * The contractor never picks a folder — they press upload next to the thing
 * that is missing, and the path decides the category. Anything unrecognised
 * lands in the submittal package, which is where a coordinator would have put
 * it by hand.
 */
export function sectionForRequirement(key: string): string {
  if (key.includes('product_approval') || key === 'opening_protection') return 'product-approval';
  if (PLAN_KEYS.has(key)) return 'plans';
  return 'submittal';
}

/** `projects/<projectId>/permits/<permitId>/<section>` — the only shape that carries a permit. */
export function permitFolderPath(projectId: string, permitId: string, section: string): string {
  return `projects/${projectId}/permits/${permitId}/${section}`;
}

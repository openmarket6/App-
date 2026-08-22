/** Domain enums. Kept as const objects + unions so they survive JSON round-trips. */

export const PERMIT_STAGES = [
  'DRAFT',
  'READY_TO_SUBMIT',
  'SUBMITTED',
  'INTAKE_REVIEW',
  'IN_REVIEW',
  'CORRECTIONS_REQUIRED',
  'RESUBMITTED',
  'APPROVED',
  'ISSUED',
  'INSPECTIONS',
  'CLOSED',
  'EXPIRED',
  'WITHDRAWN',
  'DENIED',
] as const;
export type PermitStage = (typeof PERMIT_STAGES)[number];

/** Stages where the ball is in the agency's court. */
export const AGENCY_HELD_STAGES: readonly PermitStage[] = [
  'SUBMITTED',
  'INTAKE_REVIEW',
  'IN_REVIEW',
  'RESUBMITTED',
];

/** Stages where the ball is in ours or the client's court. */
export const APPLICANT_HELD_STAGES: readonly PermitStage[] = [
  'DRAFT',
  'READY_TO_SUBMIT',
  'CORRECTIONS_REQUIRED',
];

export const TERMINAL_STAGES: readonly PermitStage[] = ['CLOSED', 'EXPIRED', 'WITHDRAWN', 'DENIED'];

export const PERMIT_TYPES = [
  'RESIDENTIAL_NEW',
  'RESIDENTIAL_ALTERATION',
  'RESIDENTIAL_ADDITION',
  'COMMERCIAL_NEW',
  'COMMERCIAL_ALTERATION',
  'ROOFING',
  'WINDOWS_DOORS',
  'MECHANICAL',
  'ELECTRICAL',
  'PLUMBING',
  'POOL',
  'SOLAR',
  'FENCE',
  'DEMOLITION',
  'SIGN',
  'SHUTTERS',
  'DOCK_SEAWALL',
] as const;
export type PermitType = (typeof PERMIT_TYPES)[number];

/** How we transact with a jurisdiction today. */
export const INTEGRATION_TIERS = ['api_live', 'api_candidate', 'api_partner', 'rpa', 'manual'] as const;
export type IntegrationTier = (typeof INTEGRATION_TIERS)[number];

export const PLATFORMS = [
  'accela',
  'energov',
  'opengov',
  'clariti',
  'etrakit',
  'citizenserve',
  'click2gov',
  'iworq',
  'cloudpermit',
  'mygovernmentonline',
  'cityview',
  'esuite',
  'oracle_pscs',
  'munis',
  'smartgov',
  'bsa',
  'infor',
  'cityworks',
  'custom',
  'none',
  'unknown',
] as const;
export type Platform = (typeof PLATFORMS)[number];

/**
 * Roles.
 *
 * PENDING is the state every new account starts in, including staff. It grants
 * nothing at all — a person who has created an account but not been authorized
 * can sign in and see a waiting screen, and that is the whole of their access.
 * Making "no role yet" an explicit role rather than a null means no permission
 * check can accidentally treat an unauthorized account as a staff account.
 */
export const ROLES = [
  'ADMIN',
  'PERMIT_TECH',
  'SITE_SUPERVISOR',
  'ENGINEER',
  'VIEWER',
  'CLIENT',
  'PENDING',
] as const;
export type Role = (typeof ROLES)[number];

export const STAFF_ROLES: readonly Role[] = [
  'ADMIN', 'PERMIT_TECH', 'SITE_SUPERVISOR', 'ENGINEER', 'VIEWER',
];

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: 'Administrator',
  PERMIT_TECH: 'Permit technician',
  SITE_SUPERVISOR: 'Site supervisor / project manager',
  ENGINEER: 'Engineer / drafter',
  VIEWER: 'Viewer',
  CLIENT: 'Contractor (client portal)',
  PENDING: 'Awaiting authorization',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  ADMIN: 'Full access, including users, billing, credentials and connector configuration.',
  PERMIT_TECH: 'Day-to-day permit work: file, chase, log corrections, schedule inspections, review compliance.',
  SITE_SUPERVISOR:
    'Field staff. Attends job sites under our licence, photographs the work, and signs off each required visit.',
  ENGINEER:
    'Produces plan sets, calculations and other deliverables, prices their own jobs, and applies their ' +
    'professional seal. Works an assigned queue; does not assign work.',
  VIEWER: 'Read-only across the firm. Cannot file, edit or download credentials.',
  CLIENT: 'Sees only their own company: their permits, documents, invoices and job photos.',
  PENDING: 'Signed up but not yet authorized. Sees nothing until an administrator assigns a role.',
};

export const RISK_LEVELS = ['ON_TRACK', 'WATCH', 'AT_RISK', 'CRITICAL'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const INSPECTION_RESULTS = ['SCHEDULED', 'PASSED', 'FAILED', 'PARTIAL', 'CANCELLED', 'NO_SHOW'] as const;
export type InspectionResult = (typeof INSPECTION_RESULTS)[number];

export const DOCUMENT_STATUSES = ['PENDING', 'UPLOADED', 'SUBMITTED', 'ACCEPTED', 'REJECTED', 'SUPERSEDED'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** Where a data row came from. The domain must not care which. */
export const SOURCE_CHANNELS = ['api', 'rpa', 'manual', 'seed'] as const;
export type SourceChannel = (typeof SOURCE_CHANNELS)[number];

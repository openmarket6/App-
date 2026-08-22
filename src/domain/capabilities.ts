/**
 * Roles and capabilities.
 *
 * These names and strings are compiled into the existing React bundle, so they
 * are a fixed contract, not a design choice this file is free to revisit. The
 * one addition is SITE_SUPERVISOR, for the field staff who perform visits and
 * take the photographs.
 *
 * The model is capability-based rather than role-checks-scattered-everywhere:
 * a route asks "may this caller do supervision:log", not "is this caller a
 * PERMIT_TECH". That way adding a role is a change to one table here instead of
 * a hunt through every handler.
 *
 * IMPORTANT: capabilities decide what a caller may ATTEMPT. They are not what
 * keeps one contractor's data away from another — that is row-level security,
 * which applies even when a capability check is forgotten.
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

/** Roles that work across contractors, as opposed to inside one. */
export const STAFF_ROLES: Role[] = [
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
  ADMIN:
    'Full access, including users, billing, credentials and connector configuration.',
  PERMIT_TECH:
    'Day-to-day permit work: file, chase, log corrections, schedule inspections, review compliance.',
  SITE_SUPERVISOR:
    'Field staff. Attends job sites under our licence, photographs the work, and signs off each required visit.',
  ENGINEER:
    'Produces plan sets, calculations and other deliverables, prices their own jobs, ' +
    'and applies their professional seal. Works an assigned queue; does not assign work.',
  VIEWER: 'Read-only across the firm. Cannot file, edit or download credentials.',
  CLIENT: 'Sees only their own company: their permits, documents, invoices and job photos.',
  PENDING:
    'Signed up but not yet authorized. Sees nothing until an administrator assigns a role.',
};

export const CAPABILITIES = [
  // Permits
  'permit:read', 'permit:create', 'permit:edit', 'permit:submit', 'permit:delete',
  // Contractors and onboarding
  'client:read', 'client:create', 'client:edit', 'client:suspend',
  // Compliance
  'compliance:read', 'compliance:review', 'compliance:waive',
  // Documents
  'document:read', 'document:upload', 'document:delete',
  // Inspections
  'inspection:read', 'inspection:schedule', 'inspection:record',
  // Supervision
  'supervision:read', 'supervision:log', 'supervision:amend',
  // Drafting and engineering
  'drafting:read', 'drafting:request', 'drafting:quote', 'drafting:produce',
  'drafting:assign',
  // Sealing is its own capability, but the capability is only half the gate:
  // the act also requires a licence on file against the person doing it. An
  // administrator holds every capability and still cannot seal, because they
  // have no licence to stake. See routes/compat/engineering.ts.
  'engineering:seal', 'engineering:manage',
  // Billing
  'billing:read', 'billing:manage', 'billing:refund',
  // Jurisdictions and connectors
  'jurisdiction:read', 'jurisdiction:edit',
  'connector:read', 'connector:configure', 'connector:run',
  'credential:read', 'credential:write',
  // Administration
  'user:read', 'user:invite', 'user:assign_role',
  'settings:read', 'settings:edit', 'audit:read',
  // Portal-side (contractor)
  'portal:read_own', 'portal:upload_own', 'portal:request_drafting',
  'portal:sign_documents', 'portal:pay', 'portal:manage_team',
  'portal:request_permit',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const VIEWER_CAPS: Capability[] = [
  'permit:read', 'client:read', 'compliance:read', 'document:read',
  'inspection:read', 'supervision:read', 'drafting:read', 'billing:read',
  'jurisdiction:read', 'connector:read', 'settings:read',
];

/**
 * Site supervisor.
 *
 * Deliberately narrow. They need to see the job they are attending and record
 * what they saw — nothing more. They cannot file permits, touch billing, or
 * amend a visit after sign-off, because a field device is the most likely thing
 * in this system to be lost or handed to someone else.
 *
 * Note the absence of 'supervision:amend': changing an observation after the
 * fact is an administrator's decision, and the amendment is recorded.
 */
const SITE_SUPERVISOR_CAPS: Capability[] = [
  'permit:read',
  'client:read',
  'document:read',
  'document:upload',
  'inspection:read',
  'inspection:record',
  'supervision:read',
  'supervision:log',
  'jurisdiction:read',
];

/**
 * The staff engineer.
 *
 * Deliberately narrow. An engineer needs to see the permits and documents
 * behind the work they are drawing, produce and seal deliverables, and price
 * their own jobs -- and nothing else. They are not an administrator who happens
 * to draw.
 *
 * Note what is absent: 'drafting:assign'. An engineer works their queue; who
 * gets which job is an admin's decision, and letting engineers assign work to
 * themselves would make workload invisible to the person managing it.
 */
const ENGINEER_CAPS: Capability[] = [
  'permit:read',
  'client:read',
  'document:read', 'document:upload',
  'jurisdiction:read',
  'compliance:read',
  'drafting:read', 'drafting:quote', 'drafting:produce',
  'engineering:seal',
];

const PERMIT_TECH_CAPS: Capability[] = [
  ...VIEWER_CAPS,
  'permit:create', 'permit:edit', 'permit:submit',
  'client:create', 'client:edit',
  'compliance:review',
  'document:upload',
  'inspection:schedule', 'inspection:record',
  'supervision:log',
  'drafting:request', 'drafting:quote', 'drafting:assign',
  'connector:run',
  'user:read',
];

const CLIENT_CAPS: Capability[] = [
  'portal:read_own', 'portal:upload_own', 'portal:request_drafting',
  'portal:sign_documents', 'portal:pay', 'portal:request_permit',
  'portal:manage_team',
  // Scoped reads. Row-level security, not this table, is what confines these to
  // their own rows -- this only says the shape of data is visible to them.
  'permit:read', 'document:read', 'document:upload', 'inspection:read',
  'compliance:read', 'drafting:read', 'billing:read', 'jurisdiction:read',
];

export const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  ADMIN: CAPABILITIES,
  PERMIT_TECH: PERMIT_TECH_CAPS,
  SITE_SUPERVISOR: SITE_SUPERVISOR_CAPS,
  ENGINEER: ENGINEER_CAPS,
  VIEWER: VIEWER_CAPS,
  CLIENT: CLIENT_CAPS,
  // Deliberately empty. An unauthorized account can do nothing but wait.
  PENDING: [],
};

export function can(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

export function canAny(role: Role, capabilities: Capability[]): boolean {
  return capabilities.some((c) => can(role, c));
}

export function missingCapabilities(role: Role, required: Capability[]): Capability[] {
  return required.filter((c) => !can(role, c));
}

/** True when this role works across contractors rather than inside one. */
export function isStaff(role: Role): boolean {
  return STAFF_ROLES.includes(role);
}

/** Role catalogue for an admin's user-management screen. */
export function roleCatalogue() {
  return ROLES.map((value) => ({
    value,
    label: ROLE_LABELS[value],
    description: ROLE_DESCRIPTIONS[value],
    isStaff: isStaff(value),
    capabilityCount: ROLE_CAPABILITIES[value].length,
  }));
}

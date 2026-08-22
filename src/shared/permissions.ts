import type { Role } from './enums.js';

/**
 * Capability-based permissions.
 *
 * Routes ask "can this role do X" rather than "is this role ADMIN". Two
 * reasons: adding a fourth staff role later becomes a one-line table change
 * instead of a search-and-replace across forty route files, and the matrix
 * below is a single readable artefact you can hand to someone and ask "is this
 * right?" — which is not true of permission logic scattered through handlers.
 */
export const CAPABILITIES = [
  // Permits
  'permit:read',
  'permit:create',
  'permit:edit',
  'permit:submit',
  'permit:delete',
  // Contractors and onboarding
  'client:read',
  'client:create',
  'client:edit',
  'client:suspend',
  // Compliance
  'compliance:read',
  'compliance:review',
  'compliance:waive',
  // Documents
  'document:read',
  'document:upload',
  'document:delete',
  // Inspections
  'inspection:read',
  'inspection:schedule',
  'inspection:record',
  // Supervision (managed-licence tier)
  'supervision:read',
  'supervision:log',
  'supervision:amend',
  // Drafting
  'drafting:read',
  'drafting:request',
  'drafting:quote',
  'drafting:produce',
  'drafting:assign',
  // Sealing is its own capability, but the capability is only half the gate:
  // the act also requires a licence on file against the person doing it. An
  // administrator holds every capability and still cannot seal, because they
  // have no licence to stake.
  'engineering:seal',
  'engineering:manage',
  // Billing
  'billing:read',
  'billing:manage',
  'billing:refund',
  // Jurisdictions and connectors
  'jurisdiction:read',
  'jurisdiction:edit',
  'connector:read',
  'connector:configure',
  'connector:run',
  'credential:read',
  'credential:write',
  // Administration
  'user:read',
  'user:invite',
  'user:assign_role',
  'settings:read',
  'settings:edit',
  'audit:read',
  // Portal-side
  'portal:read_own',
  'portal:upload_own',
  'portal:request_drafting',
  'portal:sign_documents',
  'portal:pay',
  /** A contractor's own admin managing their company's logins. Scoped to their clientId. */
  'portal:manage_team',
  /** Submit a job for us to file, rather than creating a permit directly. */
  'portal:request_permit',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * Field staff, under our licence.
 *
 * They log visits and photograph work; they do not file permits or touch
 * money. The narrowness is the point: this account travels to job sites on a
 * phone, which is the account most likely to be left unlocked in a truck.
 */
const SITE_SUPERVISOR_CAPS: Capability[] = [
  'permit:read',
  'client:read',
  'document:read', 'document:upload',
  'inspection:read', 'inspection:record',
  'supervision:read', 'supervision:log',
  'jurisdiction:read',
];

/**
 * The staff engineer.
 *
 * Deliberately narrow: see the permits and documents behind the work, produce
 * and seal deliverables, price their own jobs. Notably absent is
 * 'drafting:assign' -- an engineer works their queue, and letting them assign
 * work to themselves would make workload invisible to whoever manages it.
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

const VIEWER_CAPS: Capability[] = [
  'permit:read',
  'client:read',
  'compliance:read',
  'document:read',
  'inspection:read',
  'supervision:read',
  'drafting:read',
  'billing:read',
  'jurisdiction:read',
  'connector:read',
  'settings:read',
];

const PERMIT_TECH_CAPS: Capability[] = [
  ...VIEWER_CAPS,
  'permit:create',
  'permit:edit',
  'permit:submit',
  'client:create',
  'client:edit',
  'compliance:review',
  'document:upload',
  'inspection:schedule',
  'inspection:record',
  'supervision:log',
  'drafting:request',
  'drafting:quote',
  'drafting:produce',
  'jurisdiction:edit',
  'connector:run',
  'user:read',
];

const CLIENT_CAPS: Capability[] = [
  'portal:read_own',
  'portal:upload_own',
  'portal:request_drafting',
  'portal:sign_documents',
  'portal:pay',
  'portal:request_permit',
  // Scoped reads. The client scoping layer, not this table, is what limits
  // these to their own rows — this only says the shape of data is visible.
  'permit:read',
  'document:read',
  'document:upload',
  'inspection:read',
  'compliance:read',
  'drafting:read',
  'billing:read',
  'jurisdiction:read',
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

export function canAll(role: Role, capabilities: Capability[]): boolean {
  return capabilities.every((c) => can(role, c));
}

export function canAny(role: Role, capabilities: Capability[]): boolean {
  return capabilities.some((c) => can(role, c));
}

/** Capabilities that must never be granted to a portal account, as a belt-and-braces check. */
export const PORTAL_FORBIDDEN: Capability[] = [
  'credential:read',
  'credential:write',
  'connector:configure',
  'user:assign_role',
  'billing:manage',
  'billing:refund',
  'compliance:waive',
  'permit:delete',
  'audit:read',
  'settings:edit',
];

export function assertPortalSafe(role: Role): void {
  if (role !== 'CLIENT') return;
  const leaked = PORTAL_FORBIDDEN.filter((c) => can(role, c));
  if (leaked.length) throw new Error(`Client role must never hold: ${leaked.join(', ')}`);
}

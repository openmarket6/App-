/**
 * Role-based access control.
 *
 * Two independent axes:
 *
 *   company_role  -- the user's standing inside one contractor company
 *                    (owner > admin > member > viewer)
 *   platform_role -- One Contractor Solutions' own staff
 *                    (admin > staff > none)
 *
 * They are separate because they answer different questions. A contractor owner
 * has total authority over their own company and none anywhere else; an OCS
 * drafter has limited authority across many companies. Collapsing them into one
 * ladder is how "staff" accidentally becomes "can delete a customer's account".
 *
 * Checks here are advisory-in-depth: they decide what an authenticated caller
 * may attempt. They are NOT what keeps tenants apart -- that is row-level
 * security, which applies even if one of these checks is forgotten.
 */
import { forbidden } from '../lib/errors.js';
import type { PlatformRole } from '../db/tenant.js';

export type CompanyRole = 'owner' | 'admin' | 'member' | 'viewer';

const COMPANY_RANK: Record<CompanyRole, number> = {
  viewer: 1,
  member: 2,
  admin: 3,
  owner: 4,
};

const PLATFORM_RANK: Record<PlatformRole, number> = {
  none: 0,
  staff: 1,
  admin: 2,
};

export interface Principal {
  userId: string;
  companyId: string;
  companyRole: CompanyRole;
  platformRole: PlatformRole;
  email: string;
  /** True when the session completed a second factor (aal2). */
  mfaSatisfied: boolean;
  /** True when an OCS staff member is acting inside a company they don't belong to. */
  isImpersonatedContext: boolean;
}

export function hasCompanyRole(p: Principal, min: CompanyRole): boolean {
  return COMPANY_RANK[p.companyRole] >= COMPANY_RANK[min];
}

export function hasPlatformRole(p: Principal, min: PlatformRole): boolean {
  return PLATFORM_RANK[p.platformRole] >= PLATFORM_RANK[min];
}

/** Company role check, with OCS platform admins allowed through. */
export function requireCompanyRole(p: Principal, min: CompanyRole): void {
  if (hasPlatformRole(p, 'admin')) return;
  if (!hasCompanyRole(p, min)) {
    throw forbidden(`This action requires the ${min} role or higher`);
  }
}

export function requirePlatformRole(p: Principal, min: PlatformRole): void {
  if (!hasPlatformRole(p, min)) {
    throw forbidden('This action is restricted to One Contractor Solutions staff');
  }
}

/**
 * Require a second factor for this operation.
 *
 * Applied to the things an attacker with a stolen password would actually do:
 * moving money, changing who has access, and exporting customer data.
 */
export function requireMfa(p: Principal): void {
  if (!p.mfaSatisfied) {
    throw forbidden('This action requires multi-factor authentication to be completed');
  }
}

/** Read access. Every role including viewer has it. */
export const canRead = (p: Principal) => hasCompanyRole(p, 'viewer');

/** Create/update project and permit records. */
export const canWrite = (p: Principal) => hasCompanyRole(p, 'member');

/** Manage members, licenses, insurance, company settings. */
export const canAdminister = (p: Principal) => hasCompanyRole(p, 'admin');

/** Initiate payments and refunds. */
export const canManageBilling = (p: Principal) => hasCompanyRole(p, 'admin');

/** Permanently remove company-level records. */
export const canDestroy = (p: Principal) => hasCompanyRole(p, 'owner');

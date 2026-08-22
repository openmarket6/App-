/**
 * Roles and capabilities — re-exported from the shared definition.
 *
 * THIS FILE USED TO HOLD A SECOND COPY, and that copy is why an ENGINEER role
 * existed on the server, was enforced on every endpoint, and could not be
 * chosen anywhere in the product: the React app reads src/shared, which had
 * never heard of it. SITE_SUPERVISOR was invisible for the same reason.
 *
 * Two lists that agree on the day they are written do not stay agreed. A role
 * added on one side is a role the other side silently refuses, and the symptom
 * shows up far from the cause — a dropdown with a missing option, or a 403 on
 * an account that looks correctly configured.
 *
 * So there is one definition, in src/shared/permissions.ts and
 * src/shared/enums.ts, and both the API and the web app import it. This module
 * stays only because a great deal of server code imports from here, and adds
 * the few helpers that are useful to a server and meaningless in a browser.
 */
export {
  ROLES,
  STAFF_ROLES,
  ROLE_LABELS,
  ROLE_DESCRIPTIONS,
  type Role,
} from '../shared/enums.js';

export {
  CAPABILITIES,
  ROLE_CAPABILITIES,
  PORTAL_FORBIDDEN,
  can,
  canAll,
  canAny,
  assertPortalSafe,
  type Capability,
} from '../shared/permissions.js';

import { ROLES, STAFF_ROLES, ROLE_LABELS, ROLE_DESCRIPTIONS, type Role } from '../shared/enums.js';
import { ROLE_CAPABILITIES, can, type Capability } from '../shared/permissions.js';

/** Which of the required capabilities this role is missing. */
export function missingCapabilities(role: Role, required: Capability[]): Capability[] {
  return required.filter((c) => !can(role, c));
}

/** True when this role works across contractors rather than inside one. */
export function isStaff(role: Role): boolean {
  return STAFF_ROLES.includes(role);
}

/**
 * The role list an administrator picks from.
 *
 * Derived from ROLES rather than written out, so a role added to the shared
 * definition appears in the product without anybody remembering to add it
 * here. That omission is exactly what made ENGINEER unselectable.
 */
export function roleCatalogue() {
  return ROLES.map((value) => ({
    value,
    label: ROLE_LABELS[value],
    description: ROLE_DESCRIPTIONS[value],
    isStaff: isStaff(value),
    capabilityCount: ROLE_CAPABILITIES[value].length,
  }));
}

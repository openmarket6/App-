export * from './enums.js';
export * from './types.js';
export * from './normalize.js';
export * from './risk.js';
export * from './requirements.js';
export * from './integration.js';
export * from './money.js';
/*
 * The jurisdiction reference dataset: platform, integration tier, and the gate
 * that decides whether an API pathway is even possible.
 *
 * It lived under web/src/shared/data, imported by nothing, while this barrel
 * carried a note saying the file did not exist anywhere in the repository. Both
 * halves of that were wrong, and the cost was a whole screen: the connector
 * roadmap reads gate data the server could not reach, so it answered 501.
 *
 * One copy, here, read by both sides — which is the rule the rest of this
 * directory already follows.
 */
export * from './data/jurisdictions.data.js';
export * from './jurisdictionMatch.js';
export * from './compliance.js';
export * from './billing.js';
export * from './supervision.js';
export * from './signing.js';
export * from './drafting.js';
export * from './permissions.js';
export * from './portal.js';
export * from './google.js';

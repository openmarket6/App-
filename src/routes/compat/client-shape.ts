/**
 * One definition of what a contractor looks like on the wire.
 *
 * The list at /api/clients and the record at /api/clients/:id had drifted, and
 * only one of them was right. The list selected raw columns -- `legal_name`,
 * `license_number`, `email` -- while the frontend's Client type reads
 * `legalName`, `licenseNumber`, `contactEmail`, so every one of those rendered
 * blank on the contractors screen.
 *
 * The consequential one was `service_line`, which the list did not select at
 * all. `serviceLine` was therefore undefined on every row, and the screen reads
 * it three ways: it badges each contractor Expediting or Managed licence, it
 * counts how many are on the managed line, and it filters by it. So every
 * contractor was labelled Expediting, the managed count read zero, and the
 * filter matched nothing whichever value was chosen.
 *
 * That is not a cosmetic mislabel. On the managed line this firm's licence is
 * on the permit and supervision is a legal obligation rather than a service --
 * the screen that tells a coordinator which contractors those are was telling
 * them there are none.
 *
 * So the shape lives here, once, and both routes use it. Two hand-maintained
 * copies of a select list is what produced the drift; the fix is to stop having
 * two.
 */

/** Every column both routes need, aliased to the names the frontend reads. */
export const CLIENT_COLUMNS = `
  c.id,
  c.name,
  c.legal_name as "legalName",
  c.license_number as "licenseNumber",
  c.federal_ein as "federalEin",
  c.status::text as status,
  c.email,
  c.phone,
  c.address_line1 as "addressLine1",
  c.city,
  c.state,
  c.postal_code as zip,
  c.service_line::text as "serviceLine",
  c.filing_hold as "filingHold",
  c.filing_hold_reason as "filingHoldReason",
  c.stripe_customer_id as "stripeCustomerId",
  c.created_at as "createdAt",
  c.updated_at as "updatedAt"
`;

/**
 * Facts the Client type declares that this system does not record yet.
 *
 * Returned as explicit nulls rather than omitted, so a page renders instead of
 * throwing on a missing key, and so it is visible from the response which
 * fields are unrecorded rather than merely empty for this contractor.
 */
export function presentClient(row: Record<string, unknown>) {
  return {
    ...row,
    contactName: null,
    contactEmail: row['email'] ?? null,
    contactPhone: row['phone'] ?? null,
    licenseType: null,
    licenseExpiresAt: null,
    onboardingStatus: row['status'] === 'active' ? 'ACTIVE' : 'IN_PROGRESS',
    onboardingCompletedAt: null,
    quickbooksCustomerId: null,
    active: row['status'] === 'active',
  };
}

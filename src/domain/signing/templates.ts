/**
 * The documents a contractor signs to come on board.
 *
 * These live in code rather than a database table on purpose. A wording change
 * to a master service agreement is a legal event: it should arrive as a
 * reviewable diff with an author and a date, and it should bump a version that
 * every already-signed row keeps pointing at. An UPDATE against a templates
 * table gives none of that, and the row it rewrites is one somebody already
 * signed.
 *
 * Nothing here is job-specific. The hold-harmless in src/domain/documents is a
 * per-permit instrument naming a property and a scope; this one is the blanket
 * indemnity signed once at onboarding, before any permit exists. They are
 * different documents that happen to share a name.
 *
 * VERSIONS ARE APPEND-ONLY IN SPIRIT. Edit the text, bump the version. A signed
 * request stores the text it was signed against, so an old version is never
 * lost -- but leaving the version alone after editing means two different
 * documents claim to be the same one, which is exactly the ambiguity the hash
 * exists to prevent.
 */
import { esc } from '../documents/render.js';
import type { SignableKind } from '../../shared/signing.js';
import { SIGNABLE_LABELS } from '../../shared/signing.js';

/**
 * Everything a template may interpolate.
 *
 * Assembled by the route from the company record, so a template cannot reach
 * for data nobody checked. Optional fields render as a blank rule the signer
 * can see is blank -- silently omitting a line is how an agreement ends up
 * missing a term nobody noticed was missing.
 */
export interface SigningContext {
  /** The contractor. Legal name, not trade name: a trade name binds nobody. */
  contractorLegalName: string;
  contractorAddress: string | null;
  contractorLicenseNumber: string | null;
  signerName: string;
  signerTitle: string | null;
  serviceLine: 'EXPEDITING' | 'MANAGED_LICENSE';
  /** ISO date. Injected, never read from the clock, so rendering is deterministic. */
  effectiveDate: string;
  /** This firm. Configurable because the entity on the paper must match reality. */
  firmLegalName: string;
  firmAddress: string;
  firmLicenseNumber: string | null;
}

const STYLE = `
  :root { --ink: #111; --muted: #555; }
  * { box-sizing: border-box; }
  body { font: 11pt/1.5 Georgia, 'Times New Roman', serif; color: var(--ink);
         max-width: 7.5in; margin: 0 auto; padding: 0.6in 0.5in; }
  h1 { font-size: 15pt; margin: 0 0 0.05in; }
  h2 { font-size: 11.5pt; margin: 0.28in 0 0.08in; text-transform: uppercase;
       letter-spacing: 0.04em; }
  p { margin: 0 0 0.12in; }
  ol, ul { margin: 0 0 0.12in 0.3in; padding: 0; }
  li { margin: 0 0 0.06in; }
  .parties { margin: 0.18in 0; }
  .parties div { margin: 0 0 0.04in; }
  .k { color: var(--muted); display: inline-block; min-width: 1.6in; }
  .blank { border-bottom: 1px solid var(--ink); display: inline-block;
           min-width: 2.2in; }
  @media print { body { padding: 0.5in; } }
`;

function page(title: string, inner: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body>
<h1>${esc(title)}</h1>
${inner}
</body></html>`;
}

/** A value, or a rule the signer can see is empty. Never a silent omission. */
function val(v: string | null | undefined): string {
  const s = (v ?? '').trim();
  return s ? esc(s) : '<span class="blank"></span>';
}

function parties(c: SigningContext): string {
  return `<div class="parties">
  <div><span class="k">Contractor</span> ${val(c.contractorLegalName)}</div>
  <div><span class="k">Address</span> ${val(c.contractorAddress)}</div>
  <div><span class="k">Licence number</span> ${val(c.contractorLicenseNumber)}</div>
  <div><span class="k">Service provider</span> ${val(c.firmLegalName)}</div>
  <div><span class="k">Address</span> ${val(c.firmAddress)}</div>
  <div><span class="k">Effective date</span> ${val(c.effectiveDate)}</div>
</div>`;
}

export interface SigningTemplate {
  /** Stable across versions. Identifies the document; the version identifies the text. */
  id: string;
  kind: SignableKind;
  version: number;
  title: string;
  render: (c: SigningContext) => string;
}

const MASTER_SERVICE_AGREEMENT: SigningTemplate = {
  id: 'tmpl_master_service_agreement',
  kind: 'MASTER_SERVICE_AGREEMENT',
  version: 1,
  title: SIGNABLE_LABELS.MASTER_SERVICE_AGREEMENT,
  render: (c) => page(
    'Master Service Agreement',
    `${parties(c)}
<h2>1. Services</h2>
<p>The service provider will perform permit expediting and related administrative
services for the contractor, as requested by the contractor from time to time and
as described in the applicable order or portal request. Each request the
contractor submits is an order under this agreement.</p>

<h2>2. The contractor's responsibilities</h2>
<ol>
  <li>Provide complete and accurate information about each project, including the
      property address, parcel identification, scope of work and contract value.</li>
  <li>Maintain in force the licences and insurance required for the work, and
      provide current certificates on request.</li>
  <li>Respond to requests for information or correction from the service provider
      or a permitting authority without undue delay.</li>
  <li>Perform all construction work. The service provider performs no
      construction and supervises no means or methods except where a separate
      supervision addendum says otherwise.</li>
</ol>

<h2>3. The service provider's responsibilities</h2>
<ol>
  <li>Prepare and submit permit applications and supporting documents to the
      relevant authority.</li>
  <li>Track each application and report status, correction notices and inspection
      results through the contractor portal.</li>
  <li>Keep the contractor's project information confidential except as required
      to perform the services or as required by law.</li>
</ol>

<h2>4. Fees</h2>
<p>Fees are those quoted for each order, plus permit fees, impact fees and other
amounts charged by a governmental authority, which are advanced on the
contractor's behalf and reimbursed at cost. Invoices are due on receipt unless
the order states otherwise.</p>

<h2>5. What the service provider does not control</h2>
<p>Permit approval, review times, inspection outcomes and fees are determined by
the permitting authority. The service provider does not guarantee that a permit
will issue, or that it will issue within any period.</p>

<h2>6. Limitation of liability</h2>
<p>The service provider's total liability arising out of this agreement is
limited to the fees paid by the contractor for the order giving rise to the
claim. Neither party is liable for indirect, incidental or consequential
damages. This section does not limit liability for fraud or for any liability
that cannot be limited under Florida law.</p>

<h2>7. Term and termination</h2>
<p>This agreement continues until terminated by either party on thirty days'
written notice. Termination does not affect orders already in progress, which
continue until complete or separately cancelled, or amounts already due.</p>

<h2>8. Governing law</h2>
<p>This agreement is governed by the laws of the State of Florida. Venue for any
dispute lies in the county in which the service provider maintains its principal
place of business.</p>

<h2>9. Entire agreement</h2>
<p>This agreement, together with any addendum signed by both parties and the
orders placed under it, is the entire agreement between the parties on this
subject and supersedes prior discussions. It may be amended only in a writing
signed by both parties.</p>`,
  ),
};

const HOLD_HARMLESS: SigningTemplate = {
  id: 'tmpl_hold_harmless_blanket',
  kind: 'HOLD_HARMLESS',
  version: 1,
  title: SIGNABLE_LABELS.HOLD_HARMLESS,
  render: (c) => page(
    'Hold Harmless and Indemnification Agreement',
    `${parties(c)}
<h2>1. Indemnity</h2>
<p>The contractor will indemnify, defend and hold harmless the service provider,
its officers, employees and agents from and against claims, damages, losses and
expenses, including reasonable attorneys' fees, arising out of or resulting from
the contractor's performance of construction work, to the extent caused by the
negligent act or omission of the contractor, a subcontractor, or anyone directly
or indirectly employed by them.</p>

<h2>2. Scope</h2>
<p>This agreement applies to every project for which the service provider
performs services for the contractor, whether or not a permit issues, and
continues for each project after that project is complete.</p>

<h2>3. What this does not cover</h2>
<p>This agreement does not require the contractor to indemnify the service
provider against the service provider's own negligence or wilful misconduct, and
is limited as required by section 725.06, Florida Statutes.</p>

<h2>4. Insurance</h2>
<p>The contractor will maintain commercial general liability and workers'
compensation insurance as required by law and by the master service agreement,
and will provide certificates evidencing that coverage on request.</p>

<h2>5. Survival</h2>
<p>The obligations in this agreement survive termination of the master service
agreement.</p>`,
  ),
};

const CREDIT_CARD_AUTHORIZATION: SigningTemplate = {
  id: 'tmpl_credit_card_authorization',
  kind: 'CREDIT_CARD_AUTHORIZATION',
  version: 1,
  title: SIGNABLE_LABELS.CREDIT_CARD_AUTHORIZATION,
  render: (c) => page(
    'Credit Card and ACH Authorization',
    `${parties(c)}
<h2>1. Authorization</h2>
<p>The contractor authorizes the service provider to charge the payment method
on file for amounts due under the master service agreement, including service
fees and governmental fees advanced on the contractor's behalf.</p>

<h2>2. What may be charged, and when</h2>
<ol>
  <li>Service fees, when the corresponding invoice becomes due.</li>
  <li>Permit, impact and other governmental fees, at the amount charged by the
      authority, on or after the date they are advanced.</li>
  <li>Retainer replenishment, where the contractor has agreed to maintain a
      retainer balance.</li>
</ol>

<h2>3. Notice</h2>
<p>The service provider will send an invoice or receipt identifying each charge.
Card details are held by the payment processor; the service provider does not
store the full card number.</p>

<h2>4. Revocation</h2>
<p>The contractor may revoke this authorization at any time by written notice.
Revocation does not affect charges already processed or amounts already due, and
the service provider may suspend services while a balance is outstanding.</p>

<h2>5. Disputed charges</h2>
<p>The contractor will raise a disputed charge with the service provider within
sixty days of the invoice date so it can be reviewed and corrected if wrong.</p>`,
  ),
};

const MANAGED_LICENSE_ADDENDUM: SigningTemplate = {
  id: 'tmpl_managed_license_addendum',
  kind: 'MANAGED_LICENSE_ADDENDUM',
  version: 1,
  title: SIGNABLE_LABELS.MANAGED_LICENSE_ADDENDUM,
  render: (c) => page(
    'Managed Licence and Supervision Addendum',
    `${parties(c)}
<div class="parties">
  <div><span class="k">Qualifying licence</span> ${val(c.firmLicenseNumber)}</div>
</div>

<h2>1. What this addendum changes</h2>
<p>Under this addendum the service provider's qualifying agent qualifies the work
and the service provider's licence appears on the permit. The service provider is
therefore the contractor of record for permits issued under this addendum, and
supervision is a legal obligation of the service provider rather than an optional
service.</p>

<h2>2. Supervision</h2>
<ol>
  <li>The service provider's qualifying agent will supervise the work as required
      by section 489.1195, Florida Statutes, including attendance at the site at
      the milestones recorded in the supervision plan for each project.</li>
  <li>Each site visit is recorded with the date, the supervisor present, and
      photographs taken at the site on that date.</li>
  <li>The contractor will give the qualifying agent access to the site and
      reasonable notice of scheduled inspections.</li>
</ol>

<h2>3. The contractor's obligations</h2>
<ol>
  <li>Perform the work in accordance with the permitted plans and the Florida
      Building Code.</li>
  <li>Not represent to any person that the contractor holds the licence under
      which the permit was issued.</li>
  <li>Notify the service provider before any change in scope, and before any
      work that requires a revision to the permit.</li>
  <li>Stop work on written instruction from the qualifying agent, and not resume
      until the matter identified is resolved.</li>
</ol>

<h2>4. Termination of this addendum</h2>
<p>The service provider may terminate this addendum immediately if the contractor
performs work outside the permitted scope, denies access to the qualifying agent,
or continues work after being instructed to stop. On termination the service
provider may withdraw its licence from permits not yet commenced and will notify
the permitting authority as required.</p>

<h2>5. Relationship to the master service agreement</h2>
<p>This addendum supplements the master service agreement and applies only while
the contractor is on the managed licence service line. Where the two conflict on
supervision or on who is the contractor of record, this addendum controls.</p>`,
  ),
};

const W9_ACKNOWLEDGEMENT: SigningTemplate = {
  id: 'tmpl_w9_acknowledgement',
  kind: 'W9_ACKNOWLEDGEMENT',
  version: 1,
  title: SIGNABLE_LABELS.W9_ACKNOWLEDGEMENT,
  render: (c) => page(
    'W-9 Acknowledgement',
    `${parties(c)}
<h2>1. Acknowledgement</h2>
<p>The contractor confirms that the legal name and taxpayer identification number
provided to the service provider on Form W-9 are current and correct, and that
the contractor is not subject to backup withholding except as disclosed on that
form.</p>

<h2>2. Changes</h2>
<p>The contractor will provide an updated Form W-9 within thirty days of any
change to its legal name, entity type or taxpayer identification number.</p>

<h2>3. Why this is asked for</h2>
<p>The service provider may be required to report payments made to the
contractor. Reporting against a stale name or number produces a mismatch notice
that is slow to correct and can trigger withholding.</p>

<p>This acknowledgement does not replace Form W-9 itself, which is submitted
separately.</p>`,
  ),
};

const PERMIT_AGENT_AUTHORIZATION: SigningTemplate = {
  id: 'tmpl_permit_agent_authorization',
  kind: 'PERMIT_AGENT_AUTHORIZATION',
  version: 1,
  title: SIGNABLE_LABELS.PERMIT_AGENT_AUTHORIZATION,
  render: (c) => page(
    'Permit Agent Authorization',
    `${parties(c)}
<h2>1. Appointment</h2>
<p>The contractor appoints the service provider as its authorized agent to
prepare, sign where permitted, submit and track permit applications and related
documents with building departments and other permitting authorities in Florida
on the contractor's behalf.</p>

<h2>2. What the agent may do</h2>
<ol>
  <li>File applications, revisions, extensions and closeout documents.</li>
  <li>Pay permit and impact fees from funds provided or advanced.</li>
  <li>Receive correction notices, inspection results and correspondence.</li>
  <li>Schedule and reschedule inspections at the contractor's direction.</li>
</ol>

<h2>3. What the agent may not do</h2>
<p>The service provider may not enter into construction contracts on the
contractor's behalf, alter the scope of permitted work without the contractor's
instruction, or hold itself out as the licensed contractor for the work except
where a signed managed licence addendum makes it the contractor of record.</p>

<h2>4. Duration</h2>
<p>This authorization is effective from the date above and continues until
revoked in writing. Revocation does not affect an application already submitted,
which the contractor may take over directly with the authority.</p>

<h2>5. Reliance</h2>
<p>A permitting authority may rely on this authorization as evidence of the
service provider's agency until it receives written notice of revocation.</p>`,
  ),
};

export const SIGNING_TEMPLATES: Record<SignableKind, SigningTemplate> = {
  MASTER_SERVICE_AGREEMENT,
  HOLD_HARMLESS,
  CREDIT_CARD_AUTHORIZATION,
  MANAGED_LICENSE_ADDENDUM,
  W9_ACKNOWLEDGEMENT,
  PERMIT_AGENT_AUTHORIZATION,
};

export function templateFor(kind: SignableKind): SigningTemplate {
  return SIGNING_TEMPLATES[kind];
}

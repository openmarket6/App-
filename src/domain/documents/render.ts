/**
 * Turning a validated instrument into the page somebody signs.
 *
 * ⚠️ The templates below have NOT been reviewed by a Florida construction
 * attorney. See the warning at the head of noc.ts.
 *
 * TWO PROPERTIES THIS FILE IS BUILT AROUND
 *
 * 1. Deterministic. The same input renders the same bytes, every time. That is
 *    what makes the stored content hash worth anything: if the hash matches,
 *    the document nobody can find is byte-identical to the one we can. Nothing
 *    here reads the clock, a price table, or any other moving source — every
 *    value arrives in the input.
 *
 * 2. Never silently blank. A missing optional field renders an explicit rule
 *    the signer can see, not an empty gap. A gap in a legal instrument reads as
 *    "not applicable" to whoever finds it later; a ruled line reads as
 *    "nobody filled this in", which is what actually happened.
 */
import {
  type DocumentKind, type NocInput, type NtoInput, NTO_DEADLINE_DAYS,
} from './noc.js';
import type { HoldHarmlessInput, ContractorAgreementInput } from './agreements.js';

/** HTML-escape. Every value that reaches the page goes through this. */
export function esc(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A value, or a ruled line saying it was left blank. */
function val(v: unknown): string {
  if (v === null || v === undefined || String(v).trim().length === 0) {
    return '<span class="blank" aria-label="not provided">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>';
  }
  return esc(v);
}

function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return val(null);
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
}

/**
 * A date, rendered the way a clerk reads one.
 *
 * Dates arrive as ISO strings and are rendered in UTC deliberately. Rendering
 * in the server's local zone would make the same document produce a different
 * date depending on where it was generated, which breaks determinism and, on a
 * deadline document, could shift the date by a day.
 */
function day(iso: string | null | undefined): string {
  if (!iso) return val(null);
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return val(iso);
  return new Date(t).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
}

function field(label: string, value: string): string {
  return `<div class="f"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
}

function block(title: string, rows: string[]): string {
  return `<section><h2>${esc(title)}</h2><dl>${rows.join('')}</dl></section>`;
}

const STYLE = `
  :root { --ink:#111; --rule:#999; --muted:#555; }
  body { font-family: Georgia, 'Times New Roman', serif; color: var(--ink);
         line-height: 1.5; max-width: 7.5in; margin: 0 auto; padding: 0.75in 0.5in; }
  h1 { font-size: 17pt; text-align: center; text-transform: uppercase;
       letter-spacing: 0.04em; margin: 0 0 0.15in; }
  h2 { font-size: 11pt; text-transform: uppercase; letter-spacing: 0.05em;
       border-bottom: 1px solid var(--rule); padding-bottom: 2px; margin: 0.28in 0 0.1in; }
  .cite { text-align: center; color: var(--muted); font-size: 10pt; margin: 0 0 0.25in; }
  dl { margin: 0; }
  .f { display: grid; grid-template-columns: 2.3in 1fr; gap: 0.06in 0.12in;
       padding: 2px 0; align-items: baseline; }
  dt { color: var(--muted); font-size: 10pt; }
  dd { margin: 0; }
  .blank { border-bottom: 1px solid var(--rule); display: inline-block; min-width: 2in; }
  p.body { text-align: justify; }
  .sig { margin-top: 0.4in; display: grid; grid-template-columns: 1fr 1fr; gap: 0.3in; }
  .sigline { border-top: 1px solid var(--ink); padding-top: 4px; font-size: 10pt;
             color: var(--muted); margin-top: 0.5in; }
  .notice { border: 1px solid var(--ink); padding: 0.12in; margin: 0.2in 0; font-size: 10pt; }
  footer { margin-top: 0.4in; border-top: 1px solid var(--rule); padding-top: 6px;
           font-size: 8pt; color: var(--muted); }
  @media print { body { padding: 0.5in; } }
`;

export interface RenderMeta {
  /** ISO timestamp. Supplied, never read from the clock — see determinism above. */
  generatedAt: string;
  /** Shown in the footer so a printed page can be traced back to a record. */
  documentId?: string | null;
  companyName?: string | null;
}

function page(title: string, cite: string, inner: string, meta: RenderMeta): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body>
<h1>${esc(title)}</h1>
<p class="cite">${esc(cite)}</p>
${inner}
<footer>
Prepared ${esc(day(meta.generatedAt))}${meta.companyName ? ` for ${esc(meta.companyName)}` : ''}${
    meta.documentId ? ` &middot; Ref ${esc(meta.documentId)}` : ''
  }.
This document is prepared from the information supplied above and is not legal advice.
Review it before signing, recording or serving.
</footer>
</body></html>`;
}

// -----------------------------------------------------------------------------

export function renderNoc(input: Partial<NocInput>, meta: RenderMeta): string {
  const inner = [
    `<p class="body">The undersigned hereby gives notice that improvement will be made
      to certain real property, and in accordance with Chapter 713, Florida Statutes,
      the following information is provided in this Notice of Commencement.</p>`,

    block('The property', [
      field('Street address', val(input.propertyAddress)),
      field('Legal description', val(input.legalDescription)),
      field('Parcel identification number', val(input.parcelId)),
    ]),

    block('The improvement', [
      field('General description', val(input.improvementDescription)),
    ]),

    block('Owner', [
      field('Name', val(input.ownerName)),
      field('Address', val(input.ownerAddress)),
      field('Interest in property', val(input.ownerInterest)),
      field('Fee simple titleholder', val(input.feeSimpleTitleholderName)),
      field('Titleholder address', val(input.feeSimpleTitleholderAddress)),
    ]),

    block('Contractor', [
      field('Name', val(input.contractorName)),
      field('Address', val(input.contractorAddress)),
      field('Telephone', val(input.contractorPhone)),
      field('Licence number', val(input.contractorLicenseNumber)),
    ]),

    block('Surety (payment bond, if any)', [
      field('Name', val(input.suretyName)),
      field('Address', val(input.suretyAddress)),
      field('Amount of bond', input.suretyBondAmountCents ? money(input.suretyBondAmountCents) : val(null)),
    ]),

    block('Lender', [
      field('Name', val(input.lenderName)),
      field('Address', val(input.lenderAddress)),
    ]),

    block('Designated person', [
      field('Name', val(input.designatedPersonName)),
      field('Address', val(input.designatedPersonAddress)),
    ]),

    /*
     * The expiration paragraph states the default in words rather than leaving
     * the field blank. A contractor who reads "one year from the date of
     * recording" knows a long job needs a second notice; one who reads an empty
     * box learns it when an inspector turns up.
     */
    block('Expiration', [
      field(
        'This notice expires',
        input.expirationDate
          ? day(input.expirationDate)
          : 'one year from the date of recording (no other date specified)',
      ),
    ]),

    `<div class="notice"><strong>WARNING TO OWNER:</strong> ANY PAYMENTS MADE BY THE
      OWNER AFTER THE EXPIRATION OF THE NOTICE OF COMMENCEMENT ARE CONSIDERED IMPROPER
      PAYMENTS UNDER CHAPTER 713, PART I, SECTION 713.13, FLORIDA STATUTES, AND CAN
      RESULT IN YOUR PAYING TWICE FOR IMPROVEMENTS TO YOUR PROPERTY. A NOTICE OF
      COMMENCEMENT MUST BE RECORDED AND POSTED ON THE JOB SITE BEFORE THE FIRST
      INSPECTION. IF YOU INTEND TO OBTAIN FINANCING, CONSULT WITH YOUR LENDER OR AN
      ATTORNEY BEFORE COMMENCING WORK OR RECORDING YOUR NOTICE OF COMMENCEMENT.</div>`,

    `<p class="body">Under penalty of perjury, I declare that I have read the foregoing
      and that the facts stated in it are true to the best of my knowledge and belief.</p>`,

    `<div class="sig">
       <div><div class="sigline">Signature of owner or owner's authorised officer</div></div>
       <div><div class="sigline">Printed name: ${val(input.ownerSignatureName)}</div></div>
     </div>`,

    /*
     * The notarial certificate is deliberately NOT pre-filled with a notary
     * name, even when we know who it will be. It is sworn in front of that
     * person on a date; printing it in advance would be printing a jurat for an
     * oath that has not happened.
     */
    `<section><h2>Notarial certificate</h2>
      <p class="body">State of Florida, County of <span class="blank">&nbsp;</span>.
      Sworn to and subscribed before me by means of physical presence or online
      notarization, this <span class="blank">&nbsp;</span> day of
      <span class="blank">&nbsp;</span>, by the person named above, who is personally
      known to me or produced <span class="blank">&nbsp;</span> as identification.</p>
      <div class="sig">
        <div><div class="sigline">Notary Public, State of Florida</div></div>
        <div><div class="sigline">Commission number and expiry</div></div>
      </div>
      ${input.notarizationId ? `<p class="cite">OCS notarization record ${esc(input.notarizationId)}</p>` : ''}
     </section>`,
  ].join('\n');

  return page('Notice of Commencement', 'Fla. Stat. § 713.13', inner, meta);
}

// -----------------------------------------------------------------------------

export function renderNto(input: Partial<NtoInput>, meta: RenderMeta): string {
  const inner = [
    `<div class="notice"><strong>WARNING!</strong> FLORIDA'S CONSTRUCTION LIEN LAW
      ALLOWS SOME UNPAID CONTRACTORS, SUBCONTRACTORS, AND MATERIAL SUPPLIERS TO FILE
      LIENS AGAINST YOUR PROPERTY EVEN IF YOU HAVE MADE PAYMENT IN FULL. UNDER FLORIDA
      LAW, YOUR FAILURE TO MAKE SURE THAT WE ARE PAID MAY RESULT IN A LIEN AGAINST YOUR
      PROPERTY AND YOUR PAYING TWICE. TO AVOID A LIEN AND PAYING TWICE, YOU MUST OBTAIN
      A WRITTEN RELEASE FROM US EVERY TIME YOU PAY YOUR CONTRACTOR.</div>`,

    block('To the owner', [
      field('Name', val(input.ownerName)),
      field('Address', val(input.ownerAddress)),
    ]),

    block('The property', [
      field('Street address', val(input.propertyAddress)),
      field('Legal description', val(input.legalDescription)),
    ]),

    `<p class="body">The undersigned hereby informs you that they have furnished, or
      will furnish, services or materials as described below for the improvement of the
      real property identified above. This notice is given under Chapter 713, Florida
      Statutes, and does not mean that the undersigned is unpaid.</p>`,

    block('Services or materials furnished', [
      field('Description', val(input.servicesOrMaterials)),
      field('First furnished on', day(input.firstFurnishingDate)),
      field('Under contract with', val(input.contractedWithName ?? input.ownerName)),
    ]),

    block('Claimant', [
      field('Name', val(input.claimantName)),
      field('Address', val(input.claimantAddress)),
    ]),

    block('Service of this notice', [
      field('Served on', day(input.servedDate)),
      field('Method of service', val(input.serviceMethod)),
      field(
        'Statutory window',
        `${NTO_DEADLINE_DAYS} days from the date first furnished`,
      ),
    ]),

    `<div class="sig">
       <div><div class="sigline">Signature for the claimant</div></div>
       <div><div class="sigline">Printed name and title</div></div>
     </div>`,
  ].join('\n');

  return page('Notice to Owner', 'Fla. Stat. § 713.06', inner, meta);
}

// -----------------------------------------------------------------------------

export function renderHoldHarmless(
  input: Partial<HoldHarmlessInput>,
  meta: RenderMeta,
): string {
  const inner = [
    block('The parties', [
      field('Indemnifying party', val(input.indemnifyingPartyName)),
      field('Address', val(input.indemnifyingPartyAddress)),
      field('Indemnified party', val(input.indemnifiedPartyName)),
      field('Effective date', day(input.effectiveDate)),
    ]),

    block('The work', [
      field('Scope covered', val(input.scopeDescription)),
      field('Property', val(input.propertyAddress)),
      field('Permit number', val(input.permitNumber)),
    ]),

    /*
     * The indemnity is written to stay inside Fla. Stat. 725.06 rather than
     * reaching as far as it could. An indemnity that purports to cover the
     * indemnitee's own sole negligence without the statute's monetary limit is
     * void -- and a void indemnity fails at exactly the moment it is needed,
     * which is worse than a narrower one that holds.
     */
    `<section><h2>Indemnity</h2>
     <p class="body">To the fullest extent permitted by law, and subject to the
      limitations of section 725.06, Florida Statutes, the indemnifying party shall
      indemnify, defend and hold harmless the indemnified party, and its officers,
      employees and agents, from and against all claims, damages, losses and expenses,
      including reasonable attorneys' fees, arising out of or resulting from the
      performance of the work described above, but only to the extent caused in whole
      or in part by the acts or omissions of the indemnifying party, anyone directly or
      indirectly employed by it, or anyone for whose acts it may be liable.</p>
     <p class="body">This indemnity does not extend to any claim to the extent it
      arises from the sole negligence, or the wilful misconduct, of the indemnified
      party. Nothing in this agreement waives any defence or limitation available under
      Florida law.</p>
     </section>`,

    block('Insurance carried by the indemnifying party', [
      field('General liability carrier', val(input.generalLiabilityCarrier)),
      field('Limit', input.generalLiabilityLimitCents ? money(input.generalLiabilityLimitCents) : val(null)),
      field('Policy expires', day(input.generalLiabilityExpiresOn)),
    ]),

    `<section><h2>Other terms</h2>
     <p class="body">This agreement is governed by the laws of the State of Florida.
      If any provision is held unenforceable, the remainder stays in force and the
      unenforceable provision is limited only so far as is necessary to make it
      enforceable. This agreement survives completion of the work.</p>
     </section>`,

    `<div class="sig">
       <div><div class="sigline">Signature for ${val(input.indemnifyingPartyName)}</div></div>
       <div><div class="sigline">${val(input.signerName)}${
         input.signerTitle ? `, ${esc(input.signerTitle)}` : ''
       }</div></div>
     </div>`,
  ].join('\n');

  return page('Hold Harmless and Indemnity Agreement', 'Fla. Stat. § 725.06', inner, meta);
}

// -----------------------------------------------------------------------------

export function renderContractorAgreement(
  input: Partial<ContractorAgreementInput>,
  meta: RenderMeta,
): string {
  const p = input.pricing;

  const inner = [
    block('The parties', [
      field('Company', val(input.companyLegalName)),
      field('Address', val(input.companyAddress)),
      field('Qualifying licence', val(
        input.licenseNumber
          ? `${input.licenseNumber}${input.licenseState ? ` (${input.licenseState})` : ''}`
          : null,
      )),
      field('Effective date', day(input.effectiveDate)),
    ]),

    block('Plan', [
      field('Plan', val(p?.planName)),
      field('Trade classifications covered', val(input.classificationCount ?? p?.tradeCount)),
      field('Prices agreed as of', day(p?.capturedAt)),
    ]),

    /*
     * Every charge is shown on its own line, and the retainer is shown apart
     * from the fees. That is not formatting: the retainer is held, not earned,
     * and a customer who sees it added into a "total due" reads it as money
     * spent. It is money held on their behalf, and the document should look
     * like that.
     */
    block('Recurring and one-time fees', [
      field('Monthly service fee', money(p?.monthlyPriceCents)),
      field('Onboarding fee (charged once)', money(p?.onboardingFeeCents)),
      field('Onboarding collected on signing', money(input.onboardingCollectedCents)),
      field('Per-permit fee', money(p?.pricePerPermitCents)),
      field('Supervisor site visit, each completed visit', money(p?.supervisorVisitCents)),
    ]),

    block('Compliance retainer — held, not earned', [
      field('Retainer required for this plan', money(p?.complianceRetainerCents)),
      field('Retainer held', money(input.retainerHeldCents)),
    ]),

    `<p class="body">The compliance retainer is held on the company's behalf on a
      separate ledger. It is not a fee and is not revenue of the service provider.
      Government fees, recording fees and third-party charges are passed through at
      cost and are not included in the amounts above.</p>`,

    `<section><h2>Onboarding, upgrades and downgrades</h2>
     <p class="body">The onboarding fee is charged once. On an upgrade the company pays
      only the difference between onboarding already collected and the onboarding fee
      for the new plan; it is never charged again in full. A downgrade does not refund
      onboarding already paid. An upgrade raises the compliance retainer to the level
      the new plan requires. A reduction in the compliance retainer requires approval
      by the service provider's administrator.</p>
     </section>`,

    `<section><h2>Term and termination</h2>
     <p class="body">This agreement continues month to month from the effective date.
      Either party may terminate on ${val(
        input.terminationNoticeDays ? `${input.terminationNoticeDays} days'` : null,
      )} written notice. On termination the compliance retainer, less any amounts
      properly applied under this agreement, is returned to the company.</p>
     </section>`,

    `<div class="sig">
       <div><div class="sigline">Signature for ${val(input.companyLegalName)}</div></div>
       <div><div class="sigline">${val(input.signerName)}${
         input.signerTitle ? `, ${esc(input.signerTitle)}` : ''
       }</div></div>
     </div>`,
  ].join('\n');

  return page('Contractor Services Agreement', 'Florida', inner, meta);
}

// -----------------------------------------------------------------------------

/** Render any kind. The caller has already validated; this only draws. */
export function renderDocument(
  kind: DocumentKind,
  input: Record<string, unknown>,
  meta: RenderMeta,
): string {
  switch (kind) {
    case 'NOC': return renderNoc(input as Partial<NocInput>, meta);
    case 'NTO': return renderNto(input as Partial<NtoInput>, meta);
    case 'HOLD_HARMLESS': return renderHoldHarmless(input as Partial<HoldHarmlessInput>, meta);
    case 'CONTRACTOR_AGREEMENT':
      return renderContractorAgreement(input as Partial<ContractorAgreementInput>, meta);
  }
}

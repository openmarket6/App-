/**
 * Producing legal instruments.
 *
 * The thing under test is not formatting. It is refusal: a Notice of
 * Commencement that LOOKS right and is defective is worse than none, because
 * nobody relies on the document that was never produced and everybody relies on
 * the one that was. So most of these tests assert that something is NOT
 * produced.
 *
 * The second theme is that nothing is silently dropped -- not a warning
 * somebody accepted, not the inputs a document was made from, not a superseded
 * version.
 */
import { describe, it, expect } from 'vitest';
import {
  validateNoc, validateNto, validateHoldHarmless, validateContractorAgreement,
  validateDocument, generateDocument, canGenerate, NTO_DEADLINE_DAYS,
  DOCUMENT_KINDS, isDocumentKind, esc,
} from '../src/domain/documents/index.js';
import { planFor, snapshot } from '../src/domain/pricing.js';

const AT = { generatedAt: '2026-03-01T12:00:00.000Z' };
const blocking = (ps: { severity: string; field: string }[]) =>
  ps.filter((p) => p.severity === 'blocking').map((p) => p.field);

// -----------------------------------------------------------------------------

const goodNoc = {
  propertyAddress: '1200 Bay Street, Tampa, FL 33606',
  legalDescription: 'Lot 4, Block 7, HYDE PARK ADDITION, Plat Book 12, Page 44',
  parcelId: 'A-12-29-18-3RM-000007-00004.0',
  improvementDescription: 'Replacement of existing shingle roof, 34 squares',
  ownerName: 'Marta Delgado',
  ownerAddress: '1200 Bay Street, Tampa, FL 33606',
  ownerInterest: 'Fee simple',
  contractorName: 'Gulf Coast Roofing LLC',
  contractorAddress: '88 Industrial Way, Tampa, FL 33619',
  contractorLicenseNumber: 'CCC1330000',
  designatedPersonName: 'Ana Reyes',
  designatedPersonAddress: '88 Industrial Way, Tampa, FL 33619',
  expirationDate: '2027-03-01',
  ownerSignatureName: 'Marta Delgado',
  notarizationId: 'ron://session/9f2',
};

describe('the Notice of Commencement', () => {
  it('is produced when it is complete', () => {
    const r = generateDocument('NOC', goodNoc, AT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html).toContain('Notice of Commencement');
    expect(r.warnings).toHaveLength(0);
  });

  it('refuses one with no legal description', () => {
    // The classic defect. A street address does not identify a parcel, and an
    // NOC is recorded against a parcel.
    const { legalDescription: _drop, ...without } = goodNoc;
    const r = generateDocument('NOC', without, AT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(blocking(r.problems)).toContain('legalDescription');
  });

  it('refuses one that has not been notarized', () => {
    const { notarizationId: _drop, ...without } = goodNoc;
    const r = generateDocument('NOC', without, AT);
    expect(r.ok).toBe(false);
  });

  it('refuses a half-entered payment bond', () => {
    // Naming a surety without an amount tells subcontractors they may be
    // protected without saying by whom or for how much.
    const problems = validateNoc({ ...goodNoc, suretyName: 'Atlantic Surety Co' });
    expect(blocking(problems)).toContain('suretyName');
  });

  it('accepts a complete payment bond', () => {
    const problems = validateNoc({
      ...goodNoc,
      suretyName: 'Atlantic Surety Co',
      suretyAddress: '400 N Ashley Dr, Tampa, FL',
      suretyBondAmountCents: 5_000_00,
    });
    expect(blocking(problems)).toHaveLength(0);
  });

  it('refuses a lender with no address', () => {
    const problems = validateNoc({ ...goodNoc, lenderName: 'First Gulf Bank' });
    expect(blocking(problems)).toContain('lenderAddress');
  });

  it('states the one-year default rather than leaving the box empty', () => {
    // A blank expiry reads as "not applicable". It is not: it is one year.
    const { expirationDate: _drop, ...without } = goodNoc;
    const r = generateDocument('NOC', without, AT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html).toContain('one year from the date of recording');
  });

  it('carries the warning to owner', () => {
    const r = generateDocument('NOC', goodNoc, AT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html).toContain('WARNING TO OWNER');
    expect(r.html).toContain('PAYING TWICE');
  });

  it('does not pre-fill the notary', () => {
    /*
     * The jurat is sworn in front of a person on a date. Printing a notary's
     * name in advance would be printing a certificate for an oath that has not
     * happened yet.
     */
    const r = generateDocument('NOC', { ...goodNoc, notaryName: 'Jane Notary' }, AT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html).not.toContain('Jane Notary');
  });
});

// -----------------------------------------------------------------------------

const goodNto = {
  claimantName: 'Bay Area Truss Supply',
  claimantAddress: '15 Depot Rd, Plant City, FL',
  servicesOrMaterials: 'Prefabricated roof trusses and hardware',
  ownerName: 'Marta Delgado',
  ownerAddress: '1200 Bay Street, Tampa, FL 33606',
  propertyAddress: '1200 Bay Street, Tampa, FL 33606',
  legalDescription: 'Lot 4, Block 7, HYDE PARK ADDITION',
  firstFurnishingDate: '2026-02-20',
};

describe('the Notice to Owner', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');

  it('is produced when it is in time', () => {
    const r = generateDocument('NTO', goodNto, AT, now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toHaveLength(0);
  });

  it('refuses one with no first-furnishing date', () => {
    // The field the whole notice turns on: the deadline runs from it.
    const { firstFurnishingDate: _drop, ...without } = goodNto;
    const r = generateDocument('NTO', without, AT, now);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(blocking(r.problems)).toContain('firstFurnishingDate');
  });

  it('warns about a late notice but still produces it', () => {
    /*
     * This is the judgement call the module is built around. A late notice may
     * still protect amounts furnished inside the window, and that is a lawyer's
     * decision. Refusing would take it away from the person entitled to make
     * it; saying nothing would let it go out believed timely.
     */
    const late = { ...goodNto, firstFurnishingDate: '2025-11-01' };
    const problems = validateNto(late, now);
    expect(blocking(problems)).toHaveLength(0);
    expect(problems.some((p) => p.severity === 'warning')).toBe(true);

    const r = generateDocument('NTO', late, AT, now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('warns as the window closes, not only after it has', () => {
    const nearly = new Date('2026-02-20T00:00:00.000Z');
    nearly.setUTCDate(nearly.getUTCDate() + NTO_DEADLINE_DAYS - 3);
    const problems = validateNto(goodNto, nearly);
    expect(problems.some((p) => p.severity === 'warning')).toBe(true);
  });

  it('carries the construction lien law warning', () => {
    const r = generateDocument('NTO', goodNto, AT, now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html).toContain('CONSTRUCTION LIEN LAW');
  });
});

// -----------------------------------------------------------------------------

const goodHoldHarmless = {
  indemnifiedPartyName: 'One Contractor Solutions LLC',
  indemnifyingPartyName: 'Gulf Coast Roofing LLC',
  indemnifyingPartyAddress: '88 Industrial Way, Tampa, FL 33619',
  signerName: 'Ana Reyes',
  signerTitle: 'Managing Member',
  scopeDescription: 'Re-roof of the residence at 1200 Bay Street, Tampa',
  effectiveDate: '2026-03-01',
  generalLiabilityCarrier: 'Southeastern Mutual',
  generalLiabilityLimitCents: 1_000_000_00,
  generalLiabilityExpiresOn: '2027-01-31',
};

describe('the hold harmless agreement', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');

  it('is produced when it is complete', () => {
    const r = generateDocument('HOLD_HARMLESS', goodHoldHarmless, AT, now);
    expect(r.ok).toBe(true);
  });

  it('refuses one with no stated scope', () => {
    const { scopeDescription: _drop, ...without } = goodHoldHarmless;
    const r = generateDocument('HOLD_HARMLESS', without, AT, now);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(blocking(r.problems)).toContain('scopeDescription');
  });

  it('stays inside the statutory limit rather than reaching past it', () => {
    /*
     * An indemnity purporting to cover the indemnitee's own sole negligence is
     * void under 725.06, and a void indemnity fails at the one moment it is
     * needed. Narrower and enforceable beats broad and worthless.
     */
    const r = generateDocument('HOLD_HARMLESS', goodHoldHarmless, AT, now);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html).toContain('725.06');
    expect(r.html).toContain('sole negligence');
  });

  it('warns when the indemnifying party has no insurance recorded', () => {
    // An indemnity from an uninsured party is a promise to pay, not a source
    // of payment. OCS may accept it -- but not without noticing.
    const bare = { ...goodHoldHarmless };
    delete (bare as Record<string, unknown>)['generalLiabilityCarrier'];
    delete (bare as Record<string, unknown>)['generalLiabilityLimitCents'];
    const problems = validateHoldHarmless(bare, now);
    expect(problems.some(
      (p) => p.field === 'generalLiabilityCarrier' && p.severity === 'warning',
    )).toBe(true);
  });

  it('warns when the policy on file has already lapsed', () => {
    const problems = validateHoldHarmless(
      { ...goodHoldHarmless, generalLiabilityExpiresOn: '2025-06-30' },
      now,
    );
    expect(problems.some((p) => p.detail.includes('already expired'))).toBe(true);
  });
});

// -----------------------------------------------------------------------------

describe('the contractor services agreement', () => {
  const plan = planFor('THREE_TRADES');
  const pricing = snapshot(plan, '2026-03-01T12:00:00.000Z');

  const good = {
    companyLegalName: 'Gulf Coast Roofing LLC',
    companyAddress: '88 Industrial Way, Tampa, FL 33619',
    signerName: 'Ana Reyes',
    signerTitle: 'Managing Member',
    licenseNumber: 'CCC1330000',
    licenseState: 'FL',
    classificationCount: 3,
    pricing,
    onboardingCollectedCents: plan.onboardingFeeCents,
    retainerHeldCents: plan.complianceRetainerCents,
    effectiveDate: '2026-03-01',
    terminationNoticeDays: 30,
  };

  it('refuses to produce one with no pricing snapshot', () => {
    /*
     * The most important refusal in this file. An agreement pointing at a live
     * price table promises whatever that table says next year -- the customer
     * would have signed something that changes without them.
     */
    const { pricing: _drop, ...without } = good;
    const r = generateDocument('CONTRACTOR_AGREEMENT', without, AT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(blocking(r.problems)).toContain('pricing');
  });

  it('refuses a snapshot with no timestamp', () => {
    const problems = validateContractorAgreement({
      ...good,
      pricing: { ...pricing, capturedAt: '' },
    });
    expect(blocking(problems)).toContain('pricing.capturedAt');
  });

  it('prints the snapshotted prices, not whatever the table says now', () => {
    const frozen = { ...pricing, monthlyPriceCents: 1_234_00 };
    const r = generateDocument('CONTRACTOR_AGREEMENT', { ...good, pricing: frozen }, AT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html).toContain('$1,234.00');
    expect(r.html).not.toContain(
      `$${(plan.monthlyPriceCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
    );
  });

  it('shows the retainer apart from the fees, and says it is held', () => {
    // A customer who sees the retainer inside a "total due" reads it as money
    // spent. It is money held on their behalf.
    const r = generateDocument('CONTRACTOR_AGREEMENT', good, AT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html).toContain('held, not earned');
    expect(r.html).toContain('is not a fee and is not revenue');
  });

  it('shows every charge on its own line', () => {
    const r = generateDocument('CONTRACTOR_AGREEMENT', good, AT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const label of [
      'Monthly service fee',
      'Onboarding fee (charged once)',
      'Per-permit fee',
      'Supervisor site visit, each completed visit',
    ]) {
      expect(r.html, label).toContain(label);
    }
  });

  it('states that onboarding is charged once and an upgrade pays the difference', () => {
    const r = generateDocument('CONTRACTOR_AGREEMENT', good, AT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Whitespace-collapsed: the template wraps, and a sentence that happens to
    // break across two source lines is still the same sentence on the page.
    const text = r.html.replace(/\s+/g, ' ');
    expect(text).toContain('onboarding fee is charged once');
    expect(text).toContain('pays only the difference');
    expect(text).toContain('A downgrade does not refund onboarding already paid');
    expect(text).toContain('reduction in the compliance retainer requires approval');
  });

  it('warns when less retainer is held than the plan calls for', () => {
    const problems = validateContractorAgreement({ ...good, retainerHeldCents: 0 });
    expect(problems.some(
      (p) => p.field === 'retainerHeldCents' && p.severity === 'warning',
    )).toBe(true);
  });

  it('warns when more onboarding was collected than the plan lists', () => {
    // Usually means somebody charged the full fee again on an upgrade.
    const problems = validateContractorAgreement({
      ...good,
      onboardingCollectedCents: plan.onboardingFeeCents + 1,
    });
    expect(problems.some(
      (p) => p.field === 'onboardingCollectedCents' && p.severity === 'warning',
    )).toBe(true);
  });

  it('refuses fractional money', () => {
    const problems = validateContractorAgreement({ ...good, retainerHeldCents: 99.5 });
    expect(blocking(problems)).toContain('retainerHeldCents');
  });
});

// -----------------------------------------------------------------------------

describe('the generator itself', () => {
  it('renders the same bytes for the same input', () => {
    /*
     * Determinism is what makes the stored content hash worth anything. If it
     * held, the paper copy in a job trailer can be checked against the record.
     */
    const a = generateDocument('NOC', goodNoc, AT);
    const b = generateDocument('NOC', goodNoc, AT);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.html).toBe(b.html);
  });

  it('escapes what people type', () => {
    const r = generateDocument(
      'NOC',
      { ...goodNoc, ownerName: '<script>alert(1)</script>' },
      AT,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html).not.toContain('<script>alert(1)</script>');
    expect(r.html).toContain('&lt;script&gt;');
  });

  it('escapes quotes and ampersands too', () => {
    expect(esc(`Smith & Sons "Roofing" <FL>`))
      .toBe('Smith &amp; Sons &quot;Roofing&quot; &lt;FL&gt;');
  });

  it('renders dates the same wherever the server is', () => {
    // Rendering in the server's local zone would move a deadline date by a day
    // depending on which machine produced the document.
    const r = generateDocument('NTO', goodNto, AT, new Date('2026-03-01T12:00:00Z'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html).toContain('February 20, 2026');
  });

  it('shows a ruled line where a field was left blank, not a gap', () => {
    // A gap reads as "not applicable" to whoever finds it later. A rule reads
    // as "nobody filled this in", which is what happened.
    const r = generateDocument('NOC', { ...goodNoc, lenderName: null }, AT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html).toContain('class="blank"');
  });

  it('knows its own kinds', () => {
    expect(DOCUMENT_KINDS).toHaveLength(4);
    for (const k of DOCUMENT_KINDS) expect(isDocumentKind(k)).toBe(true);
    expect(isDocumentKind('DEED')).toBe(false);
  });

  it('treats warnings as producible and blocking problems as not', () => {
    expect(canGenerate([{ field: 'x', severity: 'warning', detail: '' }])).toBe(true);
    expect(canGenerate([{ field: 'x', severity: 'blocking', detail: '' }])).toBe(false);
  });

  it('dispatches every kind without falling through', () => {
    for (const kind of DOCUMENT_KINDS) {
      expect(Array.isArray(validateDocument(kind, {}))).toBe(true);
      // Nothing validates from an empty object -- which is the point.
      expect(generateDocument(kind, {}, AT).ok).toBe(false);
    }
  });
});

/**
 * Permit intake rules.
 *
 * The pure-function tests need no database: given the same facts about a job,
 * the checklist must always come out the same. These are the rules that decide
 * whether a contractor's application gets rejected at the counter, so they are
 * worth pinning precisely.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  requiredDocumentsFor, assessReadiness, isSubmittable, NOC_THRESHOLD_CENTS,
} from '../src/domain/permitIntake.js';
import {
  readPath, renderTemplate, mapStatus,
} from '../src/services/municipalities/vendors/configurable.js';
import { resolveForMunicipality } from '../src/services/municipalities/vendors/index.js';
import {
  dbConfigured, applyMigrations, seedTwoTenants, asTenant, client,
  appUrl, ownerUrl, ALPHA,
} from './helpers/db.js';

const base = {
  permitType: 'roofing' as const,
  valuationCents: 100_000,
  isNewConstruction: false,
  isOwnerBuilder: false,
  inHvhz: false,
  floodZone: null,
  isSubstantialImprovement: false,
  hasSubcontractors: false,
};

const types = (facts: Parameters<typeof requiredDocumentsFor>[0]) =>
  requiredDocumentsFor(facts).map((r) => r.documentType);

describe('required document rules', () => {
  it('requires a Notice of Commencement only above the statutory threshold', () => {
    // Fla. Stat. 713.13 -- $2,500.
    expect(types({ ...base, valuationCents: NOC_THRESHOLD_CENTS }))
      .not.toContain('notice_of_commencement');
    expect(types({ ...base, valuationCents: NOC_THRESHOLD_CENTS + 1 }))
      .toContain('notice_of_commencement');
  });

  it('demands a Miami-Dade NOA in the HVHZ instead of statewide product approval', () => {
    // Inside the High Velocity Hurricane Zone a statewide Florida Product
    // Approval is not sufficient, and submitting one gets the permit held.
    const hvhz = types({ ...base, inHvhz: true });
    expect(hvhz).toContain('noa_hvhz');
    expect(hvhz).not.toContain('product_approval');

    const elsewhere = types({ ...base, inHvhz: false });
    expect(elsewhere).toContain('product_approval');
    expect(elsewhere).not.toContain('noa_hvhz');
  });

  it('swaps license requirements for an affidavit on owner-builder permits', () => {
    const ownerBuilder = types({ ...base, isOwnerBuilder: true });
    expect(ownerBuilder).toContain('owner_builder_affidavit');
    expect(ownerBuilder).not.toContain('contractor_license');

    const contractor = types({ ...base, isOwnerBuilder: false });
    expect(contractor).toContain('contractor_license');
    expect(contractor).toContain('insurance_certificate');
  });

  it('asks for the full drawing set on new construction', () => {
    const docs = types({
      ...base,
      permitType: 'building_new_construction',
      isNewConstruction: true,
      valuationCents: 50_000_000,
    });
    for (const expected of [
      'site_plan', 'survey', 'floor_plan', 'elevation_drawing',
      'structural_plans', 'truss_engineering', 'energy_calculation',
    ]) {
      expect(docs).toContain(expected);
    }
  });

  it('requires an elevation certificate in a mapped flood zone but not in zone X', () => {
    // Zone X is outside the mapped floodplain, so it must NOT trigger the
    // requirement -- over-requiring is its own kind of wrong.
    expect(types({ ...base, floodZone: 'AE' })).toContain('flood_elevation_certificate');
    expect(types({ ...base, floodZone: 'X' })).not.toContain('flood_elevation_certificate');
    expect(types({ ...base, floodZone: 'x' })).not.toContain('flood_elevation_certificate');
  });

  it('applies the FEMA 50% rule regardless of zone', () => {
    expect(types({ ...base, isSubstantialImprovement: true }))
      .toContain('flood_elevation_certificate');
  });

  it('requires an asbestos survey before demolition', () => {
    const docs = types({ ...base, permitType: 'demolition' });
    expect(docs).toContain('asbestos_survey');
    expect(docs).toContain('demolition_plan');
  });

  it('lets a jurisdiction add its own requirements', () => {
    expect(types({ ...base, jurisdictionExtras: ['soil_report'] })).toContain('soil_report');
  });

  it('never returns the same document twice', () => {
    const docs = types({
      ...base,
      permitType: 'building_new_construction',
      isNewConstruction: true,
      inHvhz: true,
      floodZone: 'AE',
      isSubstantialImprovement: true,
      hasSubcontractors: true,
      jurisdictionExtras: ['site_plan'],
    });
    expect(new Set(docs).size).toBe(docs.length);
  });
});

describe('submission readiness', () => {
  const complete = {
    permitType: 'roofing',
    municipalityId: '11111111-1111-1111-1111-111111111111',
    siteAddressLine1: '123 Main St',
    siteCity: 'Tampa',
    sitePostalCode: '33601',
    parcelNumber: '12-34-56',
    ownerName: 'Jane Owner',
    scopeOfWork: 'Re-roof',
    valuationCents: 800_000,
    isOwnerBuilder: false,
    qualifierId: '22222222-2222-2222-2222-222222222222',
    requiresNoc: true,
    nocRecorded: true,
    contactEmail: 'a@b.test',
    missingRequiredDocuments: [],
  };

  it('accepts a complete application', () => {
    expect(isSubmittable(assessReadiness(complete))).toBe(true);
  });

  it('blocks submission when a Notice of Commencement is required but not recorded', () => {
    const issues = assessReadiness({ ...complete, nocRecorded: false });
    expect(isSubmittable(issues)).toBe(false);
    expect(issues.find((i) => i.field === 'nocRecorded')?.severity).toBe('blocking');
  });

  it('blocks when a required document is still missing', () => {
    const issues = assessReadiness({
      ...complete,
      missingRequiredDocuments: ['product_approval'],
    });
    expect(isSubmittable(issues)).toBe(false);
  });

  it('warns but does not block on a missing parcel number', () => {
    // A jurisdiction can look the parcel up; this should not trap the
    // contractor in the form.
    const issues = assessReadiness({ ...complete, parcelNumber: null });
    expect(isSubmittable(issues)).toBe(true);
    expect(issues.find((i) => i.field === 'parcelNumber')?.severity).toBe('warning');
  });

  it('requires a qualifier unless the permit is owner-builder', () => {
    expect(isSubmittable(assessReadiness({ ...complete, qualifierId: null }))).toBe(false);
    expect(
      isSubmittable(assessReadiness({ ...complete, qualifierId: null, isOwnerBuilder: true })),
    ).toBe(true);
  });
});

describe('configurable municipal adapter helpers', () => {
  it('reads nested and array paths', () => {
    const body = { data: { records: [{ status: 'Issued' }] } };
    expect(readPath(body, 'data.records.0.status')).toBe('Issued');
    expect(readPath(body, 'data.missing.status')).toBeUndefined();
  });

  it('URL-encodes interpolated values', () => {
    // A permit number containing a slash must not be able to rewrite the path.
    const url = renderTemplate('https://x.gov/permits/{permitNumber}', {
      permitNumber: 'ABC/123?x=1',
    });
    expect(url).toBe('https://x.gov/permits/ABC%2F123%3Fx%3D1');
  });

  it('maps vendor status wording onto ours', () => {
    expect(mapStatus('In Review', { 'In Review': 'under_review' })).toBe('under_review');
    expect(mapStatus('Corrections Required', undefined)).toBe('corrections_required');
  });

  it('returns unknown for unmapped statuses rather than guessing', () => {
    // Guessing here is how a contractor gets told a permit was approved when
    // the jurisdiction said something else entirely.
    expect(mapStatus('Pending Fire Marshal Review', undefined)).toBe('unknown');
    expect(mapStatus('APPROVED-ISH', { Issued: 'issued' })).toBe('unknown');
    expect(mapStatus(null, undefined)).toBe('unknown');
    expect(mapStatus(42, undefined)).toBe('unknown');
  });
});

describe('jurisdiction adapter selection', () => {
  const configured = {
    id: 'm1',
    name: 'Test City',
    platform: 'accela',
    portal_url: 'https://permits.test.gov',
    api_base_url: 'https://api.test.gov',
    api_config: {
      statusCheck: { urlTemplate: 'https://api.test.gov/p/{permitNumber}', statusPath: 'status' },
    },
    adapter_verified_at: '2026-01-01T00:00:00Z',
    supports_status_check: true,
  };

  it('uses the configured adapter only once verified', () => {
    expect(resolveForMunicipality(configured, null).automated).toBe(true);
  });

  it('falls back to a manual portal lookup when NOT verified', () => {
    // The safety property: an unverified jurisdiction must never run automated
    // checks, no matter how complete its configuration looks.
    const unverified = { ...configured, adapter_verified_at: null };
    expect(resolveForMunicipality(unverified, null).automated).toBe(false);
  });

  it('falls back to manual when verified but misconfigured', () => {
    const broken = { ...configured, api_config: {} };
    expect(resolveForMunicipality(broken, null).automated).toBe(false);
  });

  it('treats portal-only platforms as manual even when verified', () => {
    const portalVendor = { ...configured, platform: 'mygovernmentonline' };
    expect(resolveForMunicipality(portalVendor, null).automated).toBe(false);
  });
});

const describeIfDb = dbConfigured ? describe : describe.skip;

describeIfDb('permit intake, database-enforced', () => {
  beforeAll(async () => {
    await applyMigrations();
    await seedTwoTenants();
  });

  it('derives HVHZ from the county rather than trusting the form', async () => {
    const rows = await asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
      // Claim NOT in HVHZ while giving a Broward address; the trigger overrides.
      const dade = await c.query(
        `insert into ocs.permit_applications
           (company_id, permit_type, site_county, in_hvhz)
         values ($1, 'roofing', 'Broward', false) returning in_hvhz`,
        [ALPHA],
      );
      const orange = await c.query(
        `insert into ocs.permit_applications
           (company_id, permit_type, site_county, in_hvhz)
         values ($1, 'roofing', 'Orange', true) returning in_hvhz`,
        [ALPHA],
      );
      return { dade: dade.rows[0].in_hvhz, orange: orange.rows[0].in_hvhz };
    });
    expect(rows.dade).toBe(true);
    expect(rows.orange).toBe(false);
  });

  it('derives the Notice of Commencement requirement from valuation', async () => {
    const result = await asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
      const under = await c.query(
        `insert into ocs.permit_applications (company_id, permit_type, valuation_cents)
         values ($1, 'roofing', 250000) returning requires_noc`,
        [ALPHA],
      );
      const over = await c.query(
        `insert into ocs.permit_applications (company_id, permit_type, valuation_cents)
         values ($1, 'roofing', 250001) returning requires_noc`,
        [ALPHA],
      );
      return { under: under.rows[0].requires_noc, over: over.rows[0].requires_noc };
    });
    expect(result.under).toBe(false);
    expect(result.over).toBe(true);
  });

  it('refuses an owner-builder application that also names a qualifier', async () => {
    await expect(
      asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
        const q = await c.query(
          `insert into ocs.qualifiers (company_id, full_name) values ($1,'Q') returning id`,
          [ALPHA],
        );
        await c.query(
          `insert into ocs.permit_applications
             (company_id, permit_type, is_owner_builder, qualifier_id)
           values ($1, 'roofing', true, $2)`,
          [ALPHA, q.rows[0].id],
        );
      }),
    ).rejects.toThrow(/owner-builder/i);
  });

  it('will not enable automated checks for an unverified jurisdiction', async () => {
    // Run as the OWNER, not the API role. Under ocs_app the RLS write policy on
    // municipalities filters the row out and the UPDATE silently matches zero
    // rows -- which would pass this test without ever reaching the constraint.
    // Connecting as the owner is what actually exercises the CHECK.
    const c = client(ownerUrl!);
    await c.connect();
    try {
      await expect(
        c.query(
          `update ocs.municipalities
              set status_check_enabled = true, adapter_verified_at = null
            where name = 'Broward' and kind = 'county'`,
        ),
      ).rejects.toThrow(/municipalities_check_requires_verification/i);
    } finally {
      await c.end();
    }
  });

  it('blocks the API role from writing jurisdiction config at all', async () => {
    // The other half of the guarantee: reference data is service-context only,
    // so a contractor cannot point a jurisdiction at an endpoint of their own.
    const affected = await asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
      const res = await c.query(
        `update ocs.municipalities set portal_url = 'https://attacker.example'
          where kind = 'county'`,
      );
      return res.rowCount;
    });
    expect(affected).toBe(0);
  });

  it('rejects an application marked rejected without a reason', async () => {
    await expect(
      asTenant(appUrl!, { companyId: ALPHA }, async (c) => {
        await c.query(
          `insert into ocs.permit_applications (company_id, permit_type, status)
           values ($1, 'roofing', 'rejected')`,
          [ALPHA],
        );
      }),
    ).rejects.toThrow(/applications_rejection_has_reason/i);
  });
});

/**
 * Florida permit intake rules.
 *
 * This module encodes what a Florida building department actually asks for, so
 * that an application is checked for completeness the moment it is filled in
 * rather than three weeks later at the counter. Every rule here corresponds to
 * a real reason applications get rejected.
 *
 * It is intentionally the ONLY place these rules live. The intake form, the
 * submit check, and the staff review screen all read from here, so they cannot
 * drift apart and disagree about what is required.
 *
 * WHERE THE RULES COME FROM
 *   * Notice of Commencement over $2,500 -- Fla. Stat. 713.13
 *   * HVHZ (Miami-Dade + Broward) product approval -- Florida Building Code,
 *     which requires a Miami-Dade NOA there rather than a statewide Florida
 *     Product Approval number
 *   * Substantial improvement / 50% rule -- FEMA, applied by local floodplain
 *     administrators
 *   * Workers' compensation or a filed exemption for every sub -- Fla. Stat. 440
 *
 * WHAT THIS IS NOT: legal advice, and not a substitute for a specific
 * jurisdiction's checklist. Individual jurisdictions add their own
 * requirements, which is what `additionalRequiredDocuments` on the
 * municipality's api_config is for. Treat the output as a strong default that
 * a jurisdiction can extend.
 */

export const PERMIT_TYPES = [
  'building_new_construction',
  'building_addition',
  'building_alteration',
  'roofing',
  'windows_doors',
  'siding',
  'electrical',
  'plumbing',
  'mechanical_hvac',
  'gas',
  'pool_spa',
  'fence',
  'driveway',
  'shed_accessory',
  'demolition',
  'sign',
  'solar_pv',
  'generator',
  'screen_enclosure',
  'dock_seawall',
  'mobile_home_setup',
  'shutters_impact_protection',
  'other',
] as const;

export type PermitType = (typeof PERMIT_TYPES)[number];

export const PERMIT_TYPE_LABELS: Record<PermitType, string> = {
  building_new_construction: 'New construction',
  building_addition: 'Addition',
  building_alteration: 'Alteration / remodel',
  roofing: 'Roofing',
  windows_doors: 'Windows & doors',
  siding: 'Siding',
  electrical: 'Electrical',
  plumbing: 'Plumbing',
  mechanical_hvac: 'Mechanical / HVAC',
  gas: 'Gas',
  pool_spa: 'Pool & spa',
  fence: 'Fence',
  driveway: 'Driveway / paving',
  shed_accessory: 'Shed / accessory structure',
  demolition: 'Demolition',
  sign: 'Sign',
  solar_pv: 'Solar PV',
  generator: 'Generator',
  screen_enclosure: 'Screen enclosure',
  dock_seawall: 'Dock / seawall',
  mobile_home_setup: 'Mobile home setup',
  shutters_impact_protection: 'Shutters / impact protection',
  other: 'Other',
};

export const REQUIRED_DOCUMENT_TYPES = [
  'site_plan', 'floor_plan', 'elevation_drawing', 'structural_plans',
  'truss_engineering', 'energy_calculation', 'product_approval', 'noa_hvhz',
  'survey', 'notice_of_commencement', 'owner_authorization',
  'owner_builder_affidavit', 'contractor_license', 'insurance_certificate',
  'workers_comp_exemption', 'subcontractor_affidavit', 'soil_report',
  'septic_approval', 'well_permit', 'dep_environmental', 'hoa_approval',
  'asbestos_survey', 'demolition_plan', 'flood_elevation_certificate', 'other',
] as const;

export type RequiredDocumentType = (typeof REQUIRED_DOCUMENT_TYPES)[number];

export const DOCUMENT_LABELS: Record<RequiredDocumentType, string> = {
  site_plan: 'Site plan',
  floor_plan: 'Floor plan',
  elevation_drawing: 'Elevation drawings',
  structural_plans: 'Structural plans (signed & sealed)',
  truss_engineering: 'Truss engineering',
  energy_calculation: 'Energy calculations (Form R405/C405)',
  product_approval: 'Florida Product Approval',
  noa_hvhz: 'Miami-Dade NOA (HVHZ)',
  survey: 'Boundary survey',
  notice_of_commencement: 'Recorded Notice of Commencement',
  owner_authorization: 'Owner authorization letter',
  owner_builder_affidavit: 'Owner-builder affidavit',
  contractor_license: 'Contractor license',
  insurance_certificate: 'Certificate of insurance',
  workers_comp_exemption: "Workers' comp exemption",
  subcontractor_affidavit: 'Subcontractor affidavit',
  soil_report: 'Soil / geotechnical report',
  septic_approval: 'Septic (OSTDS) approval',
  well_permit: 'Well permit',
  dep_environmental: 'DEP environmental permit',
  hoa_approval: 'HOA approval',
  asbestos_survey: 'Asbestos survey',
  demolition_plan: 'Demolition plan',
  flood_elevation_certificate: 'FEMA elevation certificate',
  other: 'Other supporting document',
};

/**
 * Fla. Stat. 713.13 threshold, in cents to match valuation_cents.
 *
 * Re-exported from the shared definition so the filing gate and the
 * contractor's checklist cannot drift apart. They had: this gate enforced
 * $2,500 while the checklist only asked for an NOC above $250,000.
 */
export { NOC_THRESHOLD_CENTS } from '../shared/requirements.js';
import { NOC_THRESHOLD_CENTS } from '../shared/requirements.js';

/** Trades whose product must be approved for wind-borne debris resistance. */
const WIND_BORNE_TYPES = new Set<PermitType>([
  'roofing',
  'windows_doors',
  'siding',
  'shutters_impact_protection',
  'screen_enclosure',
  'building_new_construction',
  'building_addition',
]);

/** Types that always involve structural work requiring sealed drawings. */
const STRUCTURAL_TYPES = new Set<PermitType>([
  'building_new_construction',
  'building_addition',
  'pool_spa',
  'dock_seawall',
  'screen_enclosure',
  'mobile_home_setup',
]);

const TRADE_TYPES = new Set<PermitType>(['electrical', 'plumbing', 'mechanical_hvac', 'gas']);

export interface IntakeFacts {
  permitType: PermitType;
  valuationCents: number | null;
  isNewConstruction: boolean;
  isOwnerBuilder: boolean;
  inHvhz: boolean;
  floodZone: string | null;
  isSubstantialImprovement: boolean;
  hasSubcontractors: boolean;
  hasSeptic?: boolean;
  hasHoa?: boolean;
  /** Extra document types this jurisdiction demands, from its api_config. */
  jurisdictionExtras?: RequiredDocumentType[];
}

export interface RequirementRule {
  documentType: RequiredDocumentType;
  /** Shown to the contractor so a checklist item is never unexplained. */
  reason: string;
}

/**
 * Work out the required-document checklist for one application.
 *
 * Deterministic and side-effect free, so the same facts always produce the same
 * checklist and it can be unit tested without a database.
 */
export function requiredDocumentsFor(facts: IntakeFacts): RequirementRule[] {
  const rules: RequirementRule[] = [];
  const add = (documentType: RequiredDocumentType, reason: string) => {
    if (!rules.some((r) => r.documentType === documentType)) {
      rules.push({ documentType, reason });
    }
  };

  // --- Always ---------------------------------------------------------------
  if (facts.isOwnerBuilder) {
    add('owner_builder_affidavit', 'The property owner is pulling this permit themselves');
    add('owner_authorization', 'Owner-builder permits require the owner on record');
  } else {
    add('contractor_license', 'Every permit filed by a contractor requires a current license');
    add('insurance_certificate', 'Jurisdictions require proof of general liability coverage');
  }

  // --- Notice of Commencement (Fla. Stat. 713.13) ---------------------------
  if ((facts.valuationCents ?? 0) > NOC_THRESHOLD_CENTS) {
    add(
      'notice_of_commencement',
      `Florida law requires a recorded Notice of Commencement for work over $${(
        NOC_THRESHOLD_CENTS / 100
      ).toLocaleString()}`,
    );
  }

  // --- Drawings -------------------------------------------------------------
  if (facts.isNewConstruction || facts.permitType === 'building_new_construction') {
    add('site_plan', 'New construction requires a site plan');
    add('survey', 'New construction requires a boundary survey');
    add('floor_plan', 'New construction requires floor plans');
    add('elevation_drawing', 'New construction requires elevations');
    add('structural_plans', 'New construction requires signed and sealed structural plans');
    add('truss_engineering', 'Trussed roof systems require engineering');
    add('energy_calculation', 'Florida Energy Code compliance must be demonstrated');
  } else if (STRUCTURAL_TYPES.has(facts.permitType)) {
    add('site_plan', 'This work changes the site and requires a site plan');
    add('structural_plans', 'This work is structural and requires sealed plans');
  }

  if (facts.permitType === 'building_addition') {
    add('survey', 'Additions require a survey to confirm setbacks');
    add('energy_calculation', 'Conditioned additions must show energy compliance');
  }

  if (facts.permitType === 'roofing') {
    add('site_plan', 'A roof plan showing the areas of work is required');
  }

  // --- Wind-borne debris ----------------------------------------------------
  // In the HVHZ a statewide Florida Product Approval is NOT sufficient; the
  // product needs a Miami-Dade Notice of Acceptance.
  if (WIND_BORNE_TYPES.has(facts.permitType)) {
    if (facts.inHvhz) {
      add(
        'noa_hvhz',
        'This address is in the High Velocity Hurricane Zone, which requires a Miami-Dade NOA',
      );
    } else {
      add('product_approval', 'Wind-borne debris products require Florida Product Approval');
    }
  }

  // --- Flood ----------------------------------------------------------------
  const inFloodZone =
    Boolean(facts.floodZone) && !/^x$/i.test((facts.floodZone ?? '').trim());

  if (inFloodZone || facts.isSubstantialImprovement) {
    add(
      'flood_elevation_certificate',
      facts.isSubstantialImprovement
        ? 'Substantial improvements trigger the FEMA 50% rule'
        : 'The property is in a mapped flood zone',
    );
  }

  // --- Demolition -----------------------------------------------------------
  if (facts.permitType === 'demolition') {
    add('demolition_plan', 'Demolition requires a plan showing what is being removed');
    add('asbestos_survey', 'Florida requires an asbestos survey before demolition');
  }

  // --- Trade permits and subs ----------------------------------------------
  if (facts.hasSubcontractors || TRADE_TYPES.has(facts.permitType)) {
    add('subcontractor_affidavit', 'Each trade subcontractor must be named and licensed');
  }

  if (facts.hasSeptic) {
    add('septic_approval', 'Onsite sewage systems require health department approval');
  }
  if (facts.hasHoa) {
    add('hoa_approval', 'The property is in an association that must approve the work');
  }

  for (const extra of facts.jurisdictionExtras ?? []) {
    add(extra, 'Required by this jurisdiction');
  }

  return rules;
}

export interface ReadinessIssue {
  field: string;
  message: string;
  severity: 'blocking' | 'warning';
}

/**
 * Check whether an application is complete enough to file.
 *
 * `blocking` prevents submission. `warning` does not -- it flags something a
 * reviewer should look at. The split matters: treating every gap as blocking
 * traps contractors on genuinely optional fields, while treating none as
 * blocking sends incomplete applications to the counter to be rejected.
 */
export function assessReadiness(app: {
  permitType?: string | null;
  siteAddressLine1?: string | null;
  siteCity?: string | null;
  sitePostalCode?: string | null;
  parcelNumber?: string | null;
  municipalityId?: string | null;
  ownerName?: string | null;
  scopeOfWork?: string | null;
  valuationCents?: number | null;
  isOwnerBuilder?: boolean;
  qualifierId?: string | null;
  requiresNoc?: boolean;
  nocRecorded?: boolean;
  inHvhz?: boolean;
  designWindSpeedMph?: number | null;
  contactEmail?: string | null;
  missingRequiredDocuments?: string[];
}): ReadinessIssue[] {
  const issues: ReadinessIssue[] = [];
  const block = (field: string, message: string) =>
    issues.push({ field, message, severity: 'blocking' });
  const warn = (field: string, message: string) =>
    issues.push({ field, message, severity: 'warning' });

  if (!app.permitType) block('permitType', 'Select the type of permit');
  if (!app.municipalityId) block('municipalityId', 'Select the jurisdiction that will issue this permit');
  if (!app.siteAddressLine1) block('siteAddressLine1', 'Enter the job site address');
  if (!app.siteCity) block('siteCity', 'Enter the job site city');
  if (!app.sitePostalCode) block('sitePostalCode', 'Enter the job site ZIP code');
  if (!app.scopeOfWork) block('scopeOfWork', 'Describe the scope of work');
  if (!app.ownerName) block('ownerName', 'Enter the property owner’s name');

  if (app.valuationCents === null || app.valuationCents === undefined) {
    block('valuationCents', 'Enter the job valuation — jurisdictions calculate fees from it');
  }

  // Jurisdictions index their records by parcel, so a missing one usually means
  // manual lookup at the counter rather than an outright rejection.
  if (!app.parcelNumber) {
    warn('parcelNumber', 'Parcel / folio number is missing; the jurisdiction may need it to locate the property');
  }

  if (!app.isOwnerBuilder && !app.qualifierId) {
    block('qualifierId', 'Select the licensed qualifier pulling this permit');
  }

  if (app.requiresNoc && !app.nocRecorded) {
    block(
      'nocRecorded',
      'A Notice of Commencement must be recorded before this permit can be issued',
    );
  }

  if (app.inHvhz && !app.designWindSpeedMph) {
    warn('designWindSpeedMph', 'HVHZ submissions normally state the design wind speed');
  }

  if (!app.contactEmail) {
    warn('contactEmail', 'Without a contact email we cannot send status updates');
  }

  for (const doc of app.missingRequiredDocuments ?? []) {
    block(`documents.${doc}`, `Required document missing: ${DOCUMENT_LABELS[doc as RequiredDocumentType] ?? doc}`);
  }

  return issues;
}

export function isSubmittable(issues: ReadinessIssue[]): boolean {
  return !issues.some((i) => i.severity === 'blocking');
}

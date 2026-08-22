import type { PermitType } from './enums.ts';
import type { Jurisdiction, Project, RequirementItem, RequirementOverride } from './types.ts';

/**
 * The requirements engine composes in layers:
 *
 *   base -> permit type -> conditional -> firm overrides
 *
 * The override layer is the important one commercially. Every correction our
 * coordinators receive is a fact about a jurisdiction that nobody has written
 * down, and promoting it into an override is how the requirements database
 * compounds. The plumbing is replaceable; this is the asset.
 */

const BASE: RequirementItem[] = [
  { key: 'application_form', label: 'Signed permit application', detail: 'Owner or authorized agent signature, notarized where required.', required: true, source: 'base', because: null },
  { key: 'contractor_license', label: 'Contractor license & insurance', detail: 'Active state or local registration plus GL and workers comp certificates.', required: true, source: 'base', because: null },
  { key: 'proof_of_ownership', label: 'Proof of ownership', detail: 'Deed or current tax record matching the parcel.', required: true, source: 'base', because: null },
  { key: 'scope_of_work', label: 'Scope of work narrative', detail: null, required: true, source: 'base', because: null },
];

const BY_TYPE: Partial<Record<PermitType, RequirementItem[]>> = {
  RESIDENTIAL_NEW: [
    { key: 'site_plan', label: 'Survey and site plan', detail: 'Signed and sealed boundary survey, setbacks dimensioned.', required: true, source: 'permit_type', because: null },
    { key: 'structural_plans', label: 'Signed & sealed structural plans', detail: null, required: true, source: 'permit_type', because: null },
    { key: 'energy_calc', label: 'Florida Energy Code compliance form', detail: 'Form R405 or equivalent.', required: true, source: 'permit_type', because: null },
    { key: 'truss_engineering', label: 'Truss layout and engineering', detail: null, required: true, source: 'permit_type', because: null },
    { key: 'soil_report', label: 'Soil / geotechnical report', detail: null, required: false, source: 'permit_type', because: null },
  ],
  COMMERCIAL_NEW: [
    { key: 'site_plan', label: 'Signed & sealed site plan', detail: null, required: true, source: 'permit_type', because: null },
    { key: 'structural_plans', label: 'Signed & sealed structural plans', detail: null, required: true, source: 'permit_type', because: null },
    { key: 'fire_review', label: 'Fire marshal review set', detail: 'Life safety plan, occupancy load, egress.', required: true, source: 'permit_type', because: null },
    { key: 'energy_calc', label: 'Commercial energy compliance (C405)', detail: null, required: true, source: 'permit_type', because: null },
    { key: 'accessibility', label: 'FBC Accessibility compliance sheet', detail: null, required: true, source: 'permit_type', because: null },
  ],
  ROOFING: [
    { key: 'product_approval', label: 'Product approval / NOA sheets', detail: 'Florida Product Approval or Miami-Dade NOA for every component in the assembly.', required: true, source: 'permit_type', because: null },
    { key: 'roof_uplift', label: 'Uplift calculations', detail: null, required: true, source: 'permit_type', because: null },
    { key: 'reroof_affidavit', label: 'Re-roof / mitigation affidavit', detail: 'FBC 708 secondary water barrier where applicable.', required: true, source: 'permit_type', because: null },
  ],
  WINDOWS_DOORS: [
    { key: 'product_approval', label: 'Product approval / NOA sheets', detail: 'One per opening type, with installation instructions.', required: true, source: 'permit_type', because: null },
    { key: 'opening_schedule', label: 'Window & door schedule', detail: 'Sizes, locations and design pressures per opening.', required: true, source: 'permit_type', because: null },
    { key: 'attachment_detail', label: 'Anchorage / attachment details', detail: null, required: true, source: 'permit_type', because: null },
  ],
  SOLAR: [
    { key: 'structural_letter', label: 'Structural attachment letter', detail: 'Signed and sealed, confirming the roof carries the array.', required: true, source: 'permit_type', because: null },
    { key: 'electrical_one_line', label: 'Electrical one-line diagram', detail: null, required: true, source: 'permit_type', because: null },
    { key: 'utility_interconnect', label: 'Utility interconnection agreement', detail: null, required: true, source: 'permit_type', because: null },
    { key: 'product_approval', label: 'Module & rail product approval', detail: null, required: true, source: 'permit_type', because: null },
  ],
  POOL: [
    { key: 'site_plan', label: 'Survey with pool location', detail: null, required: true, source: 'permit_type', because: null },
    { key: 'barrier_compliance', label: 'Pool barrier / safety compliance', detail: 'Residential Swimming Pool Safety Act — barrier, alarms or safety cover.', required: true, source: 'permit_type', because: null },
    { key: 'electrical_bonding', label: 'Equipotential bonding detail', detail: null, required: true, source: 'permit_type', because: null },
  ],
  SHUTTERS: [
    { key: 'product_approval', label: 'Shutter product approval', detail: null, required: true, source: 'permit_type', because: null },
    { key: 'attachment_detail', label: 'Attachment details for the substrate', detail: null, required: true, source: 'permit_type', because: null },
  ],
  DEMOLITION: [
    { key: 'utility_disconnect', label: 'Utility disconnect confirmations', detail: null, required: true, source: 'permit_type', because: null },
    { key: 'asbestos_survey', label: 'Asbestos survey / NESHAP notification', detail: null, required: true, source: 'permit_type', because: null },
  ],
  DOCK_SEAWALL: [
    { key: 'submerged_lands', label: 'State submerged lands authorization', detail: null, required: true, source: 'permit_type', because: null },
    { key: 'environmental_permit', label: 'Environmental resource permit', detail: 'Water management district or DEP.', required: true, source: 'permit_type', because: null },
  ],
};

/** Structural-ish types where wind pressure and product approval logic applies. */
const ENVELOPE_TYPES: PermitType[] = [
  'RESIDENTIAL_NEW', 'RESIDENTIAL_ADDITION', 'RESIDENTIAL_ALTERATION',
  'COMMERCIAL_NEW', 'COMMERCIAL_ALTERATION', 'ROOFING', 'WINDOWS_DOORS', 'SHUTTERS', 'SOLAR',
];

export interface RequirementContext {
  permitType: PermitType;
  jurisdiction: Pick<Jurisdiction, 'id' | 'hvhz' | 'windBorneDebris' | 'paperOnly' | 'designWindSpeedMph'>;
  project: Pick<Project, 'valuationCents' | 'ownerBuilder' | 'floodZone' | 'coastalConstructionControlLine'>;
  overrides?: RequirementOverride[];
}

const HIGH_VALUATION_CENTS = 250_000_00;

export function buildRequirements(ctx: RequirementContext): RequirementItem[] {
  const items = new Map<string, RequirementItem>();
  const put = (i: RequirementItem) => items.set(i.key, i);

  for (const b of BASE) put({ ...b });
  for (const t of BY_TYPE[ctx.permitType] ?? []) put({ ...t });

  // --- conditional layer ---
  const { jurisdiction: j, project: p } = ctx;
  const envelope = ENVELOPE_TYPES.includes(ctx.permitType);

  if (j.hvhz && envelope) {
    put({ key: 'product_approval', label: 'Miami-Dade NOA for every product', detail: 'HVHZ will not accept statewide Florida Product Approval in place of a Notice of Acceptance.', required: true, source: 'conditional', because: 'High-Velocity Hurricane Zone (Miami-Dade / Broward)' });
    put({ key: 'hvhz_wind_calc', label: 'HVHZ wind load calculations', detail: j.designWindSpeedMph ? `Signed and sealed, ${j.designWindSpeedMph} mph ultimate design wind speed.` : 'Signed and sealed.', required: true, source: 'conditional', because: 'High-Velocity Hurricane Zone' });
  } else if (j.windBorneDebris && envelope) {
    put({ key: 'opening_protection', label: 'Opening protection compliance', detail: 'Impact-rated assemblies or code-compliant shutters for every glazed opening.', required: true, source: 'conditional', because: 'Wind-borne debris region' });
    put({ key: 'wind_calc', label: 'Wind load calculations', detail: j.designWindSpeedMph ? `ASCE 7, ${j.designWindSpeedMph} mph ultimate design wind speed.` : 'ASCE 7 per the adopted FBC edition.', required: true, source: 'conditional', because: 'Wind-borne debris region' });
  }

  if (p.floodZone && !/^x$/i.test(p.floodZone.trim())) {
    put({ key: 'flood_elevation_cert', label: 'Elevation certificate', detail: `Flood zone ${p.floodZone} — pre-construction elevation certificate and, for substantial improvement, a 50% rule determination.`, required: true, source: 'conditional', because: `FEMA flood zone ${p.floodZone}` });
    put({ key: 'flood_vents', label: 'Flood venting / breakaway wall detail', detail: null, required: false, source: 'conditional', because: `FEMA flood zone ${p.floodZone}` });
  }

  if (p.coastalConstructionControlLine) {
    put({ key: 'ccl_permit', label: 'DEP Coastal Construction Control Line permit', detail: 'State CCCL authorization must be in hand before the local permit issues.', required: true, source: 'conditional', because: 'Seaward of the Coastal Construction Control Line' });
  }

  if (p.ownerBuilder) {
    put({ key: 'owner_builder_affidavit', label: 'Owner-builder disclosure affidavit', detail: 'F.S. 489.103(7) statement, signed in person before the building official in most jurisdictions.', required: true, source: 'conditional', because: 'Owner-builder permit' });
  }

  if (p.valuationCents >= HIGH_VALUATION_CENTS) {
    put({ key: 'threshold_inspector', label: 'Special / threshold inspection plan', detail: null, required: false, source: 'conditional', because: 'Valuation over $250,000' });
    put({ key: 'notice_of_commencement', label: 'Recorded Notice of Commencement', detail: 'F.S. 713.135 — required before the first inspection on jobs over $5,000.', required: true, source: 'conditional', because: 'Valuation over the NOC threshold' });
  }

  if (j.paperOnly) {
    put({ key: 'wet_signed_set', label: 'Wet-signed and sealed paper set', detail: 'This jurisdiction does not accept electronic submittal. Plan for courier or in-person delivery.', required: true, source: 'conditional', because: 'Jurisdiction accepts paper submittals only' });
  }

  // --- firm override layer (learned from corrections) ---
  for (const o of ctx.overrides ?? []) {
    if (o.jurisdictionId !== j.id) continue;
    if (o.permitType && o.permitType !== ctx.permitType) continue;
    if (o.op === 'remove') {
      items.delete(o.requirementKey);
      continue;
    }
    const existing = items.get(o.requirementKey);
    if (o.op === 'amend' && !existing) continue;
    put({
      key: o.requirementKey,
      label: o.label ?? existing?.label ?? o.requirementKey,
      detail: o.detail ?? existing?.detail ?? null,
      required: true,
      source: 'override',
      because: o.learnedFromCorrectionId ? 'Learned from a correction this jurisdiction issued us' : 'Firm override',
    });
  }

  return [...items.values()].sort((a, b) => Number(b.required) - Number(a.required) || a.label.localeCompare(b.label));
}

/**
 * Permit application intake.
 *
 * The flow this implements:
 *
 *   draft ──► submitted ──► in_review ──┬─► accepted ──► converted (a permit)
 *     ▲                                 ├─► info_requested ──┐
 *     └─────────────────────────────────┘                    │
 *                                       └─► rejected         │
 *                                                            │
 *   (info_requested returns it to the contractor) ◄───────────┘
 *
 * The required-document checklist is recomputed from src/domain/permitIntake.ts
 * on every change, so it always reflects the CURRENT answers. Raising the job
 * valuation past $2,500 makes a Notice of Commencement appear immediately;
 * switching to an owner-builder permit swaps the license requirements for the
 * affidavit. A checklist computed once at creation would quietly go stale and
 * let an incomplete application through.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, principalOf, tenantOf } from '../auth/plugin.js';
import { withTenant, type Tx } from '../db/tenant.js';
import { requireCompanyRole, requirePlatformRole } from '../auth/rbac.js';
import { parse, clientIp, userAgent, created } from '../lib/http-helpers.js';
import { writeAudit } from '../lib/audit.js';
import { notFound, unprocessable, badRequest } from '../lib/errors.js';
import { paginationQuery, decodeCursor, buildPage } from '../lib/pagination.js';
import { notify } from '../services/notifications.js';
import {
  PERMIT_TYPES, PERMIT_TYPE_LABELS, DOCUMENT_LABELS, REQUIRED_DOCUMENT_TYPES,
  requiredDocumentsFor, assessReadiness, isSubmittable,
  type PermitType, type RequiredDocumentType,
} from '../domain/permitIntake.js';

const permitType = z.enum(PERMIT_TYPES);

const occupancyType = z.enum([
  'residential_single_family', 'residential_multi_family',
  'residential_mobile_manufactured', 'commercial', 'industrial',
  'institutional', 'agricultural', 'other',
]);

const applicationFields = z.object({
  permitType,
  municipalityId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),

  siteAddressLine1: z.string().trim().max(200).optional(),
  siteAddressLine2: z.string().trim().max(200).optional(),
  siteCity: z.string().trim().max(100).optional(),
  siteCounty: z.string().trim().max(100).optional(),
  sitePostalCode: z.string().trim().max(12).optional(),
  parcelNumber: z.string().trim().max(60).optional(),
  subdivision: z.string().trim().max(120).optional(),
  lot: z.string().trim().max(30).optional(),
  block: z.string().trim().max(30).optional(),

  ownerName: z.string().trim().max(200).optional(),
  ownerPhone: z.string().trim().max(40).optional(),
  ownerEmail: z.string().email().max(200).optional(),
  ownerMailingAddress: z.string().trim().max(300).optional(),
  isOwnerBuilder: z.boolean().optional(),

  scopeOfWork: z.string().trim().max(5000).optional(),
  // Dollars in the API, cents in the database. Contractors think in dollars and
  // the database must not think in floats, so the conversion happens once here.
  valuation: z.number().nonnegative().max(1e10).optional(),
  squareFootage: z.number().int().nonnegative().max(10_000_000).optional(),
  stories: z.number().int().nonnegative().max(200).optional(),
  dwellingUnits: z.number().int().nonnegative().max(10_000).optional(),
  isNewConstruction: z.boolean().optional(),
  occupancyType: occupancyType.optional(),

  designWindSpeedMph: z.number().int().min(90).max(220).optional(),
  windExposure: z.enum(['B', 'C', 'D']).optional(),
  floodZone: z.string().trim().max(20).optional(),
  baseFloodElevation: z.number().optional(),
  isSubstantialImprovement: z.boolean().optional(),

  nocRecorded: z.boolean().optional(),
  nocBook: z.string().trim().max(30).optional(),
  nocPage: z.string().trim().max(30).optional(),
  nocRecordedDate: z.string().date().optional(),

  qualifierId: z.string().uuid().optional(),
  licenseId: z.string().uuid().optional(),

  contactName: z.string().trim().max(200).optional(),
  contactPhone: z.string().trim().max(40).optional(),
  contactEmail: z.string().email().max(200).optional(),
  requestedStartDate: z.string().date().optional(),
  isExpedited: z.boolean().optional(),
  expediteReason: z.string().trim().max(500).optional(),

  hasSeptic: z.boolean().optional(),
  hasHoa: z.boolean().optional(),
});

const SELECT_COLUMNS = `
  id, company_id, project_id, municipality_id, application_number, status::text,
  permit_type, site_address_line1, site_address_line2, site_city, site_county,
  site_state, site_postal_code, parcel_number, subdivision, lot, block,
  owner_name, owner_phone, owner_email, owner_mailing_address, is_owner_builder,
  scope_of_work, valuation_cents::text, square_footage, stories, dwelling_units,
  is_new_construction, occupancy_type::text, design_wind_speed_mph,
  wind_exposure::text, in_hvhz, flood_zone, base_flood_elevation,
  is_substantial_improvement, requires_noc, noc_recorded, noc_book, noc_page,
  noc_recorded_date, qualifier_id, license_id, contact_name, contact_phone,
  contact_email, requested_start_date, is_expedited, expedite_reason,
  submitted_at, submitted_by, reviewed_at, reviewed_by, review_notes,
  rejection_reason, converted_permit_id, created_by, created_at, updated_at
`;

interface ApplicationRow {
  id: string;
  permit_type: string;
  valuation_cents: string | null;
  is_new_construction: boolean;
  is_owner_builder: boolean;
  in_hvhz: boolean;
  flood_zone: string | null;
  is_substantial_improvement: boolean;
  status: string;
  municipality_id: string | null;
  [key: string]: unknown;
}

/**
 * Recompute the checklist and reconcile it with what is stored.
 *
 * Rows that are no longer required are removed ONLY when still 'missing'. A
 * document the contractor already uploaded is kept even if the rules stop
 * requiring it -- deleting an uploaded file's checklist row because a valuation
 * was edited would lose their work and confuse everyone.
 */
async function syncChecklist(
  tx: Tx,
  application: ApplicationRow,
  opts: { hasSubcontractors: boolean; hasSeptic?: boolean; hasHoa?: boolean; jurisdictionExtras?: RequiredDocumentType[] },
): Promise<void> {
  const rules = requiredDocumentsFor({
    permitType: application.permit_type as PermitType,
    valuationCents: application.valuation_cents === null ? null : Number(application.valuation_cents),
    isNewConstruction: application.is_new_construction,
    isOwnerBuilder: application.is_owner_builder,
    inHvhz: application.in_hvhz,
    floodZone: application.flood_zone,
    isSubstantialImprovement: application.is_substantial_improvement,
    hasSubcontractors: opts.hasSubcontractors,
    ...(opts.hasSeptic !== undefined ? { hasSeptic: opts.hasSeptic } : {}),
    ...(opts.hasHoa !== undefined ? { hasHoa: opts.hasHoa } : {}),
    ...(opts.jurisdictionExtras ? { jurisdictionExtras: opts.jurisdictionExtras } : {}),
  });

  const wanted = rules.map((r) => r.documentType);

  for (const rule of rules) {
    await tx.query(
      `insert into ocs.application_documents
         (application_id, document_type, is_required, notes)
       values ($1, $2::ocs.required_document_type, true, $3)
       on conflict (application_id, document_type)
         do update set is_required = true, notes = excluded.notes`,
      [application.id, rule.documentType, rule.reason],
    );
  }

  await tx.query(
    `delete from ocs.application_documents
      where application_id = $1
        and status = 'missing'
        and document_type <> all($2::ocs.required_document_type[])`,
    [application.id, wanted],
  );
}

/** Jurisdiction-specific extras, stored on the municipality's api_config. */
async function jurisdictionExtras(tx: Tx, municipalityId: string | null): Promise<RequiredDocumentType[]> {
  if (!municipalityId) return [];
  const row = await tx.one<{ api_config: Record<string, unknown> }>(
    `select api_config from ocs.municipalities where id = $1`,
    [municipalityId],
  );
  const extras = row?.api_config?.['additionalRequiredDocuments'];
  if (!Array.isArray(extras)) return [];
  return extras.filter((e): e is RequiredDocumentType =>
    typeof e === 'string' && (REQUIRED_DOCUMENT_TYPES as readonly string[]).includes(e),
  );
}

async function loadFull(tx: Tx, companyId: string, id: string) {
  const application = await tx.one<ApplicationRow>(
    `select ${SELECT_COLUMNS} from ocs.permit_applications
      where id = $1 and company_id = $2 and deleted_at is null`,
    [id, companyId],
  );
  if (!application) throw notFound('Permit application');

  const documents = await tx.many<{ document_type: string; status: string; is_required: boolean }>(
    `select id, document_type::text, is_required, document_id, status, notes,
            reviewed_by, reviewed_at
       from ocs.application_documents
      where application_id = $1
      order by is_required desc, document_type`,
    [id],
  );

  const subcontractors = await tx.many(
    `select id, trade, business_name, license_number, qualifier_name, phone, email,
            has_workers_comp, workers_comp_exempt
       from ocs.application_subcontractors
      where application_id = $1
      order by trade`,
    [id],
  );

  const missingRequired = documents
    .filter((d) => d.is_required && d.status === 'missing')
    .map((d) => d.document_type);

  const issues = assessReadiness({
    permitType: application.permit_type,
    siteAddressLine1: application['site_address_line1'] as string | null,
    siteCity: application['site_city'] as string | null,
    sitePostalCode: application['site_postal_code'] as string | null,
    parcelNumber: application['parcel_number'] as string | null,
    municipalityId: application.municipality_id,
    ownerName: application['owner_name'] as string | null,
    scopeOfWork: application['scope_of_work'] as string | null,
    valuationCents: application.valuation_cents === null ? null : Number(application.valuation_cents),
    isOwnerBuilder: application.is_owner_builder,
    qualifierId: application['qualifier_id'] as string | null,
    requiresNoc: application['requires_noc'] as boolean,
    nocRecorded: application['noc_recorded'] as boolean,
    inHvhz: application.in_hvhz,
    designWindSpeedMph: application['design_wind_speed_mph'] as number | null,
    contactEmail: application['contact_email'] as string | null,
    missingRequiredDocuments: missingRequired,
  });

  return {
    ...application,
    documents: documents.map((d) => ({
      ...d,
      label: DOCUMENT_LABELS[d.document_type as RequiredDocumentType] ?? d.document_type,
    })),
    subcontractors,
    readiness: {
      issues,
      canSubmit: isSubmittable(issues),
      blockingCount: issues.filter((i) => i.severity === 'blocking').length,
      warningCount: issues.filter((i) => i.severity === 'warning').length,
    },
  };
}

export async function permitApplicationRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Form definition for the frontend.
   *
   * Serving this from the backend means the form's options and the rules that
   * validate them come from the same source. A hardcoded copy of the permit
   * type list in the frontend is a copy that will eventually disagree.
   *
   * Unauthenticated on purpose: it is a static description of the form, with no
   * customer data in it.
   */
  app.get('/v1/permit-intake/form-schema', async () => ({
    permitTypes: PERMIT_TYPES.map((value) => ({ value, label: PERMIT_TYPE_LABELS[value] })),
    documentTypes: REQUIRED_DOCUMENT_TYPES.map((value) => ({
      value,
      label: DOCUMENT_LABELS[value],
    })),
    occupancyTypes: [
      { value: 'residential_single_family', label: 'Single-family residential' },
      { value: 'residential_multi_family', label: 'Multi-family residential' },
      { value: 'residential_mobile_manufactured', label: 'Mobile / manufactured home' },
      { value: 'commercial', label: 'Commercial' },
      { value: 'industrial', label: 'Industrial' },
      { value: 'institutional', label: 'Institutional' },
      { value: 'agricultural', label: 'Agricultural' },
      { value: 'other', label: 'Other' },
    ],
    windExposureCategories: [
      { value: 'B', label: 'B — urban/suburban, wooded' },
      { value: 'C', label: 'C — open terrain, scattered obstructions' },
      { value: 'D', label: 'D — flat unobstructed, coastal' },
    ],
    rules: {
      nocThresholdDollars: 2500,
      nocStatute: 'Fla. Stat. 713.13',
      hvhzCounties: ['Miami-Dade', 'Broward'],
      hvhzNote:
        'In the High Velocity Hurricane Zone a Miami-Dade NOA is required; a statewide Florida Product Approval is not sufficient.',
    },
  }));

  app.get('/v1/permit-applications', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'viewer');

    const q = parse(
      paginationQuery.extend({
        status: z
          .enum(['draft', 'submitted', 'in_review', 'info_requested', 'accepted', 'rejected', 'converted', 'withdrawn'])
          .optional(),
        municipalityId: z.string().uuid().optional(),
      }),
      req.query,
      'query',
    );
    const cursor = decodeCursor(q.cursor);

    return withTenant(ctx, async (tx) => {
      const rows = await tx.many<{ id: string; created_at: string }>(
        `select ${SELECT_COLUMNS} from ocs.permit_applications
          where company_id = $1
            and deleted_at is null
            and ($2::ocs.application_status is null or status = $2::ocs.application_status)
            and ($3::uuid is null or municipality_id = $3::uuid)
            and ($4::timestamptz is null
                 or (created_at, id) < ($4::timestamptz, $5::uuid))
          order by created_at desc, id desc
          limit $6`,
        [ctx.companyId, q.status ?? null, q.municipalityId ?? null,
         cursor?.createdAt ?? null, cursor?.id ?? null, q.limit + 1],
      );
      return buildPage(rows, q.limit);
    });
  });

  app.get('/v1/permit-applications/:id', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'viewer');
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');

    return withTenant(ctx, (tx) => loadFull(tx, ctx.companyId, id));
  });

  app.post('/v1/permit-applications', { preHandler: authenticate }, async (req, reply) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'member');

    const body = parse(applicationFields, req.body, 'permit application');

    const result = await withTenant(ctx, async (tx) => {
      const row = await tx.one<ApplicationRow>(
        `insert into ocs.permit_applications
           (company_id, project_id, municipality_id, permit_type,
            site_address_line1, site_address_line2, site_city, site_county,
            site_postal_code, parcel_number, subdivision, lot, block,
            owner_name, owner_phone, owner_email, owner_mailing_address, is_owner_builder,
            scope_of_work, valuation_cents, square_footage, stories, dwelling_units,
            is_new_construction, occupancy_type, design_wind_speed_mph, wind_exposure,
            flood_zone, base_flood_elevation, is_substantial_improvement,
            noc_recorded, noc_book, noc_page, noc_recorded_date,
            qualifier_id, license_id, contact_name, contact_phone, contact_email,
            requested_start_date, is_expedited, expedite_reason, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
                 $19,$20,$21,$22,$23,$24,$25::ocs.occupancy_type,$26,$27::ocs.wind_exposure,
                 $28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43)
         returning ${SELECT_COLUMNS}`,
        [
          ctx.companyId, body.projectId ?? null, body.municipalityId ?? null, body.permitType,
          body.siteAddressLine1 ?? null, body.siteAddressLine2 ?? null, body.siteCity ?? null,
          body.siteCounty ?? null, body.sitePostalCode ?? null, body.parcelNumber ?? null,
          body.subdivision ?? null, body.lot ?? null, body.block ?? null,
          body.ownerName ?? null, body.ownerPhone ?? null, body.ownerEmail ?? null,
          body.ownerMailingAddress ?? null, body.isOwnerBuilder ?? false,
          body.scopeOfWork ?? null,
          body.valuation === undefined ? null : Math.round(body.valuation * 100),
          body.squareFootage ?? null, body.stories ?? null, body.dwellingUnits ?? null,
          body.isNewConstruction ?? false, body.occupancyType ?? null,
          body.designWindSpeedMph ?? null, body.windExposure ?? null,
          body.floodZone ?? null, body.baseFloodElevation ?? null,
          body.isSubstantialImprovement ?? false,
          body.nocRecorded ?? false, body.nocBook ?? null, body.nocPage ?? null,
          body.nocRecordedDate ?? null,
          body.qualifierId ?? null, body.licenseId ?? null,
          body.contactName ?? null, body.contactPhone ?? null, body.contactEmail ?? null,
          body.requestedStartDate ?? null, body.isExpedited ?? false, body.expediteReason ?? null,
          p.userId,
        ],
      );
      if (!row) throw badRequest('Could not create permit application');

      await syncChecklist(tx, row, {
        hasSubcontractors: false,
        ...(body.hasSeptic !== undefined ? { hasSeptic: body.hasSeptic } : {}),
        ...(body.hasHoa !== undefined ? { hasHoa: body.hasHoa } : {}),
        jurisdictionExtras: await jurisdictionExtras(tx, row.municipality_id),
      });

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'permit_application.created',
        entityType: 'permit_application',
        entityId: row.id,
        summary: `Permit application started (${PERMIT_TYPE_LABELS[body.permitType]})`,
        requestId: req.id,
        ipAddress: clientIp(req),
        userAgent: userAgent(req),
      });

      return loadFull(tx, ctx.companyId, row.id);
    });

    return created(reply, result);
  });

  app.patch('/v1/permit-applications/:id', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'member');

    const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
    const body = parse(applicationFields.partial(), req.body, 'permit application');

    return withTenant(ctx, async (tx) => {
      const before = await tx.one<ApplicationRow>(
        `select ${SELECT_COLUMNS} from ocs.permit_applications
          where id = $1 and company_id = $2 and deleted_at is null
          for update`,
        [id, ctx.companyId],
      );
      if (!before) throw notFound('Permit application');

      // Once accepted or converted the application is a record of what was
      // filed. Editing it afterwards would make our copy disagree with the
      // jurisdiction's.
      if (['accepted', 'converted', 'rejected', 'withdrawn'].includes(before.status)) {
        throw unprocessable(
          `This application is ${before.status} and can no longer be edited`,
        );
      }

      const updated = await tx.one<ApplicationRow>(
        `update ocs.permit_applications set
            municipality_id = coalesce($3, municipality_id),
            project_id = coalesce($4, project_id),
            permit_type = coalesce($5, permit_type),
            site_address_line1 = coalesce($6, site_address_line1),
            site_address_line2 = coalesce($7, site_address_line2),
            site_city = coalesce($8, site_city),
            site_county = coalesce($9, site_county),
            site_postal_code = coalesce($10, site_postal_code),
            parcel_number = coalesce($11, parcel_number),
            subdivision = coalesce($12, subdivision),
            lot = coalesce($13, lot),
            block = coalesce($14, block),
            owner_name = coalesce($15, owner_name),
            owner_phone = coalesce($16, owner_phone),
            owner_email = coalesce($17, owner_email),
            owner_mailing_address = coalesce($18, owner_mailing_address),
            is_owner_builder = coalesce($19, is_owner_builder),
            scope_of_work = coalesce($20, scope_of_work),
            valuation_cents = coalesce($21, valuation_cents),
            square_footage = coalesce($22, square_footage),
            stories = coalesce($23, stories),
            dwelling_units = coalesce($24, dwelling_units),
            is_new_construction = coalesce($25, is_new_construction),
            occupancy_type = coalesce($26::ocs.occupancy_type, occupancy_type),
            design_wind_speed_mph = coalesce($27, design_wind_speed_mph),
            wind_exposure = coalesce($28::ocs.wind_exposure, wind_exposure),
            flood_zone = coalesce($29, flood_zone),
            base_flood_elevation = coalesce($30, base_flood_elevation),
            is_substantial_improvement = coalesce($31, is_substantial_improvement),
            noc_recorded = coalesce($32, noc_recorded),
            noc_book = coalesce($33, noc_book),
            noc_page = coalesce($34, noc_page),
            noc_recorded_date = coalesce($35, noc_recorded_date),
            qualifier_id = coalesce($36, qualifier_id),
            license_id = coalesce($37, license_id),
            contact_name = coalesce($38, contact_name),
            contact_phone = coalesce($39, contact_phone),
            contact_email = coalesce($40, contact_email),
            requested_start_date = coalesce($41, requested_start_date),
            is_expedited = coalesce($42, is_expedited),
            expedite_reason = coalesce($43, expedite_reason)
          where id = $1 and company_id = $2
          returning ${SELECT_COLUMNS}`,
        [
          id, ctx.companyId,
          body.municipalityId ?? null, body.projectId ?? null, body.permitType ?? null,
          body.siteAddressLine1 ?? null, body.siteAddressLine2 ?? null, body.siteCity ?? null,
          body.siteCounty ?? null, body.sitePostalCode ?? null, body.parcelNumber ?? null,
          body.subdivision ?? null, body.lot ?? null, body.block ?? null,
          body.ownerName ?? null, body.ownerPhone ?? null, body.ownerEmail ?? null,
          body.ownerMailingAddress ?? null, body.isOwnerBuilder ?? null,
          body.scopeOfWork ?? null,
          body.valuation === undefined ? null : Math.round(body.valuation * 100),
          body.squareFootage ?? null, body.stories ?? null, body.dwellingUnits ?? null,
          body.isNewConstruction ?? null, body.occupancyType ?? null,
          body.designWindSpeedMph ?? null, body.windExposure ?? null,
          body.floodZone ?? null, body.baseFloodElevation ?? null,
          body.isSubstantialImprovement ?? null,
          body.nocRecorded ?? null, body.nocBook ?? null, body.nocPage ?? null,
          body.nocRecordedDate ?? null,
          body.qualifierId ?? null, body.licenseId ?? null,
          body.contactName ?? null, body.contactPhone ?? null, body.contactEmail ?? null,
          body.requestedStartDate ?? null, body.isExpedited ?? null, body.expediteReason ?? null,
        ],
      );
      if (!updated) throw notFound('Permit application');

      const subCount = await tx.one<{ n: string }>(
        `select count(*)::text as n from ocs.application_subcontractors where application_id = $1`,
        [id],
      );

      await syncChecklist(tx, updated, {
        hasSubcontractors: Number(subCount?.n ?? 0) > 0,
        ...(body.hasSeptic !== undefined ? { hasSeptic: body.hasSeptic } : {}),
        ...(body.hasHoa !== undefined ? { hasHoa: body.hasHoa } : {}),
        jurisdictionExtras: await jurisdictionExtras(tx, updated.municipality_id),
      });

      return loadFull(tx, ctx.companyId, id);
    });
  });

  // ---------------------------------------------------------------------------
  // Subcontractors
  // ---------------------------------------------------------------------------

  app.post('/v1/permit-applications/:id/subcontractors', { preHandler: authenticate }, async (req, reply) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'member');

    const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
    const body = parse(
      z.object({
        trade: z.string().trim().min(1).max(80),
        businessName: z.string().trim().min(1).max(200),
        licenseNumber: z.string().trim().max(80).optional(),
        qualifierName: z.string().trim().max(200).optional(),
        phone: z.string().trim().max(40).optional(),
        email: z.string().email().max(200).optional(),
        hasWorkersComp: z.boolean().optional(),
        workersCompExempt: z.boolean().default(false),
      }),
      req.body,
      'subcontractor',
    );

    // Florida requires coverage or a filed exemption; neither is not an option.
    if (body.hasWorkersComp === false && !body.workersCompExempt) {
      throw unprocessable(
        "A subcontractor must either carry workers' compensation or have a filed exemption",
      );
    }

    const result = await withTenant(ctx, async (tx) => {
      const application = await tx.one<ApplicationRow>(
        `select ${SELECT_COLUMNS} from ocs.permit_applications
          where id = $1 and company_id = $2 and deleted_at is null`,
        [id, ctx.companyId],
      );
      if (!application) throw notFound('Permit application');

      const row = await tx.one(
        `insert into ocs.application_subcontractors
           (application_id, trade, business_name, license_number, qualifier_name,
            phone, email, has_workers_comp, workers_comp_exempt)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         returning id, trade, business_name, license_number, qualifier_name,
                   phone, email, has_workers_comp, workers_comp_exempt`,
        [
          id, body.trade, body.businessName, body.licenseNumber ?? null,
          body.qualifierName ?? null, body.phone ?? null, body.email ?? null,
          body.hasWorkersComp ?? null, body.workersCompExempt,
        ],
      );

      // Adding a sub makes a subcontractor affidavit required.
      await syncChecklist(tx, application, {
        hasSubcontractors: true,
        jurisdictionExtras: await jurisdictionExtras(tx, application.municipality_id),
      });

      return row;
    });

    return created(reply, result);
  });

  app.delete(
    '/v1/permit-applications/:id/subcontractors/:subId',
    { preHandler: authenticate },
    async (req) => {
      const p = principalOf(req);
      const ctx = tenantOf(req);
      requireCompanyRole(p, 'member');

      const params = parse(
        z.object({ id: z.string().uuid(), subId: z.string().uuid() }),
        req.params,
        'parameters',
      );

      return withTenant(ctx, async (tx) => {
        const row = await tx.one<{ id: string }>(
          `delete from ocs.application_subcontractors
            where id = $1 and application_id = $2 and company_id = $3
            returning id`,
          [params.subId, params.id, ctx.companyId],
        );
        if (!row) throw notFound('Subcontractor');
        return { id: row.id, deleted: true };
      });
    },
  );

  // ---------------------------------------------------------------------------
  // Attach an uploaded document to a checklist item
  // ---------------------------------------------------------------------------

  app.post('/v1/permit-applications/:id/documents', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'member');

    const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
    const body = parse(
      z.object({
        documentType: z.enum(REQUIRED_DOCUMENT_TYPES),
        documentId: z.string().uuid(),
      }),
      req.body,
      'document link',
    );

    return withTenant(ctx, async (tx) => {
      // RLS keeps this from linking another tenant's document, but checking
      // gives a clear 404 instead of a policy violation.
      const doc = await tx.one(
        `select id from ocs.documents
          where id = $1 and company_id = $2 and deleted_at is null`,
        [body.documentId, ctx.companyId],
      );
      if (!doc) throw notFound('Document');

      const row = await tx.one(
        `insert into ocs.application_documents
           (application_id, document_type, document_id, status, is_required)
         values ($1, $2::ocs.required_document_type, $3, 'provided', true)
         on conflict (application_id, document_type)
           do update set document_id = excluded.document_id, status = 'provided'
         returning id, document_type::text, document_id, status`,
        [id, body.documentType, body.documentId],
      );

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'permit_application.document_attached',
        entityType: 'permit_application',
        entityId: id,
        summary: `Attached ${DOCUMENT_LABELS[body.documentType]}`,
        requestId: req.id,
      });

      return row;
    });
  });

  // ---------------------------------------------------------------------------
  // Submit
  // ---------------------------------------------------------------------------

  app.post('/v1/permit-applications/:id/submit', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'member');

    const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');

    return withTenant(ctx, async (tx) => {
      const current = await tx.one<ApplicationRow>(
        `select ${SELECT_COLUMNS} from ocs.permit_applications
          where id = $1 and company_id = $2 and deleted_at is null
          for update`,
        [id, ctx.companyId],
      );
      if (!current) throw notFound('Permit application');

      if (!['draft', 'info_requested'].includes(current.status)) {
        throw unprocessable(`This application is already ${current.status}`);
      }

      // Re-check completeness at submit time rather than trusting a flag set
      // earlier -- the application may have been edited since.
      const full = await loadFull(tx, ctx.companyId, id);
      if (!full.readiness.canSubmit) {
        throw unprocessable('This application is not complete enough to submit', {
          issues: full.readiness.issues.filter((i) => i.severity === 'blocking'),
        });
      }

      const updated = await tx.one(
        `update ocs.permit_applications
            set status = 'submitted', submitted_at = now(), submitted_by = $3
          where id = $1 and company_id = $2
          returning ${SELECT_COLUMNS}`,
        [id, ctx.companyId, p.userId],
      );

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'permit_application.submitted',
        entityType: 'permit_application',
        entityId: id,
        summary: `Application #${current['application_number']} submitted`,
        requestId: req.id,
        ipAddress: clientIp(req),
        userAgent: userAgent(req),
      });

      const staff = await tx.many<{ user_id: string; email: string }>(
        `select m.user_id, u.email from ocs.company_memberships m
           join ocs.app_users u on u.id = m.user_id
          where m.company_id = $1 and m.is_active
            and m.role in ('owner','admin')
            and u.is_active and u.deleted_at is null`,
        [ctx.companyId],
      );
      for (const s of staff) {
        await notify(tx, {
          companyId: ctx.companyId,
          userId: s.user_id,
          kind: 'system',
          title: `Permit application #${current['application_number']} submitted`,
          body: `${PERMIT_TYPE_LABELS[current.permit_type as PermitType]} at ${current['site_address_line1'] ?? 'the job site'}`,
          entityType: 'permit_application',
          entityId: id,
          linkPath: `/permit-applications/${id}`,
          email: { to: s.email },
          dedupeKey: `application_submitted:${id}:${s.user_id}`,
        });
      }

      return updated;
    });
  });

  // ---------------------------------------------------------------------------
  // Staff review
  // ---------------------------------------------------------------------------

  app.post('/v1/permit-applications/:id/review', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    // Reviewing is One Contractor Solutions' own step, not the contractor's.
    requirePlatformRole(p, 'staff');

    const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
    const body = parse(
      z.object({
        decision: z.enum(['accepted', 'rejected', 'info_requested', 'in_review']),
        notes: z.string().trim().max(4000).optional(),
        rejectionReason: z.string().trim().max(2000).optional(),
      }),
      req.body,
      'review',
    );

    if (body.decision === 'rejected' && !body.rejectionReason) {
      throw unprocessable('A rejection must include a reason the contractor can act on');
    }
    if (body.decision === 'info_requested' && !body.notes) {
      throw unprocessable('Say what information is needed');
    }

    return withTenant(ctx, async (tx) => {
      const current = await tx.one<ApplicationRow>(
        `select ${SELECT_COLUMNS} from ocs.permit_applications
          where id = $1 and company_id = $2 and deleted_at is null
          for update`,
        [id, ctx.companyId],
      );
      if (!current) throw notFound('Permit application');

      if (['converted', 'withdrawn'].includes(current.status)) {
        throw unprocessable(`This application is ${current.status}`);
      }

      const updated = await tx.one(
        `update ocs.permit_applications
            set status = $3::ocs.application_status,
                reviewed_at = now(),
                reviewed_by = $4,
                review_notes = coalesce($5, review_notes),
                rejection_reason = $6
          where id = $1 and company_id = $2
          returning ${SELECT_COLUMNS}`,
        [id, ctx.companyId, body.decision, p.userId, body.notes ?? null, body.rejectionReason ?? null],
      );

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: `permit_application.${body.decision}`,
        entityType: 'permit_application',
        entityId: id,
        summary: `Application #${current['application_number']} → ${body.decision}`,
        before: { status: current.status },
        after: { status: body.decision, notes: body.notes ?? null },
        requestId: req.id,
        ipAddress: clientIp(req),
        userAgent: userAgent(req),
      });

      const recipients = await tx.many<{ user_id: string; email: string }>(
        `select m.user_id, u.email from ocs.company_memberships m
           join ocs.app_users u on u.id = m.user_id
          where m.company_id = $1 and m.is_active
            and u.is_active and u.deleted_at is null`,
        [ctx.companyId],
      );
      for (const r of recipients) {
        await notify(tx, {
          companyId: ctx.companyId,
          userId: r.user_id,
          kind: 'system',
          title: `Application #${current['application_number']}: ${body.decision.replace('_', ' ')}`,
          body: body.rejectionReason ?? body.notes ?? '',
          entityType: 'permit_application',
          entityId: id,
          linkPath: `/permit-applications/${id}`,
          email: { to: r.email },
          dedupeKey: `application_review:${id}:${body.decision}:${r.user_id}`,
        });
      }

      return updated;
    });
  });

  /**
   * Turn an accepted application into a permit record.
   *
   * Guarded so it can run only once: a second call finds the status already
   * 'converted' and refuses, rather than creating a duplicate permit.
   */
  app.post('/v1/permit-applications/:id/convert', { preHandler: authenticate }, async (req, reply) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requirePlatformRole(p, 'staff');

    const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
    const body = parse(
      z.object({ projectId: z.string().uuid().optional() }),
      req.body ?? {},
      'conversion',
    );

    const result = await withTenant(ctx, async (tx) => {
      const application = await tx.one<ApplicationRow>(
        `select ${SELECT_COLUMNS} from ocs.permit_applications
          where id = $1 and company_id = $2 and deleted_at is null
          for update`,
        [id, ctx.companyId],
      );
      if (!application) throw notFound('Permit application');

      if (application.status === 'converted') {
        throw unprocessable('This application has already been converted to a permit');
      }
      if (application.status !== 'accepted') {
        throw unprocessable('Only an accepted application can be converted to a permit');
      }

      // Reuse the linked project, or create one from the job site so the permit
      // always has a parent.
      let projectId = body.projectId ?? (application['project_id'] as string | null);

      if (!projectId) {
        const project = await tx.one<{ id: string }>(
          `insert into ocs.projects
             (company_id, name, municipality_id, address_line1, address_line2,
              city, state, postal_code, parcel_number, client_name, client_email,
              client_phone, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           returning id`,
          [
            ctx.companyId,
            (application['site_address_line1'] as string) ?? `Application #${application['application_number']}`,
            application.municipality_id,
            application['site_address_line1'] ?? null,
            application['site_address_line2'] ?? null,
            application['site_city'] ?? null,
            application['site_state'] ?? 'FL',
            application['site_postal_code'] ?? null,
            application['parcel_number'] ?? null,
            application['owner_name'] ?? null,
            application['owner_email'] ?? null,
            application['owner_phone'] ?? null,
            p.userId,
          ],
        );
        if (!project) throw badRequest('Could not create a project for this permit');
        projectId = project.id;
      }

      const permit = await tx.one<{ id: string }>(
        `insert into ocs.permits
           (company_id, project_id, municipality_id, permit_type, scope_of_work,
            valuation, fee_amount, created_by, status)
         values ($1,$2,$3,$4,$5,$6,null,$7,'ready_to_submit')
         returning id`,
        [
          ctx.companyId, projectId, application.municipality_id,
          application.permit_type, application['scope_of_work'] ?? null,
          application.valuation_cents === null ? null : Number(application.valuation_cents) / 100,
          p.userId,
        ],
      );
      if (!permit) throw badRequest('Could not create the permit');

      await tx.query(
        `update ocs.permit_applications
            set status = 'converted', converted_permit_id = $2, project_id = $3
          where id = $1`,
        [id, permit.id, projectId],
      );

      // Carry the uploaded documents across so the permit has its paperwork.
      await tx.query(
        `update ocs.documents d
            set permit_id = $2, project_id = coalesce(d.project_id, $3)
           from ocs.application_documents ad
          where ad.application_id = $1
            and ad.document_id = d.id
            and d.company_id = $4`,
        [id, permit.id, projectId, ctx.companyId],
      );

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'permit_application.converted',
        entityType: 'permit_application',
        entityId: id,
        summary: `Application #${application['application_number']} converted to a permit`,
        after: { permitId: permit.id, projectId },
        requestId: req.id,
      });

      return { applicationId: id, permitId: permit.id, projectId };
    });

    return created(reply, result);
  });
}

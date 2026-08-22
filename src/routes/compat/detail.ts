/**
 * /api/* — the single-record routes the frontend calls and the compat layer
 * never grew.
 *
 * WHY THIS FILE EXISTS. `/api/*` is a hand-maintained mirror of the newer
 * `/v1/*` surface, and the frontend speaks `/api/*` exclusively. Pages were
 * built faster than the mirror, so nine paths the UI calls had no route behind
 * them — including `GET /api/permits/:id`, which is the screen the whole
 * product is arranged around. Every one returned `404 No route for …`, which
 * reads to a user as "this permit does not exist".
 *
 * These are not thin aliases of the `/v1` handlers. `/v1` authenticates with a
 * principal and a tenant context (`principalOf` / `requireCompanyRole`); the
 * compat layer authenticates with the frontend's own token through
 * `requireApiAuth` and decides access mode in `scoped()`. Mixing the two would
 * mean two answers to "may this caller see this row", so these handlers use
 * the compat conventions throughout and share `scoped()` with the rest of the
 * layer rather than reimplementing it.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireApiAuth, requireCapability } from './auth.js';
import { scoped } from './api.js';
import { parse, clientIp } from '../../lib/http-helpers.js';
import { writeAudit } from '../../lib/audit.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import {
  PERMIT_STAGES, toStage, fromStage, toTrade, assessRisk, daysInStage,
  toPlatformLabel, toIntegrationTier, toInspectionResult,
} from './mapping.js';
import { toDetectedStatus } from '../../services/municipalities/accela/mapping.js';
import { buildRequirements } from '../../shared/requirements.js';
import { assessCompliance, type ComplianceItem } from '../../shared/compliance.js';
import { DECISION_TO_STATUS } from './compliance.js';
import type { RequirementItem } from '../../shared/types.js';
import type { PermitType } from '../../shared/enums.js';

const idParam = z.object({ id: z.string().uuid() });

/**
 * The permit as the detail screen reads it.
 *
 * Deliberately the same column names the list endpoint returns, so a permit
 * does not change shape depending on which screen you reached it from.
 */
const PERMIT_SELECT = `
  p.id, p.company_id as "clientId", p.project_id as "projectId",
  p.permit_number as "agencyRecordId", p.permit_type as "permitType",
  p.status::text as status, p.scope_of_work as "scopeOfWork",
  p.valuation, p.applied_at as "appliedAt", p.submitted_at as "submittedAt",
  p.approved_at as "approvedAt", p.issued_at as "issuedAt",
  p.expires_at as "expiresAt", p.closed_at as "closedAt",
  p.external_reference as "externalReference",
  p.last_checked_at as "lastCheckedAt", p.last_check_error as "lastCheckError",
  p.next_check_at as "nextCheckAt", p.fee_amount as "feeAmount",
  p.fee_paid_at as "feePaidAt", p.assigned_to as "assignedTo",
  p.created_by as "createdBy", p.created_at as "createdAt",
  p.updated_at as "updatedAt", p.municipality_id as "jurisdictionId"
`;

export async function compatDetailRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------------------
  // One permit, with everything the detail screen shows
  // ---------------------------------------------------------------------------

  /**
   * Assembled here rather than by six round trips from the browser. The screen
   * needs the permit, its project, its contractor, its jurisdiction, its
   * requirements, its history, its documents, its inspections and its
   * corrections before it can render anything useful; issuing those separately
   * would mean nine requests over a job-site connection and a screen that
   * fills in piece by piece.
   */
  app.get(
    '/api/permits/:id',
    { preHandler: [requireApiAuth, requireCapability('permit:read')] },
    async (req) => {
      const { id } = parse(idParam, req.params, 'parameters');

      return scoped(req, async (tx, companyId) => {
        const permit = await tx.one<Record<string, unknown>>(
          `select ${PERMIT_SELECT} from ocs.permits p
            where p.id = $1 and p.deleted_at is null
              and ($2::uuid is null or p.company_id = $2::uuid)`,
          [id, companyId],
        );
        if (!permit) throw notFound('Permit');

        const stage = toStage(permit['status'] as string);

        const project = await tx.one<Record<string, unknown>>(
          `select pr.id, pr.company_id as "clientId", pr.name, pr.address_line1 as "addressLine1",
                  pr.city, pr.state, pr.postal_code as "postalCode", pr.county,
                  pr.parcel_number as "parcelNumber",
                  pr.valuation_cents as "valuationCents",
                  pr.owner_builder as "ownerBuilder",
                  pr.flood_zone as "floodZone",
                  pr.coastal_construction_control_line as "coastalConstructionControlLine"
             from ocs.projects pr
            where pr.id = $1 and pr.deleted_at is null`,
          [permit['projectId'] ?? null],
        );

        const client = await tx.one<Record<string, unknown>>(
          `select c.id, c.name, c.legal_name as "legalName",
                  c.license_number as "licenseNumber", c.status::text as status
             from ocs.companies c
            where c.id = $1 and c.deleted_at is null`,
          [permit['clientId']],
        );

        const jurisdictionRow = await tx.one<Record<string, unknown>>(
          `select m.id, m.id as "jurisdictionId", m.name, m.kind::text as kind,
                  m.county, m.state, m.portal_url as "portalUrl",
                  m.platform::text as platform,
                  m.status_check_enabled as "statusCheckEnabled",
                  m.adapter_verified_at,
                  ocs.county_is_hvhz(m.county) as hvhz
             from ocs.municipalities m
            where m.id = $1`,
          [permit['jurisdictionId'] ?? null],
        );

        const jurisdiction: Record<string, unknown> | null = jurisdictionRow
          ? {
              ...jurisdictionRow,
              platform: toPlatformLabel(jurisdictionRow['platform'] as string | null),
              integrationTier: toIntegrationTier(jurisdictionRow as never),
              paperOnly:
                !jurisdictionRow['platform'] || jurisdictionRow['platform'] === 'none',
              medianReviewDays: null,
              reviewSampleSize: 0,
            }
          : null;

        const [statusEvents, documents, inspections, corrections] = await Promise.all([
          tx.many<Record<string, unknown>>(
            `select h.id, h.permit_id as "permitId", h.created_at as at,
                    h.note as "rawStatus", h.to_status::text as "toStatus",
                    h.note, h.source as "sourceChannel"
               from ocs.permit_status_history h
              where h.permit_id = $1
              order by h.created_at desc
              limit 100`,
            [id],
          ),
          tx.many<Record<string, unknown>>(
            `select d.id, d.company_id as "clientId", d.permit_id as "permitId",
                    d.name, d.category::text as category,
                    d.requirement_key as "requirementKey",
                    v.file_name as "fileName", v.content_type as "contentType",
                    v.byte_size as "sizeBytes", v.uploaded_at as "uploadedAt",
                    d.uploaded_by as "uploadedBy"
               from ocs.documents d
               left join ocs.document_versions v on v.id = d.current_version_id
              where d.permit_id = $1 and d.deleted_at is null
              order by d.created_at desc
              limit 200`,
            [id],
          ),
          tx.many<Record<string, unknown>>(
            `select i.id, i.permit_id as "permitId",
                    i.inspection_type as "inspectionType",
                    i.scheduled_for as "scheduledFor",
                    i.result::text as result,
                    i.inspector_note as "inspectorNote",
                    i.reinspection_of_id as "reinspectionOfId",
                    i.source_channel::text as "sourceChannel"
               from ocs.permit_inspections i
              where i.permit_id = $1
              order by coalesce(i.scheduled_for, i.created_at) desc
              limit 200`,
            [id],
          ),
          tx.many<Record<string, unknown>>(
            `select c.id, c.permit_id as "permitId", c.cycle, c.issued_at as "issuedAt",
                    c.discipline, c.body as text, c.resolved_at as "resolvedAt",
                    c.promoted_to_requirement as "promotedToRequirement"
               from ocs.permit_corrections c
              where c.permit_id = $1
              order by c.issued_at desc
              limit 200`,
            [id],
          ),
        ]);

        /*
         * Requirements are DERIVED, not stored — which is why they can be
         * computed here at all. The same function runs in the browser on the
         * new-permit screen, so a requirement cannot appear on one screen and
         * not the other.
         *
         * It needs facts about the site, and those live on the project (0026
         * moved them there for exactly this reason: they are the same on the
         * second permit as the first). A permit with no project has nothing to
         * reason from, so it gets an empty list rather than a guess.
         */
        let requirements: RequirementItem[] = [];
        if (project && jurisdiction) {
          requirements = buildRequirements({
            permitType: permit['permitType'] as PermitType,
            jurisdiction: {
              id: jurisdiction['id'] as string,
              hvhz: Boolean(jurisdiction['hvhz']),
              windBorneDebris: Boolean(jurisdiction['hvhz']),
              paperOnly: Boolean(jurisdiction['paperOnly']),
              designWindSpeedMph: null,
            } as never,
            project: {
              valuationCents: (project['valuationCents'] as number | null) ?? null,
              ownerBuilder: Boolean(project['ownerBuilder']),
              floodZone: (project['floodZone'] as string | null) ?? null,
              coastalConstructionControlLine: Boolean(
                project['coastalConstructionControlLine'],
              ),
            } as never,
          });
        }

        return {
          permit: {
            ...permit,
            stage,
            trade: toTrade(permit['permitType'] as string),
            serviceLine: 'EXPEDITING',
            correctionCycles: corrections.length,
            daysInStage: daysInStage(permit['updatedAt'] as string),
            jurisdictionName: jurisdiction?.['name'] ?? null,
            projectName: project?.['name'] ?? null,
            clientName: client?.['name'] ?? null,
          },
          project,
          client,
          jurisdiction,
          risk: assessRisk({
            stage,
            updatedAt: permit['updatedAt'] as string,
            expiresAt: (permit['expiresAt'] as string | null) ?? null,
          }),
          requirements,
          statusEvents: statusEvents.map((e) => ({
            ...e,
            stage: toStage(e['toStatus'] as string),
          })),
          documents,
          inspections: inspections.map((i) => ({
            ...i,
            result: toInspectionResult(i['result'] as string),
          })),
          corrections,
        };
      });
    },
  );

  /**
   * Record what the agency's portal actually says.
   *
   * The caller sends the jurisdiction's own wording — "Plan Review –
   * Corrections Required", "Ready for Issuance" — not one of our statuses. The
   * mapping happens here, with the SAME rules the automated municipal check
   * uses, so a coordinator pasting a status and a scheduled sync cannot
   * disagree about what it meant.
   *
   * An unrecognised status is reported as unrecognised and changes nothing.
   * Guessing would put a permit in a stage nobody chose, and the whole point of
   * this screen is that a human saw the words.
   */
  app.post(
    '/api/permits/:id/status',
    { preHandler: [requireApiAuth, requireCapability('permit:edit')] },
    async (req) => {
      const auth = req.apiAuth!;
      const { id } = parse(idParam, req.params, 'parameters');
      const body = parse(
        z.object({
          rawStatus: z.string().min(1).max(500),
          note: z.string().max(2000).optional(),
        }),
        req.body,
        'status',
      );

      return scoped(req, async (tx, companyId) => {
        const permit = await tx.one<{ id: string; status: string }>(
          `select id, status::text as status from ocs.permits
            where id = $1 and deleted_at is null
              and ($2::uuid is null or company_id = $2::uuid)
            for update`,
          [id, companyId],
        );
        if (!permit) throw notFound('Permit');

        const detected = toDetectedStatus(body.rawStatus);
        const recognised = detected !== 'unknown';
        const stage = recognised ? toStage(detected) : null;

        if (recognised && detected !== permit.status) {
          await tx.query(`select set_config('ocs.change_source', 'user', true)`);
          await tx.query(
            `update ocs.permits
                set status = $2::ocs.permit_status,
                    last_checked_at = now()
              where id = $1`,
            [id, detected],
          );
          await tx.query(
            `update ocs.permit_status_history
                set note = $2
              where id = (select max(id) from ocs.permit_status_history where permit_id = $1)`,
            [id, body.note ?? `Portal reported: ${body.rawStatus}`],
          );
        }

        await writeAudit(tx, {
          actorUserId: auth.userId,
          actorEmail: auth.email,
          action: 'permit.status_observed',
          entityType: 'permit',
          entityId: id,
          summary: recognised
            ? `Portal status mapped to ${detected}`
            : 'Portal status not recognised',
          after: { rawStatus: body.rawStatus, detected, stage },
          requestId: req.id,
          ipAddress: clientIp(req),
        });

        return {
          permitId: id,
          normalization: { rawStatus: body.rawStatus, stage, recognised },
        };
      });
    },
  );

  /**
   * Move a permit to a stage a person chose, from the board.
   *
   * Distinct from the route above on purpose: that one records what an agency
   * said, this one records what we decided. They end in the same column and
   * would be easy to merge, but then the history could no longer answer "did a
   * human do this, or did the portal?" — which is the first question asked when
   * a permit is in a stage nobody expected.
   */
  app.post(
    '/api/permits/:id/advance',
    { preHandler: [requireApiAuth, requireCapability('permit:edit')] },
    async (req) => {
      const auth = req.apiAuth!;
      const { id } = parse(idParam, req.params, 'parameters');
      const body = parse(
        z.object({ stage: z.enum(PERMIT_STAGES) }),
        req.body,
        'stage',
      );

      const target = fromStage(body.stage);
      if (!target) {
        throw badRequest(`"${body.stage}" is not a stage a permit can be moved to.`);
      }

      return scoped(req, async (tx, companyId) => {
        const permit = await tx.one<{ id: string; status: string }>(
          `select id, status::text as status from ocs.permits
            where id = $1 and deleted_at is null
              and ($2::uuid is null or company_id = $2::uuid)
            for update`,
          [id, companyId],
        );
        if (!permit) throw notFound('Permit');

        if (permit.status === target) {
          return { permitId: id, stage: body.stage, unchanged: true };
        }

        await tx.query(`select set_config('ocs.change_source', 'user', true)`);
        await tx.query(
          `update ocs.permits
              set status = $2::ocs.permit_status,
                  submitted_at = case when $2 in ('submitted','resubmitted') and submitted_at is null
                                      then now() else submitted_at end,
                  approved_at  = case when $2 = 'approved' and approved_at is null
                                      then now() else approved_at end,
                  issued_at    = case when $2 = 'issued' and issued_at is null
                                      then now() else issued_at end,
                  closed_at    = case when $2 = 'closed' and closed_at is null
                                      then now() else closed_at end
            where id = $1`,
          [id, target],
        );

        await writeAudit(tx, {
          actorUserId: auth.userId,
          actorEmail: auth.email,
          action: 'permit.advanced',
          entityType: 'permit',
          entityId: id,
          summary: `Moved to ${body.stage}`,
          before: { status: permit.status },
          after: { status: target },
          requestId: req.id,
          ipAddress: clientIp(req),
        });

        return { permitId: id, stage: body.stage, unchanged: false };
      });
    },
  );

  // ---------------------------------------------------------------------------
  // One contractor
  // ---------------------------------------------------------------------------

  /**
   * One contractor.
   *
   * Returned bare rather than wrapped, because that is how the page reads it —
   * `get<Client>('/clients/:id')`. The list endpoint beside this one wraps and
   * returns snake_case; the two disagree, and this is the shape the screen
   * actually consumes.
   *
   * Service line and filing hold are read from the columns 0033 added. Before
   * that they were invented here at read time, so every contractor looked like
   * EXPEDITING no matter what they had been sold — and on MANAGED_LICENSE that
   * is the difference between supervision being a service and being a legal
   * obligation.
   *
   * The remainder — contact name, onboarding status, QuickBooks id — still have
   * no column. They are returned as explicit nulls rather than omitted, so the
   * page renders instead of throwing on a missing key, and so it is obvious
   * from the response which facts this system does not yet record.
   */
  app.get(
    '/api/clients/:id',
    { preHandler: [requireApiAuth, requireCapability('client:read')] },
    async (req) => {
      const { id } = parse(idParam, req.params, 'parameters');

      return scoped(
        req,
        async (tx, companyId) => {
          const row = await tx.one<Record<string, unknown>>(
            `select c.id, c.name, c.legal_name as "legalName",
                    c.license_number as "licenseNumber", c.federal_ein as "federalEin",
                    c.status::text as status, c.email, c.phone,
                    c.address_line1 as "addressLine1", c.city, c.state,
                    c.postal_code as zip,
                    c.service_line::text as "serviceLine",
                    c.filing_hold as "filingHold",
                    c.filing_hold_reason as "filingHoldReason",
                    c.stripe_customer_id as "stripeCustomerId",
                    c.created_at as "createdAt", c.updated_at as "updatedAt",
                    (select count(*)::int from ocs.permits p
                      where p.company_id = c.id and p.deleted_at is null) as "permitCount",
                    (select count(*)::int from ocs.app_users u
                      where u.client_id = c.id and u.deleted_at is null) as "userCount"
               from ocs.companies c
              where c.id = $1 and c.deleted_at is null
                and ($2::uuid is null or c.id = $2::uuid)`,
            [id, companyId],
          );
          if (!row) throw notFound('Contractor');

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
        },
        // A CLIENT may only ever read itself; scoped() enforces that, and
        // passing the requested id narrows staff to the same one record.
        id,
      );
    },
  );

  /**
   * Create a contractor.
   *
   * The service line is stored, not assumed. It decides pricing, which
   * paperwork is mandatory, and whether a permit filed for this contractor
   * needs one of our qualifiers named on it — so a default here is a wrong
   * answer for half of the customers, not a neutral one.
   */
  app.post(
    '/api/clients',
    { preHandler: [requireApiAuth, requireCapability('client:create')] },
    async (req, reply) => {
      const auth = req.apiAuth!;
      const body = parse(
        z.object({
          name: z.string().min(1).max(200),
          legalName: z.string().max(200).nullable().optional(),
          contactName: z.string().max(200).nullable().optional(),
          contactEmail: z.string().email().nullable().optional(),
          contactPhone: z.string().max(40).nullable().optional(),
          serviceLine: z.enum(['EXPEDITING', 'MANAGED_LICENSE']).default('EXPEDITING'),
          licenseNumber: z.string().max(60).nullable().optional(),
          licenseType: z.string().max(60).nullable().optional(),
          onboardingStatus: z.string().max(40).optional(),
        }),
        req.body,
        'contractor',
      );

      const created = await scoped(req, async (tx) => {
        const row = await tx.one<Record<string, unknown>>(
          `insert into ocs.companies
             (name, legal_name, license_number, service_line, email, phone, status)
           values ($1, $2, $3, $4::ocs.service_line, $5, $6, 'active')
           returning id, name, legal_name as "legalName",
                     license_number as "licenseNumber",
                     service_line::text as "serviceLine",
                     filing_hold as "filingHold",
                     filing_hold_reason as "filingHoldReason",
                     status::text as status, email, phone,
                     created_at as "createdAt", updated_at as "updatedAt"`,
          [
            body.name,
            body.legalName ?? null,
            body.licenseNumber ?? null,
            body.serviceLine,
            body.contactEmail ?? null,
            body.contactPhone ?? null,
          ],
        );

        await writeAudit(tx, {
          actorUserId: auth.userId,
          actorEmail: auth.email,
          action: 'client.created',
          entityType: 'company',
          entityId: String(row!['id']),
          summary: `Created ${body.name} on ${body.serviceLine}`,
          after: { ...body },
          requestId: req.id,
          ipAddress: clientIp(req),
        });

        return row!;
      });

      reply.code(201);
      // Bare, matching the read: the page does `post<Client>('/clients', …)`.
      return {
        ...created,
        contactName: body.contactName ?? null,
        contactEmail: created['email'] ?? null,
        contactPhone: created['phone'] ?? null,
        licenseType: body.licenseType ?? null,
        licenseExpiresAt: null,
        federalEin: null,
        onboardingStatus: body.onboardingStatus ?? 'INVITED',
        onboardingCompletedAt: null,
        quickbooksCustomerId: null,
        stripeCustomerId: null,
        active: true,
        permitCount: 0,
        userCount: 0,
      };
    },
  );

  /**
   * Change a contractor — in practice, put them on or take them off filing hold.
   *
   * A hold needs a reason and the database enforces it, because a hold nobody
   * can explain is a hold nobody can clear.
   */
  app.patch(
    '/api/clients/:id',
    { preHandler: [requireApiAuth, requireCapability('client:suspend')] },
    async (req) => {
      const auth = req.apiAuth!;
      const { id } = parse(idParam, req.params, 'parameters');
      const body = parse(
        z.object({
          name: z.string().min(1).max(200).optional(),
          legalName: z.string().max(200).nullable().optional(),
          licenseNumber: z.string().max(60).nullable().optional(),
          serviceLine: z.enum(['EXPEDITING', 'MANAGED_LICENSE']).optional(),
          filingHold: z.boolean().optional(),
          filingHoldReason: z.string().max(2000).nullable().optional(),
          email: z.string().email().nullable().optional(),
          phone: z.string().max(40).nullable().optional(),
        }),
        req.body,
        'contractor',
      );

      if (Object.keys(body).length === 0) throw badRequest('Nothing to change.');
      if (body.filingHold === true && !body.filingHoldReason?.trim()) {
        throw badRequest(
          'A filing hold needs a reason. Record what is outstanding, or the ' +
            'next person has no way to know when it can be lifted.',
        );
      }

      return scoped(req, async (tx, companyId) => {
        const before = await tx.one<Record<string, unknown>>(
          `select id, name, service_line::text as service_line, filing_hold
             from ocs.companies
            where id = $1 and deleted_at is null
              and ($2::uuid is null or id = $2::uuid)`,
          [id, companyId],
        );
        if (!before) throw notFound('Contractor');

        const columns: Array<[string, unknown]> = [
          ['name', body.name],
          ['legal_name', body.legalName],
          ['license_number', body.licenseNumber],
          ['email', body.email],
          ['phone', body.phone],
          ['filing_hold', body.filingHold],
          // Clearing the hold clears its reason, so a stale explanation cannot
          // outlive the thing it explained.
          ['filing_hold_reason', body.filingHold === false ? null : body.filingHoldReason],
        ];

        const sets: string[] = [];
        const values: unknown[] = [id];
        for (const [column, value] of columns) {
          if (value === undefined) continue;
          values.push(value);
          sets.push(`${column} = $${values.length}`);
        }
        if (body.serviceLine !== undefined) {
          values.push(body.serviceLine);
          sets.push(`service_line = $${values.length}::ocs.service_line`);
        }

        const client = await tx.one<Record<string, unknown>>(
          `update ocs.companies set ${sets.join(', ')}
            where id = $1
            returning id, name, legal_name as "legalName",
                      license_number as "licenseNumber",
                      service_line::text as "serviceLine",
                      filing_hold as "filingHold",
                      filing_hold_reason as "filingHoldReason",
                      status::text as status, email, phone,
                      updated_at as "updatedAt"`,
          values,
        );

        await writeAudit(tx, {
          actorUserId: auth.userId,
          actorEmail: auth.email,
          action: body.filingHold === true ? 'client.filing_hold_set'
            : body.filingHold === false ? 'client.filing_hold_cleared'
              : 'client.updated',
          entityType: 'company',
          entityId: id,
          summary: `Updated ${String(before['name'])}`,
          before,
          after: body,
          requestId: req.id,
          ipAddress: clientIp(req),
        });

        return client;
      });
    },
  );

  // ---------------------------------------------------------------------------
  // Filing a permit
  // ---------------------------------------------------------------------------

  /**
   * File a permit.
   *
   * Two refusals here are the point of the route, and both answer with the
   * exact thing to go and fix rather than a bare "no":
   *
   *   not_cleared_to_file      the contractor's own paperwork does not stand up
   *   supervision_not_defensible   the managed licence has nobody behind it
   *
   * The screen reads `details` and lists the gaps, so a coordinator can act on
   * the refusal instead of guessing at it. That is why they are structured
   * codes and not messages.
   */
  app.post(
    '/api/permits',
    { preHandler: [requireApiAuth, requireCapability('permit:create')] },
    async (req, reply) => {
      const auth = req.apiAuth!;
      const body = parse(
        z.object({
          projectId: z.string().uuid(),
          permitType: z.string().min(1).max(60),
          serviceLine: z.enum(['EXPEDITING', 'MANAGED_LICENSE']).optional(),
          agencyRecordId: z.string().max(120).nullable().optional(),
          qualifyingAgentId: z.string().uuid().nullable().optional(),
          supervisorUserId: z.string().uuid().nullable().optional(),
          scopeOfWork: z.string().max(4000).nullable().optional(),
        }),
        req.body,
        'permit',
      );

      const permit = await scoped(req, async (tx, companyId) => {
        const project = await tx.one<{
          id: string; company_id: string; municipality_id: string | null;
        }>(
          `select id, company_id, municipality_id from ocs.projects
            where id = $1 and deleted_at is null
              and ($2::uuid is null or company_id = $2::uuid)`,
          [body.projectId, companyId],
        );
        if (!project) throw notFound('Project');

        const client = await tx.one<{
          id: string; name: string; service_line: string;
          filing_hold: boolean; filing_hold_reason: string | null;
        }>(
          `select id, name, service_line::text as service_line,
                  filing_hold, filing_hold_reason
             from ocs.companies where id = $1 and deleted_at is null`,
          [project.company_id],
        );
        if (!client) throw notFound('Contractor');

        // A hold is a decision already taken. It outranks the paperwork check
        // below, and says who to talk to rather than what to upload.
        if (client.filing_hold) {
          throw new AppError(409, 'filing_hold',
            `${client.name} is on filing hold: ${client.filing_hold_reason}`,
            { details: { reason: client.filing_hold_reason } });
        }

        const items = await tx.many<ComplianceItem & { decision: string }>(
          `select c.id, c.company_id as "clientId", c.kind::text as kind,
                  c.carrier, c.policy_number as "policyNumber",
                  c.limit_per_occurrence_cents as "limitPerOccurrenceCents",
                  c.limit_aggregate_cents as "limitAggregateCents",
                  c.effective_date as "effectiveDate",
                  c.expires_at as "expiresAt",
                  c.document_id as "documentId",
                  c.decision::text as decision
             from ocs.compliance_items c
            where c.company_id = $1`,
          [client.id],
        );

        // The stored decision is not the status: an accepted certificate that
        // has since expired is not valid, and assessCompliance works that out
        // from the expiry date. This only translates the decision.
        const verdict = assessCompliance(
          items.map((i) => ({
            ...i,
            status: DECISION_TO_STATUS[i.decision] ?? 'PENDING_REVIEW',
          })) as never,
        );

        if (!verdict.clearedToFile) {
          const blockingGaps = verdict.gaps.filter((g) => g.blocksFiling);
          throw new AppError(409, 'not_cleared_to_file',
            `${client.name} is not cleared to file: ` +
              blockingGaps.map((g) => g.label).join(', '),
            { details: { blockingGaps } });
        }

        const line = body.serviceLine ?? client.service_line;

        /*
         * On the managed line our licence goes on the permit and we become the
         * contractor of record. Filing one with nobody named is not an
         * administrative omission -- it is a filing we could not defend.
         */
        if (line === 'MANAGED_LICENSE') {
          const gaps: Array<{ kind: string; detail: string }> = [];
          if (!body.qualifyingAgentId) {
            gaps.push({
              kind: 'NO_QUALIFIER',
              detail: 'No qualifying agent named. Our licence cannot go on a permit without saying whose it is.',
            });
          } else {
            const licence = await tx.one<{
              qualifier_name: string; expires_on: string | null; status: string;
              max_active: number; active_count: number;
            }>(
              `select l.qualifier_name, l.expires_on, l.status::text as status,
                      l.max_active_engagements as max_active,
                      (select count(*)::int from ocs.supervision_engagements e
                        where e.service_license_id = l.id and e.status = 'active') as active_count
                 from ocs.service_licenses l
                where l.id = $1 and l.deleted_at is null`,
              [body.qualifyingAgentId],
            );
            if (!licence) throw notFound('Qualifying agent');
            if (licence.status !== 'active') {
              gaps.push({ kind: 'LICENCE_INACTIVE', detail: `${licence.qualifier_name}'s licence is not active.` });
            }
            // pg hands back a `date` as a JS Date, whose default string form
            // is "Thu Jul 23 2026 00:00:00 GMT+0000 (Coordinated Universal
            // Time)" — a timestamp with a timezone, for a value that has
            // neither. The date alone is what expired.
            const expiresOn = licence.expires_on
              ? new Date(licence.expires_on).toISOString().slice(0, 10)
              : null;
            if (expiresOn && Date.parse(expiresOn) < Date.now()) {
              gaps.push({
                kind: 'LICENCE_EXPIRED',
                detail: `${licence.qualifier_name}'s licence expired on ${expiresOn}.`,
              });
            }
            if (licence.active_count >= licence.max_active) {
              gaps.push({
                kind: 'AT_CAPACITY',
                detail:
                  `${licence.qualifier_name} is already on ${licence.active_count} active engagements, ` +
                  `at the cap of ${licence.max_active}. Florida expects real supervisory control.`,
              });
            }
          }
          if (!body.supervisorUserId) {
            gaps.push({
              kind: 'NO_SUPERVISOR',
              detail: 'No supervisor assigned. Somebody has to be walking the job.',
            });
          }

          if (gaps.length > 0) {
            throw new AppError(409, 'supervision_not_defensible',
              'This permit cannot be filed under our licence yet.',
              { details: { gaps } });
          }
        }

        const row = await tx.one<Record<string, unknown>>(
          `insert into ocs.permits
             (company_id, project_id, municipality_id, permit_number, permit_type,
              status, scope_of_work, created_by)
           values ($1, $2, $3, $4, $5, 'draft', $6, $7)
           returning ${PERMIT_SELECT.replace(/p\./g, '')}`,
          [
            client.id,
            project.id,
            project.municipality_id,
            body.agencyRecordId ?? null,
            body.permitType,
            body.scopeOfWork ?? null,
            auth.userId,
          ],
        );

        await writeAudit(tx, {
          actorUserId: auth.userId,
          actorEmail: auth.email,
          action: 'permit.created',
          entityType: 'permit',
          entityId: String(row!['id']),
          summary: `Filed ${body.permitType} for ${client.name}`,
          after: { ...body, serviceLine: line },
          requestId: req.id,
          ipAddress: clientIp(req),
        });

        return {
          ...row!,
          stage: toStage(row!['status'] as string),
          trade: toTrade(body.permitType),
          serviceLine: line,
          correctionCycles: 0,
          daysInStage: 0,
        };
      });

      reply.code(201);
      return { permit };
    },
  );

  // ---------------------------------------------------------------------------
  // Qualifying agents
  // ---------------------------------------------------------------------------

  /**
   * Whose licence can go on a managed-licence permit.
   *
   * Read from `service_licenses`, not from the contractor's own `qualifiers`
   * table — on this service line it is OUR licence on the permit, which is what
   * makes us the contractor of record. The two tables answer different
   * questions and confusing them would put the wrong name on a filing.
   *
   * `activePermits` against `maxConcurrentPermits` is not bookkeeping. Florida
   * expects a qualifier to exercise real supervisory control, and a licence on
   * two hundred simultaneous jobs makes that claim indefensible — so the count
   * is surfaced next to the cap at the moment somebody is choosing.
   */
  app.get(
    '/api/supervision/qualifiers',
    { preHandler: [requireApiAuth, requireCapability('supervision:read')] },
    async (req) => {
      return scoped(req, async (tx) => {
        const rows = await tx.many<{
          maxConcurrentPermits: number | null;
          activePermits: number;
          [k: string]: unknown;
        }>(
          `select l.id,
                  l.qualifier_name as name,
                  l.license_number as "licenseNumber",
                  l.license_type::text as "licenseType",
                  l.expires_on as "licenseExpiresAt",
                  l.qualifier_user_id as "userId",
                  (l.status = 'active' and l.deleted_at is null) as active,
                  l.max_active_engagements as "maxConcurrentPermits",
                  t.name as "tradeName",
                  -- ::int because count() is bigint, which node-pg returns as a
                  -- string; compared against a numeric cap that silently misreads.
                  (select count(*)::int from ocs.supervision_engagements e
                    where e.service_license_id = l.id
                      and e.status = 'active') as "activePermits"
             from ocs.service_licenses l
             left join ocs.trades t on t.id = l.trade_id
            where l.deleted_at is null
            order by (l.status = 'active') desc, l.qualifier_name
            limit 500`,
        );

        const qualifiers = rows.map((r) => ({
          ...r,
          overCapacity:
            r.maxConcurrentPermits != null && r.activePermits > r.maxConcurrentPermits,
        }));

        return { qualifiers, total: qualifiers.length };
      });
    },
  );
}

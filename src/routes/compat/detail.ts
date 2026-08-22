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
import { badRequest, notFound } from '../../lib/errors.js';
import {
  PERMIT_STAGES, toStage, fromStage, toTrade, assessRisk, daysInStage,
  toPlatformLabel, toIntegrationTier, toInspectionResult,
} from './mapping.js';
import { toDetectedStatus } from '../../services/municipalities/accela/mapping.js';
import { buildRequirements } from '../../shared/requirements.js';
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
   * Several fields the Client type declares have no column yet — service line,
   * onboarding status, filing hold. They are returned as explicit nulls and
   * defaults rather than omitted, so the page renders instead of throwing on a
   * missing key, and so it is obvious from the response which facts this
   * system does not yet record.
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
            serviceLine: 'EXPEDITING',
            licenseType: null,
            licenseExpiresAt: null,
            onboardingStatus: row['status'] === 'active' ? 'ACTIVE' : 'IN_PROGRESS',
            onboardingCompletedAt: null,
            filingHold: false,
            filingHoldReason: null,
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

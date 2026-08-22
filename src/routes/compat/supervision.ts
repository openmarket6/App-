/**
 * /api/supervision — the record that makes a managed licence defensible.
 *
 * This is the part of the product the business is actually selling. A
 * contractor works under this firm's licence, and the only thing standing
 * between that arrangement and an unlicensed-contracting problem is evidence
 * that somebody qualified was genuinely supervising: named, present, on dates,
 * with photographs.
 *
 * So the verdict -- whether the record supports the licence being on a permit
 * -- is not computed here. It comes from assessSupervision in src/shared, the
 * same function the screen calls, because a server and a screen disagreeing
 * about whether supervision is defensible is precisely the disagreement nobody
 * can afford.
 *
 * The endpoints existed under /v1/*, which authenticates SUPABASE tokens. The
 * application signs in natively, so a supervisor standing on a roof could not
 * reach any of them.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant, withServiceContext, type Tx } from '../../db/tenant.js';
import { requireApiAuth, requireCapability } from './auth.js';
import { parse, clientIp, userAgent } from '../../lib/http-helpers.js';
import { writeAudit } from '../../lib/audit.js';
import { notFound, badRequest, forbidden, conflict } from '../../lib/errors.js';
import {
  assessSupervision, SITE_VISIT_PURPOSES, SITE_VISIT_PURPOSE_LABELS,
  type SiteVisit,
} from '../../shared/supervision.js';

/** Stored milestone codes carry more detail than the frontend's purposes. */
const TO_PURPOSE: Record<string, string> = {
  pre_construction: 'PRE_CONSTRUCTION',
  progress: 'PROGRESS',
  pre_inspection: 'PRE_INSPECTION',
  inspection: 'INSPECTION_ATTENDANCE',
  corrective: 'CORRECTIVE',
  final: 'FINAL',
};

const purposeOf = (milestoneCode: string | null): string =>
  TO_PURPOSE[(milestoneCode ?? '').toLowerCase()] ?? 'PROGRESS';

async function scoped<T>(
  req: FastifyRequest,
  fn: (tx: Tx, companyId: string | null) => Promise<T>,
  requestedClientId?: string | null,
): Promise<T> {
  const auth = req.apiAuth!;
  if (auth.role === 'CLIENT') {
    if (!auth.clientId) throw forbidden('This account is not linked to a contractor company');
    return withTenant(
      { companyId: auth.clientId, userId: auth.userId, platformRole: 'none', requestId: req.id },
      (tx) => fn(tx, auth.clientId),
    );
  }
  if (auth.role === 'PENDING') {
    throw forbidden('This account is awaiting authorization from an administrator');
  }
  return withServiceContext((tx) => fn(tx, requestedClientId ?? null), {
    reason: `supervision_${auth.role}`,
    ...(requestedClientId ? { companyId: requestedClientId } : {}),
  });
}

const VISIT_SELECT = `
  v.id,
  v.company_id as "clientId",
  e.permit_id as "permitId",
  p.project_id as "projectId",
  v.supervisor_id as "supervisorUserId",
  v.milestone_code as "milestoneCode",
  v.milestone_name as "milestoneName",
  v.status::text as status,
  v.is_mandatory as "isMandatory",
  v.scheduled_for as "scheduledFor",
  v.checked_in_at as "checkedInAt",
  v.check_in_latitude as "lat",
  v.check_in_longitude as "lng",
  v.distance_from_site_meters as "distanceM",
  v.checked_out_at as "checkedOutAt",
  v.findings,
  v.work_approved as "workApproved",
  v.corrections_required as "correctionsRequired",
  v.signed_off_at as "signedOffAt",
  v.signed_off_by as "signedOffBy",
  v.required_photo_count as "requiredPhotoCount",
  v.photo_count as "photoCount",
  v.created_at as "createdAt"
`;

const VISIT_FROM = `
  from ocs.supervision_visits v
  join ocs.supervision_engagements e on e.id = v.engagement_id
  left join ocs.permits p on p.id = e.permit_id
`;

interface VisitRow {
  id: string; clientId: string; permitId: string | null; projectId: string | null;
  supervisorUserId: string | null; milestoneCode: string | null;
  checkedInAt: string | null; lat: number | null; lng: number | null;
  findings: string | null; photoCount: number; requiredPhotoCount: number;
  [k: string]: unknown;
}

/** The frontend's SiteVisit, from our richer row. */
function toSiteVisit(row: VisitRow): SiteVisit {
  return {
    id: row.id,
    permitId: row.permitId ?? '',
    projectId: row.projectId ?? '',
    clientId: row.clientId,
    supervisorUserId: row.supervisorUserId ?? '',
    purpose: purposeOf(row.milestoneCode) as SiteVisit['purpose'],
    occurredAt: (row.checkedInAt ?? row['scheduledFor'] ?? row['createdAt']) as string,
    recordedAt: row['createdAt'] as string,
    location: row.lat != null && row.lng != null
      ? { lat: row.lat, lng: row.lng, accuracyM: null }
      : null,
    observations: row.findings ?? '',
    directionGiven: (row['correctionsRequired'] as string | null) ?? null,
    photoDocumentIds: [],
    amendedAt: null,
    amendedBy: null,
    amendmentReason: null,
  };
}

/**
 * The supervisor record for the signed-in person.
 *
 * `supervision_visits.supervisor_id` points at ocs.supervisors, NOT at
 * app_users -- a supervisor is a person with trades they are competent in, a
 * service area and a daily capacity, and that is a different thing from a login.
 *
 * I got this wrong first time and compared a visit's supervisor_id against a
 * user id. It did not error; it silently compared two unrelated identifiers and
 * would have let anyone with the capability check in against anybody's visit,
 * which is the one thing the whole record must not allow.
 */
async function supervisorIdFor(tx: Tx, userId: string): Promise<string | null> {
  const row = await tx.one<{ id: string }>(
    `select id from ocs.supervisors
      where user_id = $1 and is_active and deleted_at is null`,
    [userId],
  );
  return row?.id ?? null;
}

export async function compatSupervisionRoutes(app: FastifyInstance): Promise<void> {
  /** Overview: what is scheduled, what is overdue, what has no photographs. */
  app.get(
    '/api/supervision',
    { preHandler: [requireApiAuth, requireCapability('supervision:read')] },
    async (req) => {
      const q = parse(z.object({ clientId: z.string().uuid().optional() }), req.query, 'query');

      return scoped(
        req,
        async (tx, companyId) => {
          const rows = await tx.many<VisitRow>(
            `select ${VISIT_SELECT} ${VISIT_FROM}
              where ($1::uuid is null or v.company_id = $1::uuid)
              order by v.scheduled_for desc nulls last
              limit 500`,
            [companyId],
          );

          const now = Date.now();
          const overdue = rows.filter((r) => {
            const due = r['scheduledFor'] as string | null;
            return r['status'] === 'scheduled' && due && Date.parse(due) < now;
          });

          /**
           * A completed visit with fewer photographs than required is the gap
           * that matters most here: it is the one that looks fine in a list and
           * falls apart the moment anybody asks to see the evidence.
           */
          const thin = rows.filter(
            (r) => r['status'] === 'completed' && r.photoCount < r.requiredPhotoCount,
          );

          return {
            visits: rows.map(toSiteVisit),
            total: rows.length,
            scheduledCount: rows.filter((r) => r['status'] === 'scheduled').length,
            overdueCount: overdue.length,
            thinPhotoRecordCount: thin.length,
            purposes: SITE_VISIT_PURPOSES.map((p) => ({
              value: p, label: SITE_VISIT_PURPOSE_LABELS[p],
            })),
          };
        },
        q.clientId ?? null,
      );
    },
  );

  /**
   * Does the supervision record support the licence being on this permit?
   *
   * The question the whole area exists to answer, and the one somebody will ask
   * under oath. Computed by the shared function so the answer here and the
   * answer on screen cannot differ.
   */
  app.get(
    '/api/supervision/verdict/:permitId',
    { preHandler: [requireApiAuth, requireCapability('supervision:read')] },
    async (req) => {
      const { permitId } = parse(
        z.object({ permitId: z.string().uuid() }), req.params, 'parameters',
      );

      return scoped(req, async (tx, companyId) => {
        const permit = await tx.one<{ id: string; status: string; company_id: string }>(
          `select id, status::text as status, company_id from ocs.permits
            where id = $1 and deleted_at is null
              and ($2::uuid is null or company_id = $2::uuid)`,
          [permitId, companyId],
        );
        if (!permit) throw notFound('Permit');

        const rows = await tx.many<VisitRow>(
          `select ${VISIT_SELECT} ${VISIT_FROM}
            where e.permit_id = $1 and v.status = 'completed'`,
          [permitId],
        );

        const engagement = await tx.one<{
          supervisor_id: string | null; license_expires_on: string | null;
          max_active: number | null; active_count: string;
        }>(
          `select e.supervisor_id,
                  l.expires_on as license_expires_on,
                  q.max_active_engagements as max_active,
                  (select count(*) from ocs.supervision_engagements e2
                    where e2.qualifier_id = e.qualifier_id and e2.status = 'active')::text as active_count
             from ocs.supervision_engagements e
             left join ocs.qualifiers q on q.id = e.qualifier_id
             left join ocs.service_licenses l on l.id = e.service_license_id
            where e.permit_id = $1
            order by e.created_at desc limit 1`,
          [permitId],
        );

        const verdict = assessSupervision({
          visits: rows.map(toSiteVisit),
          supervisorUserId: engagement?.supervisor_id ?? null,
          qualifier: engagement
            ? {
                licenseExpiresAt: engagement.license_expires_on,
                maxConcurrentPermits: engagement.max_active,
              }
            : null,
          qualifierActivePermits: Number(engagement?.active_count ?? 0),
          stage: permit.status.toUpperCase(),
        });

        return { permitId, ...verdict };
      });
    },
  );

  /** One visit, with its photographs. */
  app.get(
    '/api/supervision/visits/:id',
    { preHandler: [requireApiAuth, requireCapability('supervision:read')] },
    async (req) => {
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');

      return scoped(req, async (tx, companyId) => {
        const row = await tx.one<VisitRow>(
          `select ${VISIT_SELECT} ${VISIT_FROM}
            where v.id = $1 and ($2::uuid is null or v.company_id = $2::uuid)`,
          [id, companyId],
        );
        if (!row) throw notFound('Site visit');

        const photos = await tx.many(
          `select ph.id, ph.document_id as "documentId", ph.photo_type as "photoType",
                  ph.caption, ph.taken_at as "takenAt", ph.latitude as lat,
                  ph.longitude as lng, ph.distance_from_site_meters as "distanceM"
             from ocs.supervision_visit_photos ph
            where ph.visit_id = $1
            order by ph.sequence, ph.created_at`,
          [id],
        );

        return {
          ...toSiteVisit(row),
          milestoneName: row['milestoneName'],
          status: row['status'],
          isMandatory: row['isMandatory'],
          requiredPhotoCount: row.requiredPhotoCount,
          photoCount: row.photoCount,
          photos,
        };
      });
    },
  );

  /**
   * The supervisor's own list.
   *
   * Ordered by what to do next: overdue first, then today, then upcoming. A
   * list ordered by creation date is a list that quietly misses a mandatory
   * visit, and a missed mandatory visit is a hole in the evidence.
   */
  app.get(
    '/api/supervision/my-visits',
    { preHandler: [requireApiAuth, requireCapability('supervision:read')] },
    async (req) => {
      const auth = req.apiAuth!;

      return withServiceContext(
        async (tx) => {
          const supervisorId = await supervisorIdFor(tx, auth.userId);
          if (!supervisorId) {
            /*
             * A login with the supervisor role but no supervisor record is a
             * half-finished setup, and returning an empty list would let it
             * look like a quiet day rather than a missing record.
             */
            return {
              visits: [],
              total: 0,
              overdueCount: 0,
              note:
                'This account is not linked to a supervisor record yet, so it has no ' +
                'visits assigned. An administrator needs to finish the setup.',
            };
          }

          const rows = await tx.many<VisitRow>(
            `select ${VISIT_SELECT},
                    pr.address_line1 as "siteAddress", pr.city as "siteCity",
                    co.name as "contractorName",
                    (v.scheduled_for is not null and v.scheduled_for < now()
                     and v.status = 'scheduled') as overdue
               ${VISIT_FROM}
               left join ocs.projects pr on pr.id = p.project_id
               left join ocs.companies co on co.id = v.company_id
              where v.supervisor_id = $1
                and v.status in ('scheduled', 'in_progress')
              order by
                (v.scheduled_for is not null and v.scheduled_for < now()) desc,
                v.scheduled_for asc nulls last
              limit 200`,
            [supervisorId],
          );

          return {
            visits: rows,
            total: rows.length,
            overdueCount: rows.filter((r) => r['overdue'] === true).length,
          };
        },
        { reason: 'supervisor_queue' },
      );
    },
  );

  /**
   * Arrive on site.
   *
   * The location is recorded as the browser gave it, including its accuracy,
   * and a missing one does NOT block the check-in. Plenty of phones decline,
   * and a supervisor standing on a roof with no signal is still standing on
   * the roof. Refusing them would teach people to stop logging visits, which
   * costs far more evidence than an occasional missing coordinate.
   */
  app.post(
    '/api/supervision/visits/:id/check-in',
    { preHandler: [requireApiAuth, requireCapability('supervision:log')] },
    async (req) => {
      const auth = req.apiAuth!;
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
      const body = parse(
        z.object({
          lat: z.number().min(-90).max(90).nullable().optional(),
          lng: z.number().min(-180).max(180).nullable().optional(),
          accuracyM: z.number().min(0).max(100000).nullable().optional(),
        }),
        req.body,
        'check-in',
      );

      return withServiceContext(
        async (tx) => {
          const visit = await tx.one<{
            id: string; company_id: string; status: string; supervisor_id: string | null;
          }>(
            `select id, company_id, status::text as status, supervisor_id
               from ocs.supervision_visits where id = $1 for update`,
            [id],
          );
          if (!visit) throw notFound('Site visit');
          if (visit.status === 'completed') {
            throw conflict('That visit is already signed off');
          }

          /*
           * A visit records who was PHYSICALLY PRESENT, not who typed it in.
           * Letting one person check in against another's visit would make the
           * whole record worthless as evidence of supervision.
           */
          const supervisorId = await supervisorIdFor(tx, auth.userId);
          if (!supervisorId) {
            throw forbidden(
              'This account is not linked to a supervisor record, so it cannot check in ' +
                'to a site visit. An administrator needs to finish the setup.',
            );
          }
          if (visit.supervisor_id && visit.supervisor_id !== supervisorId) {
            throw forbidden(
              'This visit is assigned to a different supervisor. A visit records who ' +
                'was actually on site, so it cannot be checked in on their behalf.',
            );
          }

          await tx.query(
            `update ocs.supervision_visits
                set status = 'in_progress',
                    checked_in_at = coalesce(checked_in_at, now()),
                    supervisor_id = coalesce(supervisor_id, $2),
                    check_in_latitude = coalesce($3, check_in_latitude),
                    check_in_longitude = coalesce($4, check_in_longitude)
              where id = $1`,
            [id, supervisorId, body.lat ?? null, body.lng ?? null],
          );

          await writeAudit(tx, {
            companyId: visit.company_id,
            actorUserId: auth.userId,
            actorEmail: auth.email,
            action: 'supervision.checked_in',
            entityType: 'supervision_visit',
            entityId: id,
            summary: body.lat != null ? 'Checked in with location' : 'Checked in without location',
            after: { lat: body.lat ?? null, lng: body.lng ?? null, accuracyM: body.accuracyM ?? null },
            requestId: req.id,
            ipAddress: clientIp(req),
            userAgent: userAgent(req),
          });

          const row = await tx.one<VisitRow>(
            `select ${VISIT_SELECT} ${VISIT_FROM} where v.id = $1`, [id],
          );
          return {
            ...toSiteVisit(row!),
            status: row!['status'],
            locationRecorded: body.lat != null,
            note: body.lat == null
              ? 'No location came from the device. The visit is logged; nothing else changes.'
              : null,
          };
        },
        { reason: 'supervision_check_in' },
      );
    },
  );

  /**
   * Sign off.
   *
   * Refused while the visit has fewer photographs than it requires. That rule
   * lives in a database trigger (0013) as well, and this endpoint exists to
   * turn its refusal into a sentence rather than a 500 -- but the trigger is
   * what makes it true, because a photograph minimum enforced only in a route
   * is a minimum that lasts until the next route.
   */
  app.post(
    '/api/supervision/visits/:id/sign-off',
    { preHandler: [requireApiAuth, requireCapability('supervision:log')] },
    async (req) => {
      const auth = req.apiAuth!;
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
      const body = parse(
        z.object({
          findings: z.string().trim().min(1).max(8000),
          workApproved: z.boolean(),
          correctionsRequired: z.string().trim().max(8000).nullable().optional(),
          signatureName: z.string().trim().min(1).max(200),
        }),
        req.body,
        'sign-off',
      );

      /*
       * Saying the work is not approved without saying what is wrong leaves the
       * trades on site with nothing to act on, and leaves the record unable to
       * show that direction was actually given.
       */
      if (!body.workApproved && !body.correctionsRequired) {
        throw badRequest(
          'If the work is not approved, say what has to change. A refusal with no ' +
            'direction leaves the crew guessing and leaves the record unable to show ' +
            'that supervision happened.',
        );
      }

      return withServiceContext(
        async (tx) => {
          const visit = await tx.one<{
            id: string; company_id: string; status: string; supervisor_id: string | null;
            photo_count: number; required_photo_count: number;
          }>(
            `select id, company_id, status::text as status, supervisor_id,
                    photo_count, required_photo_count
               from ocs.supervision_visits where id = $1 for update`,
            [id],
          );
          if (!visit) throw notFound('Site visit');
          if (visit.status === 'completed') throw conflict('That visit is already signed off');
          const supervisorId = await supervisorIdFor(tx, auth.userId);
          if (visit.supervisor_id && visit.supervisor_id !== supervisorId) {
            throw forbidden('This visit is assigned to a different supervisor');
          }

          if (visit.photo_count < visit.required_photo_count) {
            throw badRequest(
              `This visit needs ${visit.required_photo_count} photographs and has ` +
                `${visit.photo_count}. A signed-off visit with no photographic record ` +
                'is not evidence of supervision — it is a claim that somebody was there.',
            );
          }

          try {
            await tx.query(
              `update ocs.supervision_visits
                  set status = 'completed',
                      checked_out_at = now(),
                      findings = $2,
                      work_approved = $3,
                      corrections_required = $4,
                      signed_off_at = now(),
                      signed_off_by = $5,
                      signature_name = $6
                where id = $1`,
              [
                id, body.findings, body.workApproved,
                body.correctionsRequired ?? null, auth.userId, body.signatureName,
              ],
            );
          } catch (err) {
            const message = String((err as { message?: string })?.message ?? '');
            if (/photo/i.test(message)) {
              throw badRequest(
                'This visit cannot be signed off until its required photographs are uploaded.',
              );
            }
            throw err;
          }

          await writeAudit(tx, {
            companyId: visit.company_id,
            actorUserId: auth.userId,
            actorEmail: auth.email,
            action: 'supervision.signed_off',
            entityType: 'supervision_visit',
            entityId: id,
            summary: body.workApproved
              ? `Visit signed off by ${body.signatureName}: work approved`
              : `Visit signed off by ${body.signatureName}: corrections required`,
            after: {
              workApproved: body.workApproved,
              photoCount: visit.photo_count,
              signatureName: body.signatureName,
            },
            requestId: req.id,
            ipAddress: clientIp(req),
            userAgent: userAgent(req),
          });

          const row = await tx.one<VisitRow>(
            `select ${VISIT_SELECT} ${VISIT_FROM} where v.id = $1`, [id],
          );
          return { ...toSiteVisit(row!), status: row!['status'], photoCount: row!.photoCount };
        },
        { reason: 'supervision_sign_off' },
      );
    },
  );
}

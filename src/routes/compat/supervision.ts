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
import { createHash } from 'node:crypto';
import {
  buildStorageKey, uploadObject, assertAllowedContentType,
} from '../../services/storage.js';
import {
  assessSupervision, SITE_VISIT_PURPOSES, SITE_VISIT_PURPOSE_LABELS,
  type SiteVisit,
} from '../../shared/supervision.js';

/** 20 MB, matching the general photo upload. */
const MAX_PHOTO_BYTES = 20 * 1024 * 1024;

/** Mirrors ocs.visit_photo_type. A type the enum rejects is a 500, not a 400. */
const VISIT_PHOTO_TYPES = [
  'site_overview', 'work_in_progress', 'completed_work', 'defect',
  'materials', 'safety', 'other',
] as const;

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
  v.amended_at as "amendedAt",
  v.amended_by as "amendedBy",
  v.amendment_reason as "amendmentReason",
  coalesce(
    (select array_agg(vp.document_id order by vp.sequence)
       from ocs.supervision_visit_photos vp
      where vp.visit_id = v.id),
    '{}'::uuid[]
  ) as "photoDocumentIds",
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
    photoDocumentIds: (row['photoDocumentIds'] as string[] | null) ?? [],
    amendedAt: (row['amendedAt'] as string | null) ?? null,
    amendedBy: (row['amendedBy'] as string | null) ?? null,
    amendmentReason: (row['amendmentReason'] as string | null) ?? null,
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

  /**
   * The list the Supervision page reads.
   *
   * It lived in compat/api.ts and returned the raw milestone row, whose column
   * names share almost nothing with the SiteVisit the frontend renders -- so
   * every field on the page came out undefined. It belongs here, beside the
   * adapter that already knows how to speak the frontend's shape.
   */
  app.get(
    '/api/supervision/visits',
    { preHandler: [requireApiAuth, requireCapability('supervision:read')] },
    async (req) => {
      const q = parse(
        z.object({
          clientId: z.string().uuid().optional(),
          permitId: z.string().uuid().optional(),
        }),
        req.query,
        'query',
      );

      return scoped(
        req,
        async (tx, companyId) => {
          const rows = await tx.many<VisitRow>(
            `select ${VISIT_SELECT} ${VISIT_FROM}
              where ($1::uuid is null or v.company_id = $1::uuid)
                and ($2::uuid is null or e.permit_id = $2::uuid)
              order by coalesce(v.checked_in_at, v.scheduled_for, v.created_at) desc nulls last
              limit 300`,
            [companyId, q.permitId ?? null],
          );
          const visits = rows.map(toSiteVisit);
          return { visits, total: visits.length };
        },
        q.clientId ?? null,
      );
    },
  );

  /**
   * Log a visit that nobody scheduled.
   *
   * The milestone plan covers the visits a job is known to need. This covers
   * the rest -- the trip made because somebody called -- which is most of the
   * supervision that actually happens and, until now, could not be recorded at
   * all. It is stored as a visit like any other so it lands in the same
   * evidence trail, with a milestone code of its own so it can never collide
   * with a planned milestone (the table makes those unique per engagement) and
   * is_mandatory false so it does not distort what the plan says is required.
   */
  app.post(
    '/api/supervision/visits',
    { preHandler: [requireApiAuth, requireCapability('supervision:log')] },
    async (req, reply) => {
      const auth = req.apiAuth!;
      const body = parse(
        z.object({
          permitId: z.string().uuid(),
          purpose: z.enum(SITE_VISIT_PURPOSES),
          occurredAt: z.string().datetime(),
          observations: z.string().trim().min(1, 'Say what was observed'),
          directionGiven: z.string().trim().nullable().optional(),
          photoDocumentIds: z.array(z.string().uuid()).default([]),
          location: z
            .object({
              lat: z.number().min(-90).max(90),
              lng: z.number().min(-180).max(180),
              accuracyM: z.number().min(0).nullable().optional(),
            })
            .nullable()
            .optional(),
        }),
        req.body,
        'site visit',
      );

      const created = await scoped(req, async (tx, companyId) => {
        const engagement = await tx.one<{ id: string; company_id: string }>(
          `select id, company_id from ocs.supervision_engagements
            where permit_id = $1 and ($2::uuid is null or company_id = $2::uuid)
            order by created_at desc limit 1`,
          [body.permitId, companyId],
        );
        if (!engagement) {
          throw badRequest(
            'That permit has no supervision engagement yet, so there is nothing to attach a visit to.',
          );
        }

        const supervisorId = await supervisorIdFor(tx, auth.userId);

        /*
         * Unique per engagement, and it round-trips: purposeOf reads the
         * leading segment back out, so an ad-hoc visit still reports the
         * purpose the supervisor chose rather than defaulting to PROGRESS.
         */
        const code = `${body.purpose.toLowerCase()}-adhoc-${Date.now().toString(36)}`;

        const row = await tx.one<VisitRow>(
          `insert into ocs.supervision_visits
             (company_id, engagement_id, milestone_code, milestone_name, is_mandatory,
              status, supervisor_id, checked_in_at, check_in_latitude, check_in_longitude,
              findings, corrections_required, signed_off_at, signed_off_by, signature_name)
           values ($1, $2, $3, $4, false, 'completed', $5, $6, $7, $8, $9, $10, now(), $11, $12)
           returning id`,
          [
            engagement.company_id,
            engagement.id,
            code,
            SITE_VISIT_PURPOSE_LABELS[body.purpose],
            supervisorId,
            body.occurredAt,
            body.location?.lat ?? null,
            body.location?.lng ?? null,
            body.observations,
            body.directionGiven?.trim() || null,
            auth.userId,
            auth.email,
          ],
        );

        for (const [i, documentId] of body.photoDocumentIds.entries()) {
          await tx.query(
            `insert into ocs.supervision_visit_photos
               (company_id, visit_id, document_id, sequence)
             values ($1, $2, $3, $4)`,
            [engagement.company_id, row!.id, documentId, i],
          );
        }
        if (body.photoDocumentIds.length) {
          await tx.query(
            `update ocs.supervision_visits set photo_count = $2 where id = $1`,
            [row!.id, body.photoDocumentIds.length],
          );
        }

        await writeAudit(tx, {
          companyId: engagement.company_id,
          actorUserId: auth.userId,
          actorEmail: auth.email,
          action: 'supervision.visit_logged',
          entityType: 'supervision_visit',
          entityId: row!.id,
          summary: `Unscheduled ${SITE_VISIT_PURPOSE_LABELS[body.purpose]} logged`,
          requestId: req.id,
          ipAddress: clientIp(req),
        });

        const full = await tx.one<VisitRow>(
          `select ${VISIT_SELECT} ${VISIT_FROM} where v.id = $1`,
          [row!.id],
        );
        return toSiteVisit(full!);
      });

      reply.code(201);
      return { visit: created };
    },
  );

  /**
   * Amend a visit's narrative.
   *
   * Never silent: the reason and the author are stored on the row, and the
   * page shows them. A site record that can be edited without trace is worth
   * nothing the first time somebody disputes what happened.
   */
  app.patch(
    '/api/supervision/visits/:id',
    { preHandler: [requireApiAuth, requireCapability('supervision:log')] },
    async (req) => {
      const auth = req.apiAuth!;
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
      const body = parse(
        z.object({
          amendmentReason: z.string().trim().min(1, 'Amendments need a reason'),
          observations: z.string().trim().min(1, 'Say what was observed'),
          directionGiven: z.string().trim().nullable().optional(),
        }),
        req.body,
        'amendment',
      );

      return scoped(req, async (tx, companyId) => {
        const existing = await tx.one<{ id: string; company_id: string }>(
          `select id, company_id from ocs.supervision_visits
            where id = $1 and ($2::uuid is null or company_id = $2::uuid)
            for update`,
          [id, companyId],
        );
        if (!existing) throw notFound('Site visit');

        await tx.query(
          `update ocs.supervision_visits
              set findings = $2,
                  corrections_required = $3,
                  amended_at = now(),
                  amended_by = $4,
                  amendment_reason = $5,
                  updated_at = now()
            where id = $1`,
          [id, body.observations, body.directionGiven?.trim() || null, auth.userId, body.amendmentReason],
        );

        await writeAudit(tx, {
          companyId: existing.company_id,
          actorUserId: auth.userId,
          actorEmail: auth.email,
          action: 'supervision.visit_amended',
          entityType: 'supervision_visit',
          entityId: id,
          summary: `Visit narrative amended: ${body.amendmentReason}`,
          requestId: req.id,
          ipAddress: clientIp(req),
        });

        const full = await tx.one<VisitRow>(
          `select ${VISIT_SELECT} ${VISIT_FROM} where v.id = $1`,
          [id],
        );
        return { visit: toSiteVisit(full!) };
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

  /**
   * A photograph, attached to the visit it evidences.
   *
   * This endpoint was missing, and its absence was not cosmetic: nothing
   * created a row in supervision_visit_photos, so `photo_count` stayed at zero
   * on every visit, and the sign-off rule -- which refuses a visit with fewer
   * photographs than it requires -- could never be satisfied. The supervision
   * record the business sells could be started and never finished.
   *
   * Two facts are kept apart here on purpose. `takenAt` is what the device
   * reported; `uploaded_at` is when it reached us. A large gap between them is
   * exactly the pattern of photographs assembled after the fact rather than
   * taken on site, and one column would hide it.
   *
   * A photo with no location is accepted. A supervisor on a roof with no signal
   * is still on the roof, and refusing them teaches people to stop logging
   * visits -- which costs far more evidence than a missing coordinate.
   */
  app.post(
    '/api/supervision/visits/:id/photos',
    { preHandler: [requireApiAuth, requireCapability('supervision:log')] },
    async (req, reply) => {
      const auth = req.apiAuth!;
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
      const body = parse(
        z.object({
          fileName: z.string().trim().min(1).max(300),
          contentType: z.string().trim().min(1).max(120),
          sizeBytes: z.number().int().min(1).max(MAX_PHOTO_BYTES),
          dataBase64: z.string().min(1),
          photoType: z.enum(VISIT_PHOTO_TYPES).default('work_in_progress'),
          caption: z.string().trim().max(500).nullable().optional(),
          takenAt: z.string().datetime().nullable().optional(),
          lat: z.number().min(-90).max(90).nullable().optional(),
          lng: z.number().min(-180).max(180).nullable().optional(),
        }),
        req.body,
        'photo',
      );

      if (!body.contentType.startsWith('image/')) {
        throw badRequest('That is not an image.');
      }
      assertAllowedContentType(body.contentType);

      const bytes = Buffer.from(body.dataBase64, 'base64');
      if (bytes.byteLength === 0) throw badRequest('The photo came through empty');
      if (bytes.byteLength > MAX_PHOTO_BYTES) {
        throw badRequest('That photo is too large. Around 20 MB is the limit.');
      }
      /*
       * A truncated photograph looks perfectly fine in a list until somebody
       * opens it as evidence, which is the worst possible moment to find out.
       */
      if (Math.abs(bytes.byteLength - body.sizeBytes) > 16) {
        throw badRequest('That photo did not arrive intact — the size does not match. Try again.');
      }

      const result = await withServiceContext(
        async (tx) => {
          const visit = await tx.one<{
            id: string; company_id: string; status: string; supervisor_id: string | null;
            permit_id: string | null; project_id: string | null;
            photo_count: number; required_photo_count: number;
          }>(
            `select v.id, v.company_id, v.status::text as status, v.supervisor_id,
                    e.permit_id, p.project_id, v.photo_count, v.required_photo_count
               ${VISIT_FROM}
              where v.id = $1
              for update of v`,
            [id],
          );
          if (!visit) throw notFound('Site visit');
          if (visit.status === 'completed') {
            throw conflict(
              'That visit is already signed off. Photographs added afterwards would not ' +
                'be part of the record that was signed.',
            );
          }

          const supervisorId = await supervisorIdFor(tx, auth.userId);
          if (!supervisorId) {
            throw forbidden(
              'This account is not linked to a supervisor record. An administrator ' +
                'needs to finish the setup.',
            );
          }
          if (visit.supervisor_id && visit.supervisor_id !== supervisorId) {
            throw forbidden(
              'This visit is assigned to a different supervisor. A visit records who ' +
                'was actually on site.',
            );
          }

          const sha256 = createHash('sha256').update(bytes).digest('hex');

          const doc = await tx.one<{ id: string }>(
            `insert into ocs.documents
               (company_id, permit_id, project_id, name, category,
                captured_at, geo_lat, geo_lng, uploaded_by, version_count,
                is_client_visible)
             values ($1,$2,$3,$4,'photo',$5::timestamptz,$6,$7,$8,1,true)
             returning id`,
            [
              visit.company_id, visit.permit_id, visit.project_id, body.fileName,
              body.takenAt ?? null, body.lat ?? null, body.lng ?? null, auth.userId,
            ],
          );

          const key = buildStorageKey({
            companyId: visit.company_id, documentId: doc!.id,
            versionNumber: 1, fileName: body.fileName,
          });
          const stored = await uploadObject(key, bytes, body.contentType);

          const version = await tx.one<{ id: string }>(
            `insert into ocs.document_versions
               (company_id, document_id, version_number, storage_bucket, storage_key,
                file_name, content_type, byte_size, checksum_sha256, uploaded_by, upload_state)
             values ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,'stored')
             returning id`,
            [
              visit.company_id, doc!.id, stored.bucket, stored.key, body.fileName,
              body.contentType, bytes.byteLength, sha256, auth.userId,
            ],
          );
          await tx.query('update ocs.documents set current_version_id = $2 where id = $1',
            [doc!.id, version!.id]);

          const photo = await tx.one<{ id: string }>(
            `insert into ocs.supervision_visit_photos
               (company_id, visit_id, document_id, photo_type, caption, sequence,
                taken_at, latitude, longitude, uploaded_by)
             values ($1,$2,$3,$4::ocs.visit_photo_type,$5,
                     (select coalesce(max(sequence), 0) + 1
                        from ocs.supervision_visit_photos where visit_id = $2),
                     $6::timestamptz,$7,$8,$9)
             returning id`,
            [
              visit.company_id, id, doc!.id, body.photoType, body.caption ?? null,
              body.takenAt ?? null, body.lat ?? null, body.lng ?? null, auth.userId,
            ],
          );

          await writeAudit(tx, {
            companyId: visit.company_id,
            actorUserId: auth.userId,
            actorEmail: auth.email,
            action: 'supervision.photo_added',
            entityType: 'supervision_visit',
            entityId: id,
            summary: `Photograph added: ${body.photoType}`,
            after: {
              photoId: photo!.id,
              documentId: doc!.id,
              takenAt: body.takenAt ?? null,
              hasLocation: body.lat != null,
              sha256,
            },
            requestId: req.id,
            ipAddress: clientIp(req),
            userAgent: userAgent(req),
          });

          const after = await tx.one<{ photo_count: number; required_photo_count: number }>(
            `select photo_count, required_photo_count from ocs.supervision_visits where id = $1`,
            [id],
          );

          return {
            id: photo!.id,
            documentId: doc!.id,
            photoType: body.photoType,
            takenAt: body.takenAt ?? null,
            lat: body.lat ?? null,
            lng: body.lng ?? null,
            photoCount: after!.photo_count,
            requiredPhotoCount: after!.required_photo_count,
            /*
             * Told plainly, because the supervisor is standing on the site
             * right now and this is the only moment the missing photograph is
             * cheap to take.
             */
            stillNeeded: Math.max(0, after!.required_photo_count - after!.photo_count),
          };
        },
        { reason: 'supervision_photo' },
      );

      reply.code(201);
      return result;
    },
  );

  /**
   * Open a supervision engagement.
   *
   * This existed only at POST /v1/supervision/engagements, which authenticates
   * SUPABASE tokens. The application signs in natively, so that route was
   * unreachable from every screen -- and an engagement is the row a site visit
   * hangs off. No engagement meant no visit could be logged, which meant the
   * supervision record this business sells could not be STARTED, let alone
   * completed. The symptom was one line: "That permit has no supervision
   * engagement yet, so there is nothing to attach a visit to."
   *
   * The trade is required and checked against the licences OCS actually holds.
   * Refusing here, with the reason, beats accepting the job and discovering
   * days later that nobody can qualify it.
   */
  app.post(
    '/api/supervision/engagements',
    { preHandler: [requireApiAuth, requireCapability('supervision:log')] },
    async (req, reply) => {
      const auth = req.apiAuth!;
      const body = parse(
        z.object({
          clientId: z.string().uuid().optional(),
          tradeId: z.string().uuid().optional(),
          /** Accepted instead of tradeId, so a screen can send what it shows. */
          trade: z.string().trim().max(60).optional(),
          projectId: z.string().uuid().nullable().optional(),
          permitId: z.string().uuid().nullable().optional(),
          siteAddress: z.string().trim().max(300).nullable().optional(),
          siteCity: z.string().trim().max(100).nullable().optional(),
          siteCounty: z.string().trim().max(100).nullable().optional(),
          scopeSummary: z.string().trim().max(4000).nullable().optional(),
          estimatedValueCents: z.number().int().min(0).nullable().optional(),
          requestedStartDate: z.string().date().nullable().optional(),
          expectedCompletionDate: z.string().date().nullable().optional(),
        }),
        req.body,
        'engagement',
      );

      const result = await withServiceContext(
        async (tx) => {
          /*
           * The company comes from the work where it can, for the same reason
           * as drafting: a permit or project belongs to exactly one contractor,
           * and a second copy of that answer is a second place to be wrong.
           */
          let companyId = auth.role === 'CLIENT' ? auth.clientId : (body.clientId ?? null);
          if (!companyId && (body.permitId || body.projectId)) {
            const row = body.permitId
              ? await tx.one<{ company_id: string }>(
                  'select company_id from ocs.permits where id = $1 and deleted_at is null',
                  [body.permitId],
                )
              : await tx.one<{ company_id: string }>(
                  'select company_id from ocs.projects where id = $1 and deleted_at is null',
                  [body.projectId],
                );
            companyId = row?.company_id ?? null;
          }
          if (!companyId) {
            throw badRequest(
              'A supervision engagement must belong to a contractor. Give a permitId, ' +
                'a projectId, or a clientId.',
            );
          }

          let tradeId = body.tradeId ?? null;
          if (!tradeId && body.trade) {
            const t = await tx.one<{ id: string }>(
              `select id from ocs.trades
                where upper(code) = upper($1) or upper(name) = upper($1) limit 1`,
              [body.trade],
            );
            tradeId = t?.id ?? null;
          }
          if (!tradeId) {
            throw badRequest('Say which trade this engagement is for.');
          }

          /*
           * Checked against the licences OCS holds, not against the trades that
           * exist. Our licence is what goes on the permit; a trade we cannot
           * qualify is a job we cannot take, and saying so now is far cheaper
           * than saying it after a contractor has scheduled work.
           */
          const licensed = await tx.one<{ n: string }>(
            `select count(*)::text as n from ocs.service_licenses
              where trade_id = $1 and deleted_at is null and status = 'active'
                and (expires_on is null or expires_on >= current_date)`,
            [tradeId],
          );
          if (Number(licensed?.n ?? 0) === 0) {
            throw conflict(
              'One Contractor Solutions does not currently hold an active licence for ' +
                'that trade, so it cannot supervise this job. Register the licence ' +
                'first, or file this permit under the contractor’s own licence.',
            );
          }

          const row = await tx.one<{ id: string; engagement_number: number }>(
            `insert into ocs.supervision_engagements
               (company_id, trade_id, project_id, permit_id, site_address, site_city,
                site_county, scope_summary, estimated_value_cents,
                requested_start_date, expected_completion_date, requested_by, status)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11::date,$12,'requested')
             returning id, engagement_number`,
            [
              companyId, tradeId, body.projectId ?? null, body.permitId ?? null,
              body.siteAddress ?? null, body.siteCity ?? null, body.siteCounty ?? null,
              body.scopeSummary ?? null, body.estimatedValueCents ?? null,
              body.requestedStartDate ?? null, body.expectedCompletionDate ?? null,
              auth.userId,
            ],
          );
          if (!row) throw badRequest('Could not open the engagement.');

          await writeAudit(tx, {
            companyId,
            actorUserId: auth.userId,
            actorEmail: auth.email,
            action: 'supervision.engagement_requested',
            entityType: 'supervision_engagement',
            entityId: row.id,
            summary: `Supervision engagement #${row.engagement_number} opened`,
            after: { tradeId, permitId: body.permitId ?? null, projectId: body.projectId ?? null },
            requestId: req.id,
            ipAddress: clientIp(req),
            userAgent: userAgent(req),
          });

          return {
            id: row.id,
            engagementNumber: row.engagement_number,
            clientId: companyId,
            tradeId,
            projectId: body.projectId ?? null,
            permitId: body.permitId ?? null,
            status: 'requested',
          };
        },
        { reason: 'supervision_open_engagement' },
      );

      reply.code(201);
      return result;
    },
  );
}

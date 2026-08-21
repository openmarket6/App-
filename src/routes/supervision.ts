/**
 * White-glove qualifying and on-site supervision.
 *
 * The endpoint set mirrors the lifecycle in 0012_supervision.sql:
 *
 *   contractor requests ──► OCS quotes ──► contractor accepts terms
 *        ──► OCS activates (assigns license + supervisor, generates the
 *            required visit list from the trade's milestone template)
 *        ──► supervisor checks in / out at each milestone
 *        ──► engagement completes once every mandatory visit is done
 *
 * Activation and completion are guarded by database triggers, not by the checks
 * in this file. The handlers here produce clear error messages; the database is
 * what makes the rules unavoidable.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, principalOf, tenantOf } from '../auth/plugin.js';
import { withTenant, withServiceContext, type Tx } from '../db/tenant.js';
import { requireCompanyRole, requirePlatformRole, requireMfa } from '../auth/rbac.js';
import { parse, clientIp, userAgent, created } from '../lib/http-helpers.js';
import { writeAudit } from '../lib/audit.js';
import { notFound, unprocessable, badRequest, forbidden } from '../lib/errors.js';
import { paginationQuery, decodeCursor, buildPage } from '../lib/pagination.js';
import { notify } from '../services/notifications.js';
import { assessProximity, CHECK_IN_RADIUS_METERS, distanceMeters } from '../domain/geo.js';
import {
  buildStorageKey, createSignedUploadUrl, createSignedDownloadUrl,
  headObject, assertAllowedContentType, sanitizeFileName,
} from '../services/storage.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

const ENGAGEMENT_COLUMNS = `
  id, company_id, engagement_number, project_id, permit_id, application_id,
  trade_id, service_license_id, supervisor_id, status::text,
  site_address, site_city, site_county, site_latitude, site_longitude,
  scope_summary, estimated_value_cents::text, requested_start_date,
  expected_completion_date, setup_fee_cents::text, per_visit_fee_cents::text,
  monthly_fee_cents::text, terms_accepted_at, terms_accepted_by,
  activated_at, completed_at, terminated_at, termination_reason,
  requested_by, created_at, updated_at
`;

/** Load an engagement with its visits, incidents and outstanding-work summary. */
async function loadEngagement(tx: Tx, companyId: string, id: string) {
  const engagement = await tx.one<{ id: string; trade_id: string; status: string }>(
    `select e.${ENGAGEMENT_COLUMNS.trim().split(/,\s*/).join(', e.')},
            t.name as trade_name, t.code as trade_code,
            s.display_name as supervisor_name, s.phone as supervisor_phone,
            l.license_number, l.qualifier_name, l.expires_on as license_expires_on
       from ocs.supervision_engagements e
       join ocs.trades t on t.id = e.trade_id
       left join ocs.supervisors s on s.id = e.supervisor_id
       left join ocs.service_licenses l on l.id = e.service_license_id
      where e.id = $1 and e.company_id = $2 and e.deleted_at is null`,
    [id, companyId],
  );
  if (!engagement) throw notFound('Engagement');

  const visits = await tx.many<{ is_mandatory: boolean; status: string; milestone_name: string }>(
    `select v.id, v.milestone_code, v.milestone_name, v.sequence, v.is_mandatory,
            v.status::text, v.scheduled_for, v.checked_in_at, v.checked_out_at,
            v.distance_from_site_meters, v.findings, v.work_approved,
            v.corrections_required, v.signed_off_at, v.signature_name,
            v.waiver_reason, v.photo_count, v.required_photo_count,
            v.required_photo_types, s.display_name as supervisor_name
       from ocs.supervision_visits v
       left join ocs.supervisors s on s.id = v.supervisor_id
      where v.engagement_id = $1
      order by v.sequence, v.milestone_code`,
    [id],
  );

  const incidents = await tx.many(
    `select id, severity, category, description, action_taken,
            resolved_at, resolution_notes, created_at
       from ocs.supervision_incidents
      where engagement_id = $1
      order by created_at desc`,
    [id],
  );

  const outstanding = visits.filter(
    (v) => v.is_mandatory && !['completed', 'waived', 'cancelled'].includes(v.status),
  );

  return {
    ...engagement,
    visits,
    incidents,
    progress: {
      totalVisits: visits.length,
      mandatoryOutstanding: outstanding.length,
      canComplete: outstanding.length === 0 && visits.length > 0,
      outstandingMilestones: outstanding.map((v) => v.milestone_name),
    },
  };
}

export async function supervisionRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------------------
  // Reference: trades, and what OCS can currently qualify
  // ---------------------------------------------------------------------------

  app.get('/v1/trades', { preHandler: authenticate }, async (req) => {
    const ctx = tenantOf(req);
    return withTenant(ctx, async (tx) => ({
      data: await tx.many(
        `select id, code, name, division::text, requires_permit
           from ocs.trades where is_active order by division, name`,
      ),
    }));
  });

  /**
   * Which trades the white-glove service can currently cover.
   *
   * Derived from live licenses, not a static list: a lapsed license removes the
   * trade from the catalogue immediately rather than letting a contractor
   * request something OCS cannot legally qualify.
   */
  app.get('/v1/supervision/catalogue', { preHandler: authenticate }, async (req) => {
    const ctx = tenantOf(req);
    return withTenant(ctx, async (tx) => ({
      data: await tx.many(
        `select t.id as trade_id, t.code, t.name, t.division::text,
                count(l.id)::int as license_count,
                bool_or(l.expires_on is null or l.expires_on >= current_date) as available,
                min(l.expires_on) as earliest_expiry,
                array_remove(array_agg(distinct l.service_counties[1]), null) as sample_counties
           from ocs.trades t
           left join ocs.service_licenses l
                  on l.trade_id = t.id
                 and l.deleted_at is null
                 and l.status = 'active'
          where t.is_active
          group by t.id, t.code, t.name, t.division
          having count(l.id) > 0
          order by t.name`,
      ),
      note:
        'Only trades One Contractor Solutions holds a current license in can be qualified.',
    }));
  });

  // ---------------------------------------------------------------------------
  // Engagements — contractor side
  // ---------------------------------------------------------------------------

  app.get('/v1/supervision/engagements', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'viewer');

    const q = parse(
      paginationQuery.extend({
        status: z
          .enum(['requested','quoted','accepted','active','on_hold','completed','cancelled','terminated'])
          .optional(),
      }),
      req.query,
      'query',
    );
    const cursor = decodeCursor(q.cursor);

    return withTenant(ctx, async (tx) => {
      const rows = await tx.many<{ id: string; created_at: string }>(
        `select e.id, e.engagement_number, e.status::text, e.site_address, e.site_city,
                e.trade_id, t.name as trade_name, e.supervisor_id,
                s.display_name as supervisor_name, e.activated_at, e.completed_at,
                e.created_at,
                (select count(*) from ocs.supervision_visits v
                  where v.engagement_id = e.id and v.is_mandatory
                    and v.status not in ('completed','waived','cancelled'))::int
                  as outstanding_visits
           from ocs.supervision_engagements e
           join ocs.trades t on t.id = e.trade_id
           left join ocs.supervisors s on s.id = e.supervisor_id
          where e.company_id = $1
            and e.deleted_at is null
            and ($2::ocs.engagement_status is null or e.status = $2::ocs.engagement_status)
            and ($3::timestamptz is null
                 or (e.created_at, e.id) < ($3::timestamptz, $4::uuid))
          order by e.created_at desc, e.id desc
          limit $5`,
        [ctx.companyId, q.status ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, q.limit + 1],
      );
      return buildPage(rows, q.limit);
    });
  });

  app.get('/v1/supervision/engagements/:id', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'viewer');
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
    return withTenant(ctx, (tx) => loadEngagement(tx, ctx.companyId, id));
  });

  /** A contractor requests the white-glove service for a job. */
  app.post('/v1/supervision/engagements', { preHandler: authenticate }, async (req, reply) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'member');

    const body = parse(
      z.object({
        tradeId: z.string().uuid(),
        projectId: z.string().uuid().optional(),
        permitId: z.string().uuid().optional(),
        applicationId: z.string().uuid().optional(),
        siteAddress: z.string().trim().max(300).optional(),
        siteCity: z.string().trim().max(100).optional(),
        siteCounty: z.string().trim().max(100).optional(),
        siteLatitude: z.number().min(-90).max(90).optional(),
        siteLongitude: z.number().min(-180).max(180).optional(),
        scopeSummary: z.string().trim().max(4000).optional(),
        estimatedValue: z.number().nonnegative().max(1e10).optional(),
        requestedStartDate: z.string().date().optional(),
        expectedCompletionDate: z.string().date().optional(),
      }),
      req.body,
      'engagement request',
    );

    const result = await withTenant(ctx, async (tx) => {
      // Refuse a trade OCS cannot currently qualify, with a clear reason --
      // better than accepting the request and rejecting it days later.
      const available = await tx.one<{ n: string }>(
        `select count(*)::text as n from ocs.service_licenses
          where trade_id = $1 and deleted_at is null and status = 'active'
            and (expires_on is null or expires_on >= current_date)`,
        [body.tradeId],
      );
      if (Number(available?.n ?? 0) === 0) {
        throw unprocessable(
          'One Contractor Solutions does not currently hold an active license for that trade',
        );
      }

      const row = await tx.one<{ id: string; engagement_number: number }>(
        `insert into ocs.supervision_engagements
           (company_id, trade_id, project_id, permit_id, application_id,
            site_address, site_city, site_county, site_latitude, site_longitude,
            scope_summary, estimated_value_cents, requested_start_date,
            expected_completion_date, requested_by, status)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'requested')
         returning id, engagement_number`,
        [
          ctx.companyId, body.tradeId, body.projectId ?? null, body.permitId ?? null,
          body.applicationId ?? null, body.siteAddress ?? null, body.siteCity ?? null,
          body.siteCounty ?? null, body.siteLatitude ?? null, body.siteLongitude ?? null,
          body.scopeSummary ?? null,
          body.estimatedValue === undefined ? null : Math.round(body.estimatedValue * 100),
          body.requestedStartDate ?? null, body.expectedCompletionDate ?? null, p.userId,
        ],
      );
      if (!row) throw badRequest('Could not create engagement');

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'supervision.engagement_requested',
        entityType: 'supervision_engagement',
        entityId: row.id,
        summary: `White-glove supervision requested (engagement #${row.engagement_number})`,
        requestId: req.id,
        ipAddress: clientIp(req),
        userAgent: userAgent(req),
      });

      return loadEngagement(tx, ctx.companyId, row.id);
    });

    return created(reply, result);
  });

  /**
   * The contractor accepts the terms.
   *
   * MFA-gated: this is the contractor agreeing that OCS's qualifier directs the
   * permitted work, which carries real legal weight for both parties. It should
   * not be possible with a stolen password alone.
   */
  app.post('/v1/supervision/engagements/:id/accept-terms', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    // Owner or admin only -- a field user cannot bind the company to this.
    requireCompanyRole(p, 'admin');
    requireMfa(p);

    const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
    const body = parse(
      z.object({
        acknowledgement: z.literal(
          'I understand that One Contractor Solutions qualifies and supervises this permitted work.',
        ),
      }),
      req.body,
      'terms acceptance',
    );

    return withTenant(ctx, async (tx) => {
      const row = await tx.one<{ id: string; engagement_number: number }>(
        `update ocs.supervision_engagements
            set terms_accepted_at = now(),
                terms_accepted_by = $3,
                status = case when status in ('requested','quoted')
                              then 'accepted'::ocs.engagement_status else status end
          where id = $1 and company_id = $2 and deleted_at is null
            and terms_accepted_at is null
          returning id, engagement_number`,
        [id, ctx.companyId, p.userId],
      );
      if (!row) throw notFound('Engagement awaiting terms acceptance');

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'supervision.terms_accepted',
        entityType: 'supervision_engagement',
        entityId: id,
        summary: `Terms accepted for engagement #${row.engagement_number}`,
        after: { acknowledgement: body.acknowledgement },
        requestId: req.id,
        ipAddress: clientIp(req),
        userAgent: userAgent(req),
      });

      return loadEngagement(tx, ctx.companyId, id);
    });
  });

  // ---------------------------------------------------------------------------
  // Engagements — OCS staff side
  // ---------------------------------------------------------------------------

  /**
   * Activate: assign the qualifying license and supervisor, and generate the
   * required visit list from the trade's milestone template.
   *
   * The template is COPIED rather than referenced, so later edits to a template
   * never rewrite the requirements of a job already under way. What was
   * required at the time stays on the record.
   */
  app.post('/v1/supervision/engagements/:id/activate', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requirePlatformRole(p, 'admin');
    requireMfa(p);

    const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
    const body = parse(
      z.object({
        serviceLicenseId: z.string().uuid(),
        supervisorId: z.string().uuid(),
        setupFee: z.number().nonnegative().max(1e7).optional(),
        perVisitFee: z.number().nonnegative().max(1e6).optional(),
        monthlyFee: z.number().nonnegative().max(1e6).optional(),
      }),
      req.body,
      'activation',
    );

    return withTenant(ctx, async (tx) => {
      const engagement = await tx.one<{ id: string; trade_id: string; status: string; terms_accepted_at: string | null }>(
        `select id, trade_id, status::text, terms_accepted_at
           from ocs.supervision_engagements
          where id = $1 and company_id = $2 and deleted_at is null
          for update`,
        [id, ctx.companyId],
      );
      if (!engagement) throw notFound('Engagement');
      if (engagement.status === 'active') throw unprocessable('This engagement is already active');
      if (!engagement.terms_accepted_at) {
        throw unprocessable('The contractor has not accepted the service terms yet');
      }

      // The database trigger re-checks license validity, trade match and
      // capacity; a failure surfaces here as a clear message.
      try {
        await tx.query(
          `update ocs.supervision_engagements
              set service_license_id = $3,
                  supervisor_id = $4,
                  setup_fee_cents = coalesce($5, setup_fee_cents),
                  per_visit_fee_cents = coalesce($6, per_visit_fee_cents),
                  monthly_fee_cents = coalesce($7, monthly_fee_cents),
                  status = 'active'
            where id = $1 and company_id = $2`,
          [
            id, ctx.companyId, body.serviceLicenseId, body.supervisorId,
            body.setupFee === undefined ? null : Math.round(body.setupFee * 100),
            body.perVisitFee === undefined ? null : Math.round(body.perVisitFee * 100),
            body.monthlyFee === undefined ? null : Math.round(body.monthlyFee * 100),
          ],
        );
      } catch (err) {
        throw unprocessable((err as Error).message.replace(/^error:\s*/i, ''));
      }

      // Generate the visit list from the template for this trade.
      //
      // The photo requirements are COPIED onto each visit alongside the
      // milestone, for the same reason the milestone itself is: editing a
      // template later must never change what an in-flight job was required to
      // produce.
      await tx.query(
        `insert into ocs.supervision_visits
           (engagement_id, milestone_code, milestone_name, sequence, is_mandatory,
            supervisor_id, status, required_photo_count, required_photo_types)
         select $1, t.code, t.name, t.sequence, t.is_mandatory, $2, 'required',
                t.min_photos, t.required_photo_types
           from ocs.visit_milestone_templates t
          where t.trade_id = $3
         on conflict (engagement_id, milestone_code) do nothing`,
        [id, body.supervisorId, engagement.trade_id],
      );

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'supervision.engagement_activated',
        entityType: 'supervision_engagement',
        entityId: id,
        summary: 'Engagement activated; qualifying license and supervisor assigned',
        after: { serviceLicenseId: body.serviceLicenseId, supervisorId: body.supervisorId },
        requestId: req.id,
      });

      const recipients = await tx.many<{ user_id: string; email: string }>(
        `select m.user_id, u.email from ocs.company_memberships m
           join ocs.app_users u on u.id = m.user_id
          where m.company_id = $1 and m.is_active and u.is_active and u.deleted_at is null`,
        [ctx.companyId],
      );
      for (const r of recipients) {
        await notify(tx, {
          companyId: ctx.companyId,
          userId: r.user_id,
          kind: 'system',
          title: 'Supervision engagement is active',
          body: 'Your supervisor has been assigned and the required site visits are scheduled.',
          entityType: 'supervision_engagement',
          entityId: id,
          linkPath: `/supervision/${id}`,
          email: { to: r.email },
          dedupeKey: `engagement_active:${id}:${r.user_id}`,
        });
      }

      return loadEngagement(tx, ctx.companyId, id);
    });
  });

  app.post('/v1/supervision/engagements/:id/complete', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requirePlatformRole(p, 'staff');

    const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');

    return withTenant(ctx, async (tx) => {
      try {
        const row = await tx.one<{ id: string }>(
          `update ocs.supervision_engagements
              set status = 'completed'
            where id = $1 and company_id = $2 and status = 'active'
            returning id`,
          [id, ctx.companyId],
        );
        if (!row) throw notFound('Active engagement');
      } catch (err) {
        // The completion trigger names exactly which visits are outstanding.
        if (err instanceof Error && /outstanding/.test(err.message)) {
          throw unprocessable(err.message.replace(/^error:\s*/i, ''));
        }
        throw err;
      }

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'supervision.engagement_completed',
        entityType: 'supervision_engagement',
        entityId: id,
        summary: 'Engagement completed; all required supervision visits recorded',
        requestId: req.id,
      });

      return loadEngagement(tx, ctx.companyId, id);
    });
  });

  // ---------------------------------------------------------------------------
  // Visits — the evidence trail
  // ---------------------------------------------------------------------------

  app.post('/v1/supervision/visits/:visitId/schedule', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requirePlatformRole(p, 'staff');

    const { visitId } = parse(z.object({ visitId: z.string().uuid() }), req.params, 'parameters');
    const body = parse(
      z.object({
        scheduledFor: z.string().datetime(),
        supervisorId: z.string().uuid().optional(),
      }),
      req.body,
      'schedule',
    );

    return withTenant(ctx, async (tx) => {
      const row = await tx.one(
        `update ocs.supervision_visits
            set scheduled_for = $3,
                supervisor_id = coalesce($4, supervisor_id),
                status = case when status = 'required' then 'scheduled'::ocs.visit_status
                              else status end
          where id = $1 and company_id = $2
            and status in ('required','scheduled')
          returning id, milestone_name, scheduled_for, status::text, supervisor_id`,
        [visitId, ctx.companyId, body.scheduledFor, body.supervisorId ?? null],
      );
      if (!row) throw notFound('Schedulable visit');
      return row;
    });
  });

  /**
   * Check in at the job site.
   *
   * Records where the supervisor actually was. A check-in outside the radius is
   * ACCEPTED but flagged rather than rejected: GPS is unreliable near steel
   * structures, and blocking an honest supervisor would push them off the app
   * entirely — an evidence trail nobody uses records nothing. The distance is
   * stored either way, so an anomalous check-in stays visible for review.
   */
  app.post('/v1/supervision/visits/:visitId/check-in', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requirePlatformRole(p, 'staff');

    const { visitId } = parse(z.object({ visitId: z.string().uuid() }), req.params, 'parameters');
    const body = parse(
      z.object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
      }),
      req.body,
      'check-in',
    );

    return withTenant(ctx, async (tx) => {
      const visit = await tx.one<{
        id: string; status: string; milestone_name: string;
        site_latitude: string | null; site_longitude: string | null; engagement_id: string;
      }>(
        `select v.id, v.status::text, v.milestone_name, v.engagement_id,
                e.site_latitude, e.site_longitude
           from ocs.supervision_visits v
           join ocs.supervision_engagements e on e.id = v.engagement_id
          where v.id = $1 and v.company_id = $2
          for update of v`,
        [visitId, ctx.companyId],
      );
      if (!visit) throw notFound('Visit');
      if (visit.status === 'completed') throw unprocessable('This visit is already completed');

      const proximity = assessProximity(
        {
          latitude: visit.site_latitude === null ? null : Number(visit.site_latitude),
          longitude: visit.site_longitude === null ? null : Number(visit.site_longitude),
        },
        { latitude: body.latitude, longitude: body.longitude },
      );

      const row = await tx.one(
        `update ocs.supervision_visits
            set checked_in_at = now(),
                check_in_latitude = $3,
                check_in_longitude = $4,
                distance_from_site_meters = $5,
                status = 'in_progress',
                supervisor_id = coalesce(supervisor_id,
                  (select id from ocs.supervisors where user_id = $6))
          where id = $1 and company_id = $2
          returning id, milestone_name, checked_in_at, distance_from_site_meters, status::text`,
        [visitId, ctx.companyId, body.latitude, body.longitude, proximity.distanceMeters, p.userId],
      );

      if (!proximity.unverifiable && !proximity.withinRadius) {
        logger.warn(
          { visitId, distanceMeters: proximity.distanceMeters, actor: p.userId },
          'supervision check-in recorded outside the expected site radius',
        );
      }

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'supervision.visit_check_in',
        entityType: 'supervision_visit',
        entityId: visitId,
        summary: `Checked in for ${visit.milestone_name}`,
        after: {
          distanceMeters: proximity.distanceMeters,
          withinRadius: proximity.withinRadius,
          unverifiable: proximity.unverifiable,
        },
        requestId: req.id,
        ipAddress: clientIp(req),
        userAgent: userAgent(req),
      });

      return {
        ...(row as object),
        proximity: {
          ...proximity,
          radiusMeters: CHECK_IN_RADIUS_METERS,
          warning: proximity.unverifiable
            ? 'The job site has no recorded coordinates, so this check-in could not be verified.'
            : proximity.withinRadius
              ? null
              : `Recorded ${proximity.distanceMeters} m from the job site. This has been flagged for review.`,
        },
      };
    });
  });

  /** Check out and sign off. Both are required for a visit to count as done. */
  app.post('/v1/supervision/visits/:visitId/sign-off', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requirePlatformRole(p, 'staff');

    const { visitId } = parse(z.object({ visitId: z.string().uuid() }), req.params, 'parameters');
    const body = parse(
      z.object({
        findings: z.string().trim().min(1).max(5000),
        workApproved: z.boolean(),
        correctionsRequired: z.string().trim().max(4000).optional(),
        signatureName: z.string().trim().min(1).max(200),
      }),
      req.body,
      'sign-off',
    );

    if (!body.workApproved && !body.correctionsRequired) {
      throw unprocessable(
        'Say what corrections are required when the work is not approved',
      );
    }

    return withTenant(ctx, async (tx) => {
      const visit = await tx.one<{ id: string; status: string; checked_in_at: string | null; milestone_name: string; engagement_id: string }>(
        `select id, status::text, checked_in_at, milestone_name, engagement_id
           from ocs.supervision_visits
          where id = $1 and company_id = $2
          for update`,
        [visitId, ctx.companyId],
      );
      if (!visit) throw notFound('Visit');

      // The database enforces this too; the message here is the useful part.
      if (!visit.checked_in_at) {
        throw unprocessable(
          'You must check in at the job site before signing off on a visit',
        );
      }
      if (visit.status === 'completed') throw unprocessable('This visit is already signed off');

      // The database enforces the photo requirement, but a raw trigger message
      // is a poor thing to hand a supervisor standing on a roof. Check first and
      // say exactly what is still needed.
      const evidence = await tx.one<{
        photo_count: number; required_photo_count: number; required_photo_types: string[];
      }>(
        `select photo_count, required_photo_count, required_photo_types
           from ocs.supervision_visits where id = $1`,
        [visitId],
      );

      if (evidence && evidence.photo_count < evidence.required_photo_count) {
        throw unprocessable(
          `This visit needs ${evidence.required_photo_count} photo(s) before it can be signed off; ` +
            `${evidence.photo_count} uploaded so far.`,
          { photoCount: evidence.photo_count, requiredPhotoCount: evidence.required_photo_count },
        );
      }

      if (evidence && evidence.required_photo_types.length > 0) {
        const present = await tx.many<{ photo_type: string }>(
          `select distinct photo_type::text from ocs.supervision_visit_photos where visit_id = $1`,
          [visitId],
        );
        const have = new Set(present.map((r) => r.photo_type));
        const missing = evidence.required_photo_types.filter((t) => !have.has(t));
        if (missing.length > 0) {
          throw unprocessable(
            `Missing required photo type(s): ${missing.map((m) => m.replace(/_/g, ' ')).join(', ')}`,
            { missingPhotoTypes: missing },
          );
        }
      }

      const row = await tx.one(
        `update ocs.supervision_visits
            set checked_out_at = coalesce(checked_out_at, now()),
                findings = $3,
                work_approved = $4,
                corrections_required = $5,
                signed_off_at = now(),
                signed_off_by = $6,
                signature_name = $7,
                status = 'completed'
          where id = $1 and company_id = $2
          returning id, milestone_name, status::text, work_approved,
                    signed_off_at, signature_name`,
        [
          visitId, ctx.companyId, body.findings, body.workApproved,
          body.correctionsRequired ?? null, p.userId, body.signatureName,
        ],
      );

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'supervision.visit_signed_off',
        entityType: 'supervision_visit',
        entityId: visitId,
        summary: `${visit.milestone_name}: ${body.workApproved ? 'approved' : 'corrections required'}`,
        after: { workApproved: body.workApproved, findings: body.findings },
        requestId: req.id,
        ipAddress: clientIp(req),
        userAgent: userAgent(req),
      });

      if (!body.workApproved) {
        const recipients = await tx.many<{ user_id: string; email: string }>(
          `select m.user_id, u.email from ocs.company_memberships m
             join ocs.app_users u on u.id = m.user_id
            where m.company_id = $1 and m.is_active and u.is_active and u.deleted_at is null`,
          [ctx.companyId],
        );
        for (const r of recipients) {
          await notify(tx, {
            companyId: ctx.companyId,
            userId: r.user_id,
            kind: 'corrections_required',
            title: `Corrections required: ${visit.milestone_name}`,
            body: body.correctionsRequired ?? body.findings,
            entityType: 'supervision_engagement',
            entityId: visit.engagement_id,
            linkPath: `/supervision/${visit.engagement_id}`,
            email: { to: r.email },
          });
        }
      }

      return row;
    });
  });

  /** Waive a milestone that does not apply to this job. Always needs a reason. */
  app.post('/v1/supervision/visits/:visitId/waive', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requirePlatformRole(p, 'admin');

    const { visitId } = parse(z.object({ visitId: z.string().uuid() }), req.params, 'parameters');
    const body = parse(
      z.object({ reason: z.string().trim().min(10).max(1000) }),
      req.body,
      'waiver',
    );

    return withTenant(ctx, async (tx) => {
      const row = await tx.one<{ id: string; milestone_name: string }>(
        `update ocs.supervision_visits
            set status = 'waived', waiver_reason = $3
          where id = $1 and company_id = $2 and status not in ('completed','waived')
          returning id, milestone_name`,
        [visitId, ctx.companyId, body.reason],
      );
      if (!row) throw notFound('Waivable visit');

      // Waiving a mandatory visit is the main way this evidence trail could be
      // hollowed out, so it is audited as a deliberate, attributed decision.
      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'supervision.visit_waived',
        entityType: 'supervision_visit',
        entityId: visitId,
        summary: `Waived ${row.milestone_name}`,
        after: { reason: body.reason },
        requestId: req.id,
        ipAddress: clientIp(req),
        userAgent: userAgent(req),
      });

      return row;
    });
  });

  /** Today's route for the signed-in supervisor. */
  app.get('/v1/supervision/my-visits', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    requirePlatformRole(p, 'staff');

    const q = parse(
      z.object({ days: z.coerce.number().int().min(1).max(30).default(7) }),
      req.query,
      'query',
    );

    return withServiceContext(
      async (tx) => ({
        data: await tx.many(
          `select v.id, v.milestone_name, v.status::text, v.scheduled_for,
                  v.checked_in_at, e.id as engagement_id, e.engagement_number,
                  e.site_address, e.site_city, e.site_latitude, e.site_longitude,
                  c.name as company_name, t.name as trade_name
             from ocs.supervision_visits v
             join ocs.supervision_engagements e on e.id = v.engagement_id
             join ocs.companies c on c.id = e.company_id
             join ocs.trades t on t.id = e.trade_id
             join ocs.supervisors s on s.id = v.supervisor_id
            where s.user_id = $1
              and v.status in ('scheduled','in_progress')
              and (v.scheduled_for is null
                   or v.scheduled_for <= now() + make_interval(days => $2))
            order by v.scheduled_for asc nulls last
            limit 200`,
          [p.userId, q.days],
        ),
      }),
      { reason: 'supervisor_route' },
    );
  });


  // ---------------------------------------------------------------------------
  // Visit photos — the evidence a supervision record actually rests on
  // ---------------------------------------------------------------------------

  /**
   * Start a photo upload for a visit.
   *
   * Creates the document row, the version row and the photo link, then returns
   * a signed URL the phone PUTs the image to directly. The image never passes
   * through this API: a supervisor on a job site is on cellular data with a
   * 5 MB photo, and streaming that through a request worker would be slow for
   * them and expensive for us.
   *
   * The caller sends whatever capture metadata the device has (taken_at, GPS).
   * We record it, and where the job site has coordinates we compute the
   * distance ourselves rather than trusting a supplied one.
   */
  app.post('/v1/supervision/visits/:visitId/photos', { preHandler: authenticate }, async (req, reply) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requirePlatformRole(p, 'staff');

    const { visitId } = parse(z.object({ visitId: z.string().uuid() }), req.params, 'parameters');
    const body = parse(
      z.object({
        fileName: z.string().trim().min(1).max(255),
        contentType: z.string().trim().min(1).max(150),
        byteSize: z.number().int().positive().max(env.MAX_UPLOAD_BYTES),
        photoType: z.enum([
          'site_overview', 'work_in_progress', 'completed_work',
          'defect', 'materials', 'safety', 'other',
        ]).default('work_in_progress'),
        caption: z.string().trim().max(500).optional(),
        takenAt: z.string().datetime().optional(),
        latitude: z.number().min(-90).max(90).optional(),
        longitude: z.number().min(-180).max(180).optional(),
        exif: z.record(z.unknown()).optional(),
      }),
      req.body,
      'photo',
    );

    // Photographs only. Accepting a PDF here would let the count be satisfied
    // by something that is not a photograph of the work.
    if (!body.contentType.toLowerCase().startsWith('image/')) {
      throw badRequest('Visit evidence must be an image');
    }
    assertAllowedContentType(body.contentType);

    const prepared = await withTenant(ctx, async (tx) => {
      const visit = await tx.one<{
        id: string; status: string; milestone_name: string; engagement_id: string;
        site_latitude: string | null; site_longitude: string | null;
      }>(
        `select v.id, v.status::text, v.milestone_name, v.engagement_id,
                e.site_latitude, e.site_longitude
           from ocs.supervision_visits v
           join ocs.supervision_engagements e on e.id = v.engagement_id
          where v.id = $1 and v.company_id = $2`,
        [visitId, ctx.companyId],
      );
      if (!visit) throw notFound('Visit');
      if (visit.status === 'completed') {
        throw unprocessable('This visit is already signed off; photos can no longer be added');
      }

      const document = await tx.one<{ id: string }>(
        `insert into ocs.documents
           (company_id, name, category, description, is_client_visible, uploaded_by)
         values ($1, $2, 'photo', $3, true, $4)
         returning id`,
        [
          ctx.companyId,
          sanitizeFileName(body.fileName),
          `${visit.milestone_name} — ${body.photoType.replace(/_/g, ' ')}`,
          p.userId,
        ],
      );
      if (!document) throw badRequest('Could not create the photo record');

      const storageKey = buildStorageKey({
        companyId: ctx.companyId,
        documentId: document.id,
        versionNumber: 1,
        fileName: body.fileName,
      });

      const version = await tx.one<{ id: string }>(
        `insert into ocs.document_versions
           (company_id, document_id, version_number, storage_bucket, storage_key,
            file_name, content_type, byte_size, metadata, uploaded_by, upload_state)
         values ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,'pending')
         returning id`,
        [
          ctx.companyId, document.id, env.SUPABASE_STORAGE_BUCKET, storageKey,
          sanitizeFileName(body.fileName), body.contentType, body.byteSize,
          JSON.stringify(body.exif ?? {}), p.userId,
        ],
      );
      if (!version) throw badRequest('Could not create the photo version');

      await tx.query(
        `update ocs.documents set current_version_id = $2, version_count = 1 where id = $1`,
        [document.id, version.id],
      );

      // Distance is computed here from the site's own coordinates, not accepted
      // from the client.
      let distance: number | null = null;
      if (
        body.latitude !== undefined && body.longitude !== undefined &&
        visit.site_latitude !== null && visit.site_longitude !== null
      ) {
        distance = distanceMeters(
          { latitude: Number(visit.site_latitude), longitude: Number(visit.site_longitude) },
          { latitude: body.latitude, longitude: body.longitude },
        );
      }

      const photo = await tx.one<{ id: string }>(
        `insert into ocs.supervision_visit_photos
           (visit_id, document_id, photo_type, caption, taken_at,
            latitude, longitude, distance_from_site_meters, exif, uploaded_by,
            sequence)
         values ($1,$2,$3::ocs.visit_photo_type,$4,$5,$6,$7,$8,$9,$10,
                 coalesce((select max(sequence)+1 from ocs.supervision_visit_photos
                            where visit_id = $1), 0))
         returning id`,
        [
          visitId, document.id, body.photoType, body.caption ?? null,
          body.takenAt ?? null, body.latitude ?? null, body.longitude ?? null,
          distance, JSON.stringify(body.exif ?? {}), p.userId,
        ],
      );

      return { photoId: photo?.id ?? null, documentId: document.id, versionId: version.id, storageKey, distance };
    });

    // Signed outside the transaction: an external round trip must not hold a
    // pooled database connection open.
    const signed = await createSignedUploadUrl(prepared.storageKey);

    return created(reply, {
      photoId: prepared.photoId,
      documentId: prepared.documentId,
      versionId: prepared.versionId,
      distanceFromSiteMeters: prepared.distance,
      upload: {
        url: signed.uploadUrl,
        method: 'PUT',
        headers: { 'content-type': body.contentType },
        expiresInSeconds: signed.expiresInSeconds,
      },
      confirmUrl: `/v1/supervision/visits/${visitId}/photos/${prepared.photoId}/confirm`,
    });
  });

  /**
   * Confirm the image landed.
   *
   * Reads the object back from storage for its real size. Until this succeeds
   * the photo row exists but the file may not, so an abandoned upload leaves a
   * pending row rather than a phantom piece of evidence.
   */
  app.post(
    '/v1/supervision/visits/:visitId/photos/:photoId/confirm',
    { preHandler: authenticate },
    async (req) => {
      const p = principalOf(req);
      const ctx = tenantOf(req);
      requirePlatformRole(p, 'staff');

      const params = parse(
        z.object({ visitId: z.string().uuid(), photoId: z.string().uuid() }),
        req.params,
        'parameters',
      );

      const version = await withTenant(ctx, async (tx) =>
        tx.one<{ id: string; storage_key: string; upload_state: string }>(
          `select dv.id, dv.storage_key, dv.upload_state
             from ocs.supervision_visit_photos ph
             join ocs.documents d on d.id = ph.document_id
             join ocs.document_versions dv on dv.id = d.current_version_id
            where ph.id = $1 and ph.visit_id = $2 and ph.company_id = $3`,
          [params.photoId, params.visitId, ctx.companyId],
        ),
      );
      if (!version) throw notFound('Photo');
      if (version.upload_state === 'uploaded') {
        return { photoId: params.photoId, alreadyConfirmed: true };
      }

      const info = await headObject(version.storage_key);
      if (!info) {
        throw unprocessable('No uploaded image was found for this photo');
      }

      return withTenant(ctx, async (tx) => {
        await tx.query(
          `update ocs.document_versions
              set upload_state = 'uploaded', uploaded_at = now(),
                  byte_size = $2, content_type = $3, scan_status = 'skipped'
            where id = $1`,
          [version.id, info.size, info.contentType],
        );

        const counts = await tx.one<{ photo_count: number; required_photo_count: number }>(
          `select photo_count, required_photo_count from ocs.supervision_visits
            where id = $1 and company_id = $2`,
          [params.visitId, ctx.companyId],
        );

        return {
          photoId: params.photoId,
          byteSize: info.size,
          confirmed: true,
          photoCount: counts?.photo_count ?? 0,
          requiredPhotoCount: counts?.required_photo_count ?? 0,
        };
      });
    },
  );

  /** Photos for a visit, each with a fresh short-lived download URL. */
  app.get('/v1/supervision/visits/:visitId/photos', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'viewer');

    const { visitId } = parse(z.object({ visitId: z.string().uuid() }), req.params, 'parameters');

    const photos = await withTenant(ctx, async (tx) =>
      tx.many<{
        id: string; photo_type: string; caption: string | null; taken_at: string | null;
        uploaded_at: string; distance_from_site_meters: number | null;
        storage_key: string; upload_state: string; file_name: string;
      }>(
        `select ph.id, ph.photo_type::text, ph.caption, ph.taken_at, ph.uploaded_at,
                ph.latitude, ph.longitude, ph.distance_from_site_meters, ph.sequence,
                dv.storage_key, dv.upload_state, dv.file_name
           from ocs.supervision_visit_photos ph
           join ocs.documents d on d.id = ph.document_id
           join ocs.document_versions dv on dv.id = d.current_version_id
          where ph.visit_id = $1 and ph.company_id = $2
          order by ph.sequence, ph.created_at`,
        [visitId, ctx.companyId],
      ),
    );

    // URLs are minted per request and expire in minutes, so a link that leaks
    // out of a report is dead before it is useful.
    const withUrls = await Promise.all(
      photos.map(async (photo) => {
        if (photo.upload_state !== 'uploaded') {
          return { ...photo, url: null, pending: true };
        }
        try {
          const signed = await createSignedDownloadUrl(photo.storage_key, { expiresInSeconds: 600 });
          return { ...photo, url: signed.url, pending: false };
        } catch {
          return { ...photo, url: null, pending: false, unavailable: true };
        }
      }),
    );

    return { data: withUrls.map(({ storage_key, ...rest }) => rest) };
  });

  app.delete(
    '/v1/supervision/visits/:visitId/photos/:photoId',
    { preHandler: authenticate },
    async (req) => {
      const p = principalOf(req);
      const ctx = tenantOf(req);
      requirePlatformRole(p, 'staff');

      const params = parse(
        z.object({ visitId: z.string().uuid(), photoId: z.string().uuid() }),
        req.params,
        'parameters',
      );

      return withTenant(ctx, async (tx) => {
        const visit = await tx.one<{ status: string }>(
          `select status::text from ocs.supervision_visits
            where id = $1 and company_id = $2`,
          [params.visitId, ctx.companyId],
        );
        if (!visit) throw notFound('Visit');

        // Once signed off, the photo set is the record. Removing part of it
        // afterwards would let a completed visit quietly fall below the
        // evidence it was signed off on.
        if (visit.status === 'completed') {
          throw unprocessable(
            'This visit is signed off; its photographic record can no longer be changed',
          );
        }

        const row = await tx.one<{ id: string }>(
          `delete from ocs.supervision_visit_photos
            where id = $1 and visit_id = $2 and company_id = $3
            returning id`,
          [params.photoId, params.visitId, ctx.companyId],
        );
        if (!row) throw notFound('Photo');

        await writeAudit(tx, {
          companyId: ctx.companyId,
          actorUserId: p.userId,
          actorEmail: p.email,
          action: 'supervision.visit_photo_removed',
          entityType: 'supervision_visit',
          entityId: params.visitId,
          summary: 'Photo removed before sign-off',
          requestId: req.id,
        });

        return { id: row.id, deleted: true };
      });
    },
  );

  /**
   * The evidence pack for an engagement.
   *
   * This is the thing that gets produced when someone has to demonstrate that a
   * job was genuinely supervised. Reads the security-invoker view from 0013, so
   * tenant isolation still applies.
   */
  app.get('/v1/supervision/engagements/:id/evidence', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'admin');

    const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');

    return withTenant(ctx, async (tx) => {
      const rows = await tx.many(
        `select * from ocs.supervision_evidence
          where engagement_id = $1 and company_id = $2
          order by visit_id nulls last`,
        [id, ctx.companyId],
      );
      if (rows.length === 0) throw notFound('Engagement');

      const totals = await tx.one<{ visits: string; completed: string; photos: string }>(
        `select count(v.id)::text as visits,
                count(v.id) filter (where v.status = 'completed')::text as completed,
                coalesce(sum(v.photo_count), 0)::text as photos
           from ocs.supervision_visits v
          where v.engagement_id = $1 and v.company_id = $2`,
        [id, ctx.companyId],
      );

      return {
        engagementId: id,
        visits: rows,
        totals: {
          visits: Number(totals?.visits ?? 0),
          completed: Number(totals?.completed ?? 0),
          photographs: Number(totals?.photos ?? 0),
        },
        generatedAt: new Date().toISOString(),
      };
    });
  });

  // ---------------------------------------------------------------------------
  // Incidents
  // ---------------------------------------------------------------------------

  app.post('/v1/supervision/engagements/:id/incidents', { preHandler: authenticate }, async (req, reply) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requirePlatformRole(p, 'staff');

    const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
    const body = parse(
      z.object({
        severity: z.enum(['observation', 'minor', 'serious', 'stop_work']),
        category: z.string().trim().max(80).optional(),
        description: z.string().trim().min(1).max(4000),
        actionTaken: z.string().trim().max(2000).optional(),
        visitId: z.string().uuid().optional(),
      }),
      req.body,
      'incident',
    );

    const result = await withTenant(ctx, async (tx) => {
      const row = await tx.one<{ id: string }>(
        `insert into ocs.supervision_incidents
           (engagement_id, visit_id, severity, category, description, action_taken, reported_by)
         values ($1,$2,$3,$4,$5,$6,$7)
         returning id, severity, description, created_at`,
        [
          id, body.visitId ?? null, body.severity, body.category ?? null,
          body.description, body.actionTaken ?? null, p.userId,
        ],
      );

      // A stop-work order halts the engagement. Recording it is what shows the
      // qualifier exercised real control when something was wrong.
      if (body.severity === 'stop_work') {
        await tx.query(
          `update ocs.supervision_engagements
              set status = 'on_hold'
            where id = $1 and company_id = $2 and status = 'active'`,
          [id, ctx.companyId],
        );

        const recipients = await tx.many<{ user_id: string; email: string }>(
          `select m.user_id, u.email from ocs.company_memberships m
             join ocs.app_users u on u.id = m.user_id
            where m.company_id = $1 and m.is_active and u.is_active and u.deleted_at is null`,
          [ctx.companyId],
        );
        for (const r of recipients) {
          await notify(tx, {
            companyId: ctx.companyId,
            userId: r.user_id,
            kind: 'system',
            title: 'STOP WORK issued on your job site',
            body: body.description,
            entityType: 'supervision_engagement',
            entityId: id,
            linkPath: `/supervision/${id}`,
            email: { to: r.email },
          });
        }
      }

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'supervision.incident_reported',
        entityType: 'supervision_engagement',
        entityId: id,
        summary: `${body.severity}: ${body.description.slice(0, 120)}`,
        requestId: req.id,
      });

      return row;
    });

    return created(reply, result);
  });

  // ---------------------------------------------------------------------------
  // Admin: OCS licenses and supervisor roster
  // ---------------------------------------------------------------------------

  app.get('/v1/admin/supervision/licenses', { preHandler: authenticate }, async (req) => {
    requirePlatformRole(principalOf(req), 'staff');
    return withServiceContext(
      async (tx) => ({
        data: await tx.many(
          `select l.id, l.license_number, l.qualifier_name, l.status::text,
                  l.issued_on, l.expires_on, l.max_active_engagements, l.service_counties,
                  t.code as trade_code, t.name as trade_name,
                  (l.expires_on - current_date) as days_remaining,
                  (select count(*) from ocs.supervision_engagements e
                    where e.service_license_id = l.id and e.status = 'active')::int
                    as active_engagements
             from ocs.service_licenses l
             join ocs.trades t on t.id = l.trade_id
            where l.deleted_at is null
            order by l.expires_on asc nulls last`,
        ),
      }),
      { reason: 'list_service_licenses' },
    );
  });

  app.post('/v1/admin/supervision/licenses', { preHandler: authenticate }, async (req, reply) => {
    const p = principalOf(req);
    requirePlatformRole(p, 'admin');
    requireMfa(p);

    const body = parse(
      z.object({
        tradeId: z.string().uuid(),
        licenseNumber: z.string().trim().min(1).max(80),
        qualifierName: z.string().trim().min(1).max(200),
        qualifierUserId: z.string().uuid().optional(),
        issuedOn: z.string().date().optional(),
        expiresOn: z.string().date().optional(),
        maxActiveEngagements: z.number().int().min(1).max(500).default(25),
        serviceCounties: z.array(z.string().max(60)).max(67).default([]),
      }),
      req.body,
      'service license',
    );

    const result = await withServiceContext(
      async (tx) => {
        const row = await tx.one(
          `insert into ocs.service_licenses
             (trade_id, license_number, qualifier_name, qualifier_user_id,
              issued_on, expires_on, max_active_engagements, service_counties)
           values ($1,$2,$3,$4,$5,$6,$7,$8)
           returning id, license_number, qualifier_name, expires_on, max_active_engagements`,
          [
            body.tradeId, body.licenseNumber, body.qualifierName,
            body.qualifierUserId ?? null, body.issuedOn ?? null, body.expiresOn ?? null,
            body.maxActiveEngagements, body.serviceCounties,
          ],
        );

        await writeAudit(tx, {
          actorUserId: p.userId,
          actorEmail: p.email,
          action: 'admin.service_license_added',
          entityType: 'service_license',
          entityId: (row as { id?: string } | null)?.id ?? null,
          summary: `Service license ${body.licenseNumber} (${body.qualifierName})`,
          requestId: req.id,
        });

        return row;
      },
      { reason: 'add_service_license' },
    );

    return created(reply, result);
  });

  app.get('/v1/admin/supervision/supervisors', { preHandler: authenticate }, async (req) => {
    requirePlatformRole(principalOf(req), 'staff');
    return withServiceContext(
      async (tx) => ({
        data: await tx.many(
          `select s.id, s.display_name, s.phone, s.is_active, s.service_counties,
                  s.max_active_engagements, s.max_visits_per_day, u.email,
                  (select count(*) from ocs.supervision_engagements e
                    where e.supervisor_id = s.id and e.status = 'active')::int
                    as active_engagements,
                  (select array_agg(t.name) from ocs.trades t
                    where t.id = any(s.trade_ids)) as trades
             from ocs.supervisors s
             join ocs.app_users u on u.id = s.user_id
            where s.deleted_at is null
            order by s.display_name`,
        ),
      }),
      { reason: 'list_supervisors' },
    );
  });

  app.post('/v1/admin/supervision/supervisors', { preHandler: authenticate }, async (req, reply) => {
    const p = principalOf(req);
    requirePlatformRole(p, 'admin');

    const body = parse(
      z.object({
        userId: z.string().uuid(),
        displayName: z.string().trim().min(1).max(200),
        phone: z.string().trim().max(40).optional(),
        tradeIds: z.array(z.string().uuid()).max(30).default([]),
        serviceCounties: z.array(z.string().max(60)).max(67).default([]),
        maxActiveEngagements: z.number().int().min(1).max(100).default(12),
        maxVisitsPerDay: z.number().int().min(1).max(30).default(8),
      }),
      req.body,
      'supervisor',
    );

    const result = await withServiceContext(
      async (tx) => {
        const row = await tx.one(
          `insert into ocs.supervisors
             (user_id, display_name, phone, trade_ids, service_counties,
              max_active_engagements, max_visits_per_day)
           values ($1,$2,$3,$4,$5,$6,$7)
           on conflict (user_id) do update
             set display_name = excluded.display_name,
                 phone = excluded.phone,
                 trade_ids = excluded.trade_ids,
                 service_counties = excluded.service_counties,
                 is_active = true
           returning id, display_name, trade_ids, service_counties, max_active_engagements`,
          [
            body.userId, body.displayName, body.phone ?? null, body.tradeIds,
            body.serviceCounties, body.maxActiveEngagements, body.maxVisitsPerDay,
          ],
        );

        await writeAudit(tx, {
          actorUserId: p.userId,
          actorEmail: p.email,
          action: 'admin.supervisor_added',
          entityType: 'supervisor',
          entityId: (row as { id?: string } | null)?.id ?? null,
          summary: `Supervisor ${body.displayName}`,
          requestId: req.id,
        });

        return row;
      },
      { reason: 'add_supervisor' },
    );

    return created(reply, result);
  });

  /**
   * Dispatch view: who is available for a trade in a county, with current load.
   */
  app.get('/v1/admin/supervision/availability', { preHandler: authenticate }, async (req) => {
    requirePlatformRole(principalOf(req), 'staff');
    const q = parse(
      z.object({
        tradeId: z.string().uuid().optional(),
        county: z.string().trim().max(60).optional(),
      }),
      req.query,
      'query',
    );

    return withServiceContext(
      async (tx) => ({
        data: await tx.many(
          `select s.id, s.display_name, s.phone, s.service_counties,
                  s.max_active_engagements,
                  (select count(*) from ocs.supervision_engagements e
                    where e.supervisor_id = s.id and e.status = 'active')::int as active_load,
                  (select count(*) from ocs.supervision_visits v
                    where v.supervisor_id = s.id
                      and v.status = 'scheduled'
                      and v.scheduled_for::date = current_date)::int as visits_today
             from ocs.supervisors s
            where s.deleted_at is null and s.is_active
              and ($1::uuid is null or $1::uuid = any(s.trade_ids))
              and ($2::text is null
                   or cardinality(s.service_counties) = 0
                   or $2::text = any(s.service_counties))
            order by active_load asc, s.display_name`,
          [q.tradeId ?? null, q.county ?? null],
        ),
      }),
      { reason: 'supervisor_availability' },
    );
  });
}

/**
 * Background jobs for the white-glove service.
 *
 * Both of these watch for the states that quietly break the service's legal
 * footing: a qualifying license about to lapse, and an engagement where the
 * required supervision has stopped happening.
 */
import { withServiceContext, withWorkerTenant } from '../../db/tenant.js';
import { registerHandler } from '../runner.js';
import { notify } from '../../services/notifications.js';
import { logger } from '../../lib/logger.js';

const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';

/**
 * Watch OCS's own qualifying licenses.
 *
 * An expired license here is not one customer's problem — it stops the service
 * for that trade across every active engagement at once, and any permit pulled
 * under it afterwards is a serious problem. So this warns early and loudly, and
 * escalates to error level once a license is actually expired while engagements
 * are still running under it.
 */
async function licenseWatch(): Promise<unknown> {
  return withServiceContext(
    async (tx) => {
      const rows = await tx.many<{
        id: string; license_number: string; qualifier_name: string;
        trade_name: string; expires_on: string; days_remaining: string;
        active_engagements: string;
      }>(
        `select l.id, l.license_number, l.qualifier_name, t.name as trade_name,
                l.expires_on::text,
                (l.expires_on - current_date)::text as days_remaining,
                (select count(*) from ocs.supervision_engagements e
                  where e.service_license_id = l.id and e.status = 'active')::text
                  as active_engagements
           from ocs.service_licenses l
           join ocs.trades t on t.id = l.trade_id
          where l.deleted_at is null
            and l.status = 'active'
            and l.expires_on is not null
            and l.expires_on <= current_date + interval '90 days'
          order by l.expires_on`,
      );

      const expired = rows.filter((r) => Number(r.days_remaining) < 0);
      const expiring = rows.filter((r) => Number(r.days_remaining) >= 0);

      for (const lic of expired) {
        logger.error(
          {
            licenseId: lic.id,
            licenseNumber: lic.license_number,
            trade: lic.trade_name,
            expiredOn: lic.expires_on,
            activeEngagements: Number(lic.active_engagements),
          },
          'SERVICE LICENSE EXPIRED — engagements are running under a lapsed license',
        );

        // Reflect reality in the data as well as the logs: an expired license
        // must stop qualifying new work, and the activation trigger reads this.
        await tx.query(
          `update ocs.service_licenses set status = 'expired' where id = $1`,
          [lic.id],
        );
      }

      for (const lic of expiring) {
        logger.warn(
          {
            licenseNumber: lic.license_number,
            trade: lic.trade_name,
            daysRemaining: Number(lic.days_remaining),
          },
          'service license expiring',
        );
      }

      // Tell OCS platform staff, who are the only people who can act on it.
      if (rows.length > 0) {
        const staff = await tx.many<{ id: string; email: string }>(
          `select id, email from ocs.app_users
            where platform_role in ('staff','admin')
              and is_active and deleted_at is null`,
        );

        for (const lic of [...expired, ...expiring]) {
          for (const person of staff) {
            await tx.query(
              `insert into ocs.notifications
                 (company_id, user_id, kind, title, body, entity_type, entity_id, link_path)
               select null, $1, 'license_expiring', $2, $3, 'service_license', $4, $5
                where not exists (
                  select 1 from ocs.notifications n
                   where n.user_id = $1 and n.entity_id = $4
                     and n.created_at > now() - interval '7 days')`,
              [
                person.id,
                Number(lic.days_remaining) < 0
                  ? `EXPIRED: ${lic.trade_name} license ${lic.license_number}`
                  : `${lic.trade_name} license expires in ${lic.days_remaining} days`,
                `Qualifier ${lic.qualifier_name}. ${lic.active_engagements} active engagement(s) depend on it.`,
                lic.id,
                '/admin/supervision/licenses',
              ],
            );
          }
        }
      }

      return { expired: expired.length, expiringSoon: expiring.length };
    },
    { reason: 'service_license_watch' },
  );
}

/**
 * Watch for engagements where supervision has stalled.
 *
 * Two things matter: a scheduled visit that never happened, and an active
 * engagement with no visit activity at all for weeks. Both mean the supervision
 * being billed for is not being delivered, which is the exact gap that makes a
 * qualifying arrangement indefensible.
 */
async function visitWatch(): Promise<unknown> {
  const overdue = await withServiceContext(
    async (tx) => {
      // Scheduled visits whose time has passed with no check-in.
      const missed = await tx.many<{ id: string; company_id: string; engagement_id: string; milestone_name: string; engagement_number: number }>(
        `select v.id, v.company_id, v.engagement_id, v.milestone_name,
                e.engagement_number
           from ocs.supervision_visits v
           join ocs.supervision_engagements e on e.id = v.engagement_id
          where v.status = 'scheduled'
            and v.scheduled_for < now() - interval '24 hours'
            and v.checked_in_at is null
            and e.status = 'active'
          limit 200`,
      );

      for (const visit of missed) {
        await tx.query(
          `update ocs.supervision_visits set status = 'missed' where id = $1`,
          [visit.id],
        );
      }

      // Active engagements with no visit activity for 30 days.
      const stalled = await tx.many<{ id: string; company_id: string; engagement_number: number }>(
        `select e.id, e.company_id, e.engagement_number
           from ocs.supervision_engagements e
          where e.status = 'active'
            and e.activated_at < now() - interval '30 days'
            and not exists (
              select 1 from ocs.supervision_visits v
               where v.engagement_id = e.id
                 and v.checked_in_at > now() - interval '30 days')
          limit 100`,
      );

      if (missed.length > 0 || stalled.length > 0) {
        logger.warn(
          { missedVisits: missed.length, stalledEngagements: stalled.length },
          'supervision gaps detected',
        );
      }

      return { missed, stalled };
    },
    { reason: 'supervision_visit_watch' },
  );

  // Notify each affected contractor inside their own tenant context.
  for (const visit of overdue.missed) {
    await withWorkerTenant(
      { companyId: visit.company_id, userId: SYSTEM_USER, platformRole: 'none' },
      async (tx) => {
        const recipients = await tx.many<{ user_id: string; email: string }>(
          `select m.user_id, u.email from ocs.company_memberships m
             join ocs.app_users u on u.id = m.user_id
            where m.company_id = $1 and m.is_active
              and m.role in ('owner','admin')
              and u.is_active and u.deleted_at is null`,
          [visit.company_id],
        );
        for (const r of recipients) {
          await notify(tx, {
            companyId: visit.company_id,
            userId: r.user_id,
            kind: 'system',
            title: `Missed supervision visit: ${visit.milestone_name}`,
            body: `A required site visit on engagement #${visit.engagement_number} was not completed and needs rescheduling.`,
            entityType: 'supervision_engagement',
            entityId: visit.engagement_id,
            linkPath: `/supervision/${visit.engagement_id}`,
            email: { to: r.email },
            dedupeKey: `missed_visit:${visit.id}:${r.user_id}`,
          });
        }
      },
    );
  }

  return {
    missedVisits: overdue.missed.length,
    stalledEngagements: overdue.stalled.length,
  };
}

export function register(): void {
  registerHandler('supervision.license_watch', licenseWatch);
  registerHandler('supervision.visit_watch', visitWatch);
}

/**
 * Expiration monitoring for licenses, insurance and issued permits.
 *
 * The business reason this exists: an expired license or lapsed workers-comp
 * policy can stop a contractor working and void permits already issued. Nobody
 * notices a date passing on its own, so the system has to.
 *
 * The scan runs daily, fans out per company, and marks each record's
 * last_reminder_sent_at so a warning goes out once rather than every single day
 * until someone acts on it.
 */
import { withServiceContext, withWorkerTenant } from '../../db/tenant.js';
import { enqueue, type JobRow } from '../queue.js';
import { registerHandler, PermanentJobError } from '../runner.js';
import { notify } from '../../services/notifications.js';
import { logger } from '../../lib/logger.js';

const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';

interface ExpiringItem {
  company_id: string;
  item_type: 'license' | 'insurance' | 'permit';
  item_id: string;
  label: string;
  expires_on: string;
  days_remaining: number;
}

async function scan(): Promise<{ found: number; enqueued: number }> {
  const items = await withServiceContext(
    async (tx) =>
      tx.many<ExpiringItem>(
        `select company_id, 'license' as item_type, id as item_id,
                coalesce(trade, license_type::text) || ' license ' || license_number as label,
                expires_on::text,
                (expires_on - current_date) as days_remaining
           from ocs.licenses
          where deleted_at is null
            and expires_on is not null
            and status not in ('revoked','suspended')
            and expires_on <= current_date + make_interval(days => reminder_days)
            and (last_reminder_sent_at is null
                 or last_reminder_sent_at < now() - interval '7 days')

          union all

         select company_id, 'insurance', id,
                insurance_type::text || ' policy ' || policy_number,
                expires_on::text,
                (expires_on - current_date)
           from ocs.insurance_policies
          where deleted_at is null
            and expires_on is not null
            and status not in ('revoked','suspended')
            and expires_on <= current_date + make_interval(days => reminder_days)
            and (last_reminder_sent_at is null
                 or last_reminder_sent_at < now() - interval '7 days')

          union all

         select company_id, 'permit', id,
                'permit ' || coalesce(permit_number, id::text),
                expires_at::date::text,
                (expires_at::date - current_date)
           from ocs.permits
          where deleted_at is null
            and expires_at is not null
            and status in ('issued','inspections')
            and expires_at::date <= current_date + interval '30 days'

          order by days_remaining asc
          limit 1000`,
      ),
    { reason: 'expiration_scan' },
  );

  // Group by company so each contractor gets one job, not one per item.
  const byCompany = new Map<string, ExpiringItem[]>();
  for (const item of items) {
    const list = byCompany.get(item.company_id) ?? [];
    list.push(item);
    byCompany.set(item.company_id, list);
  }

  let enqueued = 0;
  for (const [companyId, companyItems] of byCompany) {
    await withServiceContext(
      async (tx) => {
        const id = await enqueue(tx, {
          jobType: 'compliance.notify_expiring',
          companyId,
          payload: { items: companyItems },
          dedupeKey: `expiry:${companyId}:${new Date().toISOString().slice(0, 10)}`,
        });
        if (id) enqueued++;
      },
      { reason: 'expiry_enqueue', companyId },
    );
  }

  logger.info({ found: items.length, companies: byCompany.size, enqueued }, 'expiration scan complete');
  return { found: items.length, enqueued };
}

async function notifyExpiring(job: JobRow): Promise<unknown> {
  const items = job.payload['items'];
  if (!Array.isArray(items)) {
    throw new PermanentJobError('compliance.notify_expiring requires an items array');
  }
  const companyId = job.company_id;
  if (!companyId) throw new PermanentJobError('compliance.notify_expiring requires a company');

  let sent = 0;

  await withWorkerTenant(
    { companyId, userId: SYSTEM_USER, platformRole: 'none' },
    async (tx) => {
      // Only owners and admins -- expiry is their responsibility, and mailing
      // every field user about insurance renewals trains people to ignore us.
      const recipients = await tx.many<{ user_id: string; email: string }>(
        `select m.user_id, u.email
           from ocs.company_memberships m
           join ocs.app_users u on u.id = m.user_id
          where m.company_id = $1
            and m.is_active
            and m.role in ('owner','admin')
            and u.is_active and u.deleted_at is null`,
        [companyId],
      );

      for (const item of items as ExpiringItem[]) {
        const expired = item.days_remaining < 0;
        const title = expired
          ? `EXPIRED: ${item.label}`
          : `${item.label} expires in ${item.days_remaining} day${item.days_remaining === 1 ? '' : 's'}`;

        for (const r of recipients) {
          await notify(tx, {
            companyId,
            userId: r.user_id,
            kind:
              item.item_type === 'license'
                ? 'license_expiring'
                : item.item_type === 'insurance'
                  ? 'insurance_expiring'
                  : 'permit_expiring',
            title,
            body: expired
              ? `This expired on ${item.expires_on}. Work relying on it may not be permitted.`
              : `This expires on ${item.expires_on}. Renew it before that date to avoid interruption.`,
            entityType: item.item_type,
            entityId: item.item_id,
            linkPath: `/${item.item_type === 'permit' ? 'permits' : 'compliance'}/${item.item_id}`,
            email: { to: r.email },
            dedupeKey: `expiry:${item.item_id}:${r.user_id}:${item.expires_on}`,
          });
          sent++;
        }

        // Stamp the reminder so the next scan skips this record for a week.
        if (item.item_type === 'license') {
          await tx.query(`update ocs.licenses set last_reminder_sent_at = now() where id = $1`, [
            item.item_id,
          ]);
        } else if (item.item_type === 'insurance') {
          await tx.query(
            `update ocs.insurance_policies set last_reminder_sent_at = now() where id = $1`,
            [item.item_id],
          );
        }
      }
    },
  );

  return { notificationsCreated: sent };
}

export function register(): void {
  registerHandler('compliance.expiration_scan', scan);
  registerHandler('compliance.notify_expiring', notifyExpiring);
}

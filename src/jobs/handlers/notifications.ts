/**
 * Outbound notification delivery.
 *
 * Every attempt updates ocs.notification_deliveries, so "did the customer
 * actually get told" is answerable from the database rather than inferred.
 */
import { withServiceContext } from '../../db/tenant.js';
import type { JobRow } from '../queue.js';
import { registerHandler, PermanentJobError } from '../runner.js';
import { sendEmail, renderEmail, emailConfigured } from '../../services/notifications.js';

async function deliver(job: JobRow): Promise<unknown> {
  const deliveryId = job.payload['deliveryId'];
  if (typeof deliveryId !== 'string') {
    throw new PermanentJobError('notifications.deliver requires a deliveryId');
  }

  const delivery = await withServiceContext(
    async (tx) =>
      tx.one<{ id: string; destination: string; status: string; attempts: number }>(
        `select id, destination, status, attempts
           from ocs.notification_deliveries where id = $1`,
        [deliveryId],
      ),
    { reason: 'load_delivery' },
  );

  if (!delivery) throw new PermanentJobError(`delivery ${deliveryId} not found`);

  // Already delivered -- a duplicate job must not send a second email.
  if (delivery.status === 'sent' || delivery.status === 'delivered') {
    return { skipped: true, reason: 'already delivered' };
  }

  if (!emailConfigured()) {
    await withServiceContext(
      async (tx) => {
        await tx.query(
          `update ocs.notification_deliveries
              set status = 'failed',
                  attempts = attempts + 1,
                  error_message = 'No email provider configured (RESEND_API_KEY / EMAIL_FROM)',
                  updated_at = now()
            where id = $1`,
          [deliveryId],
        );
      },
      { reason: 'delivery_unconfigured' },
    );
    // Permanent: retrying cannot configure a provider. The row records exactly
    // why, and the in-app notification still reached the user.
    throw new PermanentJobError('email provider is not configured');
  }

  const title = String(job.payload['title'] ?? 'Notification');
  const body = String(job.payload['body'] ?? '');
  const linkPath = job.payload['linkPath'] as string | null;
  const subject = String(job.payload['subject'] ?? title);

  const { html, text } = renderEmail({ title, body, linkPath: linkPath ?? null });
  const result = await sendEmail({ to: delivery.destination, subject, html, text });

  await withServiceContext(
    async (tx) => {
      await tx.query(
        `update ocs.notification_deliveries
            set status = $2,
                attempts = attempts + 1,
                provider_message_id = $3,
                error_message = $4,
                sent_at = case when $2 = 'sent' then now() else sent_at end,
                updated_at = now()
          where id = $1`,
        [deliveryId, result.ok ? 'sent' : 'failed', result.providerMessageId ?? null, result.error ?? null],
      );
    },
    { reason: 'delivery_result' },
  );

  if (!result.ok) throw new Error(result.error ?? 'email delivery failed');
  return { sent: true, providerMessageId: result.providerMessageId };
}

export function register(): void {
  registerHandler('notifications.deliver', deliver);
}

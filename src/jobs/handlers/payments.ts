/**
 * Applying verified Stripe webhook events to our own records.
 *
 * The HTTP route does as little as possible: verify the signature, store the
 * event, return 200. All interpretation happens here, in a retryable job.
 *
 * That split matters. Stripe treats a slow or failing webhook response as a
 * delivery failure and retries it, so doing real work inline turns one slow
 * database query into a storm of duplicate deliveries. Acknowledging fast and
 * processing asynchronously means our processing speed and Stripe's retry
 * behaviour stop being coupled.
 *
 * Every effect below is written to be safe if applied twice -- guarded by a
 * unique provider id, or by a status check that makes reapplication a no-op.
 */
import { withServiceContext } from '../../db/tenant.js';
import type { JobRow } from '../queue.js';
import { registerHandler, PermanentJobError } from '../runner.js';
import { mapIntentStatus } from '../../services/stripe.js';
import { notify } from '../../services/notifications.js';
import { writeAudit } from '../../lib/audit.js';
import { logger } from '../../lib/logger.js';
import type Stripe from 'stripe';

interface WebhookRow {
  id: string;
  provider: string;
  provider_event_id: string;
  event_type: string;
  status: string;
  signature_verified: boolean;
  payload: Stripe.Event;
}

async function markProcessed(id: string, status: 'processed' | 'ignored' | 'failed', error?: string) {
  await withServiceContext(
    async (tx) => {
      await tx.query(
        `update ocs.webhook_events
            set status = $2,
                attempts = attempts + 1,
                last_error = $3,
                processed_at = case when $2 in ('processed','ignored') then now() else processed_at end
          where id = $1`,
        [id, status, error ?? null],
      );
    },
    { reason: 'mark_webhook_processed' },
  );
}

async function applyPaymentIntent(event: WebhookRow, intent: Stripe.PaymentIntent): Promise<string> {
  const companyId = intent.metadata?.['company_id'] ?? null;
  const invoiceId = intent.metadata?.['invoice_id'] ?? null;
  const status = mapIntentStatus(intent.status);

  return withServiceContext(
    async (tx) => {
      // Upsert on the provider's id. If the browser-initiated POST already
      // created this row we update it; if the webhook somehow arrives first we
      // create it. Either way exactly one row exists, because the unique index
      // on (provider, provider_payment_intent_id) says so.
      const existing = await tx.one<{ id: string; status: string; company_id: string }>(
        `select id, status::text, company_id from ocs.payments
          where provider = 'stripe' and provider_payment_intent_id = $1`,
        [intent.id],
      );

      let paymentId: string;

      if (existing) {
        // Never walk a terminal state backwards. Stripe delivers out of order,
        // so a stale 'processing' event can arrive after 'succeeded'.
        if (existing.status === 'succeeded' && status !== 'refunded') {
          return 'already succeeded; no change';
        }
        paymentId = existing.id;

        await tx.query(
          `update ocs.payments
              set status = $2::ocs.payment_status,
                  provider_charge_id = coalesce($3, provider_charge_id),
                  failure_code = $4,
                  failure_message = $5,
                  succeeded_at = case when $2 = 'succeeded' then now() else succeeded_at end
            where id = $1`,
          [
            paymentId,
            status,
            typeof intent.latest_charge === 'string' ? intent.latest_charge : null,
            intent.last_payment_error?.code ?? null,
            intent.last_payment_error?.message ?? null,
          ],
        );
      } else {
        if (!companyId) {
          // Without a company we cannot attribute the money. Permanent: no
          // amount of retrying will add metadata to an event already sent.
          throw new PermanentJobError(
            `payment intent ${intent.id} has no company_id metadata; cannot attribute`,
          );
        }

        const created = await tx.one<{ id: string }>(
          `insert into ocs.payments
             (company_id, invoice_id, direction, status, amount_cents, currency,
              provider, provider_payment_intent_id, provider_charge_id, succeeded_at)
           values ($1,$2,'inbound',$3::ocs.payment_status,$4,$5,'stripe',$6,$7,
                   case when $3 = 'succeeded' then now() else null end)
           returning id`,
          [
            companyId,
            invoiceId,
            status,
            intent.amount,
            intent.currency,
            intent.id,
            typeof intent.latest_charge === 'string' ? intent.latest_charge : null,
          ],
        );
        if (!created) throw new Error('failed to record payment');
        paymentId = created.id;
      }

      if (status !== 'succeeded') return `payment ${paymentId} -> ${status}`;

      // Apply to the invoice. amount_paid is recomputed from the payments table
      // rather than incremented, so a replayed event cannot inflate it.
      if (invoiceId) {
        await tx.query(
          `update ocs.invoices i
              set amount_paid_cents = coalesce((
                    select sum(p.amount_cents - p.amount_refunded_cents)
                      from ocs.payments p
                     where p.invoice_id = i.id and p.status = 'succeeded'
                  ), 0),
                  status = case
                    when coalesce((select sum(p.amount_cents - p.amount_refunded_cents)
                                     from ocs.payments p
                                    where p.invoice_id = i.id and p.status = 'succeeded'), 0)
                         >= i.total_cents then 'paid'::ocs.invoice_status
                    else i.status end,
                  paid_at = case
                    when coalesce((select sum(p.amount_cents - p.amount_refunded_cents)
                                     from ocs.payments p
                                    where p.invoice_id = i.id and p.status = 'succeeded'), 0)
                         >= i.total_cents then now()
                    else i.paid_at end
            where i.id = $1`,
          [invoiceId],
        );
      }

      if (companyId) {
        await writeAudit(tx, {
          companyId,
          action: 'payment.succeeded',
          entityType: 'payment',
          entityId: paymentId,
          summary: `Payment of ${(intent.amount / 100).toFixed(2)} ${intent.currency.toUpperCase()} succeeded`,
          after: { amount_cents: intent.amount, currency: intent.currency, status },
        });

        const admins = await tx.many<{ user_id: string; email: string }>(
          `select m.user_id, u.email
             from ocs.company_memberships m
             join ocs.app_users u on u.id = m.user_id
            where m.company_id = $1 and m.is_active
              and m.role in ('owner','admin')
              and u.is_active and u.deleted_at is null`,
          [companyId],
        );

        for (const a of admins) {
          await notify(tx, {
            companyId,
            userId: a.user_id,
            kind: 'payment_succeeded',
            title: `Payment received: ${(intent.amount / 100).toFixed(2)} ${intent.currency.toUpperCase()}`,
            entityType: 'payment',
            entityId: paymentId,
            linkPath: `/billing/payments/${paymentId}`,
            email: { to: a.email },
            dedupeKey: `payment_succeeded:${paymentId}:${a.user_id}`,
          });
        }
      }

      return `payment ${paymentId} succeeded`;
    },
    { reason: 'apply_payment_intent', ...(companyId ? { companyId } : {}) },
  );
}

async function applyRefund(charge: Stripe.Charge): Promise<string> {
  return withServiceContext(
    async (tx) => {
      const payment = await tx.one<{ id: string; company_id: string; amount_cents: string }>(
        `select id, company_id, amount_cents::text from ocs.payments
          where provider = 'stripe'
            and (provider_charge_id = $1 or provider_payment_intent_id = $2)`,
        [charge.id, typeof charge.payment_intent === 'string' ? charge.payment_intent : null],
      );

      if (!payment) return `no local payment for charge ${charge.id}`;

      const refunded = charge.amount_refunded;
      const total = Number(payment.amount_cents);

      await tx.query(
        `update ocs.payments
            set amount_refunded_cents = $2,
                status = case when $2 >= $3 then 'refunded'::ocs.payment_status
                              when $2 > 0 then 'partially_refunded'::ocs.payment_status
                              else status end
          where id = $1`,
        [payment.id, refunded, total],
      );

      await writeAudit(tx, {
        companyId: payment.company_id,
        action: 'payment.refunded',
        entityType: 'payment',
        entityId: payment.id,
        summary: `Refunded ${(refunded / 100).toFixed(2)} of ${(total / 100).toFixed(2)}`,
        after: { amount_refunded_cents: refunded },
      });

      return `payment ${payment.id} refunded ${refunded}`;
    },
    { reason: 'apply_refund' },
  );
}

async function processWebhook(job: JobRow): Promise<unknown> {
  const webhookEventId = job.payload['webhookEventId'];
  if (typeof webhookEventId !== 'string') {
    throw new PermanentJobError('payments.process_webhook requires a webhookEventId');
  }

  const event = await withServiceContext(
    async (tx) =>
      tx.one<WebhookRow>(
        `select id, provider, provider_event_id, event_type, status,
                signature_verified, payload
           from ocs.webhook_events where id = $1`,
        [webhookEventId],
      ),
    { reason: 'load_webhook_event' },
  );

  if (!event) throw new PermanentJobError(`webhook event ${webhookEventId} not found`);

  // Refuse to act on anything that did not pass signature verification. The row
  // exists so forged traffic is visible, not so it can be processed later.
  if (!event.signature_verified) {
    await markProcessed(event.id, 'ignored', 'signature was not verified');
    throw new PermanentJobError('refusing to process an unverified webhook event');
  }

  if (event.status === 'processed') {
    return { skipped: true, reason: 'already processed' };
  }

  await withServiceContext(
    async (tx) => {
      await tx.query(`update ocs.webhook_events set status = 'processing' where id = $1`, [event.id]);
    },
    { reason: 'mark_webhook_processing' },
  );

  try {
    const stripeEvent = event.payload;
    let outcome: string;

    switch (stripeEvent.type) {
      case 'payment_intent.succeeded':
      case 'payment_intent.payment_failed':
      case 'payment_intent.processing':
      case 'payment_intent.canceled':
        outcome = await applyPaymentIntent(event, stripeEvent.data.object as Stripe.PaymentIntent);
        break;

      case 'charge.refunded':
        outcome = await applyRefund(stripeEvent.data.object as Stripe.Charge);
        break;

      default:
        // Unhandled types are recorded and ignored rather than treated as
        // errors. Stripe sends many event types; only the ones we subscribe to
        // and understand should change state.
        await markProcessed(event.id, 'ignored', `unhandled event type ${stripeEvent.type}`);
        logger.debug({ eventType: stripeEvent.type }, 'ignoring unhandled webhook event type');
        return { ignored: true, eventType: stripeEvent.type };
    }

    await markProcessed(event.id, 'processed');
    return { processed: true, eventType: stripeEvent.type, outcome };
  } catch (err) {
    const message = (err as Error).message;
    await markProcessed(event.id, 'failed', message);
    throw err;
  }
}

export function register(): void {
  registerHandler('payments.process_webhook', processWebhook);
}

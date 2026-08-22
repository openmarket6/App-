/**
 * Inbound provider webhooks.
 *
 * This endpoint is PUBLIC -- Stripe cannot authenticate to us, so anyone on the
 * internet can POST here. Everything below follows from that:
 *
 *   1. VERIFY THE SIGNATURE FIRST. Nothing in the body is trusted until the
 *      HMAC checks out. Without this, a forged `payment_intent.succeeded` marks
 *      invoices paid for free.
 *
 *   2. The raw body is required for verification, so this plugin installs its
 *      own content-type parser that keeps the bytes untouched. Fastify's normal
 *      JSON parsing would produce an object we would have to re-serialise, and
 *      re-serialised JSON is byte-different -- the signature would never match.
 *
 *   3. STORE, THEN ACKNOWLEDGE, THEN PROCESS. We insert the event, return 200,
 *      and let a job apply it. Stripe treats a slow response as a failure and
 *      redelivers, so doing the work inline turns one slow query into a storm.
 *
 *   4. Duplicates are handled by a unique index on (provider, event id), not by
 *      application logic. Stripe redelivers on purpose; the database is what
 *      makes the second delivery a no-op.
 *
 *   5. Verification failures are recorded and answered with 400. A burst of
 *      them is someone probing, and it should be visible.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { withServiceContext } from '../db/tenant.js';
import { constructWebhookEvent, isPaymentsEnabled } from '../services/stripe.js';
import {
  verifyWebhookSignature as verifyMailSignature, mapEventType, isMailEnabled,
} from '../services/mail.js';
import { enqueue } from '../jobs/queue.js';
import { logger } from '../lib/logger.js';
import { header } from '../lib/http-helpers.js';

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  // Encapsulated: this parser applies only to routes registered on `instance`,
  // so the rest of the API keeps normal JSON parsing.
  await app.register(async (instance) => {
    instance.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_req, body, done) => {
        done(null, body);
      },
    );

    instance.post(
      '/v1/webhooks/stripe',
      {
        config: {
          // Stripe bursts on redelivery; a tight limit here would cause us to
          // reject legitimate events. Verification, not rate limiting, is the
          // control that matters on this route.
          rateLimit: { max: 1000, timeWindow: '1 minute' },
        },
      },
      async (req: FastifyRequest, reply) => {
        if (!isPaymentsEnabled()) {
          logger.warn('received a stripe webhook while payments are unconfigured');
          reply.code(503);
          return { error: 'payments_not_configured' };
        }

        const signature = header(req, 'stripe-signature');
        const rawBody = req.body as Buffer;

        if (!Buffer.isBuffer(rawBody)) {
          reply.code(400);
          return { error: 'expected_raw_body' };
        }

        let event;
        try {
          event = constructWebhookEvent(rawBody, signature);
        } catch {
          // Record the attempt without the payload -- a forged body is
          // attacker-controlled content and does not belong in our storage.
          await withServiceContext(
            async (tx) => {
              await tx.query(
                `insert into ocs.webhook_events
                   (provider, provider_event_id, event_type, signature_verified,
                    status, payload, last_error)
                 values ('stripe', $1, 'unknown', false, 'failed', '{}'::jsonb,
                         'signature verification failed')
                 on conflict (provider, provider_event_id) do nothing`,
                [`unverified-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`],
              );
            },
            { reason: 'record_failed_webhook' },
          ).catch((err: unknown) => logger.error({ err }, 'could not record failed webhook'));

          logger.warn({ ip: req.ip }, 'rejected webhook with invalid signature');
          reply.code(400);
          return { error: 'invalid_signature' };
        }

        // Signature verified from here on.
        const stored = await withServiceContext(
          async (tx) => {
            const row = await tx.one<{ id: string }>(
              `insert into ocs.webhook_events
                 (provider, provider_event_id, event_type, signature_verified, status, payload)
               values ('stripe', $1, $2, true, 'received', $3)
               on conflict (provider, provider_event_id) do nothing
               returning id`,
              [event.id, event.type, JSON.stringify(event)],
            );

            if (!row) {
              // Already stored: a redelivery. Nothing further to do.
              return null;
            }

            await enqueue(tx, {
              jobType: 'payments.process_webhook',
              payload: { webhookEventId: row.id },
              dedupeKey: `webhook:${row.id}`,
              maxAttempts: 5,
              priority: 10, // money events go ahead of routine work
            });

            return row;
          },
          { reason: 'store_webhook_event' },
        );

        if (!stored) {
          logger.debug({ eventId: event.id }, 'duplicate webhook delivery ignored');
          return { received: true, duplicate: true };
        }

        logger.info({ eventId: event.id, eventType: event.type }, 'webhook accepted');
        return { received: true };
      },
    );

    /**
     * Lob delivery events.
     *
     * This is where a certified letter becomes proof. A forged `letter.delivered`
     * would put a false proof of service in the record -- the single worst thing
     * ocs.document_mailings could contain -- so the signature is checked over the
     * RAW body, and the timestamp is checked too, so an old genuine event cannot
     * be replayed later.
     *
     * Applied inline rather than queued, unlike the Stripe path. The work is one
     * indexed update on one row, and the reason Stripe events are deferred -- a
     * slow handler turning redelivery into a storm -- does not apply to a query
     * that touches a single row by unique index.
     */
    instance.post(
      '/api/webhooks/lob',
      { config: { rateLimit: { max: 1000, timeWindow: '1 minute' } } },
      async (req: FastifyRequest, reply) => {
        if (!isMailEnabled()) {
          logger.warn('received a lob webhook while mail is unconfigured');
          reply.code(503);
          return { error: 'mail_not_configured' };
        }

        const rawBody = req.body as Buffer;
        if (!Buffer.isBuffer(rawBody)) {
          reply.code(400);
          return { error: 'expected_raw_body' };
        }

        const ok = verifyMailSignature(
          rawBody,
          header(req, 'lob-signature-timestamp'),
          header(req, 'lob-signature'),
        );
        if (!ok) {
          // Not recorded with its payload: a forged body is attacker-controlled
          // content and does not belong in our storage.
          logger.warn({ ip: req.ip }, 'rejected lob webhook with invalid signature');
          reply.code(400);
          return { error: 'invalid_signature' };
        }

        let event: {
          id?: string;
          event_type?: { id?: string } | string;
          body?: { id?: string; tracking_number?: string | null; expected_delivery_date?: string | null };
        };
        try {
          event = JSON.parse(rawBody.toString('utf8'));
        } catch {
          reply.code(400);
          return { error: 'invalid_json' };
        }

        const eventType =
          typeof event.event_type === 'string'
            ? event.event_type
            : (event.event_type?.id ?? '');
        const letterId = event.body?.id;
        if (!letterId) {
          // Nothing to attach it to. Answered 200 so Lob stops retrying an
          // event we will never be able to apply.
          logger.warn({ eventType }, 'lob webhook carried no letter id');
          return { received: true, applied: false };
        }

        const status = mapEventType(eventType);
        const at = new Date().toISOString();

        const applied = await withServiceContext(
          async (tx) => {
            /*
             * Every event is appended, whether or not it moves the status.
             * "In transit, then delivered, then returned" is a story, and the
             * dates it turns on are exactly what a dispute asks about.
             *
             * The status columns use `coalesce` so a redelivered event cannot
             * move a delivery date that is already recorded -- the first time
             * we were told is the time that matters.
             */
            const row = await tx.one<{ id: string; company_id: string }>(
              `update ocs.document_mailings
                  set events = events || $2::jsonb,
                      status = coalesce($3::ocs.mail_status, status),
                      delivered_at = case when $3 = 'delivered'
                                          then coalesce(delivered_at, now())
                                          else delivered_at end,
                      returned_at = case when $3 = 'returned'
                                         then coalesce(returned_at, now())
                                         else returned_at end,
                      tracking_number = coalesce(tracking_number, $4),
                      expected_delivery_on = coalesce(expected_delivery_on, $5::date)
                where provider = 'lob' and provider_id = $1
                returning id, company_id`,
              [
                letterId,
                JSON.stringify([{ at, status: status ?? eventType, detail: eventType }]),
                status,
                event.body?.tracking_number ?? null,
                event.body?.expected_delivery_date ?? null,
              ],
            );
            return row;
          },
          { reason: 'lob_webhook' },
        );

        if (!applied) {
          // A letter we have no row for. Worth seeing -- it means something was
          // posted outside this system, or a row was lost.
          logger.warn({ letterId, eventType }, 'lob event for an unknown letter');
          return { received: true, applied: false };
        }

        logger.info({ letterId, eventType, status }, 'lob event applied');
        return { received: true, applied: true };
      },
    );
  });
}

/**
 * Stripe integration.
 *
 * Two properties matter more than anything else here.
 *
 * WEBHOOK SIGNATURE VERIFICATION. `/v1/webhooks/stripe` is a public endpoint.
 * Anyone can POST to it. Without signature verification, anyone could POST
 * `payment_intent.succeeded` and mark invoices paid for free. constructEvent()
 * checks an HMAC over the RAW request body -- which is why the route registers
 * a raw-body parser and never lets JSON parsing touch it first. A re-serialised
 * body produces different bytes and the signature will not match.
 *
 * IDEMPOTENCY. Every mutating Stripe call carries an idempotency key, so a
 * network timeout followed by a retry cannot create a second charge. Stripe
 * returns the original result for a repeated key.
 *
 * Card data never reaches this server: the browser collects it with Stripe.js
 * and we only ever see tokens and identifiers.
 */
import Stripe from 'stripe';
import { env, paymentsConfigured } from '../config/env.js';
import { serviceUnavailable, badRequest } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

let client: Stripe | null = null;

export function stripe(): Stripe {
  if (!paymentsConfigured || !env.STRIPE_SECRET_KEY) {
    throw serviceUnavailable('Payments are not configured on this server');
  }
  client ??= new Stripe(env.STRIPE_SECRET_KEY, {
    // Stripe's own retry/timeout handling; kept modest so a slow Stripe does
    // not hold an API worker for a whole request timeout.
    maxNetworkRetries: 2,
    timeout: 15_000,
    telemetry: false,
  });
  return client;
}

export function isPaymentsEnabled(): boolean {
  return paymentsConfigured;
}

/**
 * Verify and parse an inbound webhook.
 *
 * Throws on any signature mismatch. The caller must return a 4xx and record the
 * failure -- never process an event that failed verification, and never fall
 * back to trusting the body "just this once".
 */
export function constructWebhookEvent(rawBody: Buffer | string, signature: string | undefined): Stripe.Event {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw serviceUnavailable('Webhook verification is not configured');
  }
  if (!signature) {
    throw badRequest('Missing Stripe-Signature header');
  }

  try {
    return stripe().webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    // Log that verification failed and nothing about the payload: a forged
    // request's body is attacker-controlled and does not belong in our logs.
    logger.warn({ err: (err as Error).message }, 'stripe webhook signature verification failed');
    throw badRequest('Webhook signature verification failed');
  }
}

export interface CreateIntentParams {
  amountCents: number;
  currency: string;
  companyId: string;
  invoiceId?: string | null;
  description?: string;
  /** Reused verbatim as the Stripe idempotency key. */
  idempotencyKey: string;
  customerId?: string | null;
}

export async function createPaymentIntent(params: CreateIntentParams): Promise<Stripe.PaymentIntent> {
  return stripe().paymentIntents.create(
    {
      amount: params.amountCents,
      currency: params.currency,
      description: params.description,
      ...(params.customerId ? { customer: params.customerId } : {}),
      automatic_payment_methods: { enabled: true },
      // Metadata is how a webhook arriving later is matched back to our rows
      // without trusting anything in the request that triggered it.
      metadata: {
        company_id: params.companyId,
        ...(params.invoiceId ? { invoice_id: params.invoiceId } : {}),
      },
    },
    { idempotencyKey: params.idempotencyKey },
  );
}

export async function createRefund(params: {
  paymentIntentId: string;
  amountCents?: number;
  reason?: Stripe.RefundCreateParams.Reason;
  idempotencyKey: string;
}): Promise<Stripe.Refund> {
  return stripe().refunds.create(
    {
      payment_intent: params.paymentIntentId,
      ...(params.amountCents ? { amount: params.amountCents } : {}),
      ...(params.reason ? { reason: params.reason } : {}),
    },
    { idempotencyKey: params.idempotencyKey },
  );
}

/**
 * Map Stripe's PaymentIntent status onto ocs.payment_status.
 *
 * Explicit and total rather than a cast: when Stripe adds a status we do not
 * know, this returns 'processing' (a safe, non-terminal state) instead of
 * writing an unrecognised value or crashing the webhook handler.
 */
export function mapIntentStatus(status: Stripe.PaymentIntent.Status): string {
  switch (status) {
    case 'succeeded':
      return 'succeeded';
    case 'canceled':
      return 'canceled';
    case 'processing':
      return 'processing';
    case 'requires_payment_method':
      return 'requires_payment_method';
    case 'requires_action':
    case 'requires_confirmation':
    case 'requires_capture':
      return 'requires_action';
    default:
      logger.warn({ status }, 'unrecognised stripe payment intent status');
      return 'processing';
  }
}

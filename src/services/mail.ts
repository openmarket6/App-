/**
 * Lob — physical mail, with proof of delivery.
 *
 * Bought for one job: serving a Notice to Owner in a way that can be shown to
 * have happened. Everything unusual about this file traces back to that.
 *
 * IDEMPOTENCY IS NOT OPTIONAL. A certified letter costs real money and, more to
 * the point, sending two of them to the same owner for the same notice makes
 * the record ambiguous about which one was served. Every send carries a key
 * derived from the mailing row, so a network timeout and a retry produce one
 * letter, and Lob returns the original.
 *
 * ADDRESSES ARE VERIFIED BEFORE ANYTHING IS SPENT. An undeliverable address on
 * an NTO is a failed service that surfaces weeks later as a return-to-sender,
 * by which point the window has closed. Verification is a separate, cheap call
 * and its result is kept.
 *
 * WEBHOOK SIGNATURES ARE CHECKED. The delivery webhook is public, and a forged
 * "delivered" would put a false proof of service in the record — the single
 * worst thing this table could contain.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env, mailConfigured } from '../config/env.js';
import { requestWithRetry } from '../lib/http.js';
import { serviceUnavailable, badRequest } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { MailAddress, MailClass } from '../domain/mailing.js';

const BASE = 'https://api.lob.com/v1';

export function isMailEnabled(): boolean {
  return mailConfigured;
}

function auth(): string {
  if (!env.LOB_API_KEY) {
    throw serviceUnavailable(
      'Physical mail is not configured on this server. Nothing was sent.',
    );
  }
  // Lob uses HTTP basic with the key as the username and an empty password.
  return `Basic ${Buffer.from(`${env.LOB_API_KEY}:`).toString('base64')}`;
}

function form(fields: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && v !== '') p.append(k, v);
  }
  return p.toString();
}

// -----------------------------------------------------------------------------

export interface AddressVerification {
  deliverable: boolean;
  /** Lob's own wording, kept so a refusal can be explained rather than guessed. */
  deliverability: string;
  /** The corrected address Lob would actually use, when it offered one. */
  corrected: MailAddress | null;
  raw: unknown;
}

/**
 * Check an address before spending anything on it.
 *
 * Returns rather than throws on an undeliverable result: whether to post to a
 * questionable address is a judgement (an owner's address taken from a permit
 * may be right even when the USPS database disagrees), and this function's job
 * is to make sure the judgement is made knowingly.
 */
export async function verifyAddress(addr: MailAddress): Promise<AddressVerification> {
  const res = await requestWithRetry(
    `${BASE}/us_verifications`,
    {
      method: 'POST',
      headers: {
        authorization: auth(),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form({
        primary_line: addr.line1,
        secondary_line: addr.line2 ?? undefined,
        city: addr.city,
        state: addr.state,
        zip_code: addr.postalCode,
      }),
    },
    // Safe to repeat: verification creates nothing and costs nothing per call.
    { retryUnsafeMethod: true, attempts: 3, timeoutMs: 10_000, label: 'lob.verify' },
  );

  if (!res.ok) {
    logger.warn({ status: res.status }, 'address verification failed');
    return {
      deliverable: false,
      deliverability: 'verification_unavailable',
      corrected: null,
      raw: { status: res.status },
    };
  }

  const body = JSON.parse(res.body) as {
    deliverability?: string;
    primary_line?: string;
    secondary_line?: string;
    components?: { city?: string; state?: string; zip_code?: string; zip_code_plus_4?: string };
  };

  const deliverability = body.deliverability ?? 'unknown';
  const zip = body.components?.zip_code
    ? body.components.zip_code_plus_4
      ? `${body.components.zip_code}-${body.components.zip_code_plus_4}`
      : body.components.zip_code
    : addr.postalCode;

  return {
    deliverable: deliverability === 'deliverable',
    deliverability,
    corrected: body.primary_line
      ? {
          name: addr.name,
          line1: body.primary_line,
          line2: body.secondary_line || null,
          city: body.components?.city ?? addr.city,
          state: body.components?.state ?? addr.state,
          postalCode: zip,
          country: 'US',
        }
      : null,
    raw: body,
  };
}

// -----------------------------------------------------------------------------

/** Lob's names for the extra services. First class needs none. */
const EXTRA_SERVICE: Record<MailClass, string | undefined> = {
  first_class: undefined,
  certified: 'certified',
  certified_return_receipt: 'certified_return_receipt',
};

export interface SentLetter {
  providerId: string;
  trackingNumber: string | null;
  expectedDeliveryOn: string | null;
  chargedCents: number | null;
}

/**
 * Post one letter.
 *
 * `idempotencyKey` must be stable for a given mailing row and must NOT include
 * a timestamp or a random value — that is the whole mechanism. A retry with the
 * same key returns the letter already created rather than creating a second.
 */
export async function sendLetter(input: {
  to: MailAddress;
  from: MailAddress;
  html: string;
  mailClass: MailClass;
  description: string;
  idempotencyKey: string;
}): Promise<SentLetter> {
  const extra = EXTRA_SERVICE[input.mailClass];

  const res = await requestWithRetry(
    `${BASE}/letters`,
    {
      method: 'POST',
      headers: {
        authorization: auth(),
        'content-type': 'application/x-www-form-urlencoded',
        // Lob honours this for 24 hours. Long enough to cover every retry path
        // a request can take, including a worker restart.
        'idempotency-key': input.idempotencyKey,
      },
      body: form({
        description: input.description,
        // Colour costs more and proves nothing. These are legal instruments,
        // not brochures.
        color: 'false',
        double_sided: 'false',
        // The address block is printed by us inside the HTML, so Lob must not
        // overlay its own on top of the document text.
        address_placement: 'insert_blank_page',
        file: input.html,
        'to[name]': input.to.name,
        'to[address_line1]': input.to.line1,
        'to[address_line2]': input.to.line2 ?? undefined,
        'to[address_city]': input.to.city,
        'to[address_state]': input.to.state,
        'to[address_zip]': input.to.postalCode,
        'to[address_country]': input.to.country ?? 'US',
        'from[name]': input.from.name,
        'from[address_line1]': input.from.line1,
        'from[address_line2]': input.from.line2 ?? undefined,
        'from[address_city]': input.from.city,
        'from[address_state]': input.from.state,
        'from[address_zip]': input.from.postalCode,
        'from[address_country]': input.from.country ?? 'US',
        extra_service: extra,
      }),
    },
    /*
     * Retried despite being a POST, because the idempotency key makes it safe
     * and because the alternative is worse: a timeout on a certified letter
     * that DID send leaves a notice served with no record of serving it.
     */
    { retryUnsafeMethod: true, attempts: 3, timeoutMs: 30_000, label: 'lob.letter' },
  );

  if (!res.ok) {
    let detail = `Lob rejected the letter (HTTP ${res.status})`;
    try {
      const err = JSON.parse(res.body) as { error?: { message?: string } };
      if (err.error?.message) detail = err.error.message;
    } catch {
      // Body was not JSON. The status is all we have, and it is in `detail`.
    }
    logger.error({ status: res.status }, 'lob letter failed');
    // 4xx is our request being wrong -- a bad address, usually -- and the
    // person who typed it can fix it. 5xx is theirs, and retrying later is the
    // right answer, so it must not be reported as a user error.
    if (res.status >= 400 && res.status < 500) throw badRequest(detail);
    throw serviceUnavailable(detail);
  }

  const body = JSON.parse(res.body) as {
    id: string;
    tracking_number?: string | null;
    expected_delivery_date?: string | null;
    // Lob reports price as a decimal string of dollars.
    price?: string | null;
  };

  return {
    providerId: body.id,
    trackingNumber: body.tracking_number ?? null,
    expectedDeliveryOn: body.expected_delivery_date ?? null,
    chargedCents:
      body.price != null && body.price !== ''
        ? Math.round(Number(body.price) * 100)
        : null,
  };
}

// -----------------------------------------------------------------------------

/**
 * Verify a webhook signature.
 *
 * Lob signs `${timestamp}.${rawBody}` with HMAC-SHA256. The timestamp is part
 * of the signed material specifically so an old, genuine delivery notice cannot
 * be replayed later — so it is checked, not just read.
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  timestamp: string | undefined,
  signature: string | undefined,
  now: Date = new Date(),
): boolean {
  if (!env.LOB_WEBHOOK_SECRET || !timestamp || !signature) return false;

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) return false;
  // Five minutes either way. Wide enough for clock skew, narrow enough that a
  // captured request is useless by the time anyone could replay it.
  if (Math.abs(now.getTime() - sentAt) > 5 * 60_000) return false;

  const mac = createHmac('sha256', env.LOB_WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody.toString('utf8')}`);
  const digest = mac.digest();

  /*
   * Hex or base64, whichever the provider sent.
   *
   * Both are encodings of the SAME 32 bytes, so accepting either gives an
   * attacker nothing -- they still need the secret to produce either one. What
   * it does buy is the difference between a working integration and one where
   * every delivery event is silently rejected as forged. That failure mode is
   * particularly nasty here: certified mail would keep going out, letters would
   * keep arriving, and the proof of service the certified mail was bought for
   * would never reach the record.
   */
  for (const encoding of ['hex', 'base64'] as const) {
    const a = Buffer.from(digest.toString(encoding), 'utf8');
    const b = Buffer.from(signature, 'utf8');
    // Length first: timingSafeEqual throws on a mismatch. The comparison
    // itself stays constant-time.
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

/**
 * Lob's event names, mapped to what we store.
 *
 * Unknown events map to null and are recorded without changing status. A
 * provider adding an event type must never silently move a letter into a state
 * this system reasons about.
 */
export function mapEventType(eventType: string): string | null {
  const table: Record<string, string> = {
    'letter.created': 'submitted',
    'letter.rendered_pdf': 'submitted',
    'letter.mailed': 'in_transit',
    'letter.in_transit': 'in_transit',
    'letter.in_local_area': 'in_transit',
    'letter.processed_for_delivery': 'in_transit',
    'letter.delivered': 'delivered',
    'letter.re-routed': 'in_transit',
    'letter.returned_to_sender': 'returned',
    'letter.failed': 'failed',
  };
  return table[eventType] ?? null;
}

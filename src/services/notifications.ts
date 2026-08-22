/**
 * Notifications.
 *
 * Two layers, on purpose:
 *
 *   ocs.notifications             -- the in-app feed. Created in the same
 *                                    transaction as the event that caused it,
 *                                    so it cannot disagree with what happened.
 *   ocs.notification_deliveries   -- outbound email/SMS. Attempted by a job,
 *                                    with its own retry state.
 *
 * Splitting them means a mail outage degrades to "no email went out yet",
 * visible and retryable, rather than either losing the notification or blocking
 * the permit update that triggered it.
 *
 * When no email provider is configured the delivery row is marked failed with
 * an explicit reason. It is never marked sent, and never silently dropped:
 * "we told the customer" must not be a lie that lives in the database.
 */
import { env } from '../config/env.js';
import type { Tx } from '../db/tenant.js';
import { requestWithRetry } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { enqueue } from '../jobs/queue.js';

export type NotificationKind =
  | 'permit_status_changed'
  | 'permit_expiring'
  | 'corrections_required'
  | 'drafting_assigned'
  | 'drafting_ready_for_review'
  | 'drafting_approved'
  | 'document_uploaded'
  | 'license_expiring'
  | 'insurance_expiring'
  | 'message_received'
  | 'payment_succeeded'
  | 'payment_failed'
  | 'system';

export interface NotifyParams {
  companyId: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  entityType?: string;
  entityId?: string;
  linkPath?: string;
  /** Also send email. In-app is always created. */
  email?: { to: string; subject?: string } | null;
  /** Suppresses a repeat within the window (e.g. one expiry warning per day). */
  dedupeKey?: string;
}

export async function notify(tx: Tx, params: NotifyParams): Promise<string | null> {
  const row = await tx.one<{ id: string }>(
    `insert into ocs.notifications
       (company_id, user_id, kind, title, body, entity_type, entity_id, link_path)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id`,
    [
      params.companyId,
      params.userId,
      params.kind,
      params.title,
      params.body ?? null,
      params.entityType ?? null,
      params.entityId ?? null,
      params.linkPath ?? null,
    ],
  );

  if (!row) return null;

  if (params.email?.to) {
    const delivery = await tx.one<{ id: string }>(
      `insert into ocs.notification_deliveries
         (company_id, notification_id, channel, destination, provider)
       values ($1, $2, 'email', $3, $4)
       returning id`,
      [params.companyId, row.id, params.email.to, env.RESEND_API_KEY ? 'resend' : 'none'],
    );

    if (delivery) {
      await enqueue(tx, {
        jobType: 'notifications.deliver',
        queue: 'notifications',
        companyId: params.companyId,
        payload: {
          deliveryId: delivery.id,
          subject: params.email.subject ?? params.title,
          title: params.title,
          body: params.body ?? '',
          linkPath: params.linkPath ?? null,
        },
        ...(params.dedupeKey ? { dedupeKey: `notify:${params.dedupeKey}` } : {}),
      });
    }
  }

  return row.id;
}

export function emailConfigured(): boolean {
  return Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
}

export interface EmailResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
}

export async function sendEmail(params: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<EmailResult> {
  if (!emailConfigured()) {
    return {
      ok: false,
      error: 'No email provider configured (set RESEND_API_KEY and EMAIL_FROM)',
    };
  }

  const res = await requestWithRetry(
    'https://api.resend.com/emails',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [params.to],
        subject: params.subject,
        html: params.html,
        text: params.text,
      }),
    },
    // Sending is NOT idempotent -- a retry can deliver twice. We accept a
    // possible duplicate email (harmless) over a silently lost notification
    // (not harmless), but cap attempts low.
    { retryUnsafeMethod: true, attempts: 2, timeoutMs: 15_000, label: 'email.send' },
  );

  if (!res.ok) {
    logger.warn({ status: res.status }, 'email send failed');
    return { ok: false, error: `provider responded ${res.status}` };
  }

  const parsed = JSON.parse(res.body) as { id?: string };
  return { ok: true, providerMessageId: parsed.id };
}

/** Minimal HTML escape for values interpolated into notification emails. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderEmail(params: {
  title: string;
  body: string;
  linkPath: string | null;
  /** Button label. Defaults to the generic notification wording. */
  cta?: string;
}): { html: string; text: string } {
  const link = params.linkPath ? `${env.APP_BASE_URL.replace(/\/$/, '')}${params.linkPath}` : null;

  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5;color:#1a1a1a">
<h2 style="margin:0 0 12px">${escapeHtml(params.title)}</h2>
<p style="margin:0 0 16px">${escapeHtml(params.body).replace(/\n/g, '<br>')}</p>
${link ? `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 16px;background:#1f4fd8;color:#fff;text-decoration:none;border-radius:6px">${escapeHtml(params.cta ?? 'View in portal')}</a></p>` : ''}
<hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0">
<p style="font-size:12px;color:#666;margin:0">One Contractor Solutions</p>
</body></html>`;

  const text = [params.title, '', params.body, ...(link ? ['', link] : [])].join('\n');
  return { html, text };
}


/**
 * Send someone their invitation link.
 *
 * Sent by the API at request time rather than queued for the worker: an
 * invitation is the one email whose absence stops a person using the product
 * at all, and routing it through a background queue makes "did it go?" depend
 * on a second service being healthy. It is awaited so the caller can tell the
 * administrator whether it actually went out -- when it did not, the link is
 * still returned for them to pass on by hand, which is the only reason anybody
 * got in before this existed.
 */
export async function sendInviteEmail(params: {
  to: string;
  name: string | null;
  acceptPath: string;
}): Promise<EmailResult> {
  if (!emailConfigured()) {
    return { ok: false, error: 'No email provider configured (set RESEND_API_KEY and EMAIL_FROM)' };
  }

  const greeting = params.name?.trim() ? `${params.name.trim()}, you` : 'You';
  const { html, text } = renderEmail({
    title: 'Your One Contractor Solutions account',
    body:
      `${greeting} have been invited to One Contractor Solutions. ` +
      'Choose a password to finish setting up your account.\n\n' +
      'This link can only be used once, and it expires in seven days.',
    linkPath: params.acceptPath,
    cta: 'Choose your password',
  });

  const result = await sendEmail({
    to: params.to,
    subject: 'Set up your One Contractor Solutions account',
    html,
    text,
  });

  if (!result.ok) {
    logger.warn({ to: params.to, error: result.error }, 'invitation email not delivered');
  }
  return result;
}

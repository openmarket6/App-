/**
 * /api/generated-documents/:id/mail — posting an instrument, and proving it.
 *
 * The endpoint that spends money, so the order of operations is the design:
 *
 *   1. Check the document may be posted at all. A voided instrument never goes
 *      in an envelope.
 *   2. Check the addresses. An undeliverable address on a Notice to Owner is a
 *      failed service nobody notices for weeks.
 *   3. Write the mailing row as `queued`, INSIDE a transaction, before calling
 *      the provider. A crash after the letter is posted must leave a row we can
 *      reconcile, not silence.
 *   4. Post it with an idempotency key derived from that row.
 *   5. Record what the provider said, including what it actually charged.
 *
 * Step 3 is the one that looks like extra work and is not. Calling first and
 * writing after is how a system ends up having served a notice it has no record
 * of serving.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant, withServiceContext, type Tx } from '../../db/tenant.js';
import { requireApiAuth, requireCapability } from './auth.js';
import { parse, clientIp, userAgent } from '../../lib/http-helpers.js';
import { writeAudit } from '../../lib/audit.js';
import { notFound, badRequest, forbidden, conflict, serviceUnavailable } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { returnAddress } from '../../config/env.js';
import {
  isMailEnabled, verifyAddress, sendLetter,
} from '../../services/mail.js';
import {
  canMail, resolveMailClass, validateMailRequest, EXPECTED_COST_CENTS,
  MAIL_CLASS_LABELS, RECIPIENT_ROLE_LABELS,
  type MailAddress, type MailClass, type RecipientRole,
} from '../../domain/mailing.js';
import { type DocumentKind, DOCUMENT_KIND_LABELS } from '../../domain/documents/index.js';

const ADDRESS = z.object({
  name: z.string().trim().min(1).max(200),
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().min(1).max(120),
  state: z.string().trim().length(2),
  postalCode: z.string().trim().min(5).max(10),
});

const MAILING_SELECT = `
  m.id,
  m.company_id as "clientId",
  m.generated_document_id as "documentId",
  m.recipient_role as "recipientRole",
  m.mail_class as "mailClass",
  m.status,
  m.to_name as "toName",
  m.to_line1 as "toLine1",
  m.to_line2 as "toLine2",
  m.to_city as "toCity",
  m.to_state as "toState",
  m.to_postal_code as "toPostalCode",
  m.provider_id as "providerId",
  m.tracking_number as "trackingNumber",
  m.expected_cost_cents as "expectedCostCents",
  m.charged_cost_cents as "chargedCostCents",
  m.address_verified as "addressVerified",
  m.events,
  m.submitted_at as "submittedAt",
  m.delivered_at as "deliveredAt",
  m.returned_at as "returnedAt",
  m.expected_delivery_on as "expectedDeliveryOn",
  m.last_error as "lastError",
  m.created_at as "createdAt"
`;
const MAILING_RETURNING = MAILING_SELECT.replace(/\bm\./g, 'ocs.document_mailings.');

interface MailingRow {
  mailClass: string;
  recipientRole: string;
  [k: string]: unknown;
}

function present(row: MailingRow) {
  return {
    ...row,
    mailClassLabel: MAIL_CLASS_LABELS[row.mailClass as MailClass] ?? row.mailClass,
    recipientRoleLabel:
      RECIPIENT_ROLE_LABELS[row.recipientRole as RecipientRole] ?? row.recipientRole,
  };
}

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
    reason: `document_mailings_${auth.role}`,
    ...(requestedClientId ? { companyId: requestedClientId } : {}),
  });
}

export async function compatMailingRoutes(app: FastifyInstance): Promise<void> {
  /**
   * What posting this document would cost and how it would go.
   *
   * A GET so the screen can show the price and the class BEFORE anyone commits.
   * Certified mail with return receipt is ten dollars a recipient; finding that
   * out after clicking is how people stop trusting a button.
   */
  app.get(
    '/api/generated-documents/:id/mail-quote',
    { preHandler: [requireApiAuth, requireCapability('document:read')] },
    async (req) => {
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
      const q = parse(
        z.object({ recipients: z.coerce.number().int().min(1).max(20).default(1) }),
        req.query,
        'query',
      );

      return scoped(req, async (tx, companyId) => {
        const doc = await tx.one<{ kind: string; status: string }>(
          `select kind::text as kind, status::text as status
             from ocs.generated_documents
            where id = $1 and ($2::uuid is null or company_id = $2::uuid)`,
          [id, companyId],
        );
        if (!doc) throw notFound('Document');

        const kind = doc.kind as DocumentKind;
        const { mailClass } = resolveMailClass(kind);
        const each = EXPECTED_COST_CENTS[mailClass];
        const allowed = canMail(doc.status);

        return {
          kind,
          kindLabel: DOCUMENT_KIND_LABELS[kind],
          mailClass,
          mailClassLabel: MAIL_CLASS_LABELS[mailClass],
          costPerRecipientCents: each,
          recipients: q.recipients,
          totalCents: each * q.recipients,
          mailable: allowed.ok,
          reason: allowed.ok ? null : allowed.reason,
          configured: isMailEnabled(),
        };
      });
    },
  );

  app.get(
    '/api/generated-documents/:id/mailings',
    { preHandler: [requireApiAuth, requireCapability('document:read')] },
    async (req) => {
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
      return scoped(req, async (tx, companyId) => {
        const rows = await tx.many<MailingRow>(
          `select ${MAILING_SELECT}
             from ocs.document_mailings m
            where m.generated_document_id = $1
              and ($2::uuid is null or m.company_id = $2::uuid)
            order by m.created_at desc`,
          [id, companyId],
        );
        return { mailings: rows.map(present), total: rows.length };
      });
    },
  );

  /**
   * Post it.
   *
   * One recipient per call. Batching would make a partial failure ambiguous --
   * "three of five went" is not something a lien dispute can work with, and a
   * caller sending three letters can make three calls.
   */
  app.post(
    '/api/generated-documents/:id/mail',
    { preHandler: [requireApiAuth, requireCapability('document:record')] },
    async (req, reply) => {
      const auth = req.apiAuth!;
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
      const body = parse(
        z.object({
          to: ADDRESS,
          recipientRole: z.enum(['owner', 'contractor', 'lender', 'claimant', 'other'])
            .default('other'),
          /** May strengthen the class, never weaken it. See resolveMailClass. */
          mailClass: z.enum(['first_class', 'certified', 'certified_return_receipt']).optional(),
          /**
           * Post anyway when the address does not verify.
           *
           * Explicit, because an owner's address taken from a permit can be
           * right while the USPS database disagrees, and refusing outright would
           * make this system unable to serve exactly the notices that matter
           * most. Accepting it is a decision, and it is stored as one.
           */
          acceptUnverifiedAddress: z.boolean().optional(),
        }),
        req.body,
        'body',
      );

      if (!isMailEnabled()) {
        throw serviceUnavailable(
          'Physical mail is not configured on this server, so nothing was sent. ' +
            'No mailing record was created — a record of a letter that does not exist ' +
            'is worse than none, because somebody will rely on it.',
        );
      }

      const from = returnAddress();
      if (!from) {
        throw serviceUnavailable(
          'No return address is configured. Certified mail needs one: the signed ' +
            'receipt comes back to it, and without it a letter can arrive and still ' +
            'prove nothing.',
        );
      }

      const to: MailAddress = {
        name: body.to.name,
        line1: body.to.line1,
        line2: body.to.line2 ?? null,
        city: body.to.city,
        state: body.to.state.toUpperCase(),
        postalCode: body.to.postalCode,
        country: 'US',
      };

      // --- everything that must be true before a penny moves --------------
      const prepared = await scoped(req, async (tx, companyId) => {
        const doc = await tx.one<{
          id: string; company_id: string; kind: string; status: string;
          title: string; rendered_html: string;
        }>(
          `select id, company_id, kind::text as kind, status::text as status,
                  title, rendered_html
             from ocs.generated_documents
            where id = $1 and ($2::uuid is null or company_id = $2::uuid)`,
          [id, companyId],
        );
        if (!doc) throw notFound('Document');

        const allowed = canMail(doc.status);
        if (!allowed.ok) throw conflict(allowed.reason);

        const kind = doc.kind as DocumentKind;
        const { mailClass, downgradeRefused } = resolveMailClass(kind, body.mailClass);

        const problems = validateMailRequest({
          documentKind: kind, to, from, role: body.recipientRole,
        });
        if (problems.length > 0) {
          throw badRequest(
            'This cannot be posted yet — the address is incomplete or malformed.',
            { problems },
          );
        }

        return { doc, kind, mailClass, downgradeRefused };
      });

      // --- verify the address, still before spending ----------------------
      const verification = await verifyAddress(to);
      if (!verification.deliverable && body.acceptUnverifiedAddress !== true) {
        throw conflict(
          `The postal service does not recognise that address (${verification.deliverability}). ` +
            'Posting to it risks a failed service. Correct it, or re-send with ' +
            'acceptUnverifiedAddress to go ahead knowingly.',
          {
            deliverability: verification.deliverability,
            suggested: verification.corrected,
          },
        );
      }

      /*
       * Use Lob's corrected address when it offered one and we are accepting
       * its verification. Its correction is what the USPS will actually deliver
       * to, and a ZIP+4 on a certified letter is one fewer reason for it to
       * come back.
       */
      const finalTo = verification.deliverable && verification.corrected
        ? verification.corrected
        : to;

      // --- the row exists before the letter does --------------------------
      const queued = await scoped(req, async (tx, companyId) => {
        const row = await tx.one<{ id: string }>(
          `insert into ocs.document_mailings
             (company_id, generated_document_id, recipient_role, mail_class, status,
              to_name, to_line1, to_line2, to_city, to_state, to_postal_code,
              from_name, from_line1, from_line2, from_city, from_state, from_postal_code,
              expected_cost_cents, address_verified, address_verification, requested_by)
           values ($1, $2, $3::ocs.mail_recipient_role, $4::ocs.mail_class, 'queued',
                   $5,$6,$7,$8,$9,$10,
                   $11,$12,$13,$14,$15,$16,
                   $17, $18, $19::jsonb, $20)
           returning id`,
          [
            prepared.doc.company_id, id, body.recipientRole, prepared.mailClass,
            finalTo.name, finalTo.line1, finalTo.line2 ?? null, finalTo.city,
            finalTo.state, finalTo.postalCode,
            from.name, from.line1, from.line2 ?? null, from.city, from.state,
            from.postalCode,
            EXPECTED_COST_CENTS[prepared.mailClass],
            verification.deliverable,
            JSON.stringify({
              deliverability: verification.deliverability,
              acceptedUnverified: body.acceptUnverifiedAddress === true,
            }),
            auth.userId,
          ],
        );
        if (!row) throw badRequest('The mailing could not be recorded.');
        void companyId;
        return row.id;
      });

      // --- post it --------------------------------------------------------
      let sent;
      try {
        sent = await sendLetter({
          to: finalTo,
          from: { ...from, country: 'US' },
          html: prepared.doc.rendered_html,
          mailClass: prepared.mailClass,
          description: `${DOCUMENT_KIND_LABELS[prepared.kind]} — ${prepared.doc.title}`,
          // Derived from the row, with nothing time-based or random in it. That
          // is what makes a retry return the same letter instead of a second.
          idempotencyKey: `ocs-mailing-${queued}`,
        });
      } catch (err) {
        /*
         * The row stays. A failed send that leaves no trace is a letter
         * somebody will assume went out, and the next person to look at the
         * document sees no mailing and no reason for its absence.
         */
        await withServiceContext(
          (tx) => tx.query(
            `update ocs.document_mailings
                set status = 'failed',
                    last_error = $2,
                    events = events || $3::jsonb
              where id = $1`,
            [
              queued,
              err instanceof Error ? err.message : 'The provider refused the letter',
              JSON.stringify([{
                at: new Date().toISOString(),
                status: 'failed',
                detail: err instanceof Error ? err.message : 'refused',
              }]),
            ],
          ),
          { reason: 'mailing_failed' },
        ).catch((e: unknown) => logger.error({ err: e }, 'could not record mailing failure'));
        throw err;
      }

      const result = await withServiceContext(async (tx) => {
        const row = await tx.one<MailingRow>(
          `update ocs.document_mailings
              set status = 'submitted',
                  provider_id = $2,
                  tracking_number = $3,
                  expected_delivery_on = $4,
                  charged_cost_cents = $5,
                  submitted_at = now(),
                  events = events || $6::jsonb
            where id = $1
            returning ${MAILING_RETURNING}`,
          [
            queued, sent.providerId, sent.trackingNumber,
            sent.expectedDeliveryOn, sent.chargedCents,
            JSON.stringify([{
              at: new Date().toISOString(),
              status: 'submitted',
              detail: `Handed to the carrier as ${MAIL_CLASS_LABELS[prepared.mailClass]}`,
            }]),
          ],
        );

        await writeAudit(tx, {
          companyId: prepared.doc.company_id,
          actorUserId: auth.userId,
          actorEmail: auth.email,
          action: 'generated_document.mailed',
          entityType: 'generated_document',
          entityId: id,
          summary:
            `${DOCUMENT_KIND_LABELS[prepared.kind]} posted to ${body.recipientRole} ` +
            `as ${MAIL_CLASS_LABELS[prepared.mailClass]}`,
          after: {
            mailingId: queued,
            providerId: sent.providerId,
            trackingNumber: sent.trackingNumber,
            chargedCents: sent.chargedCents,
            addressVerified: verification.deliverable,
            acceptedUnverified: body.acceptUnverifiedAddress === true,
          },
          requestId: req.id,
          ipAddress: clientIp(req),
          userAgent: userAgent(req),
        });

        return row!;
      }, { reason: 'mailing_submitted' });

      reply.code(201);
      return {
        ...present(result),
        /*
         * Surfaced rather than silently applied. Somebody who asked for first
         * class on a Notice to Owner should learn that the statute decided
         * otherwise, not just see a bigger number on the invoice.
         */
        downgradeRefused: prepared.downgradeRefused,
        note: prepared.downgradeRefused
          ? `A ${DOCUMENT_KIND_LABELS[prepared.kind]} goes out as ` +
            `${MAIL_CLASS_LABELS[prepared.mailClass]}, which is what makes service ` +
            'provable. The cheaper class was not used.'
          : null,
      };
    },
  );
}

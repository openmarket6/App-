/**
 * Invoices, payments and refunds.
 *
 * Protections that matter here, and what each one actually prevents:
 *
 *   Idempotency-Key REQUIRED on payment creation and refunds.
 *     Prevents: a double-tapped Pay button, or a client retrying after a
 *     timeout, becoming two charges. The key is required rather than optional
 *     because the caller cannot be trusted to remember it on the one request
 *     where it matters.
 *
 *   MFA required for refunds.
 *     Prevents: a stolen password being enough to move money out.
 *
 *   Amounts are integer cents, and never taken from the client for an invoice.
 *     Prevents: a tampered request paying $1 against a $10,000 invoice. The
 *     amount is read from our own invoice row.
 *
 *   No card data is accepted by this API at all.
 *     Prevents: the application ever holding a PAN, and keeps it out of PCI
 *     scope. The browser talks to Stripe directly.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, principalOf, tenantOf } from '../auth/plugin.js';
import { withTenant } from '../db/tenant.js';
import { requireCompanyRole, requireMfa } from '../auth/rbac.js';
import { parse, header, clientIp, userAgent, created } from '../lib/http-helpers.js';
import { writeAudit } from '../lib/audit.js';
import { withIdempotency } from '../lib/idempotency.js';
import { notFound, badRequest, unprocessable, serviceUnavailable } from '../lib/errors.js';
import { paginationQuery, decodeCursor, buildPage } from '../lib/pagination.js';
import { createPaymentIntent, createRefund, isPaymentsEnabled, mapIntentStatus } from '../services/stripe.js';
import { logger } from '../lib/logger.js';

export async function paymentRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------------------
  // Invoices
  // ---------------------------------------------------------------------------

  app.get('/v1/invoices', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'viewer');

    const q = parse(
      paginationQuery.extend({
        status: z.enum(['draft', 'open', 'paid', 'void', 'uncollectible', 'past_due']).optional(),
      }),
      req.query,
      'query',
    );
    const cursor = decodeCursor(q.cursor);

    return withTenant(ctx, async (tx) => {
      const rows = await tx.many<{ id: string; created_at: string }>(
        `select id, invoice_number, status::text, subtotal_cents::text, tax_cents::text,
                total_cents::text, amount_paid_cents::text, currency,
                issued_on, due_on, paid_at, project_id, permit_id, memo, created_at
           from ocs.invoices
          where company_id = $1
            and deleted_at is null
            and ($2::ocs.invoice_status is null or status = $2::ocs.invoice_status)
            and ($3::timestamptz is null
                 or (created_at, id) < ($3::timestamptz, $4::uuid))
          order by created_at desc, id desc
          limit $5`,
        [ctx.companyId, q.status ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, q.limit + 1],
      );
      return buildPage(rows, q.limit);
    });
  });

  app.post('/v1/invoices', { preHandler: authenticate }, async (req, reply) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'admin');

    const body = parse(
      z.object({
        projectId: z.string().uuid().optional(),
        permitId: z.string().uuid().optional(),
        draftingOrderId: z.string().uuid().optional(),
        currency: z.string().length(3).default('usd'),
        dueOn: z.string().date().optional(),
        memo: z.string().trim().max(2000).optional(),
        lineItems: z
          .array(
            z.object({
              description: z.string().trim().min(1).max(300),
              quantity: z.number().positive().max(100000).default(1),
              unitPriceCents: z.number().int().nonnegative().max(1_000_000_00),
            }),
          )
          .min(1)
          .max(100),
        taxCents: z.number().int().nonnegative().max(1_000_000_00).default(0),
      }),
      req.body,
      'invoice',
    );

    // Totals are computed here, from the line items, and never accepted from
    // the client. A client-supplied total is a client-controlled price.
    const subtotal = body.lineItems.reduce(
      (sum, li) => sum + Math.round(li.quantity * li.unitPriceCents),
      0,
    );
    const total = subtotal + body.taxCents;

    const invoice = await withTenant(ctx, async (tx) => {
      const row = await tx.one<{ id: string; invoice_number: number }>(
        `insert into ocs.invoices
           (company_id, project_id, permit_id, drafting_order_id, status,
            subtotal_cents, tax_cents, total_cents, currency, issued_on, due_on,
            memo, created_by)
         values ($1,$2,$3,$4,'open',$5,$6,$7,$8,current_date,$9,$10,$11)
         returning id, invoice_number, status::text, total_cents::text, currency, due_on`,
        [
          ctx.companyId,
          body.projectId ?? null,
          body.permitId ?? null,
          body.draftingOrderId ?? null,
          subtotal,
          body.taxCents,
          total,
          body.currency,
          body.dueOn ?? null,
          body.memo ?? null,
          p.userId,
        ],
      );
      if (!row) throw badRequest('Could not create invoice');

      for (const [index, li] of body.lineItems.entries()) {
        await tx.query(
          `insert into ocs.invoice_line_items
             (company_id, invoice_id, description, quantity, unit_price_cents,
              amount_cents, sort_order)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [
            ctx.companyId,
            row.id,
            li.description,
            li.quantity,
            li.unitPriceCents,
            Math.round(li.quantity * li.unitPriceCents),
            index,
          ],
        );
      }

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'invoice.created',
        entityType: 'invoice',
        entityId: row.id,
        summary: `Invoice #${row.invoice_number} for ${(total / 100).toFixed(2)} ${body.currency.toUpperCase()}`,
        after: { totalCents: total, currency: body.currency },
        requestId: req.id,
        ipAddress: clientIp(req),
        userAgent: userAgent(req),
      });

      return row;
    });

    return created(reply, invoice);
  });

  app.get('/v1/invoices/:id', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'viewer');

    const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');

    return withTenant(ctx, async (tx) => {
      const invoice = await tx.one(
        `select id, invoice_number, status::text, subtotal_cents::text, tax_cents::text,
                total_cents::text, amount_paid_cents::text, currency, issued_on, due_on,
                paid_at, project_id, permit_id, memo, created_at
           from ocs.invoices
          where id = $1 and company_id = $2 and deleted_at is null`,
        [id, ctx.companyId],
      );
      if (!invoice) throw notFound('Invoice');

      const lineItems = await tx.many(
        `select id, description, quantity, unit_price_cents::text, amount_cents::text, sort_order
           from ocs.invoice_line_items
          where invoice_id = $1 and company_id = $2
          order by sort_order`,
        [id, ctx.companyId],
      );

      const payments = await tx.many(
        `select id, status::text, amount_cents::text, amount_refunded_cents::text,
                currency, payment_method_brand, payment_method_last4, succeeded_at, created_at
           from ocs.payments
          where invoice_id = $1 and company_id = $2
          order by created_at desc`,
        [id, ctx.companyId],
      );

      return { ...invoice, lineItems, payments };
    });
  });

  // ---------------------------------------------------------------------------
  // Payments
  // ---------------------------------------------------------------------------

  app.get('/v1/payments', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'admin');

    const q = parse(paginationQuery, req.query, 'query');
    const cursor = decodeCursor(q.cursor);

    return withTenant(ctx, async (tx) => {
      const rows = await tx.many<{ id: string; created_at: string }>(
        `select id, invoice_id, permit_id, direction::text, status::text,
                amount_cents::text, amount_refunded_cents::text, currency,
                payment_method_brand, payment_method_last4, description,
                failure_code, failure_message, reconciled_at, succeeded_at, created_at
           from ocs.payments
          where company_id = $1
            and ($2::timestamptz is null
                 or (created_at, id) < ($2::timestamptz, $3::uuid))
          order by created_at desc, id desc
          limit $4`,
        [ctx.companyId, cursor?.createdAt ?? null, cursor?.id ?? null, q.limit + 1],
      );
      return buildPage(rows, q.limit);
    });
  });

  /**
   * Start a payment. Returns a Stripe client secret for the browser to confirm.
   *
   * The client secret is safe to return: it authorises confirming this one
   * intent and nothing else. The Stripe SECRET key never leaves this server.
   */
  app.post('/v1/payments/intent', { preHandler: authenticate }, async (req, reply) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'admin');

    if (!isPaymentsEnabled()) {
      throw serviceUnavailable('Payments are not configured');
    }

    const idempotencyKey = header(req, 'idempotency-key');
    if (!idempotencyKey) {
      // Required, not optional: without it a retry becomes a second charge, and
      // the client is exactly the party that cannot be relied on to notice.
      throw badRequest(
        'An Idempotency-Key header is required when creating a payment',
      );
    }

    const body = parse(
      z.object({
        invoiceId: z.string().uuid(),
        description: z.string().trim().max(300).optional(),
      }),
      req.body,
      'payment',
    );

    const outcome = await withTenant(ctx, async (tx) =>
      withIdempotency(
        tx,
        {
          companyId: ctx.companyId,
          endpoint: 'POST /v1/payments/intent',
          key: idempotencyKey,
          body,
        },
        async () => {
          const invoice = await tx.one<{
            id: string;
            status: string;
            total_cents: string;
            amount_paid_cents: string;
            currency: string;
          }>(
            `select id, status::text, total_cents::text, amount_paid_cents::text, currency
               from ocs.invoices
              where id = $1 and company_id = $2 and deleted_at is null
              for update`,
            [body.invoiceId, ctx.companyId],
          );
          if (!invoice) throw notFound('Invoice');

          if (invoice.status === 'paid') {
            throw unprocessable('This invoice is already paid');
          }
          if (invoice.status === 'void') {
            throw unprocessable('This invoice has been voided');
          }

          // Amount comes from our record, not the request.
          const outstanding = Number(invoice.total_cents) - Number(invoice.amount_paid_cents);
          if (outstanding <= 0) {
            throw unprocessable('This invoice has no outstanding balance');
          }

          const intent = await createPaymentIntent({
            amountCents: outstanding,
            currency: invoice.currency,
            companyId: ctx.companyId,
            invoiceId: invoice.id,
            description: body.description ?? `Invoice payment`,
            // Reusing the caller's key means a retry reaches Stripe as the same
            // request too, not just the same request to us.
            idempotencyKey: `${ctx.companyId}:${idempotencyKey}`,
          });

          const payment = await tx.one<{ id: string }>(
            `insert into ocs.payments
               (company_id, invoice_id, direction, status, amount_cents, currency,
                provider, provider_payment_intent_id, idempotency_key,
                description, initiated_by)
             values ($1,$2,'inbound',$3::ocs.payment_status,$4,$5,'stripe',$6,$7,$8,$9)
             on conflict (provider, provider_payment_intent_id)
               where provider_payment_intent_id is not null
               do update set status = excluded.status
             returning id`,
            [
              ctx.companyId,
              invoice.id,
              mapIntentStatus(intent.status),
              outstanding,
              invoice.currency,
              intent.id,
              idempotencyKey,
              body.description ?? null,
              p.userId,
            ],
          );

          await writeAudit(tx, {
            companyId: ctx.companyId,
            actorUserId: p.userId,
            actorEmail: p.email,
            action: 'payment.intent_created',
            entityType: 'payment',
            entityId: payment?.id ?? null,
            summary: `Payment intent for ${(outstanding / 100).toFixed(2)} ${invoice.currency.toUpperCase()}`,
            after: { amountCents: outstanding, invoiceId: invoice.id },
            requestId: req.id,
            ipAddress: clientIp(req),
            userAgent: userAgent(req),
          });

          return {
            status: 201,
            body: {
              paymentId: payment?.id ?? null,
              amountCents: outstanding,
              currency: invoice.currency,
              clientSecret: intent.client_secret,
              publishableKeyRequired: true,
            },
          };
        },
      ),
    );

    reply.code(outcome.status);
    if (outcome.replayed) reply.header('idempotent-replay', 'true');
    return outcome.body;
  });

  /**
   * Refund a payment. Admin + MFA + idempotency key.
   */
  app.post('/v1/payments/:id/refund', { preHandler: authenticate }, async (req, reply) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'admin');
    requireMfa(p);

    if (!isPaymentsEnabled()) throw serviceUnavailable('Payments are not configured');

    const idempotencyKey = header(req, 'idempotency-key');
    if (!idempotencyKey) {
      throw badRequest('An Idempotency-Key header is required when issuing a refund');
    }

    const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
    const body = parse(
      z.object({
        amountCents: z.number().int().positive().optional(),
        reason: z.enum(['duplicate', 'fraudulent', 'requested_by_customer']).optional(),
        note: z.string().trim().max(1000).optional(),
      }),
      req.body,
      'refund',
    );

    const outcome = await withTenant(ctx, async (tx) =>
      withIdempotency(
        tx,
        {
          companyId: ctx.companyId,
          endpoint: 'POST /v1/payments/:id/refund',
          key: idempotencyKey,
          body: { id, ...body },
        },
        async () => {
          const payment = await tx.one<{
            id: string;
            status: string;
            amount_cents: string;
            amount_refunded_cents: string;
            provider_payment_intent_id: string | null;
            currency: string;
          }>(
            `select id, status::text, amount_cents::text, amount_refunded_cents::text,
                    provider_payment_intent_id, currency
               from ocs.payments
              where id = $1 and company_id = $2
              for update`,
            [id, ctx.companyId],
          );
          if (!payment) throw notFound('Payment');

          if (payment.status !== 'succeeded' && payment.status !== 'partially_refunded') {
            throw unprocessable(`A payment with status "${payment.status}" cannot be refunded`);
          }
          if (!payment.provider_payment_intent_id) {
            throw unprocessable('This payment has no provider reference to refund against');
          }

          const alreadyRefunded = Number(payment.amount_refunded_cents);
          const refundable = Number(payment.amount_cents) - alreadyRefunded;
          const amount = body.amountCents ?? refundable;

          // Refusing an over-refund here rather than letting Stripe reject it
          // keeps our records and theirs in agreement.
          if (amount > refundable) {
            throw unprocessable(
              `Refund of ${amount} exceeds the refundable balance of ${refundable}`,
            );
          }

          const refund = await createRefund({
            paymentIntentId: payment.provider_payment_intent_id,
            amountCents: amount,
            ...(body.reason ? { reason: body.reason } : {}),
            idempotencyKey: `${ctx.companyId}:refund:${idempotencyKey}`,
          });

          const row = await tx.one<{ id: string }>(
            `insert into ocs.refunds
               (company_id, payment_id, amount_cents, currency, status, reason,
                provider, provider_refund_id, idempotency_key, requested_by)
             values ($1,$2,$3,$4,$5,$6,'stripe',$7,$8,$9)
             returning id`,
            [
              ctx.companyId,
              payment.id,
              amount,
              payment.currency,
              refund.status === 'succeeded' ? 'succeeded' : 'pending',
              body.reason ?? body.note ?? null,
              refund.id,
              idempotencyKey,
              p.userId,
            ],
          );

          // The authoritative refunded total still arrives via the
          // charge.refunded webhook; this is the optimistic local update.
          await tx.query(
            `update ocs.payments
                set amount_refunded_cents = amount_refunded_cents + $2,
                    status = case when amount_refunded_cents + $2 >= amount_cents
                                  then 'refunded'::ocs.payment_status
                                  else 'partially_refunded'::ocs.payment_status end
              where id = $1`,
            [payment.id, amount],
          );

          await writeAudit(tx, {
            companyId: ctx.companyId,
            actorUserId: p.userId,
            actorEmail: p.email,
            action: 'payment.refunded',
            entityType: 'payment',
            entityId: payment.id,
            summary: `Refunded ${(amount / 100).toFixed(2)} ${payment.currency.toUpperCase()}`,
            after: { amountCents: amount, reason: body.reason ?? null, note: body.note ?? null },
            requestId: req.id,
            ipAddress: clientIp(req),
            userAgent: userAgent(req),
          });

          logger.info(
            { paymentId: payment.id, amountCents: amount, actor: p.userId },
            'refund issued',
          );

          return {
            status: 201,
            body: { refundId: row?.id ?? null, amountCents: amount, status: refund.status },
          };
        },
      ),
    );

    reply.code(outcome.status);
    if (outcome.replayed) reply.header('idempotent-replay', 'true');
    return outcome.body;
  });

  /** Mark a payment reconciled against a bank record. */
  app.post('/v1/payments/:id/reconcile', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'admin');

    const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
    const body = parse(
      z.object({ note: z.string().trim().max(500).optional() }),
      req.body,
      'reconciliation',
    );

    return withTenant(ctx, async (tx) => {
      const row = await tx.one<{ id: string }>(
        `update ocs.payments
            set reconciled_at = now(), reconciliation_note = $3
          where id = $1 and company_id = $2 and status = 'succeeded'
          returning id, reconciled_at`,
        [id, ctx.companyId, body.note ?? null],
      );
      if (!row) throw notFound('Succeeded payment');

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'payment.reconciled',
        entityType: 'payment',
        entityId: id,
        after: { note: body.note ?? null },
        requestId: req.id,
      });

      return row;
    });
  });
}

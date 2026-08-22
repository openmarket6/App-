/**
 * /api/billing/invoices — what a contractor owes, and what for.
 *
 * THE ONE RULE THIS FILE EXISTS TO KEEP: our fee and the agency's fee are never
 * blended. A permit invoice carries two kinds of money -- what this firm charged
 * for its work, and what the building department charged, which we advanced and
 * are recovering at cost. A contractor who finds a $412 county fee billed at
 * $495 stops believing every other number on the invoice, and they are right to.
 *
 * So totals come from invoiceTotals in src/shared -- the same function the
 * screen uses -- and pass-through lines are summed separately by construction
 * rather than by every caller remembering to. The database refuses a
 * pass-through line that is not a government fee (0030).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant, withServiceContext, type Tx } from '../../db/tenant.js';
import { requireApiAuth, requireCapability } from './auth.js';
import { parse, clientIp } from '../../lib/http-helpers.js';
import { writeAudit } from '../../lib/audit.js';
import { notFound, badRequest, forbidden, conflict } from '../../lib/errors.js';
import { invoiceTotals, SERVICE_LINES, type InvoiceLine } from '../../shared/billing.js';
import { env } from '../../config/env.js';

/** Stored status <-> the frontend's vocabulary. */
const TO_OUTWARD: Record<string, string> = {
  draft: 'DRAFT',
  open: 'SENT',
  paid: 'PAID',
  past_due: 'OVERDUE',
  void: 'VOID',
  uncollectible: 'VOID',
};

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
    reason: `invoices_${auth.role}`,
    ...(requestedClientId ? { companyId: requestedClientId } : {}),
  });
}

const SELECT = `
  i.id,
  i.company_id as "clientId",
  coalesce(i.invoice_number::text, left(i.id::text, 8)) as number,
  i.service_line::text as "serviceLine",
  i.status::text as "storedStatus",
  i.issued_on as "issuedAt",
  i.due_on as "dueAt",
  i.paid_at as "paidAt",
  i.subtotal_cents as "subtotalCents",
  i.pass_through_cents as "passThroughCents",
  i.total_cents as "totalCents",
  i.amount_paid_cents as "amountPaidCents",
  i.quickbooks_invoice_id as "quickbooksInvoiceId",
  i.stripe_invoice_id as "stripeInvoiceId",
  i.created_at as "createdAt"
`;

interface Row {
  storedStatus: string;
  totalCents: string | number;
  amountPaidCents: string | number;
  dueAt: string | null;
  [k: string]: unknown;
}

/**
 * PARTIAL and OVERDUE are derived, not stored.
 *
 * Both are facts about the relationship between an amount, a payment and a
 * date, and all three move. A stored status is a status that is wrong the
 * morning after a due date passes.
 */
function present(row: Row, lines: InvoiceLine[] = []) {
  const { storedStatus, ...rest } = row;
  const total = Number(row.totalCents ?? 0);
  const paid = Number(row.amountPaidCents ?? 0);

  let status = TO_OUTWARD[storedStatus] ?? 'DRAFT';
  if (status !== 'PAID' && status !== 'VOID' && status !== 'DRAFT') {
    if (paid > 0 && paid < total) status = 'PARTIAL';
    else if (row.dueAt && new Date(row.dueAt) < new Date() && paid < total) status = 'OVERDUE';
  }

  return {
    ...rest,
    totalCents: total,
    amountPaidCents: paid,
    subtotalCents: Number(rest['subtotalCents'] ?? 0),
    passThroughCents: Number(rest['passThroughCents'] ?? 0),
    status,
    lines,
  };
}

export async function compatInvoiceRoutes(app: FastifyInstance): Promise<void> {
  /** Our fee per trade. Editable, because it is a commercial decision. */
  app.get(
    '/api/billing/rates',
    { preHandler: [requireApiAuth, requireCapability('billing:read')] },
    async () =>
      withServiceContext(
        async (tx) => {
          const rows = await tx.many<{
            trade: string; feeCents: string; manualSurchargeCents: string;
            resubmittalCents: string; active: boolean; updatedAt: string; updatedByName: string | null;
          }>(
            `select r.trade, r.fee_cents as "feeCents",
                    r.manual_surcharge_cents as "manualSurchargeCents",
                    r.resubmittal_cents as "resubmittalCents",
                    r.is_active as active, r.updated_at as "updatedAt",
                    u.name as "updatedByName"
               from ocs.trade_rates r
               left join ocs.app_users u on u.id = r.updated_by
              order by r.trade`,
          );

          const rates = rows.map((r) => ({
            trade: r.trade,
            feeCents: Number(r.feeCents),
            manualSurchargeCents: Number(r.manualSurchargeCents),
            resubmittalCents: Number(r.resubmittalCents),
            active: r.active,
          }));

          const newest = rows.reduce<string | null>(
            (acc, r) => (!acc || r.updatedAt > acc ? r.updatedAt : acc), null,
          );

          return {
            rates,
            updatedAt: newest ?? new Date().toISOString(),
            updatedBy: rows.find((r) => r.updatedAt === newest)?.updatedByName ?? null,
          };
        },
        { reason: 'read_rate_book' },
      ),
  );

  /** Change a price. */
  app.put(
    '/api/billing/rates',
    { preHandler: [requireApiAuth, requireCapability('billing:manage')] },
    async (req) => {
      const auth = req.apiAuth!;
      const body = parse(
        z.object({
          rates: z.array(z.object({
            trade: z.string().trim().min(1).max(40),
            feeCents: z.number().int().min(0),
            manualSurchargeCents: z.number().int().min(0),
            resubmittalCents: z.number().int().min(0),
            active: z.boolean().default(true),
          })).min(1).max(50),
        }),
        req.body,
        'rate book',
      );

      return withServiceContext(
        async (tx) => {
          for (const r of body.rates) {
            await tx.query(
              `insert into ocs.trade_rates
                 (trade, fee_cents, manual_surcharge_cents, resubmittal_cents, is_active, updated_by)
               values ($1,$2,$3,$4,$5,$6)
               on conflict (trade) do update
                 set fee_cents = excluded.fee_cents,
                     manual_surcharge_cents = excluded.manual_surcharge_cents,
                     resubmittal_cents = excluded.resubmittal_cents,
                     is_active = excluded.is_active,
                     updated_by = excluded.updated_by`,
              [r.trade, r.feeCents, r.manualSurchargeCents, r.resubmittalCents, r.active, auth.userId],
            );
          }

          /**
           * Audited as a whole rather than per row. A price change is one
           * commercial decision, and reading it back as seven separate entries
           * loses the fact that they were made together.
           */
          await writeAudit(tx, {
            actorUserId: auth.userId,
            actorEmail: auth.email,
            action: 'billing.rates_changed',
            entityType: 'trade_rates',
            summary: `Rate book updated (${body.rates.length} trades)`,
            after: { rates: body.rates },
            requestId: req.id,
            ipAddress: clientIp(req),
          });

          return { updated: body.rates.length };
        },
        { reason: 'update_rate_book' },
      );
    },
  );

  app.get(
    '/api/billing/invoices',
    { preHandler: [requireApiAuth, requireCapability('billing:read')] },
    async (req) => {
      const q = parse(
        z.object({
          clientId: z.string().uuid().optional(),
          /*
           * Filtered after presenting, not in SQL.
           *
           * PARTIAL and OVERDUE are derived from the relationship between an
           * amount, a payment and a date -- neither is a value the status
           * column can hold. A `where status = 'OVERDUE'` would have matched
           * nothing while looking exactly like a working filter, and those two
           * are the statuses anybody actually asks for.
           */
          status: z.enum([
            'DRAFT', 'SENT', 'PARTIAL', 'OVERDUE', 'PAID', 'VOID',
          ]).optional(),
        }),
        req.query,
        'query',
      );

      return scoped(
        req,
        async (tx, companyId) => {
          const rows = await tx.many<Row>(
            `select ${SELECT} from ocs.invoices i
              where i.deleted_at is null
                and ($1::uuid is null or i.company_id = $1::uuid)
              order by i.created_at desc
              limit 500`,
            [companyId],
          );

          const lineRows = await tx.many<{
            invoice_id: string; description: string; quantity: number;
            unit_price_cents: string; pass_through: boolean; permit_id: string | null;
          }>(
            `select l.invoice_id, l.description, l.quantity,
                    l.unit_price_cents, l.pass_through, l.permit_id
               from ocs.invoice_line_items l
               join ocs.invoices i on i.id = l.invoice_id
              where i.deleted_at is null
                and ($1::uuid is null or i.company_id = $1::uuid)
              order by l.sort_order, l.id`,
            [companyId],
          );

          const byInvoice = new Map<string, InvoiceLine[]>();
          for (const l of lineRows) {
            const list = byInvoice.get(l.invoice_id) ?? [];
            list.push({
              description: l.description,
              quantity: Number(l.quantity),
              unitCents: Number(l.unit_price_cents),
              passThrough: l.pass_through,
              permitId: l.permit_id,
            });
            byInvoice.set(l.invoice_id, list);
          }

          const invoices = rows
            .map((r) => present(r, byInvoice.get(r['id'] as string) ?? []))
            // The parameter was accepted and then never applied, so every
            // caller asking for one status got all of them and had no way to
            // tell. Totals below describe the set that was asked for.
            .filter((i) => !q.status || i.status === q.status);

          return {
            invoices,
            total: invoices.length,
            // What is actually still owed, not what was billed.
            outstandingCents: invoices
              .filter((i) => i.status !== 'PAID' && i.status !== 'VOID')
              .reduce((sum, i) => sum + (i.totalCents - i.amountPaidCents), 0),
          };
        },
        q.clientId ?? null,
      );
    },
  );

  /** Raise an invoice. */
  app.post(
    '/api/billing/invoices',
    { preHandler: [requireApiAuth, requireCapability('billing:manage')] },
    async (req, reply) => {
      const auth = req.apiAuth!;
      const body = parse(
        z.object({
          clientId: z.string().uuid(),
          serviceLine: z.enum(SERVICE_LINES as unknown as [string, ...string[]]).default('EXPEDITING'),
          permitIds: z.array(z.string().uuid()).max(100).optional(),
          lines: z.array(z.object({
            description: z.string().trim().min(1).max(300),
            quantity: z.number().min(0.01).max(10000),
            unitCents: z.number().int(),
            passThrough: z.boolean().default(false),
            permitId: z.string().uuid().nullable().optional(),
          })).min(1).max(200),
          dueAt: z.string().date().optional(),
          memo: z.string().max(2000).optional(),
          /*
           * Bill the agency's own fees on to the contractor.
           *
           * The create drawer has always had this switch, on by default, and
           * sent it here where nothing read it -- and `permitIds` was accepted
           * and never used either. So selecting permits and ticking the box did
           * exactly nothing, and the invoice went out without the government
           * fees somebody believed they had just added.
           *
           * Honoured now, and as PASS-THROUGH lines specifically, which is the
           * one rule this file exists to keep: our fee and the agency's fee are
           * never mixed. A contractor has to be able to see which of the two
           * they are being asked for.
           */
          includeAgencyFees: z.boolean().default(false),
        }),
        req.body,
        'invoice',
      );

      const result = await withServiceContext(
        async (tx) => {
          const company = await tx.one<{ id: string }>(
            `select id from ocs.companies where id = $1 and deleted_at is null`,
            [body.clientId],
          );
          if (!company) throw notFound('Contractor');

          /*
           * Agency fees are read from the permits themselves, never taken from
           * the request. A fee the contractor is asked to reimburse has to be
           * the fee the agency actually charged, and a number that arrived in a
           * request body is a number somebody could have typed.
           *
           * Only permits belonging to THIS contractor, and only ones carrying a
           * recorded fee: a permit whose fee is not known yet is silently
           * absent rather than billed at zero, because a zero line reads as
           * "the agency charged nothing".
           */
          const lines: InvoiceLine[] = [...(body.lines as InvoiceLine[])];
          if (body.includeAgencyFees && body.permitIds && body.permitIds.length > 0) {
            const feeRows = await tx.many<{
              id: string; fee_cents: string; permit_number: string | null;
            }>(
              `select p.id,
                      round(p.fee_amount * 100)::bigint::text as fee_cents,
                      p.permit_number
                 from ocs.permits p
                where p.company_id = $1
                  and p.id = any($2::uuid[])
                  and p.deleted_at is null
                  and p.fee_amount is not null
                  and p.fee_amount > 0
                order by p.created_at`,
              [body.clientId, body.permitIds],
            );
            for (const row of feeRows) {
              lines.push({
                description: `Agency permit fee${row.permit_number ? ` — ${row.permit_number}` : ''}`,
                quantity: 1,
                unitCents: Number(row.fee_cents),
                passThrough: true,
                permitId: row.id,
              } as InvoiceLine);
            }
          }

          // Totals from the shared function, so this invoice adds up the same
          // way the screen that requested it said it would -- now including any
          // agency fees appended above.
          const totals = invoiceTotals(lines);

          const invoice = await tx.one<{ id: string }>(
            `insert into ocs.invoices
               (company_id, service_line, status, subtotal_cents, pass_through_cents,
                total_cents, due_on, memo, created_by,
                invoice_number)
             values ($1,$2::ocs.service_line,'draft',$3,$4,$5,$6::date,$7,$8,
                     (select coalesce(max(invoice_number), 1000) + 1 from ocs.invoices))
             returning id`,
            [
              body.clientId, body.serviceLine, totals.subtotalCents,
              totals.passThroughCents, totals.totalCents,
              body.dueAt ?? null, body.memo ?? null, auth.userId,
            ],
          );

          for (const [i, line] of lines.entries()) {
            await tx.query(
              `insert into ocs.invoice_line_items
                 (company_id, invoice_id, description, quantity, unit_price_cents,
                  amount_cents, sort_order, charge_kind, pass_through, permit_id)
               values ($1,$2,$3,$4,$5,$6,$7,$8::ocs.charge_kind,$9,$10)`,
              [
                body.clientId, invoice!.id, line.description, line.quantity,
                line.unitCents, Math.round(line.quantity * line.unitCents), i,
                // The database refuses a pass-through line that is not a
                // government fee, so the kind follows from the flag rather than
                // being a second thing to keep in step.
                line.passThrough ? 'government_fee' : 'per_permit',
                line.passThrough, line.permitId ?? null,
              ],
            );
          }

          await writeAudit(tx, {
            companyId: body.clientId,
            actorUserId: auth.userId,
            actorEmail: auth.email,
            action: 'billing.invoice_created',
            entityType: 'invoice',
            entityId: invoice!.id,
            summary:
              `Invoice raised: ${(totals.totalCents / 100).toFixed(2)} ` +
              `(${(totals.passThroughCents / 100).toFixed(2)} passed through at cost)`,
            after: totals,
            requestId: req.id,
            ipAddress: clientIp(req),
          });

          const row = await tx.one<Row>(`select ${SELECT} from ocs.invoices i where i.id = $1`, [invoice!.id]);
          return present(row!, body.lines as InvoiceLine[]);
        },
        { reason: 'create_invoice' },
      );

      reply.code(201);
      return result;
    },
  );

  /**
   * Issue it.
   *
   * The issue date is stamped here rather than accepted, because it starts the
   * clock on payment terms and a caller-supplied one can be backdated into an
   * invoice that was overdue before it was sent.
   */
  app.post(
    '/api/billing/invoices/:id/send',
    { preHandler: [requireApiAuth, requireCapability('billing:manage')] },
    async (req) => {
      const auth = req.apiAuth!;
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');

      return withServiceContext(
        async (tx) => {
          const before = await tx.one<{ id: string; status: string; company_id: string; total_cents: string }>(
            `select id, status::text as status, company_id, total_cents
               from ocs.invoices where id = $1 and deleted_at is null`,
            [id],
          );
          if (!before) throw notFound('Invoice');
          if (before.status !== 'draft') {
            throw conflict('That invoice has already been sent');
          }
          if (Number(before.total_cents) <= 0) {
            throw badRequest('An invoice for nothing cannot be sent');
          }

          await tx.query(
            `update ocs.invoices
                set status = 'open',
                    issued_on = current_date,
                    -- Net 30 unless a date was set when it was raised.
                    due_on = coalesce(due_on, current_date + 30)
              where id = $1`,
            [id],
          );

          await writeAudit(tx, {
            companyId: before.company_id,
            actorUserId: auth.userId,
            actorEmail: auth.email,
            action: 'billing.invoice_sent',
            entityType: 'invoice',
            entityId: id,
            summary: `Invoice sent: ${(Number(before.total_cents) / 100).toFixed(2)}`,
            requestId: req.id,
            ipAddress: clientIp(req),
          });

          const row = await tx.one<Row>(`select ${SELECT} from ocs.invoices i where i.id = $1`, [id]);
          return present(row!);
        },
        { reason: 'send_invoice' },
      );
    },
  );

  /**
   * Begin collecting a card.
   *
   * Answers 200 with `configured: false` when Stripe is not set up, rather than
   * failing. A deployment without payments yet is not a fault, and a 500 here
   * gives the person onboarding a contractor a dead form and no explanation.
   */
  app.post(
    '/api/billing/setup-intent',
    { preHandler: [requireApiAuth, requireCapability('billing:manage')] },
    async (req) => {
      const auth = req.apiAuth!;
      const body = parse(
        z.object({ clientId: z.string().uuid() }),
        req.body,
        'setup intent',
      );

      if (!env.STRIPE_SECRET_KEY) {
        return {
          configured: false,
          reason:
            'Card payments are not set up on this deployment yet. Everything else ' +
            'works; invoices can still be raised and settled outside the system.',
        };
      }

      const { createSetupIntent, ensureCustomer } = await import('../../services/stripe.js');

      return withServiceContext(
        async (tx) => {
          const company = await tx.one<{ id: string; name: string; stripe_customer_id: string | null }>(
            `select id, name, stripe_customer_id from ocs.companies
              where id = $1 and deleted_at is null`,
            [body.clientId],
          );
          if (!company) throw notFound('Contractor');

          const customerId = company.stripe_customer_id
            ?? (await ensureCustomer({ companyId: company.id, name: company.name })).id;

          if (!company.stripe_customer_id) {
            await tx.query(
              `update ocs.companies set stripe_customer_id = $2 where id = $1`,
              [company.id, customerId],
            );
          }

          const intent = await createSetupIntent(customerId);

          await writeAudit(tx, {
            companyId: company.id,
            actorUserId: auth.userId,
            actorEmail: auth.email,
            action: 'billing.setup_intent_created',
            entityType: 'company',
            entityId: company.id,
            summary: 'Card setup started',
            requestId: req.id,
            ipAddress: clientIp(req),
          });

          return {
            configured: true,
            clientSecret: intent.clientSecret,
            publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? null,
            customerId,
          };
        },
        { reason: 'stripe_setup_intent' },
      );
    },
  );
}

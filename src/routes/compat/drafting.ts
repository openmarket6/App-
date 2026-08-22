/**
 * /api/drafting — the addresses the shipped frontend actually calls.
 *
 * This exists because of a mistake worth naming. Engineering was built in
 * 0021 and mounted at /api/engineering/*, matching the vocabulary the business
 * uses internally. The compiled frontend calls /api/drafting/*, with its own
 * vocabulary: an order is a set of SERVICES with a brief, and it moves through
 * nine named statuses. Logic mounted at an address nothing calls is logic that
 * does not exist as far as a user is concerned.
 *
 * So this is not a second implementation. The quote gate and the seal still
 * live in the database (0021) where they cannot be bypassed; this module speaks
 * the frontend's language over the top of them.
 *
 * THE STATUS TRANSLATION IS THE INTERESTING PART. The frontend distinguishes
 * QUOTED from AWAITING_CLIENT_APPROVAL and has an AWAITING_SEAL state; the
 * stored status does not carry the quote's state at all, because the quote is
 * its own column with its own rules. So the outward status is DERIVED from both
 * -- computed in one function, here, rather than in each query that happens to
 * need it.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant, withServiceContext, type Tx } from '../../db/tenant.js';
import { requireApiAuth, requireCapability } from './auth.js';
import { parse, clientIp, userAgent } from '../../lib/http-helpers.js';
import { writeAudit } from '../../lib/audit.js';
import { notFound, badRequest, forbidden, conflict } from '../../lib/errors.js';

/** What the frontend shows. Not what the database stores. */
export type OutwardStatus =
  | 'REQUESTED' | 'QUOTED' | 'AWAITING_CLIENT_APPROVAL' | 'IN_PRODUCTION'
  | 'INTERNAL_REVIEW' | 'AWAITING_SEAL' | 'DELIVERED' | 'REVISION_REQUESTED'
  | 'CANCELLED';

const STORED_TO_OUTWARD: Record<string, OutwardStatus> = {
  requested: 'REQUESTED',
  accepted: 'REQUESTED',
  in_progress: 'IN_PRODUCTION',
  in_review: 'INTERNAL_REVIEW',
  awaiting_seal: 'AWAITING_SEAL',
  client_review: 'AWAITING_CLIENT_APPROVAL',
  revision_requested: 'REVISION_REQUESTED',
  approved: 'IN_PRODUCTION',
  delivered: 'DELIVERED',
  cancelled: 'CANCELLED',
};

const OUTWARD_TO_STORED: Partial<Record<OutwardStatus, string>> = {
  REQUESTED: 'requested',
  IN_PRODUCTION: 'in_progress',
  INTERNAL_REVIEW: 'in_review',
  AWAITING_SEAL: 'awaiting_seal',
  REVISION_REQUESTED: 'revision_requested',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
};

/**
 * The status a contractor should see.
 *
 * The quote takes precedence while it is live, because that is what the person
 * looking at the screen is actually waiting on. An order sitting in "requested"
 * with a quote out is not requested any more -- it is waiting for them.
 */
export function outwardStatus(stored: string, quoteStatus: string): OutwardStatus {
  if (stored === 'cancelled') return 'CANCELLED';

  if (quoteStatus === 'sent') return 'AWAITING_CLIENT_APPROVAL';
  if (quoteStatus === 'draft') return 'REQUESTED';
  if (quoteStatus === 'rejected') return 'REQUESTED';

  // An approved quote on work that has not started reads as QUOTED: priced,
  // agreed, not yet begun.
  if (quoteStatus === 'approved' && (stored === 'requested' || stored === 'accepted')) {
    return 'QUOTED';
  }

  return STORED_TO_OUTWARD[stored] ?? 'REQUESTED';
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
    reason: `drafting_${auth.role}`,
    ...(requestedClientId ? { companyId: requestedClientId } : {}),
  });
}

const SELECT = `
  o.id,
  o.company_id as "clientId",
  o.order_number as "orderNumber",
  o.project_id as "projectId",
  o.permit_id as "permitId",
  o.title,
  o.brief,
  o.services,
  o.status::text as "storedStatus",
  o.quote_status::text as "quoteStatus",
  o.quoted_cents as "quotedCents",
  o.quote_note as "quoteNote",
  o.quote_approved_at as "quoteApprovedAt",
  /*
   * The contract in src/shared/drafting.ts calls this approvedAt, and the page
   * reads approvedAt. Sending only quoteApprovedAt meant the approval date was
   * undefined on every row. Both names go out: the contract's name is what the
   * screen uses, and the stored name stays for anything reading the raw shape.
   */
  o.quote_approved_at as "approvedAt",
  o.quoted_at as "quotedAt",
  o.quoted_by as "quotedBy",
  o.target_delivery_at as "targetDeliveryAt",
  o.due_date as "dueDate",
  o.engineer_id as "engineerId",
  o.assigned_to as "assignedToUserId",
  o.priority::text as priority,
  o.delivered_at as "deliveredAt",
  /*
   * Does anything ordered here need a seal? The seal is a professional act
   * attached to the SERVICE, not the order, so it is read from the catalogue
   * rather than stored per order -- otherwise changing the catalogue would
   * leave old orders claiming a seal they no longer need, or missing one they
   * now do.
   */
  exists (
    select 1 from ocs.drafting_services ds
     where ds.service = any(o.services) and ds.requires_seal
  ) as "requiresSeal",
  o.created_at as "createdAt",
  o.updated_at as "updatedAt"
`;

type Row = Record<string, unknown> & { storedStatus: string; quoteStatus: string };

/**
 * One line telling whoever is looking what happens next.
 *
 * The page renders this directly. Nothing was sending it, so the column sat
 * empty on every row -- which on a work queue is the one column that matters.
 */
function draftingNextStep(status: string, quotedCents: unknown): string {
  switch (status) {
    case 'REQUESTED':
      return quotedCents == null ? 'Scope it and send a quote' : 'Send the quote for approval';
    case 'QUOTED':      return 'Waiting on the contractor to approve the quote';
    case 'APPROVED':    return 'Assign a designer and start the drawings';
    case 'IN_PROGRESS': return 'In production';
    case 'AWAITING_SEAL': return 'Waiting on an engineer to seal it';
    case 'DELIVERED':   return 'Delivered — nothing outstanding';
    case 'CANCELLED':   return 'Cancelled';
    case 'REVISION_REQUESTED': return 'Revision asked for — pick it back up';
    default:            return 'No action recorded';
  }
}

/** Adds the derived status the frontend reads, without hiding what is stored. */
const present = (row: Row) => ({
  ...row,
  status: outwardStatus(row.storedStatus, row.quoteStatus),
  nextStep: draftingNextStep(outwardStatus(row.storedStatus, row.quoteStatus), row['quotedCents']),
  /*
   * The contract declares these; this table has no columns for them yet.
   * Sending [] rather than nothing is the difference between an empty section
   * and a crash: the Deliver drawer called .length on satisfiesRequirementKeys
   * and, with no error boundary at the time, blanked the whole screen.
   */
  inputDocumentIds: (row['inputDocumentIds'] as string[]) ?? [],
  outputDocumentIds: (row['outputDocumentIds'] as string[]) ?? [],
  satisfiesRequirementKeys: (row['satisfiesRequirementKeys'] as string[]) ?? [],
});

export async function compatDraftingRoutes(app: FastifyInstance): Promise<void> {
  /** The service catalogue, so prices stop living inside a compiled bundle. */
  app.get(
    '/api/drafting/services',
    { preHandler: [requireApiAuth] },
    async () =>
      withServiceContext(
        async (tx) => {
          const services = await tx.many(
            `select service, label, base_cents as "baseCents",
                    quote_required as "quoteRequired",
                    typical_turnaround_days as "typicalTurnaroundDays",
                    requires_seal as "requiresSeal", is_active as active
               from ocs.drafting_services
              where is_active
              order by sort_order, label`,
          );
          return { services, total: services.length };
        },
        { reason: 'list_drafting_services' },
      ),
  );

  /** Every order this caller may see. */
  app.get(
    '/api/drafting',
    { preHandler: [requireApiAuth, requireCapability('drafting:read')] },
    async (req) => {
      const q = parse(
        z.object({
          clientId: z.string().uuid().optional(),
          projectId: z.string().uuid().optional(),
          open: z.enum(['true', '1', 'false', '0']).optional(),
        }),
        req.query,
        'query',
      );
      const openOnly = q.open === 'true' || q.open === '1';

      return scoped(
        req,
        async (tx, companyId) => {
          const rows = await tx.many<Row>(
            `select ${SELECT}
               from ocs.drafting_orders o
              where o.deleted_at is null
                and ($1::uuid is null or o.company_id = $1::uuid)
                and ($2::uuid is null or o.project_id = $2::uuid)
                and ($3::boolean is false or o.status not in ('delivered','cancelled'))
              order by o.created_at desc
              limit 500`,
            [companyId, q.projectId ?? null, openOnly],
          );

          const orders = rows.map(present);
          return {
            /*
             * `requests` is what DraftingListResponse declares and what the
             * page reads; `orders` is what this route has always sent. Only
             * `orders` went out, so Drafting.tsx read `requests`, got
             * undefined, fell back to [] and showed an empty queue however
             * much work was in it. Both names ship: the contract's name makes
             * the page work, and the original stays so nothing else breaks.
             */
            requests: orders,
            orders,
            total: orders.length,
            openCount: orders.filter(
              (o) => o.status !== 'DELIVERED' && o.status !== 'CANCELLED',
            ).length,
          };
        },
        q.clientId ?? null,
      );
    },
  );

  /** Request drafting work. */
  app.post(
    '/api/drafting',
    { preHandler: [requireApiAuth, requireCapability('drafting:read')] },
    async (req, reply) => {
      const auth = req.apiAuth!;
      const body = parse(
        z.object({
          clientId: z.string().uuid().optional(),
          projectId: z.string().uuid().nullable().optional(),
          permitId: z.string().uuid().nullable().optional(),
          services: z.array(z.string().max(60)).min(1).max(20),
          brief: z.string().trim().max(8000).optional(),
          inputDocumentIds: z.array(z.string().uuid()).max(50).optional(),
          title: z.string().trim().max(300).optional(),
        }),
        req.body,
        'drafting request',
      );

      /*
       * The company comes from the work, not from the caller restating it.
       *
       * A project belongs to exactly one contractor, so asking the caller to
       * name the contractor as well is redundant — and it failed closed: the
       * request drawer sends projectId and no clientId, so every drafting order
       * a staff member tried to raise came back "A drafting order must belong
       * to a contractor" while pointing at a project that plainly does.
       *
       * Resolved server-side, from the project or the permit, which also means
       * the answer cannot disagree with the row it is derived from.
       */
      let companyId = auth.role === 'CLIENT' ? auth.clientId : (body.clientId ?? null);
      if (!companyId && (body.projectId || body.permitId)) {
        companyId = await withServiceContext(
          async (tx) => {
            if (body.projectId) {
              const row = await tx.one<{ company_id: string }>(
                'select company_id from ocs.projects where id = $1 and deleted_at is null',
                [body.projectId],
              );
              if (row) return row.company_id;
            }
            if (body.permitId) {
              const row = await tx.one<{ company_id: string }>(
                'select company_id from ocs.permits where id = $1 and deleted_at is null',
                [body.permitId],
              );
              if (row) return row.company_id;
            }
            return null;
          },
          { reason: 'drafting_resolve_company' },
        );
      }
      if (!companyId) {
        throw badRequest(
          'A drafting order must belong to a contractor. Give a projectId, a ' +
            'permitId, or a clientId.',
        );
      }

      const result = await withServiceContext(
        async (tx) => {
          const known = await tx.many<{ service: string; quote_required: boolean; label: string }>(
            `select service, quote_required, label from ocs.drafting_services
              where service = any($1::text[]) and is_active`,
            [body.services],
          );
          const knownNames = new Set(known.map((k) => k.service));
          const unknown = body.services.filter((s) => !knownNames.has(s));
          if (unknown.length) {
            throw badRequest(`Not a service we offer: ${unknown.join(', ')}`);
          }

          if (body.projectId) {
            const project = await tx.one<{ id: string; company_id: string }>(
              `select id, company_id from ocs.projects where id = $1 and deleted_at is null`,
              [body.projectId],
            );
            if (!project) throw badRequest('No such project');
            if (project.company_id !== companyId) {
              throw forbidden('That project belongs to a different contractor');
            }
          }

          /**
           * If any ordered service is priced per job, the whole order is
           * quoted. Mixing quoted and fixed work on one order and charging the
           * fixed part immediately would bill a contractor for half a job they
           * have not agreed to yet.
           */
          const needsQuote = known.some((k) => k.quote_required);

          const created = await tx.one<{ id: string }>(
            `insert into ocs.drafting_orders
               (company_id, order_number, project_id, permit_id, title, brief,
                services, status, quote_status, requested_by)
             values (
               $1,
               (select coalesce(max(order_number), 1000) + 1 from ocs.drafting_orders),
               $2, $3, $4, $5, $6::text[], 'requested',
               case when $7::boolean then 'draft' else 'none' end::ocs.quote_status,
               $8
             )
             returning id`,
            [
              companyId, body.projectId ?? null, body.permitId ?? null,
              body.title ?? known.map((k) => k.label).join(', ').slice(0, 300),
              body.brief ?? null, body.services, needsQuote, auth.userId,
            ],
          );

          if (body.inputDocumentIds?.length) {
            // Marked as input so a survey the contractor sent is never mistaken
            // for something we drew.
            await tx.query(
              `update ocs.documents
                  set drafting_order_id = $1, drafting_role = 'input'
                where id = any($2::uuid[]) and company_id = $3 and deleted_at is null`,
              [created!.id, body.inputDocumentIds, companyId],
            );
          }

          await writeAudit(tx, {
            companyId,
            actorUserId: auth.userId,
            actorEmail: auth.email,
            action: 'drafting.requested',
            entityType: 'drafting_order',
            entityId: created!.id,
            summary: `Drafting requested: ${body.services.join(', ')}`,
            after: { services: body.services, needsQuote },
            requestId: req.id,
            ipAddress: clientIp(req),
            userAgent: userAgent(req),
          });

          const row = await tx.one<Row>(`select ${SELECT} from ocs.drafting_orders o where o.id = $1`, [created!.id]);
          return present(row!);
        },
        { reason: 'request_drafting' },
      );

      reply.code(201);
      return result;
    },
  );

  /** One order, with its documents. */
  app.get(
    '/api/drafting/:id',
    { preHandler: [requireApiAuth, requireCapability('drafting:read')] },
    async (req) => {
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');

      return scoped(req, async (tx, companyId) => {
        const row = await tx.one<Row>(
          `select ${SELECT} from ocs.drafting_orders o
            where o.id = $1 and o.deleted_at is null
              and ($2::uuid is null or o.company_id = $2::uuid)`,
          [id, companyId],
        );
        if (!row) throw notFound('Drafting order');

        const documents = await tx.many(
          `select id, name, drafting_role as "role", category::text as category,
                  created_at as "createdAt"
             from ocs.documents
            where drafting_order_id = $1 and deleted_at is null
            order by drafting_role, created_at`,
          [id],
        );

        return { ...present(row), documents };
      });
    },
  );

  /** Price the job. */
  app.post(
    '/api/drafting/:id/quote',
    { preHandler: [requireApiAuth, requireCapability('drafting:quote')] },
    async (req) => {
      const auth = req.apiAuth!;
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
      const body = parse(
        z.object({
          quotedCents: z.number().int().min(0),
          quoteNote: z.string().max(4000).nullable().optional(),
          targetDeliveryAt: z.string().datetime().nullable().optional(),
        }),
        req.body,
        'quote',
      );

      return withServiceContext(
        async (tx) => {
          const existing = await tx.one<{ id: string; quote_status: string; company_id: string }>(
            `select id, quote_status::text as quote_status, company_id
               from ocs.drafting_orders where id = $1 and deleted_at is null`,
            [id],
          );
          if (!existing) throw notFound('Drafting order');
          if (existing.quote_status === 'approved') {
            throw conflict(
              'This quote is already approved. Re-pricing it without the contractor ' +
                'agreeing again is how a job quietly becomes more expensive than what ' +
                'was agreed — move it back to draft first.',
            );
          }

          await tx.query(
            `update ocs.drafting_orders
                set quoted_cents = $2, quote_note = $3,
                    target_delivery_at = $4::timestamptz,
                    quote_status = 'sent', quoted_by = $5, quoted_at = now(),
                    quote_rejected_reason = null
              where id = $1`,
            [id, body.quotedCents, body.quoteNote ?? null, body.targetDeliveryAt ?? null, auth.userId],
          );

          await writeAudit(tx, {
            companyId: existing.company_id,
            actorUserId: auth.userId,
            actorEmail: auth.email,
            action: 'drafting.quote_sent',
            entityType: 'drafting_order',
            entityId: id,
            summary: `Quote sent: ${(body.quotedCents / 100).toFixed(2)}`,
            after: { quotedCents: body.quotedCents },
            requestId: req.id,
            ipAddress: clientIp(req),
          });

          const row = await tx.one<Row>(`select ${SELECT} from ocs.drafting_orders o where o.id = $1`, [id]);
          return present(row!);
        },
        { reason: 'quote_drafting' },
      );
    },
  );

  /**
   * The contractor accepts the price.
   *
   * Reachable by the contractor, because it is their decision and their money.
   * Once this lands the database will not let the amount change.
   */
  app.post(
    '/api/drafting/:id/approve',
    { preHandler: [requireApiAuth, requireCapability('drafting:read')] },
    async (req) => {
      const auth = req.apiAuth!;
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');

      return scoped(req, async (tx, companyId) => {
        const existing = await tx.one<{
          id: string; quote_status: string; quoted_cents: number | null; company_id: string;
        }>(
          `select id, quote_status::text as quote_status, quoted_cents, company_id
             from ocs.drafting_orders
            where id = $1 and deleted_at is null
              and ($2::uuid is null or company_id = $2::uuid)`,
          [id, companyId],
        );
        if (!existing) throw notFound('Drafting order');
        if (existing.quote_status === 'approved') {
          throw conflict('That quote has already been approved');
        }
        if (existing.quote_status !== 'sent') {
          throw conflict('There is no quote awaiting a decision on this order');
        }

        await tx.query(
          `update ocs.drafting_orders
              set quote_status = 'approved',
                  quote_approved_by = $2,
                  quote_approved_at = now(),
                  accepted_at = coalesce(accepted_at, now()),
                  status = case when status = 'requested'
                                then 'accepted'::ocs.drafting_status
                                else status end
            where id = $1`,
          [id, auth.userId],
        );

        await writeAudit(tx, {
          companyId: existing.company_id,
          actorUserId: auth.userId,
          actorEmail: auth.email,
          action: 'drafting.quote_approved',
          entityType: 'drafting_order',
          entityId: id,
          summary: `Quote approved${existing.quoted_cents != null ? ` at ${(existing.quoted_cents / 100).toFixed(2)}` : ''}`,
          requestId: req.id,
          ipAddress: clientIp(req),
          userAgent: userAgent(req),
        });

        const row = await tx.one<Row>(`select ${SELECT} from ocs.drafting_orders o where o.id = $1`, [id]);
        return present(row!);
      });
    },
  );

  /**
   * Hand the work over.
   *
   * Refused while any ordered service still needs a seal it does not have.
   * Delivering unsealed calculations is not a paperwork slip -- it is a permit
   * rejection two weeks later, after the contractor has scheduled a crew.
   */
  app.post(
    '/api/drafting/:id/deliver',
    { preHandler: [requireApiAuth, requireCapability('drafting:produce')] },
    async (req) => {
      const auth = req.apiAuth!;
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
      const body = parse(
        z.object({
          outputDocumentIds: z.array(z.string().uuid()).min(1).max(50),
          permitId: z.string().uuid().nullable().optional(),
          note: z.string().max(4000).optional(),
        }),
        req.body,
        'delivery',
      );

      return withServiceContext(
        async (tx) => {
          const order = await tx.one<{
            id: string; company_id: string; services: string[]; status: string;
          }>(
            `select id, company_id, services, status::text as status
               from ocs.drafting_orders where id = $1 and deleted_at is null`,
            [id],
          );
          if (!order) throw notFound('Drafting order');
          if (order.status === 'delivered') {
            throw conflict('That order has already been delivered');
          }

          await tx.query(
            `update ocs.documents
                set drafting_order_id = $1, drafting_role = 'output'
              where id = any($2::uuid[]) and company_id = $3 and deleted_at is null`,
            [id, body.outputDocumentIds, order.company_id],
          );

          const sealRequired = await tx.one<{ n: string }>(
            `select count(*)::text as n from ocs.drafting_services
              where service = any($1::text[]) and requires_seal`,
            [order.services],
          );

          if (Number(sealRequired?.n ?? 0) > 0) {
            const sealed = await tx.one<{ n: string }>(
              `select count(distinct s.document_id)::text as n
                 from ocs.document_seals s
                where s.document_id = any($1::uuid[])`,
              [body.outputDocumentIds],
            );
            if (Number(sealed?.n ?? 0) === 0) {
              throw conflict(
                'This order includes work that must be signed and sealed, and none of ' +
                  'the delivered documents carries a seal. Delivering unsealed ' +
                  'calculations means a permit rejection two weeks from now, after the ' +
                  'contractor has booked a crew.',
              );
            }
          }

          await tx.query(
            `update ocs.drafting_orders
                set status = 'delivered', delivered_at = now(),
                    permit_id = coalesce($2::uuid, permit_id)
              where id = $1`,
            [id, body.permitId ?? null],
          );

          await writeAudit(tx, {
            companyId: order.company_id,
            actorUserId: auth.userId,
            actorEmail: auth.email,
            action: 'drafting.delivered',
            entityType: 'drafting_order',
            entityId: id,
            summary: `Delivered ${body.outputDocumentIds.length} document(s)`,
            after: { documentIds: body.outputDocumentIds, note: body.note ?? null },
            requestId: req.id,
            ipAddress: clientIp(req),
          });

          const row = await tx.one<Row>(`select ${SELECT} from ocs.drafting_orders o where o.id = $1`, [id]);
          return present(row!);
        },
        { reason: 'deliver_drafting' },
      );
    },
  );

  /** Move an order through its workflow. */
  app.patch(
    '/api/drafting/:id',
    { preHandler: [requireApiAuth, requireCapability('drafting:produce')] },
    async (req) => {
      const auth = req.apiAuth!;
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
      const body = parse(
        z.object({
          status: z.enum([
            'REQUESTED', 'IN_PRODUCTION', 'INTERNAL_REVIEW', 'AWAITING_SEAL',
            'REVISION_REQUESTED', 'CANCELLED',
          ]).optional(),
          assignedToUserId: z.string().uuid().nullable().optional(),
          targetDeliveryAt: z.string().datetime().nullable().optional(),
          brief: z.string().max(8000).nullable().optional(),
        }).strict(),
        req.body,
        'drafting order',
      );

      const stored = body.status ? OUTWARD_TO_STORED[body.status] : null;

      return withServiceContext(
        async (tx) => {
          const before = await tx.one<{ id: string; status: string; company_id: string }>(
            `select id, status::text as status, company_id
               from ocs.drafting_orders where id = $1 and deleted_at is null`,
            [id],
          );
          if (!before) throw notFound('Drafting order');

          try {
            await tx.query(
              `update ocs.drafting_orders
                  set status = coalesce($2::ocs.drafting_status, status),
                      assigned_to = case when $3::boolean then $4::uuid else assigned_to end,
                      target_delivery_at = case when $5::boolean then $6::timestamptz
                                                else target_delivery_at end,
                      brief = case when $7::boolean then $8::text else brief end
                where id = $1`,
              [
                id, stored,
                body.assignedToUserId !== undefined, body.assignedToUserId ?? null,
                body.targetDeliveryAt !== undefined, body.targetDeliveryAt ?? null,
                body.brief !== undefined, body.brief ?? null,
              ],
            );
          } catch (err) {
            // The quote gate from 0021 refuses work that nobody authorised.
            const message = String((err as { message?: string })?.message ?? '');
            if (message.includes('has not been approved')) {
              throw conflict(
                'This order cannot start yet: its quote has not been approved by the ' +
                  'contractor. Work begun before approval is work nobody agreed to pay for.',
              );
            }
            if (message.includes('the quote was rejected')) {
              throw conflict('This order cannot start: the contractor rejected the quote.');
            }
            throw err;
          }

          if (body.status) {
            await writeAudit(tx, {
              companyId: before.company_id,
              actorUserId: auth.userId,
              actorEmail: auth.email,
              action: 'drafting.status_changed',
              entityType: 'drafting_order',
              entityId: id,
              summary: `Drafting order -> ${body.status}`,
              before: { status: before.status },
              after: { status: body.status },
              requestId: req.id,
              ipAddress: clientIp(req),
            });
          }

          const row = await tx.one<Row>(`select ${SELECT} from ocs.drafting_orders o where o.id = $1`, [id]);
          return present(row!);
        },
        { reason: 'update_drafting_order' },
      );
    },
  );
}

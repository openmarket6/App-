/**
 * /api/drafting and /api/engineering — plan sets, calculations, and the seal.
 *
 * Two things here are not ordinary CRUD and are worth stating plainly.
 *
 * THE QUOTE GATE. Drafting is quoted per job and approved before work starts.
 * That is not a workflow preference; it is what prevents the argument where
 * work is done, an invoice is sent, and the contractor says they never agreed
 * to the price. The database refuses to move an order into progress on an
 * unapproved quote, so no route -- including one written later -- can start
 * work that nobody authorised.
 *
 * THE SEAL. When an engineer seals a drawing they stake their own licence on
 * the statement that it is sound. It is a professional act, closer to a
 * notarization than to a file upload, and it is treated that way: the licence
 * details are copied onto the record, an expired licence cannot seal, and a
 * sealed record cannot be rewritten. See 0021.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant, withServiceContext, type Tx } from '../../db/tenant.js';
import { requireApiAuth, requireCapability } from './auth.js';
import { parse, clientIp, userAgent } from '../../lib/http-helpers.js';
import { writeAudit } from '../../lib/audit.js';
import { notFound, badRequest, forbidden, conflict } from '../../lib/errors.js';

const DELIVERABLE_TYPES = [
  'plan_set', 'structural_calcs', 'truss_layout', 'wind_load_calcs',
  'hvhz_product_approval', 'energy_calcs', 'site_plan', 'fema_worksheet',
  'noc_preparation', 'other',
] as const;

const ORDER_STATUSES = [
  'requested', 'accepted', 'in_progress', 'in_review', 'client_review',
  'revision_requested', 'approved', 'delivered', 'cancelled',
] as const;

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
    reason: `engineering_${auth.role}`,
    ...(requestedClientId ? { companyId: requestedClientId } : {}),
  });
}

/** Turns a database refusal into a sentence somebody can act on. */
function explain(err: unknown): never {
  const message = String((err as { message?: string })?.message ?? '');

  if (message.includes('has not been approved')) {
    throw conflict(
      'This order cannot start yet: its quote has not been approved by the contractor. ' +
        'Work begun before approval is work nobody agreed to pay for.',
    );
  }
  if (message.includes('the quote was rejected')) {
    throw conflict('This order cannot start: the contractor rejected the quote.');
  }
  if (message.includes('an approved quote cannot be re-priced')) {
    throw conflict(
      'An approved quote cannot be re-priced. If the scope has changed, move the ' +
        'quote back to draft and have the contractor approve the new price.',
    );
  }
  if (message.includes('drafting_quote_has_amount')) {
    throw badRequest('A quote needs a price before it can be sent.');
  }
  if (message.includes('cannot seal a drawing dated')) {
    throw badRequest(
      `${message.replace(/^.*?ERROR:\s*/, '')} A seal applied after the licence ` +
        'expired is void, so it cannot be recorded as valid.',
    );
  }
  if (message.includes('a seal is a finished record')) {
    throw conflict(
      'That seal is a finished record. Only its note and external reference may be ' +
        'amended; a change to the drawing needs a new seal.',
    );
  }
  if (message.includes('document_seals_one_per_version')) {
    throw conflict(
      'That version of the document has already been sealed. Two seals would mean ' +
        'two engineers each believing they took responsibility for it.',
    );
  }
  throw err as Error;
}

const ORDER_SELECT = `
  o.id, o.company_id as "clientId", o.order_number as "orderNumber",
  o.project_id as "projectId", o.permit_id as "permitId",
  o.title, o.description, o.status::text as status, o.priority::text as priority,
  o.engineer_id as "engineerId", e.display_name as "engineerName",
  o.assigned_to as "assignedTo", o.due_date as "dueDate",
  o.quote_status::text as "quoteStatus", o.quoted_cents as "quotedCents",
  o.quote_note as "quoteNote", o.quoted_at as "quotedAt",
  o.quote_expires_on as "quoteExpiresOn",
  o.quote_approved_at as "quoteApprovedAt",
  o.quote_rejected_reason as "quoteRejectedReason",
  o.accepted_at as "acceptedAt", o.started_at as "startedAt",
  o.delivered_at as "deliveredAt", o.current_revision as "currentRevision",
  o.created_at as "createdAt", o.updated_at as "updatedAt"
`;

const ORDER_FROM = `
  from ocs.drafting_orders o
  left join ocs.engineers e on e.id = o.engineer_id
`;

export async function compatEngineeringRoutes(app: FastifyInstance): Promise<void> {
  /** The engineers we have, and what each is licensed for. */
  app.get(
    '/api/engineering/engineers',
    { preHandler: [requireApiAuth, requireCapability('drafting:read')] },
    async () =>
      withServiceContext(
        async (tx) => {
          const engineers = await tx.many(
            `select e.id, e.user_id as "userId", e.display_name as "displayName",
                    e.license_type::text as "licenseType",
                    e.license_number as "licenseNumber",
                    e.license_state as "licenseState",
                    e.license_expires_on as "licenseExpiresOn",
                    (e.license_expires_on < current_date) as "licenseExpired",
                    e.disciplines, e.max_active_orders as "maxActiveOrders",
                    e.is_active as "isActive",
                    (select count(*) from ocs.drafting_orders o
                      where o.engineer_id = e.id and o.deleted_at is null
                        and o.status not in ('delivered','cancelled')) as "activeOrders"
               from ocs.engineers e
              order by e.is_active desc, e.display_name`,
          );
          return { engineers, total: engineers.length };
        },
        { reason: 'list_engineers' },
      ),
  );

  /**
   * The engineer's queue.
   *
   * Ordered by what should be picked up next -- overdue first, then by due date
   * and priority. A queue ordered by creation date is a queue that quietly
   * misses deadlines.
   */
  app.get(
    '/api/engineering/queue',
    { preHandler: [requireApiAuth, requireCapability('drafting:produce')] },
    async (req) => {
      const auth = req.apiAuth!;
      const q = parse(
        z.object({
          engineerId: z.string().uuid().optional(),
          includeUnassigned: z.enum(['true', '1', 'false', '0']).optional(),
        }),
        req.query,
        'query',
      );
      const includeUnassigned = q.includeUnassigned === 'true' || q.includeUnassigned === '1';

      return withServiceContext(
        async (tx) => {
          // An engineer sees their own queue unless they ask for someone
          // else's and have the standing to manage assignment.
          let engineerId = q.engineerId ?? null;
          if (!engineerId) {
            const mine = await tx.one<{ id: string }>(
              `select id from ocs.engineers where user_id = $1`, [auth.userId],
            );
            engineerId = mine?.id ?? null;
          }

          const orders = await tx.many(
            `select ${ORDER_SELECT},
                    (o.due_date is not null and o.due_date < current_date) as "overdue"
             ${ORDER_FROM}
              where o.deleted_at is null
                and o.status not in ('delivered', 'cancelled')
                and (
                  ($1::uuid is not null and o.engineer_id = $1::uuid)
                  or ($2::boolean and o.engineer_id is null)
                )
              order by
                (o.due_date is not null and o.due_date < current_date) desc,
                o.due_date asc nulls last,
                o.priority desc,
                o.created_at asc
              limit 200`,
            [engineerId, includeUnassigned],
          );

          return {
            orders,
            total: orders.length,
            overdueCount: orders.filter((o) => (o as { overdue: boolean }).overdue).length,
            engineerId,
          };
        },
        { reason: 'engineer_queue' },
      );
    },
  );

  /** Assign an order to an engineer. Admin and permit-tech work, not the engineer's. */
  app.post(
    '/api/engineering/orders/:id/assign',
    { preHandler: [requireApiAuth, requireCapability('drafting:assign')] },
    async (req) => {
      const auth = req.apiAuth!;
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
      const body = parse(
        z.object({
          engineerId: z.string().uuid().nullable(),
          dueDate: z.string().date().nullable().optional(),
        }),
        req.body,
        'assignment',
      );

      return withServiceContext(
        async (tx) => {
          if (body.engineerId) {
            const engineer = await tx.one<{
              id: string; display_name: string; is_active: boolean; expired: boolean;
            }>(
              `select id, display_name, is_active,
                      (license_expires_on < current_date) as expired
                 from ocs.engineers where id = $1`,
              [body.engineerId],
            );
            if (!engineer) throw notFound('Engineer');
            if (!engineer.is_active) {
              throw badRequest(`${engineer.display_name} is no longer active`);
            }
            /**
             * Warned about at assignment rather than only at sealing. An
             * engineer with a lapsed licence can still draw, but they cannot
             * seal -- and discovering that when the work is finished and the
             * permit is due is far worse than knowing now.
             */
            if (engineer.expired) {
              throw badRequest(
                `${engineer.display_name}'s licence has expired. They cannot seal ` +
                  'this work, so assigning it to them would stall the job at the last step.',
              );
            }
          }

          const updated = await tx.one(
            `update ocs.drafting_orders
                set engineer_id = $2,
                    due_date = case when $3::boolean then $4::date else due_date end
              where id = $1 and deleted_at is null
              returning id`,
            [id, body.engineerId, body.dueDate !== undefined, body.dueDate ?? null],
          );
          if (!updated) throw notFound('Drafting order');

          await writeAudit(tx, {
            actorUserId: auth.userId,
            actorEmail: auth.email,
            action: 'drafting.assigned',
            entityType: 'drafting_order',
            entityId: id,
            summary: body.engineerId ? 'Order assigned' : 'Order unassigned',
            after: { engineerId: body.engineerId, dueDate: body.dueDate ?? null },
            requestId: req.id,
            ipAddress: clientIp(req),
          });

          return tx.one(`select ${ORDER_SELECT} ${ORDER_FROM} where o.id = $1`, [id]);
        },
        { reason: 'assign_drafting_order' },
      );
    },
  );

  /** Price a job and send the quote. */
  app.post(
    '/api/engineering/orders/:id/quote',
    { preHandler: [requireApiAuth, requireCapability('drafting:quote')] },
    async (req) => {
      const auth = req.apiAuth!;
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
      const body = parse(
        z.object({
          amountCents: z.number().int().min(0),
          note: z.string().max(4000).optional(),
          expiresOn: z.string().date().optional(),
          send: z.boolean().default(true),
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
              'This quote is already approved. Move it back to draft before re-pricing, ' +
                'so the contractor approves the new price rather than discovering it.',
            );
          }

          try {
            await tx.query(
              `update ocs.drafting_orders
                  set quoted_cents = $2,
                      quote_note = $3,
                      quote_expires_on = $4::date,
                      quote_status = case when $5::boolean then 'sent' else 'draft' end::ocs.quote_status,
                      quoted_by = $6,
                      quoted_at = now(),
                      quote_rejected_reason = null
                where id = $1`,
              [id, body.amountCents, body.note ?? null, body.expiresOn ?? null, body.send, auth.userId],
            );
          } catch (err) {
            explain(err);
          }

          await writeAudit(tx, {
            companyId: existing.company_id,
            actorUserId: auth.userId,
            actorEmail: auth.email,
            action: body.send ? 'drafting.quote_sent' : 'drafting.quote_drafted',
            entityType: 'drafting_order',
            entityId: id,
            summary: `Quote ${body.send ? 'sent' : 'drafted'}: ${(body.amountCents / 100).toFixed(2)}`,
            after: { amountCents: body.amountCents },
            requestId: req.id,
            ipAddress: clientIp(req),
          });

          return tx.one(`select ${ORDER_SELECT} ${ORDER_FROM} where o.id = $1`, [id]);
        },
        { reason: 'quote_drafting_order' },
      );
    },
  );

  /**
   * The contractor's answer.
   *
   * Reachable by the contractor themselves, because it is their decision. This
   * is the moment the price becomes binding, so it is recorded with who and
   * when -- and the database then refuses to let the amount change.
   */
  app.post(
    '/api/engineering/orders/:id/quote/respond',
    { preHandler: [requireApiAuth, requireCapability('drafting:read')] },
    async (req) => {
      const auth = req.apiAuth!;
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
      const body = parse(
        z.object({
          decision: z.enum(['approve', 'reject']),
          reason: z.string().max(2000).optional(),
        }),
        req.body,
        'decision',
      );

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
        if (existing.quote_status !== 'sent') {
          throw conflict(
            existing.quote_status === 'approved'
              ? 'That quote has already been approved.'
              : `There is no quote awaiting a decision on this order (it is "${existing.quote_status}").`,
          );
        }

        try {
          await tx.query(
            /*
             * Every parameter is cast explicitly. $2 is used both as an enum
             * and inside comparisons, and without the casts PostgreSQL cannot
             * settle on one type for it -- which fails at execution, not at
             * parse time, so it only shows up when the endpoint is actually
             * called.
             */
            `update ocs.drafting_orders
                set quote_status = $2::ocs.quote_status,
                    quote_approved_by = case when $2::text = 'approved' then $3::uuid else null end,
                    quote_approved_at = case when $2::text = 'approved' then now() else null end,
                    quote_rejected_reason = case when $2::text = 'rejected' then $4::text else null end,
                    accepted_at = case when $2::text = 'approved'
                                       then coalesce(accepted_at, now())
                                       else accepted_at end
              where id = $1`,
            [id, body.decision === 'approve' ? 'approved' : 'rejected', auth.userId, body.reason ?? null],
          );
        } catch (err) {
          explain(err);
        }

        await writeAudit(tx, {
          companyId: existing.company_id,
          actorUserId: auth.userId,
          actorEmail: auth.email,
          action: `drafting.quote_${body.decision}d`,
          entityType: 'drafting_order',
          entityId: id,
          summary: `Quote ${body.decision === 'approve' ? 'approved' : 'rejected'}` +
            (existing.quoted_cents != null ? ` at ${(existing.quoted_cents / 100).toFixed(2)}` : ''),
          after: { decision: body.decision, reason: body.reason ?? null },
          requestId: req.id,
          ipAddress: clientIp(req),
          userAgent: userAgent(req),
        });

        return tx.one(`select ${ORDER_SELECT} ${ORDER_FROM} where o.id = $1`, [id]);
      });
    },
  );

  /** What an order is producing. */
  app.get(
    '/api/engineering/orders/:id/deliverables',
    { preHandler: [requireApiAuth, requireCapability('drafting:read')] },
    async (req) => {
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');

      return scoped(req, async (tx, companyId) => {
        const deliverables = await tx.many(
          `select d.id, d.type::text as type, d.description,
                  d.is_required as "isRequired", d.requires_seal as "requiresSeal",
                  d.document_id as "documentId", doc.name as "documentName",
                  d.delivered_at as "deliveredAt",
                  (select count(*) from ocs.document_seals s
                    where s.document_id = d.document_id) as "sealCount"
             from ocs.drafting_deliverables d
             left join ocs.documents doc on doc.id = d.document_id
             join ocs.drafting_orders o on o.id = d.drafting_order_id
            where d.drafting_order_id = $1
              and ($2::uuid is null or d.company_id = $2::uuid)
            order by d.is_required desc, d.type`,
          [id, companyId],
        );

        /**
         * Surfaced rather than left to be worked out. A required deliverable
         * that was quoted and then quietly not produced is a permit rejection
         * three weeks later, and one that needs a seal and has none is the
         * same rejection wearing a different hat.
         */
        const outstanding = deliverables.filter((d) => {
          const row = d as { isRequired: boolean; deliveredAt: string | null };
          return row.isRequired && !row.deliveredAt;
        });
        const unsealed = deliverables.filter((d) => {
          const row = d as { requiresSeal: boolean; sealCount: string };
          return row.requiresSeal && Number(row.sealCount) === 0;
        });

        return {
          deliverables,
          total: deliverables.length,
          outstandingRequired: outstanding.length,
          requiringSeal: unsealed.length,
          readyToDeliver: outstanding.length === 0 && unsealed.length === 0,
        };
      });
    },
  );

  /** Add a deliverable to an order. */
  app.post(
    '/api/engineering/orders/:id/deliverables',
    { preHandler: [requireApiAuth, requireCapability('drafting:produce')] },
    async (req, reply) => {
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
      const body = parse(
        z.object({
          type: z.enum(DELIVERABLE_TYPES),
          description: z.string().max(2000).optional(),
          isRequired: z.boolean().default(true),
          requiresSeal: z.boolean().optional(),
          documentId: z.string().uuid().nullable().optional(),
        }),
        req.body,
        'deliverable',
      );

      /**
       * Calculations are sealed as a matter of course; a site plan often is
       * not. Defaulting from the type means the common case is right without
       * anybody having to remember, and it stays overridable for the case that
       * is not.
       */
      const sealByDefault =
        body.requiresSeal ??
        ['structural_calcs', 'truss_layout', 'wind_load_calcs', 'plan_set'].includes(body.type);

      const result = await withServiceContext(
        async (tx) => {
          const order = await tx.one<{ id: string; company_id: string }>(
            `select id, company_id from ocs.drafting_orders where id = $1 and deleted_at is null`,
            [id],
          );
          if (!order) throw notFound('Drafting order');

          const created = await tx.one<{ id: string }>(
            `insert into ocs.drafting_deliverables
               (company_id, drafting_order_id, type, description, is_required,
                requires_seal, document_id)
             values ($1, $2, $3::ocs.deliverable_type, $4, $5, $6, $7)
             returning id`,
            [
              order.company_id, id, body.type, body.description ?? null,
              body.isRequired, sealByDefault, body.documentId ?? null,
            ],
          );
          return { id: created!.id, type: body.type, requiresSeal: sealByDefault };
        },
        { reason: 'add_deliverable' },
      );

      reply.code(201);
      return result;
    },
  );

  /**
   * Seal a drawing.
   *
   * The capability is only the outer door. The real gate is the engineer
   * record: sealing requires a licence on file, and an administrator -- who
   * holds every capability by definition -- still cannot seal, because they
   * have no licence to stake.
   *
   * That is the stronger arrangement. A capability can be granted by anyone who
   * edits a list; a licence cannot, and it is the licence the act actually
   * rests on. Applying a seal is a named individual saying "I am professionally
   * responsible for this drawing", and only a person with a licence can say it.
   */
  app.post(
    '/api/engineering/seals',
    { preHandler: [requireApiAuth, requireCapability('engineering:seal')] },
    async (req, reply) => {
      const auth = req.apiAuth!;
      const body = parse(
        z.object({
          documentId: z.string().uuid(),
          documentVersionId: z.string().uuid().nullable().optional(),
          engineerId: z.string().uuid().optional(),
          sealReference: z.string().max(500).nullable().optional(),
          note: z.string().max(2000).nullable().optional(),
        }),
        req.body,
        'seal',
      );

      const result = await withServiceContext(
        async (tx) => {
          // Default to the signed-in engineer. Sealing on someone else's behalf
          // is possible but must be named explicitly, never inferred.
          const engineer = await tx.one<{
            id: string; display_name: string; license_type: string;
            license_number: string; license_state: string; license_expires_on: string;
            is_active: boolean;
          }>(
            body.engineerId
              ? `select id, display_name, license_type::text as license_type, license_number,
                        license_state, license_expires_on, is_active
                   from ocs.engineers where id = $1`
              : `select id, display_name, license_type::text as license_type, license_number,
                        license_state, license_expires_on, is_active
                   from ocs.engineers where user_id = $1`,
            [body.engineerId ?? auth.userId],
          );
          if (!engineer) {
            throw badRequest(
              body.engineerId
                ? 'No such engineer'
                : 'This account is not linked to an engineer record, so it cannot seal.',
            );
          }
          if (!engineer.is_active) {
            throw badRequest(`${engineer.display_name} is no longer an active engineer`);
          }

          const doc = await tx.one<{ id: string; company_id: string }>(
            `select id, company_id from ocs.documents where id = $1 and deleted_at is null`,
            [body.documentId],
          );
          if (!doc) throw notFound('Document');

          let sealId: string;
          try {
            const created = await tx.one<{ id: string }>(
              `insert into ocs.document_seals
                 (company_id, document_id, document_version_id, engineer_id,
                  sealed_by_name, license_type, license_number, license_state,
                  license_expires_on, seal_reference, note)
               values ($1,$2,$3,$4,$5,$6::ocs.engineer_license_type,$7,$8,$9::date,$10,$11)
               returning id`,
              [
                doc.company_id, body.documentId, body.documentVersionId ?? null, engineer.id,
                engineer.display_name, engineer.license_type, engineer.license_number,
                engineer.license_state, engineer.license_expires_on,
                body.sealReference ?? null, body.note ?? null,
              ],
            );
            sealId = created!.id;
          } catch (err) {
            explain(err);
          }

          await writeAudit(tx, {
            companyId: doc.company_id,
            actorUserId: auth.userId,
            actorEmail: auth.email,
            action: 'engineering.sealed',
            entityType: 'document',
            entityId: body.documentId,
            summary:
              `Sealed by ${engineer.display_name} ` +
              `(${engineer.license_type} ${engineer.license_number}, ${engineer.license_state})`,
            after: {
              engineerId: engineer.id,
              licenseNumber: engineer.license_number,
              documentVersionId: body.documentVersionId ?? null,
            },
            requestId: req.id,
            ipAddress: clientIp(req),
            userAgent: userAgent(req),
          });

          return tx.one(
            `select s.id, s.document_id as "documentId",
                    s.document_version_id as "documentVersionId",
                    s.sealed_by_name as "sealedByName",
                    s.license_type::text as "licenseType",
                    s.license_number as "licenseNumber",
                    s.license_state as "licenseState",
                    s.license_expires_on as "licenseExpiresOn",
                    s.sealed_at as "sealedAt", s.seal_reference as "sealReference", s.note
               from ocs.document_seals s where s.id = $1`,
            [sealId],
          );
        },
        { reason: 'seal_document' },
      );

      reply.code(201);
      return result;
    },
  );

  /** Every seal on a document — the provenance chain for a drawing. */
  app.get(
    '/api/engineering/seals',
    { preHandler: [requireApiAuth, requireCapability('document:read')] },
    async (req) => {
      const q = parse(
        z.object({
          documentId: z.string().uuid().optional(),
          clientId: z.string().uuid().optional(),
        }),
        req.query,
        'query',
      );

      return scoped(
        req,
        async (tx, companyId) => {
          const seals = await tx.many(
            `select s.id, s.document_id as "documentId", d.name as "documentName",
                    s.document_version_id as "documentVersionId",
                    s.sealed_by_name as "sealedByName",
                    s.license_type::text as "licenseType",
                    s.license_number as "licenseNumber",
                    s.license_state as "licenseState",
                    s.sealed_at as "sealedAt", s.seal_reference as "sealReference", s.note
               from ocs.document_seals s
               join ocs.documents d on d.id = s.document_id
              where ($1::uuid is null or s.document_id = $1::uuid)
                and ($2::uuid is null or s.company_id = $2::uuid)
              order by s.sealed_at desc
              limit 500`,
            [q.documentId ?? null, companyId],
          );
          return { seals, total: seals.length };
        },
        q.clientId ?? null,
      );
    },
  );

  /** Move an order through its workflow. */
  app.patch(
    '/api/engineering/orders/:id',
    { preHandler: [requireApiAuth, requireCapability('drafting:produce')] },
    async (req) => {
      const auth = req.apiAuth!;
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
      const body = parse(
        z.object({
          status: z.enum(ORDER_STATUSES).optional(),
          dueDate: z.string().date().nullable().optional(),
          title: z.string().trim().min(1).max(300).optional(),
          description: z.string().max(8000).nullable().optional(),
        }).strict(),
        req.body,
        'order',
      );

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
                      due_date = case when $3::boolean then $4::date else due_date end,
                      title = coalesce($5, title),
                      description = case when $6::boolean then $7 else description end,
                      delivered_at = case when $2::ocs.drafting_status = 'delivered'
                                          then coalesce(delivered_at, now())
                                          else delivered_at end
                where id = $1`,
              [
                id, body.status ?? null,
                body.dueDate !== undefined, body.dueDate ?? null,
                body.title ?? null,
                body.description !== undefined, body.description ?? null,
              ],
            );
          } catch (err) {
            explain(err);
          }

          if (body.status && body.status !== before.status) {
            await writeAudit(tx, {
              companyId: before.company_id,
              actorUserId: auth.userId,
              actorEmail: auth.email,
              action: 'drafting.status_changed',
              entityType: 'drafting_order',
              entityId: id,
              summary: `Drafting order ${before.status} -> ${body.status}`,
              before: { status: before.status },
              after: { status: body.status },
              requestId: req.id,
              ipAddress: clientIp(req),
            });
          }

          return tx.one(`select ${ORDER_SELECT} ${ORDER_FROM} where o.id = $1`, [id]);
        },
        { reason: 'update_drafting_order' },
      );
    },
  );
}

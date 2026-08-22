/**
 * /api/support — tickets between a contractor and the people working their permits.
 *
 * The whole difficulty of this area is one distinction: what was said TO the
 * contractor, and what staff said to each other ABOUT them. The second kind is
 * candid by design, and showing it to the contractor is a business catastrophe
 * rather than a bug.
 *
 * That separation is NOT enforced here. It is enforced by row-level security in
 * migration 0018: a contractor's policy does not match an internal message, so
 * no query written in this file or any future one can return it in tenant
 * context. The code below is written as though the filtering exists, because it
 * does -- one layer down, where forgetting is not possible.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant, withServiceContext, type Tx } from '../../db/tenant.js';
import { requireApiAuth, requireCapability } from './auth.js';
import { parse, clientIp, userAgent } from '../../lib/http-helpers.js';
import { writeAudit } from '../../lib/audit.js';
import { notFound, badRequest, forbidden } from '../../lib/errors.js';

const STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING_CLIENT', 'RESOLVED'] as const;
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;

const toStored = (v: string): string => v.toLowerCase();
const fromStored = (v: string): string => v.toUpperCase();

/** Same scoping rule as every other compat module. */
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
    reason: `support_${auth.role}`,
    ...(requestedClientId ? { companyId: requestedClientId } : {}),
  });
}

const isStaff = (role: string): boolean => role !== 'CLIENT' && role !== 'PENDING';

const TICKET_SELECT = `
  t.id,
  t.reference,
  t.company_id   as "clientId",
  t.permit_id    as "permitId",
  t.subject,
  upper(t.status::text)   as status,
  upper(t.priority::text) as priority,
  t.opened_by    as "openedByUserId",
  t.assigned_to  as "assignedToUserId",
  t.resolved_at  as "resolvedAt",
  t.created_at   as "createdAt",
  t.updated_at   as "updatedAt",
  p.permit_number as "permitNumber"
`;

export async function compatSupportRoutes(app: FastifyInstance): Promise<void> {
  /** The ticket list. For staff this is a work queue; for a contractor, theirs. */
  app.get(
    '/api/support',
    { preHandler: [requireApiAuth, requireCapability('permit:read')] },
    async (req) => {
      const q = parse(
        z.object({
          clientId: z.string().uuid().optional(),
          permitId: z.string().uuid().optional(),
          status: z.enum(STATUSES).optional(),
          open: z.enum(['true', '1', 'false', '0']).optional(),
        }),
        req.query,
        'query',
      );
      const openOnly = q.open === 'true' || q.open === '1';

      return scoped(
        req,
        async (tx, companyId) => {
          const tickets = await tx.many(
            `select ${TICKET_SELECT},
                    (select count(*) from ocs.support_messages m
                      where m.ticket_id = t.id) as "messageCount",
                    (select count(*) from ocs.support_messages m
                      where m.ticket_id = t.id and m.is_internal) as "internalMessageCount"
               from ocs.support_tickets t
               left join ocs.permits p on p.id = t.permit_id
              where ($1::uuid is null or t.company_id = $1::uuid)
                and ($2::uuid is null or t.permit_id = $2::uuid)
                and ($3::text is null or t.status::text = $3::text)
                and ($4::boolean is false or t.status <> 'resolved')
              order by
                case when $4::boolean then t.priority end desc,
                t.updated_at desc
              limit 500`,
            [companyId, q.permitId ?? null, q.status ? toStored(q.status) : null, openOnly],
          );

          // messageCount comes from a subquery that runs under the caller's own
          // policy, so a contractor's count excludes internal notes without
          // this code having to know they exist.
          return {
            tickets,
            total: tickets.length,
            openCount: tickets.filter((t) => (t as { status: string }).status !== 'RESOLVED').length,
          };
        },
        q.clientId ?? null,
      );
    },
  );

  /** One ticket, with its conversation. */
  app.get(
    '/api/support/:id',
    { preHandler: [requireApiAuth, requireCapability('permit:read')] },
    async (req) => {
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');

      return scoped(req, async (tx, companyId) => {
        const ticket = await tx.one(
          `select ${TICKET_SELECT}
             from ocs.support_tickets t
             left join ocs.permits p on p.id = t.permit_id
            where t.id = $1 and ($2::uuid is null or t.company_id = $2::uuid)`,
          [id, companyId],
        );
        if (!ticket) throw notFound('Ticket');

        const messages = await tx.many(
          `select m.id, m.author_user_id as "authorUserId", u.name as "authorName",
                  m.body, m.is_internal as "internal", m.created_at as "at"
             from ocs.support_messages m
             left join ocs.app_users u on u.id = m.author_user_id
            where m.ticket_id = $1
            order by m.created_at asc`,
          [id],
        );

        return { ...(ticket as object), messages };
      });
    },
  );

  /** Open a ticket. */
  app.post(
    '/api/support',
    { preHandler: [requireApiAuth, requireCapability('permit:read')] },
    async (req, reply) => {
      const auth = req.apiAuth!;
      const body = parse(
        z.object({
          clientId: z.string().uuid().optional(),
          permitId: z.string().uuid().nullable().optional(),
          subject: z.string().trim().min(1).max(300),
          body: z.string().trim().min(1).max(20000),
          priority: z.enum(PRIORITIES).optional(),
        }),
        req.body,
        'ticket',
      );

      const companyId = auth.role === 'CLIENT' ? auth.clientId : (body.clientId ?? null);
      if (!companyId) throw badRequest('A ticket must belong to a contractor');

      const result = await scoped(
        req,
        async (tx) => {
          if (body.permitId) {
            const permit = await tx.one<{ id: string; company_id: string }>(
              `select id, company_id from ocs.permits where id = $1 and deleted_at is null`,
              [body.permitId],
            );
            if (!permit) throw badRequest('No such permit');
            if (permit.company_id !== companyId) {
              throw forbidden('That permit belongs to a different contractor');
            }
          }

          const created = await tx.one<{ id: string }>(
            `insert into ocs.support_tickets
               (company_id, permit_id, subject, priority, opened_by)
             values ($1, $2, $3, coalesce($4::ocs.ticket_priority, 'normal'), $5)
             returning id`,
            [
              companyId,
              body.permitId ?? null,
              body.subject,
              body.priority ? toStored(body.priority) : null,
              auth.userId,
            ],
          );

          /**
           * The opening text is stored as the first message rather than a
           * column on the ticket. The old shape kept `body` on the ticket AND a
           * message list, which meant the first thing said lived somewhere
           * different from everything after it -- so any code reading "the
           * conversation" silently missed it.
           */
          await tx.query(
            `insert into ocs.support_messages
               (ticket_id, company_id, author_user_id, body, is_internal, is_opening)
             values ($1, $2, $3, $4, false, true)`,
            [created!.id, companyId, auth.userId, body.body],
          );

          await writeAudit(tx, {
            companyId,
            actorUserId: auth.userId,
            actorEmail: auth.email,
            action: 'support.ticket_opened',
            entityType: 'support_ticket',
            entityId: created!.id,
            summary: `Ticket opened: ${body.subject}`,
            requestId: req.id,
            ipAddress: clientIp(req),
            userAgent: userAgent(req),
          });

          return tx.one(
            `select ${TICKET_SELECT}
               from ocs.support_tickets t
               left join ocs.permits p on p.id = t.permit_id
              where t.id = $1`,
            [created!.id],
          );
        },
        auth.role === 'CLIENT' ? null : companyId,
      );

      reply.code(201);
      return result;
    },
  );

  /**
   * Reply to a ticket.
   *
   * `internal` is honoured only for staff. A contractor asking for it is not an
   * error -- the flag is simply not applied, and the echoed message shows
   * `internal: false` so the caller can see plainly what was stored. The
   * database would refuse the write anyway; this turns a 500 into an ordinary
   * reply.
   */
  app.post(
    '/api/support/:id/messages',
    { preHandler: [requireApiAuth, requireCapability('permit:read')] },
    async (req, reply) => {
      const auth = req.apiAuth!;
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
      const body = parse(
        z.object({
          body: z.string().trim().min(1).max(20000),
          internal: z.boolean().optional(),
        }).strict(),
        req.body,
        'message',
      );

      const internal = isStaff(auth.role) ? (body.internal ?? false) : false;

      const result = await scoped(req, async (tx, companyId) => {
        const ticket = await tx.one<{ id: string; company_id: string }>(
          `select id, company_id from ocs.support_tickets
            where id = $1 and ($2::uuid is null or company_id = $2::uuid)`,
          [id, companyId],
        );
        if (!ticket) throw notFound('Ticket');

        const message = await tx.one(
          `insert into ocs.support_messages (ticket_id, company_id, author_user_id, body, is_internal)
           values ($1, $2, $3, $4, $5)
           returning id, body, is_internal as "internal", created_at as "at"`,
          [id, ticket.company_id, auth.userId, body.body, internal],
        );

        // The status transition is a trigger's job (0018), so it follows from
        // the message actually being written rather than being a second step a
        // route could skip.
        const updated = await tx.one(
          `select ${TICKET_SELECT}
             from ocs.support_tickets t
             left join ocs.permits p on p.id = t.permit_id
            where t.id = $1`,
          [id],
        );

        return { ticket: updated, message };
      });

      reply.code(201);
      return result;
    },
  );

  /** Triage: status, priority, assignment. Staff only. */
  app.patch(
    '/api/support/:id',
    { preHandler: [requireApiAuth, requireCapability('permit:edit')] },
    async (req) => {
      const auth = req.apiAuth!;
      if (!isStaff(auth.role)) throw forbidden('Only staff can change a ticket');

      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
      const body = parse(
        z.object({
          status: z.enum(STATUSES).optional(),
          priority: z.enum(PRIORITIES).optional(),
          assignedToUserId: z.string().uuid().nullable().optional(),
          subject: z.string().trim().min(1).max(300).optional(),
        }).strict(),
        req.body,
        'ticket',
      );

      return withServiceContext(
        async (tx) => {
          const before = await tx.one<{ id: string; status: string; company_id: string }>(
            `select id, status::text as status, company_id from ocs.support_tickets where id = $1`,
            [id],
          );
          if (!before) throw notFound('Ticket');

          const updated = await tx.one(
            `update ocs.support_tickets
                set status      = coalesce($2::ocs.ticket_status, status),
                    priority    = coalesce($3::ocs.ticket_priority, priority),
                    assigned_to = case when $4::boolean then $5::uuid else assigned_to end,
                    subject     = coalesce($6, subject),
                    -- Kept consistent with the status here rather than left to
                    -- the caller, because a CHECK constraint requires the two
                    -- to agree and a mismatch would be a 500 rather than a
                    -- sensible refusal.
                    resolved_at = case
                                    when $2::ocs.ticket_status = 'resolved'
                                      then coalesce(resolved_at, now())
                                    when $2::ocs.ticket_status is not null then null
                                    else resolved_at
                                  end
              where id = $1
              returning id`,
            [
              id,
              body.status ? toStored(body.status) : null,
              body.priority ? toStored(body.priority) : null,
              body.assignedToUserId !== undefined,
              body.assignedToUserId ?? null,
              body.subject ?? null,
            ],
          );
          if (!updated) throw notFound('Ticket');

          if (body.status) {
            await writeAudit(tx, {
              companyId: before.company_id,
              actorUserId: auth.userId,
              actorEmail: auth.email,
              action: 'support.ticket_status_changed',
              entityType: 'support_ticket',
              entityId: id,
              summary: `Ticket ${fromStored(before.status)} -> ${body.status}`,
              before: { status: fromStored(before.status) },
              after: { status: body.status },
              requestId: req.id,
              ipAddress: clientIp(req),
            });
          }

          return tx.one(
            `select ${TICKET_SELECT}
               from ocs.support_tickets t
               left join ocs.permits p on p.id = t.permit_id
              where t.id = $1`,
            [id],
          );
        },
        { reason: 'update_ticket' },
      );
    },
  );
}

/**
 * Client communications.
 *
 * `is_internal` marks staff-only notes. The filter is applied in SQL, not in
 * the response mapper -- an internal note must never be loaded into a payload
 * that a contractor's browser receives, because "we fetched it but did not
 * render it" is still a disclosure.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, principalOf, tenantOf } from '../auth/plugin.js';
import { withTenant } from '../db/tenant.js';
import { requireCompanyRole } from '../auth/rbac.js';
import { parse, created } from '../lib/http-helpers.js';
import { notFound, forbidden } from '../lib/errors.js';
import { paginationQuery, decodeCursor, buildPage } from '../lib/pagination.js';
import { notify } from '../services/notifications.js';
import { writeAudit } from '../lib/audit.js';

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/threads', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'viewer');

    const q = parse(
      paginationQuery.extend({
        permitId: z.string().uuid().optional(),
        projectId: z.string().uuid().optional(),
        includeClosed: z.coerce.boolean().default(false),
      }),
      req.query,
      'query',
    );
    const cursor = decodeCursor(q.cursor);

    return withTenant(ctx, async (tx) => {
      const rows = await tx.many<{ id: string; created_at: string }>(
        `select id, subject, is_closed, project_id, permit_id, drafting_order_id,
                last_message_at, message_count, created_by, created_at
           from ocs.message_threads
          where company_id = $1
            and ($2::boolean or not is_closed)
            and ($3::uuid is null or permit_id = $3::uuid)
            and ($4::uuid is null or project_id = $4::uuid)
            and ($5::timestamptz is null
                 or (created_at, id) < ($5::timestamptz, $6::uuid))
          order by created_at desc, id desc
          limit $7`,
        [
          ctx.companyId,
          q.includeClosed,
          q.permitId ?? null,
          q.projectId ?? null,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          q.limit + 1,
        ],
      );
      return buildPage(rows, q.limit);
    });
  });

  app.post('/v1/threads', { preHandler: authenticate }, async (req, reply) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'member');

    const body = parse(
      z.object({
        subject: z.string().trim().min(1).max(200),
        body: z.string().trim().min(1).max(20000),
        projectId: z.string().uuid().optional(),
        permitId: z.string().uuid().optional(),
        draftingOrderId: z.string().uuid().optional(),
        isInternal: z.boolean().default(false),
      }),
      req.body,
      'thread',
    );

    if (body.isInternal && p.platformRole === 'none') {
      throw forbidden('Only One Contractor Solutions staff can post internal notes');
    }

    const thread = await withTenant(ctx, async (tx) => {
      const row = await tx.one<{ id: string; subject: string }>(
        `insert into ocs.message_threads
           (company_id, subject, project_id, permit_id, drafting_order_id, created_by)
         values ($1,$2,$3,$4,$5,$6)
         returning id, subject, created_at`,
        [
          ctx.companyId,
          body.subject,
          body.projectId ?? null,
          body.permitId ?? null,
          body.draftingOrderId ?? null,
          p.userId,
        ],
      );
      if (!row) throw notFound('Thread');

      await tx.query(
        `insert into ocs.messages (thread_id, body, is_internal, author_id, author_name)
         values ($1,$2,$3,$4,$5)`,
        [row.id, body.body, body.isInternal, p.userId, p.email],
      );

      return row;
    });

    return created(reply, thread);
  });

  app.get('/v1/threads/:threadId/messages', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'viewer');

    const params = parse(z.object({ threadId: z.string().uuid() }), req.params, 'parameters');
    const canSeeInternal = p.platformRole !== 'none';

    return withTenant(ctx, async (tx) => {
      const thread = await tx.one(
        `select id, subject, is_closed, message_count
           from ocs.message_threads where id = $1 and company_id = $2`,
        [params.threadId, ctx.companyId],
      );
      if (!thread) throw notFound('Thread');

      const messages = await tx.many(
        `select m.id, m.body, m.is_internal, m.author_id, m.author_name,
                m.edited_at, m.created_at,
                u.full_name as author_full_name
           from ocs.messages m
           left join ocs.app_users u on u.id = m.author_id
          where m.thread_id = $1
            and m.company_id = $2
            and m.deleted_at is null
            and ($3::boolean or not m.is_internal)
          order by m.created_at asc
          limit 500`,
        [params.threadId, ctx.companyId, canSeeInternal],
      );

      return { thread, messages };
    });
  });

  app.post('/v1/threads/:threadId/messages', { preHandler: authenticate }, async (req, reply) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'member');

    const params = parse(z.object({ threadId: z.string().uuid() }), req.params, 'parameters');
    const body = parse(
      z.object({
        body: z.string().trim().min(1).max(20000),
        isInternal: z.boolean().default(false),
        attachmentDocumentIds: z.array(z.string().uuid()).max(20).default([]),
      }),
      req.body,
      'message',
    );

    if (body.isInternal && p.platformRole === 'none') {
      throw forbidden('Only One Contractor Solutions staff can post internal notes');
    }

    const message = await withTenant(ctx, async (tx) => {
      const thread = await tx.one<{ id: string; subject: string; is_closed: boolean }>(
        `select id, subject, is_closed from ocs.message_threads
          where id = $1 and company_id = $2`,
        [params.threadId, ctx.companyId],
      );
      if (!thread) throw notFound('Thread');
      if (thread.is_closed) throw forbidden('This thread is closed');

      const row = await tx.one<{ id: string }>(
        `insert into ocs.messages (thread_id, body, is_internal, author_id, author_name)
         values ($1,$2,$3,$4,$5)
         returning id, body, is_internal, author_id, author_name, created_at`,
        [params.threadId, body.body, body.isInternal, p.userId, p.email],
      );
      if (!row) throw notFound('Message');

      for (const docId of body.attachmentDocumentIds) {
        // RLS keeps this from attaching another tenant's document: the insert
        // would violate the policy rather than succeed.
        await tx.query(
          `insert into ocs.message_attachments (company_id, message_id, document_id)
           values ($1,$2,$3) on conflict do nothing`,
          [ctx.companyId, row.id, docId],
        );
      }

      // Internal notes notify nobody outside the team.
      if (!body.isInternal) {
        const recipients = await tx.many<{ user_id: string; email: string }>(
          `select m.user_id, u.email from ocs.company_memberships m
             join ocs.app_users u on u.id = m.user_id
            where m.company_id = $1 and m.is_active
              and u.is_active and u.deleted_at is null
              and m.user_id <> $2`,
          [ctx.companyId, p.userId],
        );
        for (const r of recipients) {
          await notify(tx, {
            companyId: ctx.companyId,
            userId: r.user_id,
            kind: 'message_received',
            title: `New message: ${thread.subject}`,
            body: body.body.slice(0, 300),
            entityType: 'message_thread',
            entityId: params.threadId,
            linkPath: `/messages/${params.threadId}`,
            email: { to: r.email },
          });
        }
      }

      return row;
    });

    return created(reply, message);
  });

  app.post('/v1/threads/:threadId/close', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'member');

    const params = parse(z.object({ threadId: z.string().uuid() }), req.params, 'parameters');

    return withTenant(ctx, async (tx) => {
      const row = await tx.one<{ id: string }>(
        `update ocs.message_threads set is_closed = true
          where id = $1 and company_id = $2 and not is_closed
          returning id`,
        [params.threadId, ctx.companyId],
      );
      if (!row) throw notFound('Open thread');

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'thread.closed',
        entityType: 'message_thread',
        entityId: row.id,
        requestId: req.id,
      });

      return { id: row.id, closed: true };
    });
  });

  // ---------------------------------------------------------------------------
  // Notifications feed
  // ---------------------------------------------------------------------------

  app.get('/v1/notifications', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);

    const q = parse(
      paginationQuery.extend({ unreadOnly: z.coerce.boolean().default(false) }),
      req.query,
      'query',
    );
    const cursor = decodeCursor(q.cursor);

    return withTenant(ctx, async (tx) => {
      const rows = await tx.many<{ id: string; created_at: string }>(
        `select id, kind::text, title, body, entity_type, entity_id, link_path,
                read_at, created_at
           from ocs.notifications
          where company_id = $1
            -- Scoped to the caller: a notification is addressed to one person.
            and user_id = $2
            and ($3::boolean is false or read_at is null)
            and ($4::timestamptz is null
                 or (created_at, id) < ($4::timestamptz, $5::uuid))
          order by created_at desc, id desc
          limit $6`,
        [
          ctx.companyId,
          p.userId,
          q.unreadOnly,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          q.limit + 1,
        ],
      );
      return buildPage(rows, q.limit);
    });
  });

  app.post('/v1/notifications/read', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);

    const body = parse(
      z.object({
        ids: z.array(z.string().uuid()).max(200).optional(),
        all: z.boolean().default(false),
      }),
      req.body,
      'read receipt',
    );

    return withTenant(ctx, async (tx) => {
      const res = await tx.query(
        `update ocs.notifications
            set read_at = now()
          where company_id = $1
            and user_id = $2
            and read_at is null
            and ($3::boolean or id = any($4::uuid[]))`,
        [ctx.companyId, p.userId, body.all, body.ids ?? []],
      );
      return { markedRead: res.rowCount ?? 0 };
    });
  });
}

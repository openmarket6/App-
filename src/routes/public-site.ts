/**
 * The public marketing site's backend.
 *
 * This is the only place in the service where an unauthenticated stranger can
 * write to the database, so it is deliberately narrow: one endpoint, one table,
 * no reads. Everything a prospect submits is write-only from their side -- they
 * cannot read a row back, so the form cannot be used to discover who else has
 * enquired. The database enforces that (0016); this file only has to avoid
 * undoing it.
 *
 * The reading half is staff-only and lives here too, because a lead list that
 * nobody in the product can see is just a table that fills up.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withServiceContext, withPublicWrite } from '../db/tenant.js';
import { requireApiAuth, requireCapability } from './compat/auth.js';
import { parse, clientIp, userAgent } from '../lib/http-helpers.js';
import { writeAudit } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/**
 * How long two submissions from the same address are treated as one.
 *
 * Someone double-clicking Send, or resubmitting because the page scrolled,
 * should not become two leads for sales to work. Long enough to absorb that,
 * short enough that a prospect genuinely coming back later is heard.
 */
const DUPLICATE_WINDOW_MINUTES = 10;

const demoRequestSchema = z.object({
  companyName: z.string().trim().min(1).max(200),
  contactName: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320),
  phone: z.string().trim().max(40).nullable().optional(),
  trades: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  counties: z.array(z.string().trim().min(1).max(60)).max(67).optional(),
  monthlyPermits: z.string().trim().max(40).nullable().optional(),
  message: z.string().trim().max(4000).nullable().optional(),
  sourcePage: z.string().trim().max(200).nullable().optional(),
  /**
   * A honeypot field. Real people never see it, so anything in it came from a
   * bot filling every input on the page. Accepted and discarded rather than
   * rejected: telling a scraper which rule caught it only teaches it the rule.
   */
  website: z.string().max(200).optional(),
});

export async function publicSiteRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Schedule a demo.
   *
   * Rate limited far below the global default. A person fills this in once;
   * anything filling it in repeatedly is not a person, and the cost of being
   * wrong is that a genuine prospect waits a minute and tries again.
   */
  app.post(
    '/api/public/demo-request',
    { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      const body = parse(demoRequestSchema, req.body, 'demo request');

      // Silently accepted. The submitter is told the same thing either way.
      if (body.website && body.website.trim() !== '') {
        logger.info({ ip: clientIp(req) }, 'demo request discarded: honeypot filled');
        reply.code(202);
        return { ok: true, message: 'Thanks — we will be in touch shortly.' };
      }

      const email = body.email.toLowerCase();

      /**
       * One call, into a function that owns the whole operation.
       *
       * The insert is not done directly here because the duplicate check needs
       * to READ this table, and an anonymous caller must never be able to. The
       * database function runs as its owner, does the read and the write
       * together, and hands back nothing but an id -- so the privilege exists
       * for exactly one statement and cannot be pointed anywhere else. See
       * migration 0016.
       */
      await withPublicWrite(async (tx) => {
        await tx.one<{ id: string }>(
          `select ocs.submit_demo_request(
             $1, $2, $3, $4, $5::text[], $6::text[], $7, $8, $9, $10, $11::inet, $12, $13
           ) as id`,
          [
            body.companyName,
            body.contactName,
            email,
            body.phone ?? null,
            body.trades ?? [],
            body.counties ?? [],
            body.monthlyPermits ?? null,
            body.message ?? null,
            body.sourcePage ?? null,
            (req.headers.referer as string | undefined) ?? null,
            clientIp(req) ?? null,
            userAgent(req) ?? null,
            DUPLICATE_WINDOW_MINUTES,
          ],
        );
      });

      logger.info({ requestId: req.id }, 'demo request received');

      /**
       * The id is deliberately NOT returned.
       *
       * The submitter has no use for it, and handing an internal identifier to
       * an anonymous caller is a small gift to anyone probing the system. They
       * get the same confirmation whether this was a new lead or a duplicate
       * collapsed into an existing one.
       */
      reply.code(201);
      return { ok: true, message: 'Thanks — we will be in touch shortly.' };
    },
  );

  /** The lead list. Staff only; a prospect can never read this back. */
  app.get(
    '/api/demo-requests',
    { preHandler: [requireApiAuth, requireCapability('client:create')] },
    async (req) => {
      const q = parse(
        z.object({
          status: z
            .enum(['new', 'contacted', 'scheduled', 'won', 'lost', 'spam'])
            .optional(),
        }),
        req.query,
        'query',
      );

      return withServiceContext(
        async (tx) => {
          const requests = await tx.many(
            `select id, company_name as "companyName", contact_name as "contactName",
                    email, phone, trades, counties,
                    monthly_permits as "monthlyPermits", message,
                    source_page as "sourcePage", status,
                    handled_by as "handledBy", handled_at as "handledAt",
                    internal_note as "internalNote", created_at as "createdAt"
               from ocs.demo_requests
              where ($1::text is null or status = $1::text)
              order by created_at desc
              limit 500`,
            [q.status ?? null],
          );
          return { requests, total: requests.length };
        },
        { reason: 'list_demo_requests' },
      );
    },
  );

  /** Work a lead: change its status, leave a note. */
  app.patch(
    '/api/demo-requests/:id',
    { preHandler: [requireApiAuth, requireCapability('client:create')] },
    async (req) => {
      const auth = req.apiAuth!;
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
      const body = parse(
        z
          .object({
            status: z
              .enum(['new', 'contacted', 'scheduled', 'won', 'lost', 'spam'])
              .optional(),
            internalNote: z.string().max(4000).nullable().optional(),
          })
          .strict(),
        req.body,
        'demo request',
      );

      return withServiceContext(
        async (tx) => {
          const updated = await tx.one(
            `update ocs.demo_requests
                set status        = coalesce($2, status),
                    internal_note = case when $3::boolean then $4 else internal_note end,
                    handled_by    = $5,
                    handled_at    = now()
              where id = $1
              returning id, company_name as "companyName", contact_name as "contactName",
                        email, status, internal_note as "internalNote",
                        handled_at as "handledAt"`,
            [
              id,
              body.status ?? null,
              body.internalNote !== undefined,
              body.internalNote ?? null,
              auth.userId,
            ],
          );
          if (!updated) throw notFound('Demo request');

          await writeAudit(tx, {
            actorUserId: auth.userId,
            actorEmail: auth.email,
            action: 'demo_request.updated',
            entityType: 'demo_request',
            entityId: id,
            summary: `Demo request marked ${body.status ?? 'updated'}`,
            after: { status: body.status ?? null },
            requestId: req.id,
            ipAddress: clientIp(req),
          });

          return { request: updated };
        },
        { reason: 'update_demo_request' },
      );
    },
  );
}

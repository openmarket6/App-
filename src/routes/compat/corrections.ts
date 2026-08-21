/**
 * /api/corrections — jurisdiction comments on a filing.
 *
 * A correction is the jurisdiction saying the submission is wrong. It starts a
 * clock the contractor owns, and every cycle costs weeks, so the count of
 * cycles is the sharpest measure of how well a filing was prepared.
 *
 * Logging one has side effects — it advances the permit's cycle count and moves
 * the permit into CORRECTIONS_REQUIRED — and those happen in database triggers
 * (0015), not here. That way the three facts can never disagree, whichever code
 * path did the writing.
 *
 * The interesting endpoint is `promote`: it turns one contractor's painful
 * correction into a jurisdiction requirement every contractor then sees. That
 * is the part of this data that compounds.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant, withServiceContext, type Tx } from '../../db/tenant.js';
import { requireApiAuth, requireCapability } from './auth.js';
import { parse, clientIp, userAgent } from '../../lib/http-helpers.js';
import { writeAudit } from '../../lib/audit.js';
import { notFound, badRequest, forbidden } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

/**
 * Which access mode this caller gets.
 *
 * Identical reasoning to compat/api.ts: a CLIENT is confined to their own
 * company by row-level security, staff work across contractors in service
 * context. Kept here rather than imported so each compat module is readable on
 * its own, but the rule is the same one.
 */
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
    reason: `corrections_${auth.role}`,
    ...(requestedClientId ? { companyId: requestedClientId } : {}),
  });
}

/** The response shape the frontend expects. `body` is surfaced as `text`. */
const SELECT = `
  c.id,
  c.permit_id        as "permitId",
  c.company_id       as "clientId",
  c.cycle,
  c.issued_at        as "issuedAt",
  c.discipline,
  c.body             as "text",
  c.resolved_at      as "resolvedAt",
  c.promoted_to_requirement as "promotedToRequirement",
  c.created_at       as "createdAt",
  p.permit_type      as "permitType",
  p.municipality_id  as "jurisdictionId",
  m.name             as "jurisdictionName"
`;

export async function compatCorrectionsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/corrections',
    { preHandler: [requireApiAuth, requireCapability('permit:read')] },
    async (req) => {
      const q = parse(
        z.object({
          clientId: z.string().uuid().optional(),
          permitId: z.string().uuid().optional(),
          // Accepts "true" or "1", matching the previous implementation.
          open: z.enum(['true', '1', 'false', '0']).optional(),
        }),
        req.query,
        'query',
      );
      const openOnly = q.open === 'true' || q.open === '1';

      return scoped(
        req,
        async (tx, companyId) => {
          const corrections = await tx.many(
            `select ${SELECT}
               from ocs.permit_corrections c
               join ocs.permits p on p.id = c.permit_id
               left join ocs.municipalities m on m.id = p.municipality_id
              where ($1::uuid is null or c.company_id = $1::uuid)
                and ($2::uuid is null or c.permit_id = $2::uuid)
                and ($3::boolean is false or c.resolved_at is null)
              order by c.issued_at desc
              limit 500`,
            [companyId, q.permitId ?? null, openOnly],
          );
          return { corrections, total: corrections.length };
        },
        q.clientId ?? null,
      );
    },
  );

  app.post(
    '/api/corrections',
    { preHandler: [requireApiAuth, requireCapability('permit:edit')] },
    async (req, reply) => {
      const auth = req.apiAuth!;
      const body = parse(
        z.object({
          permitId: z.string().uuid(),
          text: z.string().trim().min(1).max(8000),
          discipline: z.string().trim().max(120).nullable().optional(),
          issuedAt: z.string().datetime().optional(),
        }),
        req.body,
        'correction',
      );

      const result = await scoped(req, async (tx, companyId) => {
        const permit = await tx.one<{ id: string; company_id: string; status: string }>(
          `select id, company_id, status::text from ocs.permits
            where id = $1 and deleted_at is null
              and ($2::uuid is null or company_id = $2::uuid)`,
          [body.permitId, companyId],
        );
        if (!permit) throw notFound('Permit');

        const row = await tx.one(
          `insert into ocs.permit_corrections
             (permit_id, body, discipline, issued_at, created_by)
           values ($1, $2, $3, coalesce($4::timestamptz, now()), $5)
           returning id, cycle, issued_at as "issuedAt"`,
          [body.permitId, body.text, body.discipline ?? null, body.issuedAt ?? null, auth.userId],
        );

        // Narrative trail alongside the status transition the trigger records.
        await tx.query(
          `insert into ocs.permit_events (permit_id, status, note, source_channel, actor_user_id)
           values ($1, 'corrections_required', $2, 'manual', $3)`,
          [
            body.permitId,
            `Correction cycle ${(row as { cycle: number }).cycle} logged` +
              (body.discipline ? ` (${body.discipline})` : ''),
            auth.userId,
          ],
        );

        await writeAudit(tx, {
          companyId: permit.company_id,
          actorUserId: auth.userId,
          actorEmail: auth.email,
          action: 'correction.logged',
          entityType: 'permit',
          entityId: body.permitId,
          summary: `Correction cycle ${(row as { cycle: number }).cycle} logged`,
          after: { discipline: body.discipline ?? null },
          requestId: req.id,
          ipAddress: clientIp(req),
          userAgent: userAgent(req),
        });

        const updatedPermit = await tx.one(
          `select id, status::text as status, correction_cycles as "correctionCycles"
             from ocs.permits where id = $1`,
          [body.permitId],
        );

        const full = await tx.one(
          `select ${SELECT}
             from ocs.permit_corrections c
             join ocs.permits p on p.id = c.permit_id
             left join ocs.municipalities m on m.id = p.municipality_id
            where c.id = $1`,
          [(row as { id: string }).id],
        );

        return { correction: full, permit: updatedPermit };
      });

      reply.code(201);
      return result;
    },
  );

  app.patch(
    '/api/corrections/:id',
    { preHandler: [requireApiAuth, requireCapability('permit:edit')] },
    async (req) => {
      const auth = req.apiAuth!;
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
      const body = parse(
        z.object({
          text: z.string().trim().min(1).max(8000).optional(),
          discipline: z.string().trim().max(120).nullable().optional(),
          resolved: z.boolean().optional(),
          resolvedAt: z.string().datetime().nullable().optional(),
        }),
        req.body,
        'correction',
      );

      return scoped(req, async (tx, companyId) => {
        const existing = await tx.one<{ id: string; resolved_at: string | null; cycle: number }>(
          `select id, resolved_at, cycle from ocs.permit_corrections
            where id = $1 and ($2::uuid is null or company_id = $2::uuid)`,
          [id, companyId],
        );
        if (!existing) throw notFound('Correction');

        // `resolvedAt` wins over the `resolved` flag when both are sent, and
        // resolving an already-resolved correction keeps the original
        // timestamp — when it was cleared is a fact, not something to overwrite.
        let resolvedAt: string | null | undefined;
        if (body.resolvedAt !== undefined) resolvedAt = body.resolvedAt;
        else if (body.resolved === true) resolvedAt = existing.resolved_at ?? new Date().toISOString();
        else if (body.resolved === false) resolvedAt = null;

        const updated = await tx.one(
          `update ocs.permit_corrections
              set body        = coalesce($2, body),
                  discipline  = case when $3::boolean then $4 else discipline end,
                  resolved_at = case when $5::boolean then $6::timestamptz else resolved_at end,
                  resolved_by = case when $5::boolean and $6 is not null then $7 else resolved_by end
            where id = $1
            returning id`,
          [
            id, body.text ?? null,
            body.discipline !== undefined, body.discipline ?? null,
            resolvedAt !== undefined, resolvedAt ?? null,
            auth.userId,
          ],
        );
        if (!updated) throw notFound('Correction');

        if (resolvedAt !== undefined) {
          await writeAudit(tx, {
            companyId: companyId ?? undefined,
            actorUserId: auth.userId,
            actorEmail: auth.email,
            action: resolvedAt ? 'correction.resolved' : 'correction.reopened',
            entityType: 'permit_correction',
            entityId: id,
            summary: `Correction cycle ${existing.cycle} ${resolvedAt ? 'resolved' : 'reopened'}`,
            requestId: req.id,
          });
        }

        return tx.one(
          `select ${SELECT}
             from ocs.permit_corrections c
             join ocs.permits p on p.id = c.permit_id
             left join ocs.municipalities m on m.id = p.municipality_id
            where c.id = $1`,
          [id],
        );
      });
    },
  );

  /**
   * Promote a correction into a jurisdiction requirement.
   *
   * This is the endpoint that makes corrections worth logging carefully. One
   * contractor's rejection becomes a checklist item every contractor filing in
   * that jurisdiction sees.
   *
   * Written in service context because the requirement is shared reference
   * data, not tenant data — a fact about Broward, not about whoever discovered
   * it. The originating correction and company are recorded for provenance so
   * the requirement can be traced back to the rejection that taught it.
   */
  app.post(
    '/api/corrections/:id/promote',
    { preHandler: [requireApiAuth, requireCapability('permit:edit', 'jurisdiction:edit')] },
    async (req, reply) => {
      const auth = req.apiAuth!;
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
      const body = parse(
        z.object({
          requirementKey: z.string().trim().min(1).max(80),
          op: z.enum(['add', 'remove', 'amend']).default('add'),
          label: z.string().trim().max(200).nullable().optional(),
          detail: z.string().trim().max(4000).nullable().optional(),
          permitType: z.string().trim().max(120).nullable().optional(),
          jurisdictionId: z.string().uuid().optional(),
        }),
        req.body,
        'promotion',
      );

      const result = await withServiceContext(
        async (tx) => {
          const correction = await tx.one<{
            id: string; body: string; company_id: string;
            permit_type: string; municipality_id: string | null;
          }>(
            `select c.id, c.body, c.company_id, p.permit_type, p.municipality_id
               from ocs.permit_corrections c
               join ocs.permits p on p.id = c.permit_id
              where c.id = $1`,
            [id],
          );
          if (!correction) throw notFound('Correction');

          // A CLIENT may only promote from their own correction.
          if (auth.role === 'CLIENT' && correction.company_id !== auth.clientId) {
            throw notFound('Correction');
          }

          const jurisdictionId = body.jurisdictionId ?? correction.municipality_id;
          if (!jurisdictionId) {
            throw badRequest(
              'Cannot tell which jurisdiction this correction belongs to — pass jurisdictionId',
            );
          }

          // permitType undefined means "inherit from the permit"; explicit null
          // means "applies to every permit type here". They are different
          // intentions and are kept distinct.
          const permitType =
            body.permitType !== undefined ? body.permitType : correction.permit_type;

          const requirement = await tx.one(
            `insert into ocs.jurisdiction_requirements
               (municipality_id, permit_type, requirement_key, op, label, detail,
                learned_from_correction_id, learned_from_company_id, created_by)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             on conflict (municipality_id, permit_type, requirement_key) do update
               set op = excluded.op,
                   label = coalesce(excluded.label, ocs.jurisdiction_requirements.label),
                   detail = coalesce(excluded.detail, ocs.jurisdiction_requirements.detail),
                   is_active = true
             returning id, municipality_id as "jurisdictionId", permit_type as "permitType",
                       requirement_key as "requirementKey", op, label, detail,
                       learned_from_correction_id as "learnedFromCorrectionId", created_at as "createdAt"`,
            [
              jurisdictionId, permitType, body.requirementKey, body.op,
              body.label ?? null, body.detail ?? correction.body,
              correction.id, correction.company_id, auth.userId,
            ],
          );

          await tx.query(
            `update ocs.permit_corrections set promoted_to_requirement = true where id = $1`,
            [id],
          );

          await writeAudit(tx, {
            companyId: correction.company_id,
            actorUserId: auth.userId,
            actorEmail: auth.email,
            action: 'correction.promoted',
            entityType: 'jurisdiction_requirement',
            entityId: (requirement as { id?: string } | null)?.id ?? null,
            summary: `Promoted a correction into a requirement for this jurisdiction: ${body.requirementKey}`,
            after: { requirementKey: body.requirementKey, jurisdictionId },
            requestId: req.id,
          });

          logger.info(
            { requirementKey: body.requirementKey, jurisdictionId },
            'correction promoted to a jurisdiction requirement',
          );

          const updated = await tx.one(
            `select ${SELECT}
               from ocs.permit_corrections c
               join ocs.permits p on p.id = c.permit_id
               left join ocs.municipalities m on m.id = p.municipality_id
              where c.id = $1`,
            [id],
          );

          return { correction: updated, override: requirement };
        },
        { reason: 'promote_correction' },
      );

      reply.code(201);
      return result;
    },
  );

  /** Requirements learned for a jurisdiction — the payoff from promoting. */
  app.get(
    '/api/corrections/requirements',
    { preHandler: [requireApiAuth, requireCapability('jurisdiction:read')] },
    async (req) => {
      const q = parse(
        z.object({
          jurisdictionId: z.string().uuid().optional(),
          permitType: z.string().max(120).optional(),
        }),
        req.query,
        'query',
      );

      return withServiceContext(
        async (tx) => {
          const requirements = await tx.many(
            `select r.id, r.municipality_id as "jurisdictionId", m.name as "jurisdictionName",
                    r.permit_type as "permitType", r.requirement_key as "requirementKey",
                    r.op, r.label, r.detail, r.created_at as "createdAt"
               from ocs.jurisdiction_requirements r
               join ocs.municipalities m on m.id = r.municipality_id
              where r.is_active
                and ($1::uuid is null or r.municipality_id = $1::uuid)
                and ($2::text is null or r.permit_type is null or r.permit_type = $2)
              order by m.name, r.requirement_key
              limit 500`,
            [q.jurisdictionId ?? null, q.permitType ?? null],
          );
          return { requirements, total: requirements.length };
        },
        { reason: 'list_jurisdiction_requirements' },
      );
    },
  );
}

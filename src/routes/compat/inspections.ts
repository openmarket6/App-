/**
 * /api/inspections — the jurisdiction physically looking at the work.
 *
 * An inspection is the one event in a permit's life that cannot be argued with
 * paperwork: someone stood on the site and formed an opinion. A failure is
 * expensive in the same way a correction is, so the two are modelled the same
 * way — a durable row, a cycle you can count, and a re-attempt linked back to
 * the thing it repeats.
 *
 * The chain matters more than any single row. `reinspectionOfId` is what turns
 * "this permit had four inspections" into "this milestone took four attempts",
 * and that second sentence is the one worth reporting on.
 *
 * Results are stored lowercase to match the rest of this schema and uppercased
 * on the way out, because the frontend bundle was written against the previous
 * backend's vocabulary. That translation lives in one place: mapping.ts.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant, withServiceContext, type Tx } from '../../db/tenant.js';
import { requireApiAuth, requireCapability } from './auth.js';
import { parse, clientIp, userAgent } from '../../lib/http-helpers.js';
import { writeAudit } from '../../lib/audit.js';
import { notFound, badRequest, forbidden } from '../../lib/errors.js';
import { INSPECTION_RESULTS, toInspectionResult, fromInspectionResult } from './mapping.js';

/** How long after a failure the follow-up lands, when the caller says nothing. */
const REINSPECTION_LEAD_DAYS = 3;

/**
 * Which access mode this caller gets.
 *
 * A CLIENT is confined to their own company by row-level security; staff work
 * across contractors in service context. Same rule as compat/api.ts and
 * compat/corrections.ts, repeated rather than shared so each compat module
 * reads on its own.
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
    reason: `inspections_${auth.role}`,
    ...(requestedClientId ? { companyId: requestedClientId } : {}),
  });
}

/**
 * The response shape the frontend expects.
 *
 * `clientId` and `jurisdictionId` come off the permit. The previous
 * implementation stitched them in application code after loading every permit
 * in the account; here the join does it, which is both cheaper and impossible
 * to get out of step.
 */
const SELECT = `
  i.id,
  i.permit_id            as "permitId",
  i.company_id           as "clientId",
  i.inspection_type      as "inspectionType",
  i.scheduled_for        as "scheduledFor",
  i.result::text         as "storedResult",
  i.inspector_note       as "inspectorNote",
  i.reinspection_of_id   as "reinspectionOfId",
  i.source_channel::text as "sourceChannel",
  i.created_at           as "createdAt",
  i.updated_at           as "updatedAt",
  p.permit_number        as "permitNumber",
  p.permit_type          as "permitType",
  p.municipality_id      as "jurisdictionId",
  m.name                 as "jurisdictionName"
`;

const FROM = `
  from ocs.permit_inspections i
  join ocs.permits p on p.id = i.permit_id
  left join ocs.municipalities m on m.id = p.municipality_id
`;

type Row = Record<string, unknown> & { storedResult?: string | null };

/** Uppercases the result for the frontend and drops the internal column name. */
function present(row: Row): Record<string, unknown> {
  const { storedResult, ...rest } = row;
  return { ...rest, result: toInspectionResult(storedResult) };
}

export async function compatInspectionsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * List inspections.
   *
   * `upcoming=true` narrows to scheduled inspections still ahead of now and
   * flips the sort, because that list is a work queue and the next one is the
   * one that matters. Everything else is a history, newest first.
   */
  app.get(
    '/api/inspections',
    { preHandler: [requireApiAuth, requireCapability('inspection:read')] },
    async (req) => {
      const q = parse(
        z.object({
          clientId: z.string().uuid().optional(),
          permitId: z.string().uuid().optional(),
          // Accepts "true" or "1", matching the previous implementation.
          upcoming: z.enum(['true', '1', 'false', '0']).optional(),
          result: z.enum(INSPECTION_RESULTS).optional(),
        }),
        req.query,
        'query',
      );
      const upcomingOnly = q.upcoming === 'true' || q.upcoming === '1';
      const storedResult = q.result ? fromInspectionResult(q.result) : null;

      return scoped(
        req,
        async (tx, companyId) => {
          const rows = await tx.many<Row>(
            `select ${SELECT}
             ${FROM}
              where ($1::uuid is null or i.company_id = $1::uuid)
                and ($2::uuid is null or i.permit_id = $2::uuid)
                and ($3::text is null or i.result::text = $3::text)
                and (
                  $4::boolean is false
                  or (i.result = 'scheduled' and i.scheduled_for is not null
                      and i.scheduled_for >= now())
                )
                and p.deleted_at is null
              order by
                case when $4::boolean then i.scheduled_for end asc nulls last,
                i.scheduled_for desc nulls last,
                i.created_at desc
              limit 500`,
            [companyId, q.permitId ?? null, storedResult, upcomingOnly],
          );
          const inspections = rows.map(present);
          return { inspections, total: inspections.length };
        },
        q.clientId ?? null,
      );
    },
  );

  /** Put an inspection on the calendar. */
  app.post(
    '/api/inspections',
    { preHandler: [requireApiAuth, requireCapability('inspection:schedule')] },
    async (req, reply) => {
      const auth = req.apiAuth!;
      const body = parse(
        z.object({
          permitId: z.string().uuid(),
          inspectionType: z.string().trim().min(1).max(120),
          scheduledFor: z.string().datetime().nullable().optional(),
          inspectorNote: z.string().max(4000).nullable().optional(),
          reinspectionOfId: z.string().uuid().nullable().optional(),
        }),
        req.body,
        'inspection',
      );

      const result = await scoped(req, async (tx, companyId) => {
        const permit = await tx.one<{ id: string; company_id: string }>(
          `select id, company_id from ocs.permits
            where id = $1 and deleted_at is null
              and ($2::uuid is null or company_id = $2::uuid)`,
          [body.permitId, companyId],
        );
        if (!permit) throw notFound('Permit');

        // The database enforces this too (0015), but catching it here turns a
        // constraint violation into a sentence the caller can act on.
        if (body.reinspectionOfId) {
          const prior = await tx.one<{ permit_id: string }>(
            `select permit_id from ocs.permit_inspections where id = $1`,
            [body.reinspectionOfId],
          );
          if (!prior) throw notFound('Inspection being re-inspected');
          if (prior.permit_id !== body.permitId) {
            throw badRequest(
              'A re-inspection must be on the same permit as the inspection it repeats',
            );
          }
        }

        const created = await tx.one<{ id: string }>(
          `insert into ocs.permit_inspections
             (permit_id, inspection_type, scheduled_for, inspector_note,
              reinspection_of_id, source_channel, recorded_by)
           values ($1, $2, $3::timestamptz, $4, $5, 'manual', $6)
           returning id`,
          [
            body.permitId,
            body.inspectionType,
            body.scheduledFor ?? null,
            body.inspectorNote ?? null,
            body.reinspectionOfId ?? null,
            auth.userId,
          ],
        );

        await tx.query(
          `insert into ocs.permit_events (permit_id, note, source_channel, actor_user_id)
           values ($1, $2, 'manual', $3)`,
          [
            body.permitId,
            `${body.inspectionType} inspection scheduled` +
              (body.scheduledFor ? ` for ${body.scheduledFor}` : ' (date to be set)'),
            auth.userId,
          ],
        );

        await writeAudit(tx, {
          companyId: permit.company_id,
          actorUserId: auth.userId,
          actorEmail: auth.email,
          action: 'inspection.scheduled',
          entityType: 'permit',
          entityId: body.permitId,
          summary: `${body.inspectionType} inspection scheduled`,
          after: {
            inspectionType: body.inspectionType,
            scheduledFor: body.scheduledFor ?? null,
          },
          requestId: req.id,
          ipAddress: clientIp(req),
          userAgent: userAgent(req),
        });

        const full = await tx.one<Row>(
          `select ${SELECT} ${FROM} where i.id = $1`,
          [created!.id],
        );
        return present(full!);
      });

      reply.code(201);
      return result;
    },
  );

  /**
   * Record what happened.
   *
   * The consequential branch is a pass-to-fail transition: it creates the
   * follow-up inspection automatically, because a failure nobody re-books is a
   * permit that quietly stalls. It fires only on the transition, so re-sending
   * FAILED (a retried request, a double-click) does not stack up duplicates.
   */
  app.patch(
    '/api/inspections/:id',
    { preHandler: [requireApiAuth, requireCapability('inspection:record')] },
    async (req) => {
      const auth = req.apiAuth!;
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
      const body = parse(
        z
          .object({
            result: z.enum(INSPECTION_RESULTS).optional(),
            inspectionType: z.string().trim().min(1).max(120).optional(),
            scheduledFor: z.string().datetime().nullable().optional(),
            inspectorNote: z.string().max(4000).nullable().optional(),
            // When to put the re-inspection on the calendar. Optional -- an
            // unscheduled re-inspection still needs to exist so it shows up in
            // somebody's queue.
            reinspectionScheduledFor: z.string().datetime().nullable().optional(),
          })
          .strict(),
        req.body,
        'inspection',
      );

      return scoped(req, async (tx, companyId) => {
        const existing = await tx.one<{
          id: string;
          permit_id: string;
          company_id: string;
          inspection_type: string;
          scheduled_for: Date | null;
          result: string;
        }>(
          `select i.id, i.permit_id, i.company_id, i.inspection_type,
                  i.scheduled_for, i.result::text as result
             from ocs.permit_inspections i
             join ocs.permits p on p.id = i.permit_id
            where i.id = $1 and p.deleted_at is null
              and ($2::uuid is null or i.company_id = $2::uuid)`,
          [id, companyId],
        );
        if (!existing) throw notFound('Inspection');

        const storedResult = body.result ? fromInspectionResult(body.result) : null;

        // A result other than "scheduled" describes something that already
        // happened, so it cannot sit in the future. The database says the same
        // thing; saying it here produces a usable message instead of a 500.
        if (storedResult && storedResult !== 'scheduled') {
          const effective =
            body.scheduledFor !== undefined
              ? body.scheduledFor === null
                ? null
                : new Date(body.scheduledFor)
              : existing.scheduled_for;
          if (effective && effective.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
            throw badRequest(
              'This inspection is still scheduled in the future. ' +
                'Move its date before recording a result.',
            );
          }
        }

        const updated = await tx.one<Row>(
          `update ocs.permit_inspections
              set result          = coalesce($2::ocs.inspection_result, result),
                  inspection_type = coalesce($3, inspection_type),
                  scheduled_for   = case when $4::boolean then $5::timestamptz
                                         else scheduled_for end,
                  inspector_note  = case when $6::boolean then $7
                                         else inspector_note end,
                  source_channel  = 'manual',
                  recorded_by     = $8
            where id = $1
            returning id`,
          [
            id,
            storedResult,
            body.inspectionType ?? null,
            body.scheduledFor !== undefined,
            body.scheduledFor ?? null,
            body.inspectorNote !== undefined,
            body.inspectorNote ?? null,
            auth.userId,
          ],
        );
        if (!updated) throw notFound('Inspection');

        // The transition, not the value: re-sending FAILED books nothing new.
        let reinspection: Record<string, unknown> | null = null;
        const nowFailed = storedResult === 'failed' && existing.result !== 'failed';

        if (nowFailed) {
          const when =
            body.reinspectionScheduledFor !== undefined
              ? body.reinspectionScheduledFor
              : new Date(
                  Date.now() + REINSPECTION_LEAD_DAYS * 24 * 60 * 60 * 1000,
                ).toISOString();

          const created = await tx.one<{ id: string }>(
            `insert into ocs.permit_inspections
               (permit_id, inspection_type, scheduled_for, reinspection_of_id,
                source_channel, recorded_by)
             values ($1, $2, $3::timestamptz, $4, 'manual', $5)
             returning id`,
            [existing.permit_id, existing.inspection_type, when, existing.id, auth.userId],
          );
          const fullReinspection = await tx.one<Row>(
            `select ${SELECT} ${FROM} where i.id = $1`,
            [created!.id],
          );
          reinspection = present(fullReinspection!);
        }

        if (body.result) {
          await tx.query(
            `insert into ocs.permit_events (permit_id, note, source_channel, actor_user_id)
             values ($1, $2, 'manual', $3)`,
            [
              existing.permit_id,
              `${existing.inspection_type} inspection ${body.result.toLowerCase()}` +
                (nowFailed ? '; re-inspection booked' : ''),
              auth.userId,
            ],
          );
        }

        await writeAudit(tx, {
          companyId: existing.company_id,
          actorUserId: auth.userId,
          actorEmail: auth.email,
          action: 'inspection.recorded',
          entityType: 'permit',
          entityId: existing.permit_id,
          summary:
            `${existing.inspection_type} inspection ` +
            `${body.result ? body.result.toLowerCase() : 'updated'}`,
          before: { result: toInspectionResult(existing.result) },
          after: { result: body.result ?? toInspectionResult(existing.result) },
          requestId: req.id,
          ipAddress: clientIp(req),
          userAgent: userAgent(req),
        });

        const full = await tx.one<Row>(`select ${SELECT} ${FROM} where i.id = $1`, [id]);
        return { inspection: present(full!), reinspection };
      });
    },
  );

  /**
   * The chain of attempts behind one inspection, oldest first.
   *
   * Not in the previous API. It exists because `reinspectionOfId` is only
   * useful if something walks it, and "how many attempts did this milestone
   * take" is the question the data was shaped to answer.
   */
  app.get(
    '/api/inspections/:id/chain',
    { preHandler: [requireApiAuth, requireCapability('inspection:read')] },
    async (req) => {
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');

      return scoped(req, async (tx, companyId) => {
        const rows = await tx.many<Row>(
          `with recursive back as (
             select i.* from ocs.permit_inspections i
              where i.id = $1 and ($2::uuid is null or i.company_id = $2::uuid)
             union
             select prev.* from ocs.permit_inspections prev
               join back b on b.reinspection_of_id = prev.id
           ),
           forward as (
             select i.* from ocs.permit_inspections i
              where i.id = $1 and ($2::uuid is null or i.company_id = $2::uuid)
             union
             select next_i.* from ocs.permit_inspections next_i
               join forward f on next_i.reinspection_of_id = f.id
           ),
           chain as (select * from back union select * from forward)
           select ${SELECT}
             from chain i
             join ocs.permits p on p.id = i.permit_id
             left join ocs.municipalities m on m.id = p.municipality_id
            order by i.created_at asc`,
          [id, companyId],
        );
        if (rows.length === 0) throw notFound('Inspection');

        const chain = rows.map(present);
        return { chain, attempts: chain.length };
      });
    },
  );
}

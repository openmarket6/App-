/**
 * /api/notary — notarization requests and the record of the act.
 *
 * Unlike the rest of this API, the value here is not in serving a screen. It is
 * in the record being correct and unaltered when somebody disputes a lien or a
 * Notice of Commencement years from now. So the rules that matter are database
 * constraints (0019), not checks in this file: a completed act cannot be
 * edited, a remote online notarization cannot be completed without a pointer to
 * the session recording Florida requires, a commission that had expired cannot
 * have performed the act, and the ten-year retention deadline is computed by
 * the database rather than accepted from a caller.
 *
 * What this file adds is turning those refusals into sentences a person can act
 * on, because a constraint violation surfaced raw is a 500 nobody can fix.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant, withServiceContext, type Tx } from '../../db/tenant.js';
import { requireApiAuth, requireCapability } from './auth.js';
import { parse, clientIp, userAgent } from '../../lib/http-helpers.js';
import { writeAudit } from '../../lib/audit.js';
import { notFound, badRequest, forbidden, conflict } from '../../lib/errors.js';

const TYPES = ['RON', 'IN_PERSON'] as const;
const PROVIDERS = ['DOCUSIGN_NOTARY', 'PROOF', 'BLUENOTARY', 'IN_HOUSE'] as const;
const STATUSES = ['REQUESTED', 'SCHEDULED', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;

const down = (v: string): string => v.toLowerCase();

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
    reason: `notary_${auth.role}`,
    ...(requestedClientId ? { companyId: requestedClientId } : {}),
  });
}

const SELECT = `
  n.id,
  n.company_id  as "clientId",
  n.document_id as "documentId",
  n.signature_request_id as "signatureRequestId",
  upper(n.type::text)     as type,
  upper(n.status::text)   as status,
  upper(n.provider::text) as provider,
  n.scheduled_for as "scheduledFor",
  n.completed_at  as "completedAt",
  n.notary_name   as "notaryName",
  n.notary_commission_number     as "notaryCommissionNumber",
  n.notary_commission_expires_at as "notaryCommissionExpiresAt",
  n.session_recording_ref as "sessionRecordingRef",
  n.journal_entry_ref     as "journalEntryRef",
  n.retention_until as "retentionUntil",
  n.external_id  as "externalId",
  n.created_at   as "createdAt",
  n.updated_at   as "updatedAt",
  d.name         as "documentName"
`;

const FROM = `from ocs.notarizations n join ocs.documents d on d.id = n.document_id`;

/**
 * Turns a database refusal into something a person can act on.
 *
 * These constraints exist precisely because they must not be bypassable, which
 * means callers WILL hit them. A raw constraint name in a 500 tells the person
 * on the phone nothing; the sentence below tells them what to do next.
 */
function explain(err: unknown): never {
  const message = String((err as { message?: string })?.message ?? '');

  if (message.includes('notarizations_ron_needs_recording')) {
    throw badRequest(
      'A remote online notarization needs a session recording reference. Florida ' +
        'requires the audio-video recording to be retained for ten years ' +
        '(s.117.245, F.S.), and a record with no pointer to it is not a complete record.',
    );
  }
  if (message.includes('notarizations_completed_names_notary')) {
    throw badRequest(
      'A completed notarization must name the notary and their commission number. ' +
        '"Notarized by someone" is not a record anybody can rely on.',
    );
  }
  if (message.includes('the notary commission expired')) {
    throw badRequest(
      `${message.replace(/^.*?ERROR:\s*/, '')} A notarial act performed after the ` +
        'commission expired is void, so it cannot be recorded as valid.',
    );
  }
  if (message.includes('a completed notarization is a finished record')) {
    throw conflict(
      'That notarization is complete and cannot be changed. Only the session ' +
        'recording and journal references may still be attached. Anything else ' +
        'would be a different notarial act, needing its own record.',
    );
  }
  throw err as Error;
}

export async function compatNotaryRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/notary',
    { preHandler: [requireApiAuth, requireCapability('document:read')] },
    async (req) => {
      const q = parse(
        z.object({
          clientId: z.string().uuid().optional(),
          documentId: z.string().uuid().optional(),
          status: z.enum(STATUSES).optional(),
        }),
        req.query,
        'query',
      );

      return scoped(
        req,
        async (tx, companyId) => {
          const requests = await tx.many(
            `select ${SELECT} ${FROM}
              where ($1::uuid is null or n.company_id = $1::uuid)
                and ($2::uuid is null or n.document_id = $2::uuid)
                and ($3::text is null or n.status::text = $3::text)
              order by n.created_at desc
              limit 500`,
            [companyId, q.documentId ?? null, q.status ? down(q.status) : null],
          );

          return {
            requests,
            total: requests.length,
            openCount: requests.filter((r) => {
              const s = (r as { status: string }).status;
              return s === 'REQUESTED' || s === 'SCHEDULED';
            }).length,
          };
        },
        q.clientId ?? null,
      );
    },
  );

  /** Ask for a document to be notarized. */
  app.post(
    '/api/notary',
    { preHandler: [requireApiAuth, requireCapability('document:upload')] },
    async (req, reply) => {
      const auth = req.apiAuth!;
      const body = parse(
        z.object({
          documentId: z.string().uuid(),
          type: z.enum(TYPES),
          provider: z.enum(PROVIDERS).nullable().optional(),
          signatureRequestId: z.string().uuid().nullable().optional(),
          scheduledFor: z.string().datetime().nullable().optional(),
          externalId: z.string().max(200).nullable().optional(),
        }),
        req.body,
        'notarization',
      );

      const result = await scoped(req, async (tx, companyId) => {
        const doc = await tx.one<{ id: string; company_id: string }>(
          `select id, company_id from ocs.documents
            where id = $1 and deleted_at is null
              and ($2::uuid is null or company_id = $2::uuid)`,
          [body.documentId, companyId],
        );
        if (!doc) throw notFound('Document');

        const created = await tx.one<{ id: string }>(
          `insert into ocs.notarizations
             (company_id, document_id, signature_request_id, type, status, provider,
              scheduled_for, external_id, requested_by)
           values ($1, $2, $3, $4::ocs.notary_type,
                   case when $5::timestamptz is null then 'requested' else 'scheduled' end::ocs.notary_status,
                   $6::ocs.notary_provider, $5::timestamptz, $7, $8)
           returning id`,
          [
            doc.company_id, body.documentId, body.signatureRequestId ?? null,
            down(body.type), body.scheduledFor ?? null,
            body.provider ? down(body.provider) : null,
            body.externalId ?? null, auth.userId,
          ],
        );

        await writeAudit(tx, {
          companyId: doc.company_id,
          actorUserId: auth.userId,
          actorEmail: auth.email,
          action: 'notary.requested',
          entityType: 'notarization',
          entityId: created!.id,
          summary: `${body.type} notarization requested`,
          after: { type: body.type, scheduledFor: body.scheduledFor ?? null },
          requestId: req.id,
          ipAddress: clientIp(req),
          userAgent: userAgent(req),
        });

        return tx.one(`select ${SELECT} ${FROM} where n.id = $1`, [created!.id]);
      });

      reply.code(201);
      return result;
    },
  );

  /** Reschedule, reassign, or cancel — while it is still open. */
  app.patch(
    '/api/notary/:id',
    { preHandler: [requireApiAuth, requireCapability('document:upload')] },
    async (req) => {
      const auth = req.apiAuth!;
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
      const body = parse(
        z.object({
          // COMPLETED is deliberately absent. Completing an act is its own
          // endpoint, because it requires evidence this one does not collect.
          status: z.enum(['REQUESTED', 'SCHEDULED', 'FAILED', 'CANCELLED']).optional(),
          type: z.enum(TYPES).optional(),
          provider: z.enum(PROVIDERS).nullable().optional(),
          scheduledFor: z.string().datetime().nullable().optional(),
          externalId: z.string().max(200).nullable().optional(),
          /*
           * Who is doing the act, and under what commission.
           *
           * The scheduling drawer has always sent these three and the schema
           * was .strict(), so every attempt to schedule a notarization from
           * the interface returned 400 -- not a silent drop, a hard refusal.
           * They belong here: a notary session that does not say who will
           * perform it is a diary entry, and the commission number is what
           * makes the resulting certificate checkable years later.
           */
          notaryName: z.string().trim().max(200).nullable().optional(),
          notaryCommissionNumber: z.string().trim().max(120).nullable().optional(),
          notaryCommissionExpiresAt: z.string().datetime().nullable().optional(),
        }).strict(),
        req.body,
        'notarization',
      );

      return scoped(req, async (tx, companyId) => {
        const existing = await tx.one<{ id: string; status: string; company_id: string }>(
          `select id, status::text as status, company_id from ocs.notarizations
            where id = $1 and ($2::uuid is null or company_id = $2::uuid)`,
          [id, companyId],
        );
        if (!existing) throw notFound('Notarization');
        if (existing.status === 'completed') {
          throw conflict(
            'That notarization is complete and cannot be changed here. Use the ' +
              'complete endpoint only once, and record a further act separately.',
          );
        }

        try {
          await tx.query(
            `update ocs.notarizations
                set status        = coalesce($2::ocs.notary_status,
                                      case when $3::boolean and $4::timestamptz is not null
                                             and status = 'requested'
                                           then 'scheduled'::ocs.notary_status
                                           else status end),
                    type          = coalesce($5::ocs.notary_type, type),
                    provider      = case when $6::boolean then $7::ocs.notary_provider else provider end,
                    scheduled_for = case when $3::boolean then $4::timestamptz else scheduled_for end,
                    external_id   = case when $8::boolean then $9 else external_id end,
                    notary_name   = case when $10::boolean then $11 else notary_name end,
                    notary_commission_number =
                      case when $12::boolean then $13 else notary_commission_number end,
                    notary_commission_expires_at =
                      case when $14::boolean then $15::timestamptz else notary_commission_expires_at end
              where id = $1`,
            [
              id,
              body.status ? down(body.status) : null,
              body.scheduledFor !== undefined,
              body.scheduledFor ?? null,
              body.type ? down(body.type) : null,
              body.provider !== undefined,
              body.provider ? down(body.provider) : null,
              body.externalId !== undefined,
              body.externalId ?? null,
              body.notaryName !== undefined,
              body.notaryName ?? null,
              body.notaryCommissionNumber !== undefined,
              body.notaryCommissionNumber ?? null,
              body.notaryCommissionExpiresAt !== undefined,
              body.notaryCommissionExpiresAt ?? null,
            ],
          );
        } catch (err) {
          explain(err);
        }

        void auth;
        return tx.one(`select ${SELECT} ${FROM} where n.id = $1`, [id]);
      });
    },
  );

  /**
   * Record that the act happened.
   *
   * Separate from PATCH because it demands evidence: who notarized, under what
   * commission, and for a RON, where the session recording lives. Folding it
   * into a general update would make it possible to set status=COMPLETED
   * without any of that.
   */
  app.post(
    '/api/notary/:id/complete',
    { preHandler: [requireApiAuth, requireCapability('document:upload')] },
    async (req) => {
      const auth = req.apiAuth!;
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
      const body = parse(
        z.object({
          provider: z.enum(PROVIDERS),
          notaryName: z.string().trim().min(1).max(200),
          notaryCommissionNumber: z.string().trim().min(1).max(80),
          notaryCommissionExpiresAt: z.string().date().nullable().optional(),
          sessionRecordingRef: z.string().max(500).nullable().optional(),
          journalEntryRef: z.string().max(500).nullable().optional(),
          externalId: z.string().max(200).nullable().optional(),
          completedAt: z.string().datetime().optional(),
        }).strict(),
        req.body,
        'notarization',
      );

      return scoped(req, async (tx, companyId) => {
        const existing = await tx.one<{ id: string; status: string; company_id: string; type: string }>(
          `select id, status::text as status, company_id, type::text as type
             from ocs.notarizations
            where id = $1 and ($2::uuid is null or company_id = $2::uuid)`,
          [id, companyId],
        );
        if (!existing) throw notFound('Notarization');
        if (existing.status === 'completed') {
          throw conflict('That notarization has already been completed');
        }

        try {
          await tx.query(
            `update ocs.notarizations
                set status = 'completed',
                    provider = $2::ocs.notary_provider,
                    completed_at = coalesce($3::timestamptz, now()),
                    notary_name = $4,
                    notary_commission_number = $5,
                    notary_commission_expires_at = $6::date,
                    session_recording_ref = $7,
                    journal_entry_ref = $8,
                    external_id = coalesce($9, external_id)
              where id = $1`,
            [
              id, down(body.provider), body.completedAt ?? null,
              body.notaryName, body.notaryCommissionNumber,
              body.notaryCommissionExpiresAt ?? null,
              body.sessionRecordingRef ?? null,
              body.journalEntryRef ?? null,
              body.externalId ?? null,
            ],
          );
        } catch (err) {
          explain(err);
        }

        const record = await tx.one<{ retentionUntil: Date | string | null }>(
          `select ${SELECT} ${FROM} where n.id = $1`,
          [id],
        );

        /**
         * The driver hands back a Date for a timestamptz, and String(date)
         * produces "Fri Aug 22 2036 ..." -- so slicing ten characters off it
         * yields "Fri Aug 22", which is not a date anybody can act on. The
         * retention deadline is a legal one; it gets written unambiguously.
         */
        const retentionDate = record?.retentionUntil
          ? new Date(record.retentionUntil).toISOString().slice(0, 10)
          : null;

        await writeAudit(tx, {
          companyId: existing.company_id,
          actorUserId: auth.userId,
          actorEmail: auth.email,
          action: 'notary.completed',
          entityType: 'notarization',
          entityId: id,
          summary: `${existing.type.toUpperCase()} notarization completed by ${body.notaryName}`,
          after: {
            notaryName: body.notaryName,
            commissionNumber: body.notaryCommissionNumber,
            retentionUntil: retentionDate,
          },
          requestId: req.id,
          ipAddress: clientIp(req),
          userAgent: userAgent(req),
        });

        return {
          request: record,
          retentionNote:
            `The provider must retain the session recording and journal entry until ` +
            `${retentionDate} — ten years from the notarial act (s.117.245, F.S.).`,
        };
      });
    },
  );
}

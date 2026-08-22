/**
 * /api/generated-documents — instruments this system produces.
 *
 * Distinct from /api/documents, which is files people upload. The difference
 * that matters is accountability: an uploaded file is somebody else's work
 * product, and a generated Notice of Commencement is ours. If one is defective
 * the question is what we made it from, and only a system that stored the
 * inputs can answer.
 *
 * So every route here is built around three refusals:
 *
 *   - Refuse to generate while a blocking problem stands. A document that looks
 *     right and is defective is worse than no document: nobody relies on the
 *     one that was never produced.
 *   - Refuse to edit in place. A correction produces a NEW document that
 *     supersedes the old one, because the snapshot must not move under a
 *     signature that has already been given.
 *   - Refuse to delete. A void is a status, with a reason and a date.
 *
 * ⚠️ The templates have not been reviewed by a Florida construction attorney.
 * See src/domain/documents/noc.ts.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { withTenant, withServiceContext, type Tx } from '../../db/tenant.js';
import { requireApiAuth, requireCapability } from './auth.js';
import { parse, clientIp, userAgent } from '../../lib/http-helpers.js';
import { writeAudit } from '../../lib/audit.js';
import { notFound, badRequest, forbidden, conflict } from '../../lib/errors.js';
import {
  DOCUMENT_KINDS, DOCUMENT_KIND_LABELS, validateDocument, generateDocument,
  type DocumentKind, type FieldProblem,
} from '../../domain/documents/index.js';

const KIND = z.enum(DOCUMENT_KINDS as unknown as [string, ...string[]]);

/** Which terminal status each kind can reach. Mirrors the DB check constraint. */
const TERMINAL_STATUS: Record<DocumentKind, 'recorded' | 'served' | 'executed'> = {
  NOC: 'recorded',
  NTO: 'served',
  HOLD_HARMLESS: 'executed',
  CONTRACTOR_AGREEMENT: 'executed',
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
    reason: `generated_documents_${auth.role}`,
    ...(requestedClientId ? { companyId: requestedClientId } : {}),
  });
}

const SELECT = `
  g.id,
  g.company_id as "clientId",
  g.kind::text as kind,
  g.status::text as status,
  g.title,
  g.project_id as "projectId",
  g.permit_id as "permitId",
  g.content_sha256 as sha256,
  g.warnings,
  g.document_id as "documentId",
  g.supersedes_id as "supersedesId",
  g.generated_by as "generatedBy",
  g.generated_at as "generatedAt",
  g.completed_at as "completedAt",
  g.completion_reference as "completionReference",
  g.completion_note as "completionNote",
  g.voided_at as "voidedAt",
  g.void_reason as "voidReason",
  (select s.id from ocs.generated_documents s where s.supersedes_id = g.id limit 1)
    as "supersededById"
`;

/*
 * The same column list, for `returning`, where there is no `g` alias to hang
 * off. Derived from SELECT rather than written twice: two column lists that
 * must agree are two column lists that eventually do not.
 */
const RETURNING = SELECT.replace(/\bg\./g, 'ocs.generated_documents.');

interface Row {
  kind: string;
  supersededById: string | null;
  [k: string]: unknown;
}

function present(row: Row) {
  return {
    ...row,
    kindLabel: DOCUMENT_KIND_LABELS[row.kind as DocumentKind] ?? row.kind,
    // Derived, never stored: "is this the current version" is a question about
    // what else exists, and a stored flag goes stale the moment a correction
    // is generated.
    isCurrent: row.supersededById === null && row.status !== 'void',
  };
}

/** A blocking-problem response the UI can render field by field. */
function refusal(problems: FieldProblem[]) {
  return badRequest(
    'This document cannot be produced yet — ' +
      `${problems.filter((p) => p.severity === 'blocking').length} required ` +
      'item(s) are missing or wrong.',
    { problems },
  );
}

export async function compatGeneratedDocumentsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * What can be produced, and what each one needs.
   *
   * A GET so the UI can build the form from the same source the validator
   * reads. Two hand-maintained field lists is how a form drifts from what the
   * server will accept.
   */
  app.get(
    '/api/generated-documents/kinds',
    { preHandler: [requireApiAuth] },
    async () => ({
      kinds: DOCUMENT_KINDS.map((k) => ({ kind: k, label: DOCUMENT_KIND_LABELS[k] })),
    }),
  );

  /**
   * Check without producing.
   *
   * The form calls this as the user types, so problems appear beside fields
   * rather than as a wall of text after a failed save.
   */
  app.post(
    '/api/generated-documents/validate',
    { preHandler: [requireApiAuth, requireCapability('document:generate')] },
    async (req) => {
      const body = parse(
        z.object({ kind: KIND, input: z.record(z.unknown()) }),
        req.body,
        'body',
      );
      const problems = validateDocument(body.kind as DocumentKind, body.input);
      return {
        kind: body.kind,
        ok: !problems.some((p) => p.severity === 'blocking'),
        problems,
      };
    },
  );

  app.get(
    '/api/generated-documents',
    { preHandler: [requireApiAuth, requireCapability('document:read')] },
    async (req) => {
      const q = parse(
        z.object({
          clientId: z.string().uuid().optional(),
          permitId: z.string().uuid().optional(),
          projectId: z.string().uuid().optional(),
          kind: KIND.optional(),
          includeSuperseded: z.enum(['true', '1', 'false', '0']).optional(),
        }),
        req.query,
        'query',
      );
      const includeSuperseded = q.includeSuperseded === 'true' || q.includeSuperseded === '1';

      return scoped(
        req,
        async (tx, companyId) => {
          const rows = await tx.many<Row>(
            `select ${SELECT}
               from ocs.generated_documents g
              where ($1::uuid is null or g.company_id = $1::uuid)
                and ($2::uuid is null or g.permit_id = $2::uuid)
                and ($3::uuid is null or g.project_id = $3::uuid)
                and ($4::text is null or g.kind::text = $4::text)
              order by g.generated_at desc
              limit 500`,
            [companyId, q.permitId ?? null, q.projectId ?? null, q.kind ?? null],
          );
          const documents = rows.map(present)
            .filter((d) => includeSuperseded || d.supersededById === null);
          return { documents, total: documents.length };
        },
        q.clientId ?? null,
      );
    },
  );

  /** The record, including what it was rendered from. */
  app.get(
    '/api/generated-documents/:id',
    { preHandler: [requireApiAuth, requireCapability('document:read')] },
    async (req) => {
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
      return scoped(req, async (tx, companyId) => {
        const row = await tx.one<Row & { inputSnapshot: unknown }>(
          `select ${SELECT}, g.input_snapshot as "inputSnapshot"
             from ocs.generated_documents g
            where g.id = $1 and ($2::uuid is null or g.company_id = $2::uuid)`,
          [id, companyId],
        );
        if (!row) throw notFound('Document');
        return present(row);
      });
    },
  );

  /**
   * The rendered page.
   *
   * Served from storage rather than re-rendered on the way out. Re-rendering
   * would produce today's template applied to yesterday's facts, and the whole
   * point of a signed instrument is that it does not change after signature.
   */
  app.get(
    '/api/generated-documents/:id/html',
    { preHandler: [requireApiAuth, requireCapability('document:read')] },
    async (req, reply) => {
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
      const html = await scoped(req, async (tx, companyId) => {
        const row = await tx.one<{ rendered_html: string }>(
          `select rendered_html from ocs.generated_documents
            where id = $1 and ($2::uuid is null or company_id = $2::uuid)`,
          [id, companyId],
        );
        if (!row) throw notFound('Document');
        return row.rendered_html;
      });
      /*
       * Rendered in a sandbox with no script capability. The page is our own
       * template, but the values inside it came from a form somebody filled in,
       * and a document viewer is not a place to find out that escaping had a
       * gap.
       */
      reply.header('Content-Type', 'text/html; charset=utf-8');
      reply.header(
        'Content-Security-Policy',
        // `sandbox` puts the page in an opaque origin, so even a hypothetical
        // escaping gap could not reach the API it was served from.
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; " +
          "frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox",
      );
      reply.header('X-Content-Type-Options', 'nosniff');
      return html;
    },
  );

  /**
   * Produce one.
   *
   * `supersedesId` is how a correction is made. There is no edit: the earlier
   * document keeps its snapshot and its hash, and the new one points back at
   * it, so the history of a corrected instrument stays readable.
   */
  app.post(
    '/api/generated-documents',
    { preHandler: [requireApiAuth, requireCapability('document:generate')] },
    async (req, reply) => {
      const auth = req.apiAuth!;
      const body = parse(
        z.object({
          clientId: z.string().uuid().optional(),
          kind: KIND,
          input: z.record(z.unknown()),
          title: z.string().trim().min(1).max(200).optional(),
          projectId: z.string().uuid().nullable().optional(),
          permitId: z.string().uuid().nullable().optional(),
          supersedesId: z.string().uuid().nullable().optional(),
          /**
           * Produce it even though warnings stand.
           *
           * Deliberately explicit. Serving a Notice to Owner past its window
           * may still be the right call, but it should be a decision somebody
           * makes, not a default they never saw.
           */
          acceptWarnings: z.boolean().optional(),
        }),
        req.body,
        'body',
      );
      const kind = body.kind as DocumentKind;

      return scoped(
        req,
        async (tx, companyId) => {
          if (!companyId) {
            throw badRequest('Say which contractor this document is for (clientId).');
          }

          const generatedAt = new Date();
          const result = generateDocument(
            kind,
            body.input,
            {
              generatedAt: generatedAt.toISOString(),
              companyName: null,
            },
            generatedAt,
          );
          if (!result.ok) throw refusal(result.problems);

          if (result.warnings.length > 0 && body.acceptWarnings !== true) {
            throw conflict(
              'This document can be produced, but there are things worth checking first. ' +
                'Re-send with acceptWarnings to go ahead.',
              { warnings: result.warnings },
            );
          }

          if (body.supersedesId) {
            const prior = await tx.one<{ id: string; kind: string }>(
              `select id, kind::text as kind from ocs.generated_documents
                where id = $1 and company_id = $2`,
              [body.supersedesId, companyId],
            );
            if (!prior) throw notFound('The document this replaces');
            if (prior.kind !== kind) {
              throw badRequest(
                `A ${DOCUMENT_KIND_LABELS[kind]} cannot supersede a ` +
                  `${DOCUMENT_KIND_LABELS[prior.kind as DocumentKind]}.`,
              );
            }
          }

          const sha256 = createHash('sha256').update(result.html, 'utf8').digest('hex');
          const title = body.title?.trim() || DOCUMENT_KIND_LABELS[kind];

          const row = await tx.one<Row>(
            `insert into ocs.generated_documents
               (company_id, kind, title, project_id, permit_id, input_snapshot,
                rendered_html, content_sha256, warnings, supersedes_id,
                generated_by, generated_at)
             values ($1, $2::ocs.generated_document_kind, $3, $4, $5, $6::jsonb,
                     $7, $8, $9::jsonb, $10, $11, $12)
             returning ${RETURNING}`,
            [
              companyId, kind, title, body.projectId ?? null, body.permitId ?? null,
              JSON.stringify(body.input), result.html, sha256,
              JSON.stringify(result.warnings), body.supersedesId ?? null,
              auth.userId, generatedAt,
            ],
          );
          if (!row) throw badRequest('The document could not be saved.');

          await writeAudit(tx, {
            companyId,
            actorUserId: auth.userId,
            actorEmail: auth.email,
            action: 'generated_document.create',
            entityType: 'generated_document',
            entityId: String(row['id']),
            /*
             * The hash goes in the audit log, not the document body. Somebody
             * asking later whether the page in their hand is the page we made
             * can answer it from the log alone, without opening the record.
             */
            summary: `${DOCUMENT_KIND_LABELS[kind]} generated`,
            after: {
              kind,
              sha256,
              warnings: result.warnings.length,
              acceptedWarnings: body.acceptWarnings === true,
              supersedesId: body.supersedesId ?? null,
            },
            ipAddress: clientIp(req),
            userAgent: userAgent(req),
          });

          reply.code(201);
          return { ...present(row), warnings: result.warnings };
        },
        body.clientId ?? null,
      );
    },
  );

  /**
   * Record what happened to it.
   *
   * One endpoint for recorded / served / executed, because they are the same
   * event seen from different statutes: the instrument left our hands and
   * something official happened to it. The reference — the clerk's instrument
   * number, the certified mail number — is what makes the claim checkable.
   */
  app.post(
    '/api/generated-documents/:id/complete',
    { preHandler: [requireApiAuth, requireCapability('document:record')] },
    async (req) => {
      const auth = req.apiAuth!;
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
      const body = parse(
        z.object({
          completedAt: z.string().datetime().optional(),
          reference: z.string().trim().min(1).max(200).optional(),
          note: z.string().trim().max(2000).optional(),
        }),
        req.body ?? {},
        'body',
      );

      return scoped(req, async (tx, companyId) => {
        const current = await tx.one<{ kind: string; status: string }>(
          `select kind::text as kind, status::text as status
             from ocs.generated_documents
            where id = $1 and ($2::uuid is null or company_id = $2::uuid)`,
          [id, companyId],
        );
        if (!current) throw notFound('Document');
        if (current.status === 'void') {
          throw conflict('This document was voided. Generate a replacement instead.');
        }

        const target = TERMINAL_STATUS[current.kind as DocumentKind];
        const completedAt = body.completedAt ? new Date(body.completedAt) : new Date();

        const row = await tx.one<Row>(
          `update ocs.generated_documents
              set status = $2::ocs.generated_document_status,
                  completed_at = $3,
                  completion_reference = coalesce($4, completion_reference),
                  completion_note = coalesce($5, completion_note)
            where id = $1
            returning ${RETURNING}`,
          [id, target, completedAt, body.reference ?? null, body.note ?? null],
        );
        if (!row) throw notFound('Document');

        await writeAudit(tx, {
          companyId: companyId ?? String(row['clientId']),
          actorUserId: auth.userId,
          actorEmail: auth.email,
          action: `generated_document.${target}`,
          entityType: 'generated_document',
          entityId: id,
          summary: `${DOCUMENT_KIND_LABELS[current.kind as DocumentKind]} ${target}`,
          after: { reference: body.reference ?? null, completedAt: completedAt.toISOString() },
          ipAddress: clientIp(req),
          userAgent: userAgent(req),
        });

        return present(row);
      });
    },
  );

  /**
   * Void one.
   *
   * Not a delete. A Notice of Commencement that was recorded and then withdrawn
   * is a fact about a job, and a system that erased it would leave the people
   * who relied on it with no explanation.
   */
  app.post(
    '/api/generated-documents/:id/void',
    { preHandler: [requireApiAuth, requireCapability('document:record')] },
    async (req) => {
      const auth = req.apiAuth!;
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
      const body = parse(
        z.object({ reason: z.string().trim().min(1).max(2000) }),
        req.body,
        'body',
      );

      return scoped(req, async (tx, companyId) => {
        const row = await tx.one<Row>(
          `update ocs.generated_documents
              set status = 'void', voided_at = now(), voided_by = $2, void_reason = $3
            where id = $1 and ($4::uuid is null or company_id = $4::uuid)
              and status <> 'void'
            returning ${RETURNING}`,
          [id, auth.userId, body.reason, companyId],
        );
        if (!row) throw notFound('Document');

        await writeAudit(tx, {
          companyId: companyId ?? String(row['clientId']),
          actorUserId: auth.userId,
          actorEmail: auth.email,
          action: 'generated_document.void',
          entityType: 'generated_document',
          entityId: id,
          summary: 'Generated document voided',
          after: { reason: body.reason },
          ipAddress: clientIp(req),
          userAgent: userAgent(req),
        });

        return present(row);
      });
    },
  );
}

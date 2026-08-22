/**
 * /api/documents — files, and the facts that make them evidence.
 *
 * A photograph with no capture time proves that somebody uploaded a picture.
 * The same photograph with a capture time and a location places a named person
 * on a job site on a date, which is the entire basis of the supervision record
 * this business sells. So the metadata is not decoration and is not optional:
 * it is the reason the file is worth keeping.
 *
 * Documents VERSION rather than overwrite. Agencies ask which revision went in
 * on which correction cycle, and a system that overwrites cannot answer.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { withTenant, withServiceContext, type Tx } from '../../db/tenant.js';
import { requireApiAuth, requireCapability } from './auth.js';
import { parse, clientIp, userAgent } from '../../lib/http-helpers.js';
import { writeAudit } from '../../lib/audit.js';
import { notFound, badRequest, forbidden } from '../../lib/errors.js';
import {
  buildStorageKey, uploadObject, createSignedDownloadUrl, assertAllowedContentType,
} from '../../services/storage.js';
import { DOCUMENT_CATEGORIES, type DocumentCategory } from '../../shared/types.js';

/** Stored vocabulary <-> the frontend's. See portal.ts for the same mapping. */
const TO_PORTAL: Record<string, DocumentCategory> = {
  permit_application: 'SUBMITTAL',
  drawing: 'PLAN_SET',
  approved_plan: 'AGENCY_ISSUED',
  inspection_report: 'AGENCY_ISSUED',
  correction_notice: 'AGENCY_ISSUED',
  photo: 'JOB_PHOTO',
  license: 'COMPLIANCE',
  insurance: 'COMPLIANCE',
  contract: 'SIGNED_AGREEMENT',
  receipt: 'OTHER',
  invoice: 'OTHER',
  correspondence: 'OTHER',
  other: 'OTHER',
};

const TO_STORED: Record<string, string> = {
  SUBMITTAL: 'permit_application',
  PLAN_SET: 'drawing',
  PRODUCT_APPROVAL: 'drawing',
  CORRECTION_RESPONSE: 'permit_application',
  AGENCY_ISSUED: 'approved_plan',
  JOB_PHOTO: 'photo',
  SUPERVISION_PHOTO: 'photo',
  COMPLIANCE: 'license',
  SIGNED_AGREEMENT: 'contract',
  OTHER: 'other',
};

/** 20 MB. Above this the browser should be using a signed upload URL instead. */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

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
    reason: `documents_${auth.role}`,
    ...(requestedClientId ? { companyId: requestedClientId } : {}),
  });
}

const SELECT = `
  d.id,
  d.permit_id as "permitId",
  d.company_id as "clientId",
  d.category::text as "storedCategory",
  coalesce(v.content_type, 'application/octet-stream') as "contentType",
  d.captured_at as "capturedAt",
  d.geo_lat as "geoLat",
  d.geo_lng as "geoLng",
  v.checksum_sha256 as sha256,
  coalesce(d.requirement_key, '') as "requirementKey",
  d.name as "fileName",
  d.version_count as version,
  d.supersedes_id as "supersedesId",
  d.submitted_on_cycle as "submittedOnCycle",
  coalesce(v.byte_size, 0)::int as "sizeBytes",
  d.created_at as "uploadedAt",
  (select s.id from ocs.documents s where s.supersedes_id = d.id limit 1) as "supersededById"
`;

const FROM = `
  from ocs.documents d
  left join ocs.document_versions v on v.id = d.current_version_id
`;

interface Row {
  storedCategory: string;
  geoLat: number | null;
  geoLng: number | null;
  supersededById: string | null;
  [k: string]: unknown;
}

/** Shapes a stored row into the PermitDocument the frontend expects. */
function present(row: Row) {
  const { storedCategory, geoLat, geoLng, supersededById, ...rest } = row;
  return {
    ...rest,
    category: TO_PORTAL[storedCategory] ?? 'OTHER',
    geo: geoLat != null && geoLng != null ? { lat: geoLat, lng: geoLng } : null,
    // Derived rather than stored: "is this the current revision" is a question
    // about what else exists, and a stored flag would go stale the moment a
    // newer revision landed.
    status: supersededById ? 'SUPERSEDED' : 'UPLOADED',
    supersededById,
  };
}

export async function compatDocumentsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/documents',
    { preHandler: [requireApiAuth, requireCapability('document:read')] },
    async (req) => {
      const q = parse(
        z.object({
          clientId: z.string().uuid().optional(),
          permitId: z.string().uuid().optional(),
          projectId: z.string().uuid().optional(),
          category: z.enum(DOCUMENT_CATEGORIES as unknown as [string, ...string[]]).optional(),
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
            `select ${SELECT} ${FROM}
              where d.deleted_at is null
                and ($1::uuid is null or d.company_id = $1::uuid)
                and ($2::uuid is null or d.permit_id = $2::uuid)
                and ($3::uuid is null or d.project_id = $3::uuid)
                and ($4::text is null or d.category::text = $4::text)
              order by coalesce(d.captured_at, d.created_at) desc
              limit 1000`,
            [
              companyId, q.permitId ?? null, q.projectId ?? null,
              q.category ? (TO_STORED[q.category] ?? null) : null,
            ],
          );

          const documents = rows.map(present)
            .filter((d) => includeSuperseded || d.status !== 'SUPERSEDED');

          return { documents, total: documents.length };
        },
        q.clientId ?? null,
      );
    },
  );

  /** A time-limited link. Never a permanent one: these are private records. */
  app.get(
    '/api/documents/:id/download',
    { preHandler: [requireApiAuth, requireCapability('document:read')] },
    async (req) => {
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');

      return scoped(req, async (tx, companyId) => {
        const doc = await tx.one<{ storage_key: string; file_name: string }>(
          `select v.storage_key, v.file_name
             from ocs.documents d
             join ocs.document_versions v on v.id = d.current_version_id
            where d.id = $1 and d.deleted_at is null
              and ($2::uuid is null or d.company_id = $2::uuid)`,
          [id, companyId],
        );
        if (!doc) throw notFound('Document');

        const signed = await createSignedDownloadUrl(doc.storage_key);
        return { url: signed.url, fileName: doc.file_name, expiresInSeconds: signed.expiresInSeconds };
      });
    },
  );

  /**
   * Photographs from a job site.
   *
   * Its own endpoint rather than a flag on a general upload, because the
   * metadata it insists on is different: the camera's own timestamp and, where
   * the device gave one, a location. Those two fields are what make the file
   * evidence rather than a picture.
   */
  app.post(
    '/api/documents/photos',
    { preHandler: [requireApiAuth, requireCapability('document:upload')] },
    async (req, reply) => {
      const auth = req.apiAuth!;
      const body = parse(
        z.object({
          clientId: z.string().uuid().optional(),
          permitId: z.string().uuid().nullable().optional(),
          projectId: z.string().uuid().nullable().optional(),
          fileName: z.string().trim().min(1).max(300),
          contentType: z.string().trim().min(1).max(120),
          sizeBytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
          dataBase64: z.string().min(1),
          capturedAt: z.string().datetime().nullable().optional(),
          geo: z.object({
            lat: z.number().min(-90).max(90),
            lng: z.number().min(-180).max(180),
          }).nullable().optional(),
          category: z.enum(['JOB_PHOTO', 'SUPERVISION_PHOTO']).default('JOB_PHOTO'),
        }),
        req.body,
        'photo',
      );

      if (!body.contentType.startsWith('image/')) {
        throw badRequest('That is not an image. Use the document upload for other files.');
      }
      assertAllowedContentType(body.contentType);

      const bytes = Buffer.from(body.dataBase64, 'base64');
      if (bytes.byteLength === 0) throw badRequest('The photo came through empty');
      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        throw badRequest('That photo is too large. Around 20 MB is the limit.');
      }
      /**
       * The declared size and the real size must agree. A mismatch means the
       * upload was truncated in transit, and a truncated photograph looks
       * perfectly fine in a list until somebody opens it as evidence.
       */
      if (Math.abs(bytes.byteLength - body.sizeBytes) > 16) {
        throw badRequest(
          'That photo did not arrive intact — the size does not match what was sent. Try again.',
        );
      }

      const result = await scoped(
        req,
        async (tx, scopeCompany) => {
          let companyId = scopeCompany;

          if (body.permitId) {
            const permit = await tx.one<{ id: string; company_id: string; project_id: string }>(
              `select id, company_id, project_id from ocs.permits
                where id = $1 and deleted_at is null`,
              [body.permitId],
            );
            if (!permit) throw badRequest('No such permit');
            if (companyId && permit.company_id !== companyId) {
              throw forbidden('That permit belongs to a different contractor');
            }
            companyId = permit.company_id;
          }
          if (!companyId) throw badRequest('A photo must belong to a contractor');

          const sha256 = createHash('sha256').update(bytes).digest('hex');

          const doc = await tx.one<{ id: string }>(
            `insert into ocs.documents
               (company_id, permit_id, project_id, name, category,
                captured_at, geo_lat, geo_lng, uploaded_by, version_count)
             values ($1,$2,$3,$4,$5::ocs.document_category,$6::timestamptz,$7,$8,$9,1)
             returning id`,
            [
              companyId, body.permitId ?? null, body.projectId ?? null,
              body.fileName, 'photo',
              body.capturedAt ?? null,
              body.geo?.lat ?? null, body.geo?.lng ?? null,
              auth.userId,
            ],
          );

          const key = buildStorageKey({
            companyId, documentId: doc!.id, versionNumber: 1, fileName: body.fileName,
          });

          // Stored BEFORE the row is finalised, so a failed upload leaves a
          // document with no current version rather than a row pointing at
          // bytes that are not there.
          const stored = await uploadObject(key, bytes, body.contentType);

          const version = await tx.one<{ id: string }>(
            `insert into ocs.document_versions
               (company_id, document_id, version_number, storage_bucket, storage_key,
                file_name, content_type, byte_size, checksum_sha256, uploaded_by, upload_state)
             values ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,'stored')
             returning id`,
            [
              companyId, doc!.id, stored.bucket, stored.key, body.fileName,
              body.contentType, bytes.byteLength, sha256, auth.userId,
            ],
          );

          await tx.query(
            `update ocs.documents set current_version_id = $2 where id = $1`,
            [doc!.id, version!.id],
          );

          await writeAudit(tx, {
            companyId,
            actorUserId: auth.userId,
            actorEmail: auth.email,
            action: 'document.photo_uploaded',
            entityType: 'document',
            entityId: doc!.id,
            summary: `Photo uploaded: ${body.fileName}`,
            after: {
              permitId: body.permitId ?? null,
              capturedAt: body.capturedAt ?? null,
              hasLocation: Boolean(body.geo),
              sha256,
            },
            requestId: req.id,
            ipAddress: clientIp(req),
            userAgent: userAgent(req),
          });

          const row = await tx.one<Row>(`select ${SELECT} ${FROM} where d.id = $1`, [doc!.id]);
          return { document: present(row!), superseded: null };
        },
        body.clientId ?? null,
      );

      reply.code(201);
      return result;
    },
  );

  /**
   * Any other document.
   *
   * `supersedesId` records a revision replacing an earlier one rather than
   * overwriting it, because agencies ask which revision went in on which
   * correction cycle.
   */
  app.post(
    '/api/documents',
    { preHandler: [requireApiAuth, requireCapability('document:upload')] },
    async (req, reply) => {
      const auth = req.apiAuth!;
      const body = parse(
        z.object({
          clientId: z.string().uuid().optional(),
          permitId: z.string().uuid().nullable().optional(),
          projectId: z.string().uuid().nullable().optional(),
          category: z.enum(DOCUMENT_CATEGORIES as unknown as [string, ...string[]]),
          fileName: z.string().trim().min(1).max(300),
          contentType: z.string().trim().min(1).max(120),
          sizeBytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
          dataBase64: z.string().min(1),
          supersedesId: z.string().uuid().nullable().optional(),
          requirementKey: z.string().trim().max(120).nullable().optional(),
          submittedOnCycle: z.number().int().min(0).nullable().optional(),
        }),
        req.body,
        'document',
      );

      assertAllowedContentType(body.contentType);
      const bytes = Buffer.from(body.dataBase64, 'base64');
      if (bytes.byteLength === 0) throw badRequest('The file came through empty');
      if (Math.abs(bytes.byteLength - body.sizeBytes) > 16) {
        throw badRequest('That file did not arrive intact — the size does not match. Try again.');
      }

      const result = await scoped(
        req,
        async (tx, scopeCompany) => {
          let companyId = scopeCompany;

          if (body.permitId) {
            const permit = await tx.one<{ company_id: string }>(
              `select company_id from ocs.permits where id = $1 and deleted_at is null`,
              [body.permitId],
            );
            if (!permit) throw badRequest('No such permit');
            if (companyId && permit.company_id !== companyId) {
              throw forbidden('That permit belongs to a different contractor');
            }
            companyId = permit.company_id;
          }
          if (!companyId) throw badRequest('A document must belong to a contractor');

          let supersededRow: Row | null = null;
          if (body.supersedesId) {
            const prior = await tx.one<Row>(
              `select ${SELECT} ${FROM} where d.id = $1 and d.company_id = $2 and d.deleted_at is null`,
              [body.supersedesId, companyId],
            );
            if (!prior) throw badRequest('The document being replaced was not found');
            supersededRow = prior;
          }

          const sha256 = createHash('sha256').update(bytes).digest('hex');
          const storedCategory = TO_STORED[body.category] ?? 'other';

          const doc = await tx.one<{ id: string }>(
            `insert into ocs.documents
               (company_id, permit_id, project_id, name, category, supersedes_id,
                requirement_key, submitted_on_cycle, uploaded_by, version_count)
             values ($1,$2,$3,$4,$5::ocs.document_category,$6,$7,$8,$9,1)
             returning id`,
            [
              companyId, body.permitId ?? null, body.projectId ?? null,
              body.fileName, storedCategory, body.supersedesId ?? null,
              body.requirementKey ?? null, body.submittedOnCycle ?? null, auth.userId,
            ],
          );

          const key = buildStorageKey({
            companyId, documentId: doc!.id, versionNumber: 1, fileName: body.fileName,
          });
          const stored = await uploadObject(key, bytes, body.contentType);

          const version = await tx.one<{ id: string }>(
            `insert into ocs.document_versions
               (company_id, document_id, version_number, storage_bucket, storage_key,
                file_name, content_type, byte_size, checksum_sha256, uploaded_by, upload_state)
             values ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,'stored')
             returning id`,
            [
              companyId, doc!.id, stored.bucket, stored.key, body.fileName,
              body.contentType, bytes.byteLength, sha256, auth.userId,
            ],
          );

          await tx.query(
            `update ocs.documents set current_version_id = $2 where id = $1`,
            [doc!.id, version!.id],
          );

          await writeAudit(tx, {
            companyId,
            actorUserId: auth.userId,
            actorEmail: auth.email,
            action: 'document.uploaded',
            entityType: 'document',
            entityId: doc!.id,
            summary: `${body.category}: ${body.fileName}`,
            after: {
              category: body.category,
              supersedesId: body.supersedesId ?? null,
              sha256,
            },
            requestId: req.id,
            ipAddress: clientIp(req),
            userAgent: userAgent(req),
          });

          const row = await tx.one<Row>(`select ${SELECT} ${FROM} where d.id = $1`, [doc!.id]);
          return {
            document: present(row!),
            superseded: supersededRow ? present(supersededRow) : null,
          };
        },
        body.clientId ?? null,
      );

      reply.code(201);
      return result;
    },
  );
}

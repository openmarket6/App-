/**
 * Documents, folders and file access.
 *
 * UPLOAD is two-phase and deliberately never streams bytes through this API:
 *
 *   1. POST /v1/documents/upload-init
 *      Authorise, create the document + a 'pending' version row, and return a
 *      short-lived signed URL.
 *   2. The browser PUTs the file straight to Supabase Storage.
 *   3. POST /v1/documents/:id/versions/:versionId/complete
 *      We ask storage how big the object actually is, record that, and only
 *      then does the version become downloadable.
 *
 * Why: a 150 MB drawing set uploaded through this process would occupy a
 * request worker for minutes and put the whole file in memory. Going direct
 * means upload throughput is Supabase's problem, and an abandoned upload leaves
 * one harmless 'pending' row instead of a half-written file.
 *
 * The size the client claims in step 1 is treated as a hint. The size recorded
 * in step 3 comes from storage, because the client can lie about the first one.
 *
 * DOWNLOAD always mints a fresh signed URL. No permanent URL is ever stored.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, principalOf, tenantOf } from '../auth/plugin.js';
import { withTenant } from '../db/tenant.js';
import { requireCompanyRole } from '../auth/rbac.js';
import { parse, clientIp, userAgent, created } from '../lib/http-helpers.js';
import { writeAudit } from '../lib/audit.js';
import { notFound, badRequest, unprocessable } from '../lib/errors.js';
import { paginationQuery, decodeCursor, buildPage } from '../lib/pagination.js';
import {
  buildStorageKey,
  createSignedUploadUrl,
  createSignedDownloadUrl,
  headObject,
  assertAllowedContentType,
  sanitizeFileName,
} from '../services/storage.js';
import { env } from '../config/env.js';

const documentCategory = z.enum([
  'permit_application', 'approved_plan', 'drawing', 'correction_notice', 'photo',
  'license', 'insurance', 'receipt', 'invoice', 'contract', 'inspection_report',
  'correspondence', 'other',
]);

const uploadInitSchema = z
  .object({
    fileName: z.string().trim().min(1).max(255),
    contentType: z.string().trim().min(1).max(150),
    byteSize: z.number().int().positive().max(env.MAX_UPLOAD_BYTES),
    category: documentCategory.default('other'),
    name: z.string().trim().max(200).optional(),
    description: z.string().trim().max(2000).optional(),
    folderId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
    permitId: z.string().uuid().optional(),
    draftingOrderId: z.string().uuid().optional(),
    draftingRevisionId: z.string().uuid().optional(),
    isClientVisible: z.boolean().default(true),
    /** Supply to add a new version of an existing document instead of a new one. */
    documentId: z.string().uuid().optional(),
    /** EXIF/capture data for site photos. */
    metadata: z.record(z.unknown()).optional(),
  })
  .refine(
    (v) => v.projectId || v.permitId || v.draftingOrderId || v.folderId || v.documentId,
    { message: 'A document must be attached to a project, permit, drafting order or folder' },
  );

const listQuery = paginationQuery.extend({
  category: documentCategory.optional(),
  projectId: z.string().uuid().optional(),
  permitId: z.string().uuid().optional(),
  folderId: z.string().uuid().optional(),
  includeDeleted: z.coerce.boolean().default(false),
});

export async function documentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/documents', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'viewer');

    const q = parse(listQuery, req.query, 'query');
    const cursor = decodeCursor(q.cursor);
    const staff = p.platformRole !== 'none';

    return withTenant(ctx, async (tx) => {
      const rows = await tx.many<{ id: string; created_at: string }>(
        `select d.id, d.company_id, d.folder_id, d.project_id, d.permit_id,
                d.drafting_order_id, d.drafting_revision_id, d.name, d.category::text,
                d.description, d.version_count, d.is_client_visible, d.uploaded_by,
                d.created_at, d.updated_at, d.deleted_at,
                v.file_name, v.content_type, v.byte_size::text as byte_size,
                v.scan_status::text, v.version_number, v.uploaded_at
           from ocs.documents d
           left join ocs.document_versions v on v.id = d.current_version_id
          where d.company_id = $1
            and ($2::boolean or d.deleted_at is null)
            and ($3::ocs.document_category is null or d.category = $3::ocs.document_category)
            and ($4::uuid is null or d.project_id = $4::uuid)
            and ($5::uuid is null or d.permit_id = $5::uuid)
            and ($6::uuid is null or d.folder_id = $6::uuid)
            -- Internal working files stay hidden from the contractor's portal.
            and ($7::boolean or d.is_client_visible)
            and ($8::timestamptz is null
                 or (d.created_at, d.id) < ($8::timestamptz, $9::uuid))
          order by d.created_at desc, d.id desc
          limit $10`,
        [
          ctx.companyId,
          q.includeDeleted,
          q.category ?? null,
          q.projectId ?? null,
          q.permitId ?? null,
          q.folderId ?? null,
          staff,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          q.limit + 1,
        ],
      );
      return buildPage(rows, q.limit);
    });
  });

  app.post('/v1/documents/upload-init', { preHandler: authenticate }, async (req, reply) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'member');

    const body = parse(uploadInitSchema, req.body, 'upload');
    assertAllowedContentType(body.contentType);

    const result = await withTenant(ctx, async (tx) => {
      let documentId = body.documentId;
      let versionNumber = 1;

      if (documentId) {
        const existing = await tx.one<{ id: string; version_count: number }>(
          `select id, version_count from ocs.documents
            where id = $1 and company_id = $2 and deleted_at is null
            for update`,
          [documentId, ctx.companyId],
        );
        if (!existing) throw notFound('Document');
        versionNumber = existing.version_count + 1;
      } else {
        // Verify the parent belongs to this tenant. RLS would block a foreign
        // id anyway; this turns it into a clear 404.
        if (body.permitId) {
          const permit = await tx.one(
            `select id from ocs.permits where id = $1 and company_id = $2 and deleted_at is null`,
            [body.permitId, ctx.companyId],
          );
          if (!permit) throw notFound('Permit');
        }
        if (body.projectId) {
          const project = await tx.one(
            `select id from ocs.projects where id = $1 and company_id = $2 and deleted_at is null`,
            [body.projectId, ctx.companyId],
          );
          if (!project) throw notFound('Project');
        }

        const doc = await tx.one<{ id: string }>(
          `insert into ocs.documents
             (company_id, folder_id, project_id, permit_id, drafting_order_id,
              drafting_revision_id, name, category, description, is_client_visible, uploaded_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8::ocs.document_category,$9,$10,$11)
           returning id`,
          [
            ctx.companyId,
            body.folderId ?? null,
            body.projectId ?? null,
            body.permitId ?? null,
            body.draftingOrderId ?? null,
            body.draftingRevisionId ?? null,
            body.name ?? sanitizeFileName(body.fileName),
            body.category,
            body.description ?? null,
            body.isClientVisible,
            p.userId,
          ],
        );
        if (!doc) throw badRequest('Could not create document');
        documentId = doc.id;
      }

      const storageKey = buildStorageKey({
        companyId: ctx.companyId,
        documentId: documentId!,
        versionNumber,
        fileName: body.fileName,
      });

      const version = await tx.one<{ id: string }>(
        `insert into ocs.document_versions
           (company_id, document_id, version_number, storage_bucket, storage_key,
            file_name, content_type, byte_size, metadata, uploaded_by, upload_state)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')
         returning id`,
        [
          ctx.companyId,
          documentId,
          versionNumber,
          env.SUPABASE_STORAGE_BUCKET,
          storageKey,
          sanitizeFileName(body.fileName),
          body.contentType,
          body.byteSize,
          JSON.stringify(body.metadata ?? {}),
          p.userId,
        ],
      );
      if (!version) throw badRequest('Could not create document version');

      return { documentId: documentId!, versionId: version.id, storageKey, versionNumber };
    });

    // Signing happens after the transaction commits: an external call inside a
    // transaction holds a database connection for the duration of a network
    // round trip, which is how connection pools get exhausted under load.
    const signed = await createSignedUploadUrl(result.storageKey);

    return created(reply, {
      documentId: result.documentId,
      versionId: result.versionId,
      versionNumber: result.versionNumber,
      upload: {
        url: signed.uploadUrl,
        method: 'PUT',
        headers: { 'content-type': body.contentType },
        expiresInSeconds: signed.expiresInSeconds,
      },
      /** Call this once the PUT succeeds. */
      completeUrl: `/v1/documents/${result.documentId}/versions/${result.versionId}/complete`,
    });
  });

  app.post(
    '/v1/documents/:documentId/versions/:versionId/complete',
    { preHandler: authenticate },
    async (req) => {
      const p = principalOf(req);
      const ctx = tenantOf(req);
      requireCompanyRole(p, 'member');

      const params = parse(
        z.object({ documentId: z.string().uuid(), versionId: z.string().uuid() }),
        req.params,
        'parameters',
      );

      const version = await withTenant(ctx, async (tx) =>
        tx.one<{ id: string; storage_key: string; upload_state: string; version_number: number }>(
          `select id, storage_key, upload_state, version_number
             from ocs.document_versions
            where id = $1 and document_id = $2 and company_id = $3`,
          [params.versionId, params.documentId, ctx.companyId],
        ),
      );

      if (!version) throw notFound('Document version');
      if (version.upload_state === 'uploaded') {
        return { documentId: params.documentId, versionId: version.id, alreadyComplete: true };
      }

      // The authoritative size and type, read from storage rather than trusted
      // from the client.
      const info = await headObject(version.storage_key);
      if (!info) {
        throw unprocessable(
          'No uploaded file was found for this version. Upload the file before completing.',
        );
      }
      if (info.size > env.MAX_UPLOAD_BYTES) {
        throw unprocessable(
          `Uploaded file is ${info.size} bytes, which exceeds the ${env.MAX_UPLOAD_BYTES} byte limit`,
        );
      }

      return withTenant(ctx, async (tx) => {
        await tx.query(
          `update ocs.document_versions
              set upload_state = 'uploaded',
                  uploaded_at = now(),
                  byte_size = $2,
                  content_type = $3,
                  -- 'skipped' is honest: no malware scanner is wired up yet.
                  -- See README "Before production" -- this must become 'pending'
                  -- with a real scanner before customer uploads are trusted.
                  scan_status = 'skipped'
            where id = $1`,
          [version.id, info.size, info.contentType],
        );

        const doc = await tx.one(
          `update ocs.documents
              set current_version_id = $2,
                  version_count = greatest(version_count, $3)
            where id = $1 and company_id = $4
            returning id, name, category::text, version_count`,
          [params.documentId, version.id, version.version_number, ctx.companyId],
        );

        await writeAudit(tx, {
          companyId: ctx.companyId,
          actorUserId: p.userId,
          actorEmail: p.email,
          action: 'document.uploaded',
          entityType: 'document',
          entityId: params.documentId,
          summary: `Uploaded version ${version.version_number}`,
          after: { versionNumber: version.version_number, byteSize: info.size },
          requestId: req.id,
          ipAddress: clientIp(req),
          userAgent: userAgent(req),
        });

        return { ...doc, versionId: version.id, byteSize: info.size, uploaded: true };
      });
    },
  );

  /**
   * Mint a download URL.
   *
   * Every call re-checks tenancy and role, so revoking someone's access takes
   * effect on their next click rather than whenever a stored link happens to
   * expire.
   */
  app.get('/v1/documents/:documentId/download', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'viewer');

    const params = parse(z.object({ documentId: z.string().uuid() }), req.params, 'parameters');
    const q = parse(
      z.object({ versionId: z.string().uuid().optional() }),
      req.query,
      'query',
    );

    const version = await withTenant(ctx, async (tx) => {
      const row = await tx.one<{
        id: string;
        storage_key: string;
        file_name: string;
        scan_status: string;
        upload_state: string;
        is_client_visible: boolean;
      }>(
        `select v.id, v.storage_key, v.file_name, v.scan_status::text, v.upload_state,
                d.is_client_visible
           from ocs.document_versions v
           join ocs.documents d on d.id = v.document_id
          where v.document_id = $1
            and v.company_id = $2
            and d.deleted_at is null
            and ($3::uuid is null or v.id = $3::uuid)
          order by v.version_number desc
          limit 1`,
        [params.documentId, ctx.companyId, q.versionId ?? null],
      );
      if (!row) throw notFound('Document');

      if (!row.is_client_visible && p.platformRole === 'none') throw notFound('Document');
      if (row.upload_state !== 'uploaded') {
        throw unprocessable('This file has not finished uploading');
      }
      // Never hand out a file a scanner has flagged.
      if (row.scan_status === 'infected') {
        throw unprocessable('This file was flagged by malware scanning and cannot be downloaded');
      }

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'document.downloaded',
        entityType: 'document',
        entityId: params.documentId,
        summary: `Downloaded ${row.file_name}`,
        requestId: req.id,
        ipAddress: clientIp(req),
        userAgent: userAgent(req),
      });

      return row;
    });

    const signed = await createSignedDownloadUrl(version.storage_key, {
      downloadAs: version.file_name,
    });

    return {
      url: signed.url,
      fileName: version.file_name,
      expiresInSeconds: signed.expiresInSeconds,
    };
  });

  /** Soft delete, recoverable for DOCUMENT_RETENTION_DAYS. */
  app.delete('/v1/documents/:documentId', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'member');

    const params = parse(z.object({ documentId: z.string().uuid() }), req.params, 'parameters');

    return withTenant(ctx, async (tx) => {
      const row = await tx.one<{ id: string; name: string }>(
        `update ocs.documents
            set deleted_at = now(),
                deleted_by = $3,
                purge_after = now() + make_interval(days => $4)
          where id = $1 and company_id = $2 and deleted_at is null
          returning id, name`,
        [params.documentId, ctx.companyId, p.userId, env.DOCUMENT_RETENTION_DAYS],
      );
      if (!row) throw notFound('Document');

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'document.deleted',
        entityType: 'document',
        entityId: row.id,
        summary: `Deleted "${row.name}" (recoverable for ${env.DOCUMENT_RETENTION_DAYS} days)`,
        requestId: req.id,
        ipAddress: clientIp(req),
        userAgent: userAgent(req),
      });

      return { id: row.id, deleted: true, recoverableUntilDays: env.DOCUMENT_RETENTION_DAYS };
    });
  });

  app.post('/v1/documents/:documentId/restore', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'admin');

    const params = parse(z.object({ documentId: z.string().uuid() }), req.params, 'parameters');

    return withTenant(ctx, async (tx) => {
      const row = await tx.one<{ id: string; name: string }>(
        `update ocs.documents
            set deleted_at = null, deleted_by = null, purge_after = null
          where id = $1 and company_id = $2
            and deleted_at is not null
            -- Once purge_after has passed the storage object may already be
            -- gone, so a "restored" row could point at nothing.
            and purge_after > now()
          returning id, name`,
        [params.documentId, ctx.companyId],
      );
      if (!row) throw notFound('Recoverable document');

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'document.restored',
        entityType: 'document',
        entityId: row.id,
        requestId: req.id,
        ipAddress: clientIp(req),
        userAgent: userAgent(req),
      });

      return { id: row.id, restored: true };
    });
  });

  // ---------------------------------------------------------------------------
  // Folders
  // ---------------------------------------------------------------------------

  app.get('/v1/folders', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'viewer');

    const q = parse(
      z.object({
        permitId: z.string().uuid().optional(),
        projectId: z.string().uuid().optional(),
        parentId: z.string().uuid().optional(),
      }),
      req.query,
      'query',
    );

    return withTenant(ctx, async (tx) => ({
      data: await tx.many(
        `select f.id, f.parent_id, f.project_id, f.permit_id, f.name, f.depth,
                f.is_system, f.created_at,
                (select count(*) from ocs.documents d
                  where d.folder_id = f.id and d.deleted_at is null)::int as document_count
           from ocs.folders f
          where f.company_id = $1
            and f.deleted_at is null
            and ($2::uuid is null or f.permit_id = $2::uuid)
            and ($3::uuid is null or f.project_id = $3::uuid)
            and ($4::uuid is null or f.parent_id = $4::uuid)
          order by f.depth, f.name`,
        [ctx.companyId, q.permitId ?? null, q.projectId ?? null, q.parentId ?? null],
      ),
    }));
  });

  app.post('/v1/folders', { preHandler: authenticate }, async (req, reply) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'member');

    const body = parse(
      z
        .object({
          name: z.string().trim().min(1).max(120),
          parentId: z.string().uuid().optional(),
          projectId: z.string().uuid().optional(),
          permitId: z.string().uuid().optional(),
        })
        .refine((v) => v.parentId || v.projectId || v.permitId, {
          message: 'A folder needs a parent, project or permit',
        }),
      req.body,
      'folder',
    );

    const folder = await withTenant(ctx, async (tx) => {
      // The cycle/company checks live in the folders_check_hierarchy trigger,
      // so they hold no matter which code path inserts.
      const row = await tx.one(
        `insert into ocs.folders (company_id, parent_id, project_id, permit_id, name, created_by)
         values ($1,$2,$3,$4,$5,$6)
         returning id, parent_id, project_id, permit_id, name, depth, created_at`,
        [
          ctx.companyId,
          body.parentId ?? null,
          body.projectId ?? null,
          body.permitId ?? null,
          body.name,
          p.userId,
        ],
      );

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'folder.created',
        entityType: 'folder',
        entityId: (row as { id?: string } | null)?.id ?? null,
        summary: `Folder "${body.name}" created`,
        requestId: req.id,
      });

      return row;
    });

    return created(reply, folder);
  });
}

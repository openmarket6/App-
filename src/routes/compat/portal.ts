/**
 * /api/portal — everything a contractor sees of their own company.
 *
 * The folder tree, the action queue and the "what happens next" sentence are
 * NOT computed here. They come from src/shared, the same pure functions the
 * React app imports, because the alternative is two implementations that drift
 * until a contractor and the coordinator looking at their account see different
 * things. That is the failure this module is arranged to avoid.
 *
 * What this file does is the part only a server can: read the rows, translate
 * between the two category vocabularies, and enforce that a contractor sees
 * their own company and nothing else.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant, withServiceContext, type Tx } from '../../db/tenant.js';
import { requireApiAuth, requireCapability } from './auth.js';
import { parse, clientIp, userAgent } from '../../lib/http-helpers.js';
import { writeAudit } from '../../lib/audit.js';
import { notFound, badRequest, forbidden, conflict } from '../../lib/errors.js';
import { newInviteToken, publicUser, type UserRow } from '../../auth/native.js';
import {
  buildFolderTree, findFolder, folderTrail, buildActionQueue,
  permitRequestNextStep, type PortalFolder,
} from '../../shared/portal.js';
import type { DocumentCategory, PermitDocument } from '../../shared/types.js';
import {
  buildStorageKey, uploadObject, assertAllowedContentType,
} from '../../services/storage.js';
import { createHash } from 'node:crypto';

/**
 * Translating between two category vocabularies.
 *
 * The database enum grew from how the office files things; the frontend's grew
 * from what a contractor is looking for. Neither is wrong, and neither can be
 * renamed without rewriting the other side, so the mapping is explicit and the
 * awkward cases are named rather than smoothed over.
 */
const CATEGORY_TO_PORTAL: Record<string, DocumentCategory> = {
  permit_application: 'SUBMITTAL',
  drawing: 'PLAN_SET',
  // An approved plan and an inspection report are both things the AGENCY hands
  // back, which is what a contractor is actually looking for when they open
  // that folder -- not the fact that one happens to be a drawing.
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

/**
 * The reverse, for uploads. Lossy on purpose: several stored categories map to
 * OTHER, so this picks the one an upload into that folder should become. A
 * folder decides what its uploads are -- see the note in PortalFiles.tsx about
 * the upload body deliberately carrying no category at all.
 */
const PORTAL_TO_CATEGORY: Record<string, string> = {
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

const toPortalCategory = (stored: string): DocumentCategory =>
  CATEGORY_TO_PORTAL[stored] ?? 'OTHER';

/** A contractor's own company, always. Staff may name one. */
/** 20 MB, matching the documents API. Larger files need a signed upload URL. */
const MAX_PORTAL_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Portal categories to the stored enum, as compat/documents does it. */
const TO_STORED_CATEGORY: Record<string, string> = {
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

async function portalScope<T>(
  req: FastifyRequest,
  fn: (tx: Tx, companyId: string) => Promise<T>,
  requestedClientId?: string | null,
): Promise<T> {
  const auth = req.apiAuth!;

  if (auth.role === 'CLIENT') {
    if (!auth.clientId) throw forbidden('This account is not linked to a contractor company');
    return withTenant(
      { companyId: auth.clientId, userId: auth.userId, platformRole: 'none', requestId: req.id },
      (tx) => fn(tx, auth.clientId!),
    );
  }
  if (auth.role === 'PENDING') {
    throw forbidden('This account is awaiting authorization from an administrator');
  }
  if (!requestedClientId) {
    throw badRequest('Staff must say which contractor: pass clientId');
  }
  return withServiceContext((tx) => fn(tx, requestedClientId), {
    reason: `portal_${auth.role}`,
    companyId: requestedClientId,
  });
}

/** Everything buildFolderTree needs, read in one place. */
async function treeInputFor(tx: Tx, companyId: string) {
  const documents = await tx.many<{
    id: string; permit_id: string | null; category: string; content_type: string;
    captured_at: string | null; file_name: string; version: number;
    supersedes_id: string | null; status: string; size_bytes: number;
    uploaded_at: string; uploaded_by_name: string | null; superseded_by_id: string | null;
  }>(
    `select d.id,
            d.permit_id,
            d.category::text as category,
            coalesce(v.content_type, 'application/octet-stream') as content_type,
            null::text as captured_at,
            d.name as file_name,
            d.version_count as version,
            null::uuid as supersedes_id,
            case when d.deleted_at is not null then 'SUPERSEDED' else 'UPLOADED' end as status,
            coalesce(v.byte_size, 0)::int as size_bytes,
            d.created_at as uploaded_at,
            u.name as uploaded_by_name,
            null::uuid as superseded_by_id
       from ocs.documents d
       left join ocs.document_versions v on v.id = d.current_version_id
       left join ocs.app_users u on u.id = d.uploaded_by
      where d.company_id = $1 and d.deleted_at is null
      order by d.created_at desc`,
    [companyId],
  );

  const projects = await tx.many<{ id: string; name: string; address_line1: string; city: string }>(
    `select id, name, coalesce(address_line1,'') as address_line1, coalesce(city,'') as city
       from ocs.projects where company_id = $1 and deleted_at is null order by name`,
    [companyId],
  );

  const permits = await tx.many<{
    id: string; project_id: string; permit_type: string;
    agency_record_id: string | null; stage: string;
  }>(
    `select id, project_id, permit_type,
            coalesce(permit_number, external_reference) as agency_record_id,
            status::text as stage
       from ocs.permits where company_id = $1 and deleted_at is null`,
    [companyId],
  );

  const docs: PermitDocument[] = documents.map((d) => ({
    id: d.id,
    permitId: d.permit_id,
    clientId: companyId,
    category: toPortalCategory(d.category),
    contentType: d.content_type,
    capturedAt: d.captured_at,
    geo: null,
    sha256: null,
    requirementKey: '',
    fileName: d.file_name,
    version: d.version ?? 1,
    supersedesId: d.supersedes_id,
    submittedOnCycle: null,
    status: d.status as PermitDocument['status'],
    sizeBytes: d.size_bytes ?? 0,
    uploadedAt: d.uploaded_at,
  } as PermitDocument));

  return {
    documents: docs,
    projects: projects.map((p) => ({
      id: p.id, name: p.name, addressLine1: p.address_line1, city: p.city,
    })),
    permits: permits.map((p) => ({
      id: p.id, projectId: p.project_id, permitType: p.permit_type,
      agencyRecordId: p.agency_record_id, stage: p.stage,
    })),
    rawDocuments: documents,
  };
}

/**
 * Resolves which company this caller may act on, then hands back service
 * context.
 *
 * The team endpoints cannot use tenant context, and the reason is worth stating
 * rather than working around. `ocs.app_users` is not scoped by company at all:
 * its policies allow a row to be read by its owner or a colleague sharing a
 * company_membership, and inserts only in service context. A contractor
 * inviting a colleague is therefore a cross-boundary act by construction.
 *
 * Running these in tenant context does not fail safely -- the list silently
 * under-reports colleagues who have no membership row, which reads as "my
 * team-mate disappeared". So the boundary is enforced HERE, in code, by
 * resolving the company first and filtering every query by it.
 */
async function teamScope<T>(
  req: FastifyRequest,
  fn: (tx: Tx, companyId: string) => Promise<T>,
  requestedClientId?: string | null,
): Promise<T> {
  const auth = req.apiAuth!;

  let companyId: string;
  if (auth.role === 'CLIENT') {
    if (!auth.clientId) throw forbidden('This account is not linked to a contractor company');
    companyId = auth.clientId;
  } else if (auth.role === 'PENDING') {
    throw forbidden('This account is awaiting authorization from an administrator');
  } else {
    if (!requestedClientId) throw badRequest('Staff must say which contractor: pass clientId');
    companyId = requestedClientId;
  }

  return withServiceContext((tx) => fn(tx, companyId), {
    reason: `portal_team_${auth.role}`,
    companyId,
  });
}

export async function compatPortalRoutes(app: FastifyInstance): Promise<void> {
  /** The whole folder tree, derived from the contractor's own rows. */
  app.get(
    '/api/portal/folders',
    { preHandler: [requireApiAuth, requireCapability('portal:read_own')] },
    async (req) => {
      const q = parse(z.object({ clientId: z.string().uuid().optional() }), req.query, 'query');

      return portalScope(
        req,
        async (tx, companyId) => {
          const input = await treeInputFor(tx, companyId);
          const tree = buildFolderTree({
            documents: input.documents,
            projects: input.projects,
            permits: input.permits,
          });
          return { clientId: companyId, tree, generatedAt: new Date().toISOString() };
        },
        q.clientId ?? null,
      );
    },
  );

  /**
   * One folder's contents.
   *
   * Revisions fold: a document with a newer version is marked superseded so the
   * UI can tuck it under the current one. Five rows called "roof-plan.pdf" is
   * how the wrong revision reaches a plans examiner.
   */
  /**
   * Upload into a portal folder.
   *
   * The folder decides what the document is: its path carries the permit, and
   * the tree says which categories belong there. Nothing about the filing is
   * taken from the request body, which is why the client sends no category,
   * permitId or clientId -- a contractor should not be able to file a photo as
   * a licence by editing a payload.
   *
   * Fastify wildcards only match at the end of a path, so the upload arrives
   * as part of the wildcard and the trailing segment is stripped here.
   */
  app.post(
    '/api/portal/folders/*',
    { preHandler: [requireApiAuth, requireCapability('portal:upload_own')] },
    async (req, reply) => {
      const auth = req.apiAuth!;
      const raw = (req.params as Record<string, string>)['*'] ?? '';
      if (!raw.endsWith('/upload')) throw notFound('That is not an upload target');
      const folderPath = raw
        .slice(0, -'/upload'.length)
        .split('/')
        .map((seg) => decodeURIComponent(seg))
        .join('/')
        .replace(/^\/+|\/+$/g, '');

      const body = parse(
        z.object({
          fileName: z.string().trim().min(1).max(300),
          contentType: z.string().trim().min(1).max(120),
          sizeBytes: z.number().int().min(1).max(MAX_PORTAL_UPLOAD_BYTES),
          dataBase64: z.string().min(1),
          capturedAt: z.string().datetime().nullable().optional(),
        }),
        req.body,
        'upload',
      );

      assertAllowedContentType(body.contentType);
      const bytes = Buffer.from(body.dataBase64, 'base64');
      if (bytes.byteLength > MAX_PORTAL_UPLOAD_BYTES) {
        throw badRequest('That file is larger than 20 MB.');
      }
      if (bytes.byteLength !== body.sizeBytes) {
        throw badRequest('The upload did not arrive intact — try again.');
      }

      const result = await portalScope(req, async (tx, companyId) => {
        const input = await treeInputFor(tx, companyId);
        const tree = buildFolderTree({
          documents: input.documents,
          projects: input.projects,
          permits: input.permits,
        });
        const folder = findFolder(tree, folderPath);
        if (!folder) throw notFound('Folder');
        if (!folder.acceptsUpload) {
          throw badRequest(`${folder.name} is not a folder you can upload into.`);
        }

        const category = folder.uploadCategories[0];
        if (!category) throw badRequest(`${folder.name} does not accept uploads.`);

        /*
         * The permit is read out of the folder path rather than trusted from
         * the caller. A path that names a permit the contractor cannot see
         * never reaches here, because the tree was built from their own rows.
         */
        const permitMatch = /permits\/([0-9a-f-]{36})/i.exec(folder.path);
        const projectMatch = /projects\/([0-9a-f-]{36})/i.exec(folder.path);

        const doc = await tx.one<{ id: string }>(
          `insert into ocs.documents
             (company_id, permit_id, project_id, name, category, uploaded_by,
              version_count, captured_at)
           values ($1,$2,$3,$4,$5::ocs.document_category,$6,1,$7::timestamptz)
           returning id`,
          [
            companyId,
            permitMatch?.[1] ?? null,
            projectMatch?.[1] ?? null,
            body.fileName,
            TO_STORED_CATEGORY[category] ?? 'other',
            auth.userId,
            body.capturedAt ?? null,
          ],
        );

        const key = buildStorageKey({
          companyId, documentId: doc!.id, versionNumber: 1, fileName: body.fileName,
        });
        // Bytes first: a failed upload must leave a document with no version,
        // never a version pointing at objects that are not there.
        const stored = await uploadObject(key, bytes, body.contentType);
        const sha256 = createHash('sha256').update(bytes).digest('hex');

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
          action: 'portal.document_uploaded',
          entityType: 'document',
          entityId: doc!.id,
          summary: `${body.fileName} uploaded to ${folder.name}`,
          requestId: req.id,
          ipAddress: clientIp(req),
          userAgent: userAgent(req),
        });

        const document: PermitDocument = {
          id: doc!.id,
          permitId: permitMatch?.[1] ?? null,
          clientId: companyId,
          category,
          contentType: body.contentType,
          capturedAt: body.capturedAt ?? null,
          geo: null,
          sha256,
          requirementKey: '',
          fileName: body.fileName,
          version: 1,
          supersedesId: null,
          submittedOnCycle: null,
          status: 'UPLOADED',
          sizeBytes: bytes.byteLength,
          uploadedAt: new Date().toISOString(),
          storageKey: stored.key,
          uploadedBy: auth.userId,
        } as PermitDocument;

        return {
          folder: { path: folder.path, name: folder.name },
          document,
          superseded: null,
        };
      });

      reply.code(201);
      return result;
    },
  );

  app.get(
    '/api/portal/folders/*',
    { preHandler: [requireApiAuth, requireCapability('portal:read_own')] },
    async (req) => {
      const q = parse(z.object({ clientId: z.string().uuid().optional() }), req.query, 'query');
      const raw = (req.params as Record<string, string>)['*'] ?? '';
      const path = raw.split('/').map((s) => decodeURIComponent(s)).join('/').replace(/^\/+|\/+$/g, '');

      return portalScope(
        req,
        async (tx, companyId) => {
          const input = await treeInputFor(tx, companyId);
          const tree = buildFolderTree({
            documents: input.documents,
            projects: input.projects,
            permits: input.permits,
          });

          const folder: PortalFolder | null = path ? findFolder(tree, path) : tree;
          if (!folder) throw notFound('Folder');

          const ids = new Set(folder.documentIds);
          const byId = new Map(input.rawDocuments.map((d) => [d.id, d]));

          const documents = [...ids].map((id) => {
            const d = byId.get(id)!;
            return {
              id: d.id,
              fileName: d.file_name,
              category: toPortalCategory(d.category),
              version: d.version ?? 1,
              status: d.status,
              sizeBytes: d.size_bytes ?? 0,
              contentType: d.content_type,
              uploadedAt: d.uploaded_at,
              uploadedByName: d.uploaded_by_name,
              supersedesId: d.supersedes_id,
              capturedAt: d.captured_at,
              superseded: Boolean(d.superseded_by_id),
              supersededById: d.superseded_by_id,
            };
          });

          const trail = folderTrail(tree, path).map((f) => ({
            path: f.path, name: f.name, kind: f.kind,
          }));

          return {
            clientId: companyId,
            folder,
            trail,
            documents,
            currentCount: documents.filter((d) => !d.superseded).length,
            supersededCount: documents.filter((d) => d.superseded).length,
          };
        },
        q.clientId ?? null,
      );
    },
  );

  /**
   * The one list a contractor should read every morning.
   *
   * Ordered by what actually stops work -- expired insurance outranks an
   * unsigned form, which outranks an unpaid invoice, because only the first
   * prevents us filing anything at all. That ordering lives in buildActionQueue,
   * shared with the app, so this endpoint cannot quietly disagree with it.
   */
  app.get(
    '/api/portal/actions',
    { preHandler: [requireApiAuth, requireCapability('portal:read_own')] },
    async (req) => {
      const q = parse(z.object({ clientId: z.string().uuid().optional() }), req.query, 'query');

      return portalScope(
        req,
        async (tx, companyId) => {
          const corrections = await tx.many<{
            id: string; permit_id: string; permit_label: string; cycle: number;
          }>(
            `select c.id, c.permit_id,
                    coalesce(p.permit_number, p.permit_type) as permit_label,
                    c.cycle
               from ocs.permit_corrections c
               join ocs.permits p on p.id = c.permit_id
              where c.company_id = $1 and c.resolved_at is null
              order by c.created_at`,
            [companyId],
          );

          const invoices = await tx.many<{
            id: string; number: string; balance: number; overdue: boolean;
          }>(
            `select id, coalesce(invoice_number::text, left(id::text, 8)) as number,
                    (total_cents - amount_paid_cents)::int as balance,
                    (due_on is not null and due_on < current_date) as overdue
               from ocs.invoices
              where company_id = $1 and deleted_at is null
                and status <> 'paid' and total_cents > amount_paid_cents`,
            [companyId],
          );

          const drafting = await tx.many<{ id: string; quoted_cents: number | null }>(
            `select id, quoted_cents from ocs.drafting_orders
              where company_id = $1 and deleted_at is null and quote_status = 'sent'`,
            [companyId],
          );

          const actions = buildActionQueue({
            // Compliance is not modelled on this backend yet, so this reports
            // no gaps rather than inventing them. An invented gap tells a
            // contractor they cannot file when they can.
            complianceGaps: [],
            pendingSignatures: [],
            correctionsAwaitingResponse: corrections.map((c) => ({
              id: c.id, permitId: c.permit_id,
              permitLabel: c.permit_label, cycle: c.cycle,
            })),
            unpaidInvoices: invoices.map((i) => ({
              id: i.id, number: i.number, balanceCents: i.balance, overdue: i.overdue,
            })),
            draftingAwaitingApproval: drafting.map((d) => ({
              id: d.id, quotedCents: d.quoted_cents,
            })),
            missingPaymentMethod: false,
          });

          return {
            clientId: companyId,
            actions,
            total: actions.length,
            blockingCount: actions.filter((a) => a.urgency === 'blocking').length,
            generatedAt: new Date().toISOString(),
          };
        },
        q.clientId ?? null,
      );
    },
  );

  // -- Permit requests -------------------------------------------------------

  const REQUEST_SELECT = `
    r.id, r.company_id as "clientId", r.project_id as "projectId",
    r.permit_id as "permitId", upper(r.status::text) as status,
    r.scope_of_work as "scopeOfWork", r.address_line1 as "addressLine1",
    r.city, r.zip, r.county,
    r.suggested_permit_type as "suggestedPermitType",
    r.estimated_value_cents as "estimatedValueCents",
    r.desired_start_date as "desiredStartDate",
    r.attachment_ids as "attachmentIds",
    r.triage_note as "triageNote", r.triaged_by as "triagedByUserId",
    r.triaged_at as "triagedAt", r.submitted_by as "submittedByUserId",
    r.created_at as "createdAt", r.updated_at as "updatedAt"
  `;

  app.get(
    '/api/portal/permit-requests',
    { preHandler: [requireApiAuth, requireCapability('portal:read_own')] },
    async (req) => {
      const auth = req.apiAuth!;
      const q = parse(z.object({ clientId: z.string().uuid().optional() }), req.query, 'query');

      // Staff without a named contractor see the whole triage queue, which is
      // the screen they actually want.
      if (auth.role !== 'CLIENT' && !q.clientId) {
        return withServiceContext(
          async (tx) => {
            const requests = await tx.many(
              `select ${REQUEST_SELECT} from ocs.permit_requests r order by r.created_at desc limit 500`,
            );
            const withNext = requests.map((r) => {
              const row = r as { status: string };
              return { ...row, nextStep: permitRequestNextStep(r as never) };
            });
            return {
              clientId: null,
              requests: withNext,
              total: withNext.length,
              openCount: withNext.filter(
                (r) => !['ACCEPTED', 'DECLINED', 'WITHDRAWN'].includes(r.status),
              ).length,
            };
          },
          { reason: 'portal_request_queue' },
        );
      }

      return portalScope(
        req,
        async (tx, companyId) => {
          const requests = await tx.many(
            `select ${REQUEST_SELECT} from ocs.permit_requests r
              where r.company_id = $1 order by r.created_at desc limit 500`,
            [companyId],
          );
          const withNext = requests.map((r) => {
            const row = r as { status: string };
            return { ...row, nextStep: permitRequestNextStep(r as never) };
          });
          return {
            clientId: companyId,
            requests: withNext,
            total: withNext.length,
            openCount: withNext.filter(
              (r) => !['ACCEPTED', 'DECLINED', 'WITHDRAWN'].includes(r.status),
            ).length,
          };
        },
        q.clientId ?? null,
      );
    },
  );

  app.post(
    '/api/portal/permit-requests',
    { preHandler: [requireApiAuth, requireCapability('portal:read_own')] },
    async (req, reply) => {
      const auth = req.apiAuth!;
      const body = parse(
        z.object({
          clientId: z.string().uuid().optional(),
          scopeOfWork: z.string().trim().min(1).max(8000),
          addressLine1: z.string().trim().min(1).max(300),
          city: z.string().trim().min(1).max(120),
          zip: z.string().trim().min(3).max(12),
          county: z.string().trim().max(120).nullable().optional(),
          suggestedPermitType: z.string().trim().max(120).nullable().optional(),
          estimatedValueCents: z.number().int().min(0).nullable().optional(),
          desiredStartDate: z.string().date().nullable().optional(),
          attachmentIds: z.array(z.string().uuid()).max(50).optional(),
        }),
        req.body,
        'permit request',
      );

      const result = await portalScope(
        req,
        async (tx, companyId) => {
          const created = await tx.one<{ id: string }>(
            `insert into ocs.permit_requests
               (company_id, scope_of_work, address_line1, city, zip, county,
                suggested_permit_type, estimated_value_cents, desired_start_date,
                attachment_ids, submitted_by)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10::uuid[],$11)
             returning id`,
            [
              companyId, body.scopeOfWork, body.addressLine1, body.city, body.zip,
              body.county ?? null, body.suggestedPermitType ?? null,
              body.estimatedValueCents ?? null, body.desiredStartDate ?? null,
              body.attachmentIds ?? [], auth.userId,
            ],
          );

          await writeAudit(tx, {
            companyId,
            actorUserId: auth.userId,
            actorEmail: auth.email,
            action: 'portal.permit_requested',
            entityType: 'permit_request',
            entityId: created!.id,
            summary: `Permit requested at ${body.addressLine1}, ${body.city}`,
            requestId: req.id,
            ipAddress: clientIp(req),
            userAgent: userAgent(req),
          });

          const row = await tx.one(
            `select ${REQUEST_SELECT} from ocs.permit_requests r where r.id = $1`,
            [created!.id],
          );
          return { ...(row as object), nextStep: permitRequestNextStep(row as never) };
        },
        body.clientId ?? null,
      );

      reply.code(201);
      return result;
    },
  );

  /** The contractor pulls their own request. */
  app.post(
    '/api/portal/permit-requests/:id/withdraw',
    { preHandler: [requireApiAuth, requireCapability('portal:read_own')] },
    async (req) => {
      const auth = req.apiAuth!;
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
      const q = parse(z.object({ clientId: z.string().uuid().optional() }), req.query, 'query');

      return portalScope(
        req,
        async (tx, companyId) => {
          const existing = await tx.one<{ id: string; status: string }>(
            `select id, status::text as status from ocs.permit_requests
              where id = $1 and company_id = $2`,
            [id, companyId],
          );
          if (!existing) throw notFound('Permit request');
          if (existing.status === 'accepted') {
            throw conflict(
              'That request has already become a permit. Withdrawing it here would ' +
                'leave the permit behind with nothing explaining it — ask us to cancel the permit.',
            );
          }
          if (existing.status === 'withdrawn') {
            throw conflict('That request has already been withdrawn');
          }

          await tx.query(
            `update ocs.permit_requests
                set status = 'withdrawn', triaged_at = coalesce(triaged_at, now()),
                    triage_note = coalesce(triage_note, 'Withdrawn by the contractor')
              where id = $1`,
            [id],
          );

          await writeAudit(tx, {
            companyId,
            actorUserId: auth.userId,
            actorEmail: auth.email,
            action: 'portal.permit_request_withdrawn',
            entityType: 'permit_request',
            entityId: id,
            summary: 'Permit request withdrawn',
            requestId: req.id,
            ipAddress: clientIp(req),
          });

          const row = await tx.one(
            `select ${REQUEST_SELECT} from ocs.permit_requests r where r.id = $1`,
            [id],
          );
          return { ...(row as object), nextStep: permitRequestNextStep(row as never) };
        },
        q.clientId ?? null,
      );
    },
  );

  // -- The contractor's own team --------------------------------------------

  const TEAM_SELECT = `
    u.id, u.email, u.name, u.app_role as role, u.client_id as "clientId",
    u.is_active as active, u.created_at as "createdAt",
    u.last_login_at as "lastLoginAt",
    (u.password_hash is not null) as "hasPassword",
    u.client_admin as "clientAdmin",
    (u.invite_token is not null) as "invitePending",
    u.invite_expires_at as "inviteExpiresAt"
  `;

  app.get(
    '/api/portal/team',
    { preHandler: [requireApiAuth, requireCapability('portal:read_own')] },
    async (req) => {
      const q = parse(z.object({ clientId: z.string().uuid().optional() }), req.query, 'query');

      return teamScope(
        req,
        async (tx, companyId) => {
          const members = await tx.many(
            `select ${TEAM_SELECT} from ocs.app_users u
              where u.client_id = $1 and u.deleted_at is null
              order by u.client_admin desc, u.name nulls last, u.email`,
            [companyId],
          );
          return {
            clientId: companyId,
            members,
            total: members.length,
            activeCount: members.filter((m) => (m as { active: boolean }).active).length,
            adminCount: members.filter((m) => (m as { clientAdmin: boolean }).clientAdmin).length,
          };
        },
        q.clientId ?? null,
      );
    },
  );

  /**
   * A contractor invites their own colleague.
   *
   * Restricted to the company's own administrator, not merely to anyone with a
   * portal login. Otherwise any employee could add another, and the contractor
   * would have no control over who can see their permits and invoices.
   */
  app.post(
    '/api/portal/team/invite',
    { preHandler: [requireApiAuth, requireCapability('portal:read_own')] },
    async (req, reply) => {
      const auth = req.apiAuth!;
      const body = parse(
        z.object({
          clientId: z.string().uuid().optional(),
          email: z.string().email().max(200),
          name: z.string().trim().max(200).optional(),
          clientAdmin: z.boolean().optional(),
        }),
        req.body,
        'invitation',
      );

      const result = await teamScope(
        req,
        async (tx, companyId) => {
          if (auth.role === 'CLIENT') {
            const me = await tx.one<{ client_admin: boolean }>(
              `select client_admin from ocs.app_users where id = $1`,
              [auth.userId],
            );
            if (!me?.client_admin) {
              throw forbidden(
                'Only your company administrator can add logins. Ask them, or ask us.',
              );
            }
          }

          const token = newInviteToken();
          const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

          /**
           * The WHERE on the conflict branch is the whole security of this
           * endpoint, and it was missing.
           *
           * Without it, upserting on the email address let a contractor
           * administrator name ANY existing portal account -- including one at
           * a different contractor -- and the update would move that account
           * into their company, issue it a fresh invitation token, and hand
           * that token back in the response. Redeeming it sets a password and
           * returns a session, because accept-invite has no way to know who is
           * redeeming. That is a complete takeover of another contractor's
           * login, available to anyone who knows an email address.
           *
           * Restricted to rows ALREADY in this company, a conflict on somebody
           * else's address now updates nothing and returns nothing, which the
           * check below turns into a neutral refusal. Neutral deliberately: it
           * must not become a way to discover which addresses have accounts.
           */
          const row = await tx.one<UserRow & { client_admin: boolean }>(
            `insert into ocs.app_users
               (email, name, app_role, client_id, client_admin,
                invite_token, invite_expires_at, is_active)
             values ($1, $2, 'CLIENT', $3, $4, $5, $6, true)
             on conflict (lower(email)) do update
               set name = coalesce(excluded.name, ocs.app_users.name),
                   client_admin = excluded.client_admin,
                   invite_token = excluded.invite_token,
                   invite_expires_at = excluded.invite_expires_at,
                   is_active = true
               where ocs.app_users.client_id = excluded.client_id
                 and ocs.app_users.password_hash is null
             returning id, email, name, app_role, client_id, is_active, password_hash,
                       token_version, created_at, last_login_at, client_admin`,
            [
              body.email.trim(), body.name ?? null, companyId,
              body.clientAdmin ?? false, token, expires,
            ],
          );

          if (!row) {
            throw conflict(
              'That email address cannot be invited. It may already be in use, or ' +
                'already have a password set — ask them to sign in, or reset it instead.',
            );
          }

          await writeAudit(tx, {
            companyId,
            actorUserId: auth.userId,
            actorEmail: auth.email,
            action: 'portal.team_invited',
            entityType: 'app_user',
            entityId: row.id,
            summary: `${body.email} invited to the contractor portal`,
            requestId: req.id,
            ipAddress: clientIp(req),
          });

          const member = await tx.one(
            `select ${TEAM_SELECT} from ocs.app_users u where u.id = $1`, [row.id],
          );

          return {
            user: member,
            invitePending: true,
            inviteExpiresAt: expires.toISOString(),
            // Returned once, on creation. There is no outbound mail yet, and an
            // invitation nobody can send is worse than one shown to its sender.
            inviteUrl: `/accept-invite?token=${token}`,
          };
        },
        body.clientId ?? null,
      );

      reply.code(201);
      return result;
    },
  );

  /** Deactivate or rename someone on the contractor's own team. */
  app.patch(
    '/api/portal/team/:userId',
    { preHandler: [requireApiAuth, requireCapability('portal:read_own')] },
    async (req) => {
      const auth = req.apiAuth!;
      const { userId } = parse(z.object({ userId: z.string().uuid() }), req.params, 'parameters');
      const body = parse(
        z.object({
          clientId: z.string().uuid().optional(),
          active: z.boolean().optional(),
          name: z.string().trim().min(1).max(200).optional(),
          clientAdmin: z.boolean().optional(),
        }).strict(),
        req.body,
        'team member',
      );

      return teamScope(
        req,
        async (tx, companyId) => {
          if (auth.role === 'CLIENT') {
            const me = await tx.one<{ client_admin: boolean }>(
              `select client_admin from ocs.app_users where id = $1`, [auth.userId],
            );
            if (!me?.client_admin) {
              throw forbidden('Only your company administrator can change logins');
            }
            if (userId === auth.userId && body.active === false) {
              throw forbidden('You cannot deactivate your own login');
            }
          }

          const target = await tx.one<{ id: string; client_admin: boolean }>(
            `select id, client_admin from ocs.app_users
              where id = $1 and client_id = $2 and deleted_at is null for update`,
            [userId, companyId],
          );
          if (!target) throw notFound('Team member');

          /**
           * A company must keep an administrator. Without one, nobody on their
           * side can add or remove a login and every change becomes a support
           * ticket for us.
           */
          if (target.client_admin && (body.clientAdmin === false || body.active === false)) {
            const others = await tx.one<{ n: string }>(
              `select count(*)::text as n from ocs.app_users
                where client_id = $1 and client_admin and is_active
                  and deleted_at is null and id <> $2`,
              [companyId, userId],
            );
            if (Number(others?.n ?? 0) === 0) {
              throw conflict(
                'This is the last administrator for this company — make someone else ' +
                  'an administrator first.',
              );
            }
          }

          await tx.query(
            `update ocs.app_users
                set is_active = coalesce($2, is_active),
                    name = coalesce($3, name),
                    client_admin = coalesce($4, client_admin),
                    token_version = case when $2 is false
                                         then token_version + 1 else token_version end
              where id = $1`,
            [userId, body.active ?? null, body.name ?? null, body.clientAdmin ?? null],
          );

          if (body.active === false) {
            await tx.query(
              `update ocs.refresh_tokens set revoked_at = now()
                where user_id = $1 and revoked_at is null`,
              [userId],
            );
          }

          await writeAudit(tx, {
            companyId,
            actorUserId: auth.userId,
            actorEmail: auth.email,
            action: 'portal.team_updated',
            entityType: 'app_user',
            entityId: userId,
            summary: body.active === false ? 'Portal login deactivated' : 'Portal login updated',
            after: { active: body.active, clientAdmin: body.clientAdmin },
            requestId: req.id,
            ipAddress: clientIp(req),
          });

          const member = await tx.one(
            `select ${TEAM_SELECT} from ocs.app_users u where u.id = $1`, [userId],
          );
          return { user: member };
        },
        body.clientId ?? null,
      );
    },
  );

  // -- Messages on a permit --------------------------------------------------

  /**
   * The conversation about one permit.
   *
   * Backed by the same support ticket machinery, so a contractor's message and
   * a coordinator's reply are one thread rather than two systems. Internal
   * staff notes never appear: the row-level policy in 0018 does not match them
   * in tenant context, so they are not filtered here -- they are unreachable.
   */
  app.get(
    '/api/portal/permits/:permitId/messages',
    { preHandler: [requireApiAuth, requireCapability('portal:read_own')] },
    async (req) => {
      const { permitId } = parse(
        z.object({ permitId: z.string().uuid() }), req.params, 'parameters',
      );
      const q = parse(z.object({ clientId: z.string().uuid().optional() }), req.query, 'query');

      return portalScope(
        req,
        async (tx, companyId) => {
          const ticket = await tx.one(
            `select t.id, t.reference, t.company_id as "clientId", t.permit_id as "permitId",
                    t.subject, upper(t.status::text) as status,
                    upper(t.priority::text) as priority,
                    t.created_at as "createdAt", t.updated_at as "updatedAt"
               from ocs.support_tickets t
              where t.permit_id = $1 and t.company_id = $2
              order by t.created_at desc limit 1`,
            [permitId, companyId],
          );

          if (!ticket) return { permitId, ticket: null, messages: [] };

          const messages = await tx.many(
            `select m.id, m.author_user_id as "authorUserId", u.name as "authorName",
                    m.body, m.created_at as "at"
               from ocs.support_messages m
               left join ocs.app_users u on u.id = m.author_user_id
              where m.ticket_id = $1
              order by m.created_at`,
            [(ticket as { id: string }).id],
          );

          return { permitId, ticket, messages };
        },
        q.clientId ?? null,
      );
    },
  );

  /** Say something about a permit. Opens the thread if there is not one. */
  app.post(
    '/api/portal/permits/:permitId/messages',
    { preHandler: [requireApiAuth, requireCapability('portal:read_own')] },
    async (req, reply) => {
      const auth = req.apiAuth!;
      const { permitId } = parse(
        z.object({ permitId: z.string().uuid() }), req.params, 'parameters',
      );
      const body = parse(
        z.object({
          clientId: z.string().uuid().optional(),
          body: z.string().trim().min(1).max(20000),
        }),
        req.body,
        'message',
      );

      const result = await portalScope(
        req,
        async (tx, companyId) => {
          const permit = await tx.one<{ id: string; permit_type: string; permit_number: string | null }>(
            `select id, permit_type, permit_number from ocs.permits
              where id = $1 and company_id = $2 and deleted_at is null`,
            [permitId, companyId],
          );
          if (!permit) throw notFound('Permit');

          let ticket = await tx.one<{ id: string }>(
            `select id from ocs.support_tickets
              where permit_id = $1 and company_id = $2 and status <> 'resolved'
              order by created_at desc limit 1`,
            [permitId, companyId],
          );

          let opening = false;
          if (!ticket) {
            ticket = await tx.one<{ id: string }>(
              `insert into ocs.support_tickets (company_id, permit_id, subject, opened_by)
               values ($1, $2, $3, $4) returning id`,
              [
                companyId, permitId,
                `Permit ${permit.permit_number ?? permit.permit_type}`,
                auth.userId,
              ],
            );
            opening = true;
          }

          await tx.query(
            `insert into ocs.support_messages
               (ticket_id, company_id, author_user_id, body, is_internal, is_opening)
             values ($1, $2, $3, $4, false, $5)`,
            [ticket!.id, companyId, auth.userId, body.body, opening],
          );

          const messages = await tx.many(
            `select m.id, m.author_user_id as "authorUserId", u.name as "authorName",
                    m.body, m.created_at as "at"
               from ocs.support_messages m
               left join ocs.app_users u on u.id = m.author_user_id
              where m.ticket_id = $1 order by m.created_at`,
            [ticket!.id],
          );

          const full = await tx.one(
            `select t.id, t.reference, t.company_id as "clientId", t.permit_id as "permitId",
                    t.subject, upper(t.status::text) as status,
                    upper(t.priority::text) as priority,
                    t.created_at as "createdAt", t.updated_at as "updatedAt"
               from ocs.support_tickets t where t.id = $1`,
            [ticket!.id],
          );

          return { permitId, ticket: full, messages };
        },
        body.clientId ?? null,
      );

      reply.code(201);
      return result;
    },
  );
}

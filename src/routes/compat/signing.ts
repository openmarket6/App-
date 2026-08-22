/**
 * /api/signing — putting a document in front of a contractor, and proving it.
 *
 * The screens for this shipped long before the backend did. Onboarding step 4
 * ("Agreements") and the contractor portal both called these paths, got 501,
 * and rendered a red error; the onboarding checklist could never reach 100%
 * for anybody, and no contractor has a signed master service agreement.
 *
 * Three rules run through every handler here, and each one exists because the
 * opposite destroys the evidentiary value of the record:
 *
 *   THE DOCUMENT IS FROZEN AT SEND TIME. The exact rendered text is stored on
 *   the row with its sha256. Re-rendering at read time would mean a template
 *   edit silently changes what somebody is recorded as having agreed to.
 *
 *   ONLY THE SIGNER SIGNS. A staff account cannot sign on a contractor's
 *   behalf, even though ADMIN holds every capability. A signature applied by
 *   someone other than the signer is not weak evidence, it is the absence of
 *   evidence, and the role table alone would have allowed it.
 *
 *   NOTHING IS EDITED IN PLACE. A wrong document is VOIDED and a new one sent.
 *   Rewriting a sent request would move the words out from under a signature
 *   that may already have been given.
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
  SIGNABLE_KINDS, SIGNABLE_LABELS, REQUIRED_SIGNABLES, assessSigning,
  type SignableKind, type SignatureRequest,
} from '../../shared/signing.js';
import { templateFor, type SigningContext } from '../../domain/signing/templates.js';
import { env } from '../../config/env.js';

const KIND = z.enum(SIGNABLE_KINDS as unknown as [string, ...string[]]);

/** Kept small on purpose: a drawn signature is a scribble, not a photograph. */
const MAX_DRAWN_SIGNATURE_CHARS = 250_000;

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

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
    reason: `signing_${auth.role}`,
    ...(requestedClientId ? { companyId: requestedClientId } : {}),
  });
}

/**
 * A contractor may only ever address their own company.
 *
 * `scoped` already pins a CLIENT session to its own tenant, so a mismatched id
 * would return an empty result rather than somebody else's data. This turns
 * that silence into a 403, because a contractor who mistypes an id should be
 * told they cannot look there rather than shown an empty agreements list and
 * left to conclude nothing was ever sent.
 */
function resolveClientId(req: FastifyRequest, requested: string | null | undefined): string | null {
  const auth = req.apiAuth!;
  if (auth.role !== 'CLIENT') return requested ?? null;
  if (!auth.clientId) throw forbidden('This account is not linked to a contractor company');
  if (requested && requested !== auth.clientId) {
    throw forbidden('You can only view agreements for your own company');
  }
  return auth.clientId;
}

const SELECT = `
  s.id,
  s.company_id as "clientId",
  s.kind::text as kind,
  s.status::text as status,
  s.template_id as "templateId",
  s.template_version as "templateVersion",
  s.rendered_hash as "renderedHash",
  s.signer_name as "signerName",
  s.signer_email as "signerEmail",
  s.signer_title as "signerTitle",
  s.sent_at as "sentAt",
  s.viewed_at as "viewedAt",
  s.signed_at as "signedAt",
  s.declined_at as "declinedAt",
  s.decline_reason as "declineReason",
  s.expires_at as "expiresAt",
  s.signature,
  s.audit_trail as "auditTrail",
  s.created_at as "createdAt"
`;

interface Row {
  id: string;
  clientId: string;
  kind: SignableKind;
  status: SignatureRequest['status'];
  templateId: string;
  templateVersion: number;
  renderedHash: string;
  signerName: string;
  signerEmail: string;
  signerTitle: string | null;
  sentAt: string | null;
  viewedAt: string | null;
  signedAt: string | null;
  declinedAt: string | null;
  declineReason: string | null;
  expiresAt: string | null;
  signature: SignatureRequest['signature'];
  auditTrail: SignatureRequest['signature'] extends null ? never[] : unknown[];
  createdAt: string;
  renderedBody?: string;
}

/**
 * Add the label and the tamper verdict, so no caller recomputes either.
 *
 * `intact` is null rather than false for anything unsigned. False would read as
 * "this signature is broken" on a document nobody has signed yet, which is the
 * kind of alarm that gets a real one ignored.
 */
function present(row: Row) {
  const intact = row.status === 'SIGNED' && row.signature
    ? row.signature.documentHashAtSigning === row.renderedHash
    : null;
  return {
    ...row,
    label: SIGNABLE_LABELS[row.kind] ?? row.kind,
    intact,
  };
}

/** The shape assessSigning needs, from a row that does not carry the body. */
function forVerdict(row: Row): SignatureRequest {
  return { ...row, renderedBody: '' } as unknown as SignatureRequest;
}

async function loadContext(
  tx: Tx,
  companyId: string,
): Promise<SigningContext & { contactEmail: string | null }> {
  /*
   * `email`, not `contact_email`. ocs.companies has never had a contact_name or
   * contact_email column -- the frontend's Client type says contactEmail
   * because /api/clients/:id maps c.email onto that name. Writing the frontend's
   * spelling into SQL here produced a 500 on every send, which the integration
   * test caught before anyone tried to onboard somebody with it.
   */
  const { rows } = await tx.query<{
    legalName: string | null; name: string;
    contactEmail: string | null; licenseNumber: string | null;
    serviceLine: 'EXPEDITING' | 'MANAGED_LICENSE';
    addressLine1: string | null; city: string | null; state: string | null; postalCode: string | null;
  }>(
    `select c.legal_name as "legalName", c.name,
            c.email as "contactEmail", c.license_number as "licenseNumber",
            c.service_line::text as "serviceLine",
            c.address_line1 as "addressLine1", c.city, c.state, c.postal_code as "postalCode"
       from ocs.companies c
      where c.id = $1 and c.deleted_at is null`,
    [companyId],
  );
  const c = rows[0];
  if (!c) throw notFound('Contractor');

  const address = [c.addressLine1, c.city, c.state && c.postalCode ? `${c.state} ${c.postalCode}` : c.state]
    .filter((p) => p && String(p).trim())
    .join(', ');

  return {
    /*
     * Legal name if we have it, trade name if we do not.
     *
     * Falling back is better than refusing -- a blank party line is a document
     * that binds nobody, and the name on file is at least a name the signer
     * will recognise. The compliance screen is where the legal name gets
     * corrected; this is not the place to block onboarding over it.
     */
    contractorLegalName: (c.legalName ?? '').trim() || c.name,
    contractorAddress: address || null,
    contractorLicenseNumber: c.licenseNumber,
    contactEmail: c.contactEmail,
    /*
     * There is no contact-name column, so the addressee defaults to the company
     * itself and the caller may override it. The name that ends up mattering is
     * the one the signer types at signing time, which is captured as evidence;
     * this is only who the request was addressed to.
     */
    signerName: (c.legalName ?? '').trim() || c.name,
    signerTitle: null,
    serviceLine: c.serviceLine,
    effectiveDate: new Date().toISOString().slice(0, 10),
    firmLegalName: env.MAIL_RETURN_NAME ?? 'One Contractor Solutions',
    firmAddress: [env.MAIL_RETURN_LINE1, env.MAIL_RETURN_CITY,
      env.MAIL_RETURN_STATE && env.MAIL_RETURN_POSTAL_CODE
        ? `${env.MAIL_RETURN_STATE} ${env.MAIL_RETURN_POSTAL_CODE}` : null]
      .filter(Boolean).join(', '),
    firmLicenseNumber: null,
  };
}

export async function compatSigningRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------------------
  // GET /api/signing/status/:clientId
  // ---------------------------------------------------------------------------

  /**
   * The verdict onboarding step 4 and the portal dashboard both read.
   *
   * Computed by assessSigning from src/shared -- the same function the screen
   * imports -- because a server and a screen disagreeing about whether a
   * contractor is papered is the disagreement that gets somebody working under
   * an agreement nobody signed.
   */
  app.get<{ Params: { clientId: string } }>(
    '/api/signing/status/:clientId',
    { preHandler: [requireApiAuth, requireCapability('document:read')] },
    async (req) => {
      const { clientId } = parse(
        z.object({ clientId: z.string().uuid() }), req.params, 'params',
      );
      const companyId = resolveClientId(req, clientId)!;

      return scoped(req, async (tx) => {
        const { rows: companyRows } = await tx.query<{ serviceLine: 'EXPEDITING' | 'MANAGED_LICENSE' }>(
          `select service_line::text as "serviceLine" from ocs.companies
            where id = $1 and deleted_at is null`,
          [companyId],
        );
        const company = companyRows[0];
        if (!company) throw notFound('Contractor');

        const { rows } = await tx.query<Row>(
          `select ${SELECT} from ocs.signature_requests s where s.company_id = $1`,
          [companyId],
        );

        return {
          clientId: companyId,
          serviceLine: company.serviceLine,
          verdict: assessSigning(rows.map(forVerdict), company.serviceLine),
          labels: SIGNABLE_LABELS,
          /*
           * Which documents this line requires, sent alongside the verdict.
           *
           * The list and the verdict have to come from the same read of
           * service_line. The screen would otherwise derive it from the client
           * record it already has, which arrives from a different endpoint --
           * and on any disagreement it would offer agreements this verdict is
           * not judging, leaving the step pending against documents nobody is
           * counting.
           */
          required: REQUIRED_SIGNABLES[company.serviceLine],
        };
      }, clientId);
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/signing/requests
  // ---------------------------------------------------------------------------

  app.get(
    '/api/signing/requests',
    { preHandler: [requireApiAuth, requireCapability('document:read')] },
    async (req) => {
      const q = parse(
        z.object({ clientId: z.string().uuid().optional() }), req.query, 'query',
      );
      const companyId = resolveClientId(req, q.clientId);

      return scoped(req, async (tx) => {
        const { rows } = await tx.query<Row>(
          `select ${SELECT}
             from ocs.signature_requests s
            where ($1::uuid is null or s.company_id = $1)
            order by s.created_at desc`,
          [companyId],
        );
        return { requests: rows.map(present), total: rows.length };
      }, companyId);
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/signing/requests/:id  — the document itself
  // ---------------------------------------------------------------------------

  /**
   * The only handler that returns `renderedBody`, and the only one that records
   * that the document was opened.
   *
   * Presentment is half the E-SIGN burden: it is not enough that they signed,
   * it has to be shown they were presented with the words. That is only
   * provable if the opening was recorded at the moment it happened, so the
   * VIEWED transition lives here rather than being set optimistically when the
   * signature arrives.
   */
  app.get<{ Params: { id: string } }>(
    '/api/signing/requests/:id',
    { preHandler: [requireApiAuth, requireCapability('document:read')] },
    async (req) => {
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'params');
      const auth = req.apiAuth!;

      return scoped(req, async (tx) => {
        const { rows } = await tx.query<Row>(
          `select ${SELECT}, s.rendered_body as "renderedBody"
             from ocs.signature_requests s where s.id = $1`,
          [id],
        );
        const row = rows[0];
        if (!row) throw notFound('Signature request');

        // Only the signer opening it is presentment. Staff previewing the
        // document is not, and recording it as such would put a false fact in
        // the audit trail.
        if (auth.role === 'CLIENT' && (row.status === 'SENT' || row.status === 'DRAFT')) {
          const { rows: updated } = await tx.query<Row>(
            `update ocs.signature_requests
                set status = 'VIEWED',
                    viewed_at = coalesce(viewed_at, now()),
                    audit_trail = audit_trail || $2::jsonb
              where id = $1
              returning ${SELECT.replace(/\bs\./g, '')}, rendered_body as "renderedBody"`,
            [id, JSON.stringify([{
              at: new Date().toISOString(),
              event: 'opened',
              ipAddress: clientIp(req),
              detail: null,
            }])],
          );
          if (updated[0]) return present(updated[0]);
        }

        return present(row);
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/signing/requests  — send one
  // ---------------------------------------------------------------------------

  app.post(
    '/api/signing/requests',
    { preHandler: [requireApiAuth, requireCapability('document:generate')] },
    async (req, reply) => {
      const body = parse(
        z.object({
          clientId: z.string().uuid(),
          kind: KIND,
          signerName: z.string().min(1).max(200).optional(),
          signerEmail: z.string().email().optional(),
          signerTitle: z.string().max(120).nullish(),
        }),
        req.body,
        'body',
      );
      const auth = req.apiAuth!;
      const kind = body.kind as SignableKind;

      return scoped(req, async (tx) => {
        const ctx = await loadContext(tx, body.clientId);

        /*
         * Refuse a document the contractor's line does not use.
         *
         * Sending the managed-licence addendum to an expediting contractor
         * produces a pending requirement that can never be satisfied and never
         * goes away: assessSigning only counts required kinds, so the row sits
         * there unsigned forever while the verdict says complete. Confusing,
         * and the contractor has been asked to sign something that does not
         * apply to them.
         */
        if (!REQUIRED_SIGNABLES[ctx.serviceLine].includes(kind)
            && kind !== 'W9_ACKNOWLEDGEMENT') {
          throw badRequest(
            `${SIGNABLE_LABELS[kind]} does not apply to a contractor on the ` +
            `${ctx.serviceLine === 'MANAGED_LICENSE' ? 'managed licence' : 'expediting'} service line.`,
          );
        }

        const signerEmail = body.signerEmail ?? ctx.contactEmail ?? null;
        if (!signerEmail) {
          throw badRequest(
            'This contractor has no contact email, so there is nobody to send the ' +
            'agreement to. Add one on the contractor record first.',
          );
        }

        const template = templateFor(kind);
        const renderedBody = template.render({
          ...ctx,
          signerName: body.signerName ?? ctx.signerName,
          signerTitle: body.signerTitle ?? ctx.signerTitle,
        });

        const now = new Date().toISOString();
        let rows: Row[];
        try {
          ({ rows } = await tx.query<Row>(
            `insert into ocs.signature_requests
               (company_id, kind, status, template_id, template_version,
                rendered_body, rendered_hash, signer_name, signer_email, signer_title,
                sent_at, audit_trail, requested_by)
             values ($1, $2, 'SENT', $3, $4, $5, $6, $7, $8, $9, now(), $10::jsonb, $11)
             returning ${SELECT.replace(/\bs\./g, '')}`,
            [
              body.clientId, kind, template.id, template.version,
              renderedBody, sha256(renderedBody),
              body.signerName ?? ctx.signerName, signerEmail, body.signerTitle ?? null,
              JSON.stringify([
                { at: now, event: 'created', ipAddress: clientIp(req), detail: null },
                { at: now, event: 'sent', ipAddress: clientIp(req), detail: signerEmail },
              ]),
              auth.userId,
            ],
          ));
        } catch (err) {
          // The partial unique index. Two open requests for the same document
          // is a contractor who signs one and stays pending on the other.
          if ((err as { code?: string }).code === '23505') {
            throw conflict(
              `${SIGNABLE_LABELS[kind]} has already been sent and is waiting to be ` +
              'signed. Void the existing request before sending a replacement.',
            );
          }
          throw err;
        }

        await writeAudit(tx, {
          companyId: body.clientId,
          actorUserId: auth.userId,
          actorEmail: auth.email,
          action: 'signature.requested',
          entityType: 'signature_request',
          entityId: rows[0]!.id,
          summary: `${SIGNABLE_LABELS[kind]} sent to ${signerEmail}`,
          requestId: String(req.id),
          ipAddress: clientIp(req),
          userAgent: userAgent(req),
        });

        reply.code(201);
        return present(rows[0]!);
      }, body.clientId);
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/signing/requests/:id/sign
  // ---------------------------------------------------------------------------

  /**
   * The signature.
   *
   * The hash is recomputed here from the stored body rather than trusted from
   * the row, so that if the two ever disagree the disagreement is recorded
   * inside the evidence instead of being papered over by copying the column.
   */
  app.post<{ Params: { id: string } }>(
    '/api/signing/requests/:id/sign',
    { preHandler: [requireApiAuth, requireCapability('portal:sign_documents')] },
    async (req) => {
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'params');
      const body = parse(
        z.object({
          typedName: z.string().min(2).max(200),
          consentToElectronicSignature: z.literal(true),
          drawnSignaturePng: z.string().max(MAX_DRAWN_SIGNATURE_CHARS).nullish(),
        }),
        req.body,
        'body',
      );
      const auth = req.apiAuth!;

      /*
       * Staff cannot sign, capability table notwithstanding.
       *
       * ADMIN holds every capability including portal:sign_documents, so the
       * guard above would have let a coordinator apply a contractor's
       * signature. An electronic signature is worth exactly what can be shown
       * about who made it; one applied by the counterparty is worth nothing,
       * and would be indistinguishable in the record from a real one.
       */
      if (auth.role !== 'CLIENT') {
        throw forbidden(
          'Only the contractor can sign their own agreement. A signature applied ' +
          'by this firm would not be evidence of the contractor agreeing to it.',
        );
      }

      if (body.drawnSignaturePng && !body.drawnSignaturePng.startsWith('data:image/png;base64,')) {
        throw badRequest('A drawn signature must be a PNG data URL.');
      }

      return scoped(req, async (tx) => {
        const { rows } = await tx.query<Row & { renderedBody: string }>(
          `select ${SELECT}, s.rendered_body as "renderedBody"
             from ocs.signature_requests s
            where s.id = $1
              for update`,
          [id],
        );
        const row = rows[0];
        if (!row) throw notFound('Signature request');

        if (row.status === 'SIGNED') {
          throw conflict('This document has already been signed.');
        }
        if (row.status === 'VOIDED' || row.status === 'DECLINED' || row.status === 'EXPIRED') {
          throw conflict(
            `This request is ${row.status.toLowerCase()} and cannot be signed. ` +
            'Ask for a new one to be sent.',
          );
        }
        if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) {
          throw conflict('This request has expired. Ask for a new one to be sent.');
        }

        const at = new Date().toISOString();
        const evidence = {
          typedName: body.typedName.trim(),
          drawnSignaturePng: body.drawnSignaturePng ?? null,
          consentToElectronicSignature: true,
          ipAddress: clientIp(req) ?? '',
          userAgent: userAgent(req) ?? '',
          signedAt: at,
          documentHashAtSigning: sha256(row.renderedBody),
          auditTrail: [],
        };

        const { rows: updated } = await tx.query<Row>(
          `update ocs.signature_requests
              set status = 'SIGNED',
                  signed_at = now(),
                  signature = $2::jsonb,
                  audit_trail = audit_trail || $3::jsonb
            where id = $1
            returning ${SELECT.replace(/\bs\./g, '')}`,
          [id, JSON.stringify(evidence), JSON.stringify([
            { at, event: 'signed', ipAddress: clientIp(req), detail: body.typedName.trim() },
          ])],
        );

        await writeAudit(tx, {
          companyId: row.clientId,
          actorUserId: auth.userId,
          actorEmail: auth.email,
          action: 'signature.signed',
          entityType: 'signature_request',
          entityId: id,
          summary: `${SIGNABLE_LABELS[row.kind]} signed by ${body.typedName.trim()}`,
          requestId: String(req.id),
          ipAddress: clientIp(req),
          userAgent: userAgent(req),
        });

        return present(updated[0]!);
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/signing/requests/:id/decline
  // ---------------------------------------------------------------------------

  app.post<{ Params: { id: string } }>(
    '/api/signing/requests/:id/decline',
    { preHandler: [requireApiAuth, requireCapability('portal:sign_documents')] },
    async (req) => {
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'params');
      const body = parse(
        z.object({ reason: z.string().min(1).max(1000) }), req.body, 'body',
      );
      const auth = req.apiAuth!;
      if (auth.role !== 'CLIENT') {
        throw forbidden('Only the contractor can decline their own agreement.');
      }

      return scoped(req, async (tx) => {
        const { rows } = await tx.query<Row>(
          `update ocs.signature_requests
              set status = 'DECLINED', declined_at = now(), decline_reason = $2,
                  audit_trail = audit_trail || $3::jsonb
            where id = $1 and status in ('DRAFT', 'SENT', 'VIEWED')
            returning ${SELECT.replace(/\bs\./g, '')}`,
          [id, body.reason.trim(), JSON.stringify([{
            at: new Date().toISOString(), event: 'declined',
            ipAddress: clientIp(req), detail: body.reason.trim(),
          }])],
        );
        if (!rows[0]) {
          throw conflict('This request is not open, so it cannot be declined.');
        }

        await writeAudit(tx, {
          companyId: rows[0].clientId,
          actorUserId: auth.userId,
          actorEmail: auth.email,
          action: 'signature.declined',
          entityType: 'signature_request',
          entityId: id,
          summary: `${SIGNABLE_LABELS[rows[0].kind]} declined: ${body.reason.trim()}`,
          requestId: String(req.id),
          ipAddress: clientIp(req),
          userAgent: userAgent(req),
        });

        return present(rows[0]);
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/signing/requests/:id/void
  // ---------------------------------------------------------------------------

  /**
   * Withdraw a request that should not have been sent.
   *
   * Deliberately not a delete. "We sent the wrong addendum and withdrew it" is
   * a fact about how this contractor was dealt with, and a row that vanishes
   * cannot be distinguished later from one that was never sent.
   */
  app.post<{ Params: { id: string } }>(
    '/api/signing/requests/:id/void',
    { preHandler: [requireApiAuth, requireCapability('document:generate')] },
    async (req) => {
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'params');
      const body = parse(
        z.object({ reason: z.string().min(1).max(1000) }), req.body, 'body',
      );
      const auth = req.apiAuth!;

      return scoped(req, async (tx) => {
        const { rows } = await tx.query<Row>(
          `update ocs.signature_requests
              set status = 'VOIDED',
                  audit_trail = audit_trail || $2::jsonb
            where id = $1 and status in ('DRAFT', 'SENT', 'VIEWED')
            returning ${SELECT.replace(/\bs\./g, '')}`,
          [id, JSON.stringify([{
            at: new Date().toISOString(), event: 'voided',
            ipAddress: clientIp(req), detail: body.reason.trim(),
          }])],
        );
        if (!rows[0]) {
          // A signed request is the case worth naming: voiding it would look
          // like a way to undo a signature, and it is not one.
          throw conflict(
            'Only an open request can be voided. A signed agreement stays on the ' +
            'record; send a replacement if the terms have changed.',
          );
        }

        await writeAudit(tx, {
          companyId: rows[0].clientId,
          actorUserId: auth.userId,
          actorEmail: auth.email,
          action: 'signature.voided',
          entityType: 'signature_request',
          entityId: id,
          summary: `${SIGNABLE_LABELS[rows[0].kind]} voided: ${body.reason.trim()}`,
          requestId: String(req.id),
          ipAddress: clientIp(req),
          userAgent: userAgent(req),
        });

        return present(rows[0]);
      });
    },
  );
}

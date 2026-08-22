/**
 * /api/compliance — whether we can lawfully file for a contractor today.
 *
 * That is the only question this area exists to answer. Everything else is in
 * service of it: an expiring certificate matters because of what it stops, not
 * because a date is approaching.
 *
 * THE STATUS IS COMPUTED, NOT STORED. It comes from computeComplianceStatus in
 * src/shared -- the same function the React app calls -- because a stored
 * status goes stale overnight: a policy that expires at midnight still reads
 * VALID at nine the next morning unless something has run. What IS stored is
 * the human decision (rejected, waived, awaiting review), which no amount of
 * date arithmetic can derive.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant, withServiceContext, type Tx } from '../../db/tenant.js';
import { requireApiAuth, requireCapability } from './auth.js';
import { parse, clientIp } from '../../lib/http-helpers.js';
import { writeAudit } from '../../lib/audit.js';
import { notFound, badRequest, forbidden } from '../../lib/errors.js';
import {
  COMPLIANCE_KINDS, COMPLIANCE_LABELS, DEFAULT_COMPLIANCE_POLICY,
  computeComplianceStatus, daysUntilExpiry, EXPIRING_SOON_DAYS,
  type ComplianceKind, type ComplianceStatus,
} from '../../shared/compliance.js';

/** The stored decision maps onto the frontend's status vocabulary. */
/**
 * Exported so the filing check reads decisions the same way this module does.
 * A second copy of this map is a second answer to "is this certificate good",
 * and the two would diverge the first time a decision value is added.
 */
export const DECISION_TO_STATUS: Record<string, ComplianceStatus> = {
  pending_review: 'PENDING_REVIEW',
  rejected: 'REJECTED',
  waived: 'WAIVED',
  // 'accepted' is deliberately absent: an accepted record's status depends on
  // its expiry date, which is what computeComplianceStatus works out.
  accepted: 'VALID',
};

interface StoredItem {
  id: string;
  clientId: string;
  kind: ComplianceKind;
  carrier: string | null;
  policyNumber: string | null;
  limitPerOccurrenceCents: string | null;
  limitAggregateCents: string | null;
  effectiveDate: string | null;
  expiresAt: string | null;
  documentId: string | null;
  decision: string;
  decisionNote: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Adds the derived status and the label, so no caller recomputes either. */
function present(row: StoredItem) {
  const status = computeComplianceStatus(
    {
      kind: row.kind,
      expiresAt: row.expiresAt,
      status: DECISION_TO_STATUS[row.decision] ?? 'PENDING_REVIEW',
    },
  );
  return {
    ...row,
    limitPerOccurrenceCents: row.limitPerOccurrenceCents == null
      ? null : Number(row.limitPerOccurrenceCents),
    limitAggregateCents: row.limitAggregateCents == null
      ? null : Number(row.limitAggregateCents),
    label: COMPLIANCE_LABELS[row.kind] ?? row.kind,
    status,
    daysUntilExpiry: daysUntilExpiry({ expiresAt: row.expiresAt }),
  };
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
    reason: `compliance_${auth.role}`,
    ...(requestedClientId ? { companyId: requestedClientId } : {}),
  });
}

const SELECT = `
  c.id, c.company_id as "clientId", c.kind::text as kind,
  c.carrier, c.policy_number as "policyNumber",
  c.limit_per_occurrence_cents as "limitPerOccurrenceCents",
  c.limit_aggregate_cents as "limitAggregateCents",
  c.effective_date as "effectiveDate",
  c.expires_at as "expiresAt",
  c.document_id as "documentId",
  c.decision::text as decision,
  c.decision_note as "decisionNote",
  c.created_at as "createdAt", c.updated_at as "updatedAt"
`;

export async function compatComplianceRoutes(app: FastifyInstance): Promise<void> {
  /** What the firm requires, and what blocks a filing. Reference data. */
  app.get(
    '/api/compliance/policy',
    { preHandler: [requireApiAuth] },
    async () => ({
      policy: DEFAULT_COMPLIANCE_POLICY.map((p) => ({
        ...p,
        label: COMPLIANCE_LABELS[p.kind] ?? p.kind,
      })),
      kinds: COMPLIANCE_KINDS.map((k) => ({ kind: k, label: COMPLIANCE_LABELS[k] })),
      expiringSoonDays: EXPIRING_SOON_DAYS,
    }),
  );

  /**
   * One contractor's compliance, with the gaps named.
   *
   * Every required kind appears whether or not a record exists, because a
   * missing certificate is the thing you most need to see and an absent row
   * shows nothing at all.
   */
  app.get(
    '/api/compliance',
    { preHandler: [requireApiAuth, requireCapability('compliance:read')] },
    async (req) => {
      const q = parse(z.object({ clientId: z.string().uuid().optional() }), req.query, 'query');

      return scoped(
        req,
        async (tx, companyId) => {
          const rows = await tx.many<StoredItem>(
            `select ${SELECT} from ocs.compliance_items c
              where ($1::uuid is null or c.company_id = $1::uuid)
              order by c.kind`,
            [companyId],
          );

          const items = rows.map(present);
          const byKind = new Map(items.map((i) => [i.kind, i]));

          const gaps = DEFAULT_COMPLIANCE_POLICY.filter((spec) => {
            if (!spec.required) return false;
            const held = byKind.get(spec.kind);
            // A workers-comp exemption certificate satisfies the workers-comp
            // requirement, which is how Florida works for a qualifying officer.
            if (spec.kind === 'WORKERS_COMP' && byKind.get('WORKERS_COMP_EXEMPTION')) {
              const ex = byKind.get('WORKERS_COMP_EXEMPTION')!;
              if (ex.status === 'VALID' || ex.status === 'EXPIRING_SOON') return false;
            }
            if (!held) return true;
            return !['VALID', 'EXPIRING_SOON', 'WAIVED'].includes(held.status);
          }).map((spec) => ({
            kind: spec.kind,
            label: COMPLIANCE_LABELS[spec.kind] ?? spec.kind,
            blocksFiling: spec.blocksFiling,
            status: byKind.get(spec.kind)?.status ?? 'MISSING',
            note: spec.note,
          }));

          const canFile = companyId
            ? (await tx.one<{ ok: boolean }>(
                `select ocs.can_file_for($1) as ok`, [companyId],
              ))?.ok ?? false
            : null;

          return {
            clientId: companyId,
            items,
            total: items.length,
            gaps,
            blockingGaps: gaps.filter((g) => g.blocksFiling).length,
            // The answer the whole area exists for, stated rather than implied.
            canFile,
          };
        },
        q.clientId ?? null,
      );
    },
  );

  /**
   * What is running out, across every contractor.
   *
   * Ordered by expiry, and expired items come first: something that has already
   * lapsed is stopping work now, while something expiring in three weeks is a
   * reminder.
   */
  app.get(
    '/api/compliance/expiring',
    { preHandler: [requireApiAuth, requireCapability('compliance:read')] },
    async (req) => {
      const q = parse(
        z.object({ days: z.coerce.number().int().min(1).max(365).default(EXPIRING_SOON_DAYS) }),
        req.query,
        'query',
      );

      return withServiceContext(
        async (tx) => {
          const rows = await tx.many<StoredItem & {
            clientName: string | null; clientOnFilingHold: boolean;
          }>(
            `select ${SELECT},
                    co.name as "clientName",
                    not ocs.can_file_for(c.company_id) as "clientOnFilingHold"
               from ocs.compliance_items c
               join ocs.companies co on co.id = c.company_id
              where c.expires_at is not null
                and c.decision <> 'waived'
                and c.expires_at <= current_date + ($1 || ' days')::interval
              order by c.expires_at
              limit 500`,
            [String(q.days)],
          );

          const items = rows.map((r) => ({
            ...present(r),
            clientName: r.clientName,
            clientOnFilingHold: r.clientOnFilingHold,
          }));

          return {
            windowDays: q.days,
            items,
            total: items.length,
            expiredCount: items.filter((i) => i.status === 'EXPIRED').length,
          };
        },
        { reason: 'compliance_expiring' },
      );
    },
  );

  /**
   * Record or replace a certificate.
   *
   * POST rather than PUT even though it upserts by (company, kind): the caller
   * is uploading a new certificate, and which existing row that displaces is
   * this module's business, not theirs. It was PUT, which nothing called --
   * the screen has always sent POST, so the upload has never reached here.
   */
  app.post(
    '/api/compliance',
    { preHandler: [requireApiAuth, requireCapability('compliance:read')] },
    async (req, reply) => {
      const auth = req.apiAuth!;
      const body = parse(
        z.object({
          clientId: z.string().uuid().optional(),
          kind: z.enum(COMPLIANCE_KINDS as unknown as [string, ...string[]]),
          carrier: z.string().trim().max(200).nullable().optional(),
          policyNumber: z.string().trim().max(120).nullable().optional(),
          limitPerOccurrenceCents: z.number().int().min(0).nullable().optional(),
          limitAggregateCents: z.number().int().min(0).nullable().optional(),
          effectiveDate: z.string().date().nullable().optional(),
          expiresAt: z.string().date().nullable().optional(),
          documentId: z.string().uuid().nullable().optional(),
        }),
        req.body,
        'compliance record',
      );

      const companyId = auth.role === 'CLIENT' ? auth.clientId : (body.clientId ?? null);
      if (!companyId) throw badRequest('A compliance record must belong to a contractor');

      const result = await scoped(
        req,
        async (tx) => {
          const row = await tx.one<StoredItem>(
            `insert into ocs.compliance_items
               (company_id, kind, carrier, policy_number,
                limit_per_occurrence_cents, limit_aggregate_cents,
                effective_date, expires_at, document_id, decision)
             values ($1,$2::ocs.compliance_kind,$3,$4,$5,$6,$7::date,$8::date,$9,'pending_review')
             on conflict (company_id, kind) do update
               set carrier = excluded.carrier,
                   policy_number = excluded.policy_number,
                   limit_per_occurrence_cents = excluded.limit_per_occurrence_cents,
                   limit_aggregate_cents = excluded.limit_aggregate_cents,
                   effective_date = excluded.effective_date,
                   expires_at = excluded.expires_at,
                   document_id = excluded.document_id,
                   -- A replacement certificate goes back for review. Carrying
                   -- the old acceptance forward would mean a lapsed policy
                   -- replaced by an unchecked one still reads as accepted.
                   decision = 'pending_review',
                   decision_note = null,
                   decided_by = null,
                   decided_at = null
             returning ${SELECT.replace(/c\./g, '')}`,
            [
              companyId, body.kind, body.carrier ?? null, body.policyNumber ?? null,
              body.limitPerOccurrenceCents ?? null, body.limitAggregateCents ?? null,
              body.effectiveDate ?? null, body.expiresAt ?? null, body.documentId ?? null,
            ],
          );

          await writeAudit(tx, {
            companyId,
            actorUserId: auth.userId,
            actorEmail: auth.email,
            action: 'compliance.recorded',
            entityType: 'compliance_item',
            entityId: row!.id,
            summary: `${COMPLIANCE_LABELS[body.kind as ComplianceKind] ?? body.kind} recorded`,
            after: { kind: body.kind, expiresAt: body.expiresAt ?? null },
            requestId: req.id,
            ipAddress: clientIp(req),
          });

          return present(row!);
        },
        auth.role === 'CLIENT' ? null : companyId,
      );

      reply.code(201);
      return result;
    },
  );

  /** Accept or reject what a contractor sent. */
  app.post(
    '/api/compliance/:id/review',
    { preHandler: [requireApiAuth, requireCapability('compliance:review')] },
    async (req) => {
      const auth = req.apiAuth!;
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
      /*
       * Speaks the screen's vocabulary as well as its own.
       *
       * The review drawer sends {decision: 'APPROVE'|'REJECT', reviewNote,
       * effectiveDate, expiresAt}. This endpoint accepted
       * {decision: 'accept'|'reject', note} and nothing else -- so every
       * approval from the UI returned 400, and since no permit can be filed
       * until compliance is accepted, onboarding could not complete at all.
       * The dates were worse than rejected: they were dropped in silence, and
       * an expiry date is what drives every renewal warning this system sends.
       *
       * Both spellings are taken, because this is the compat layer and its job
       * is to absorb exactly this kind of drift rather than break on it.
       */
      const body = parse(
        z.object({
          decision: z.string().trim(),
          note: z.string().trim().max(2000).nullable().optional(),
          reviewNote: z.string().trim().max(2000).nullable().optional(),
          effectiveDate: z.string().nullable().optional(),
          expiresAt: z.string().nullable().optional(),
        }),
        req.body,
        'review',
      );

      const decision = body.decision.toLowerCase();
      const accepted = decision === 'accept' || decision === 'approve' || decision === 'approved';
      const rejected = decision === 'reject' || decision === 'rejected';
      if (!accepted && !rejected) {
        throw badRequest(
          `Unknown review decision "${body.decision}". Use approve or reject.`,
        );
      }

      const note = body.note ?? body.reviewNote ?? null;

      if (rejected && !note) {
        throw badRequest(
          'Say why it was rejected. A rejection with no reason generates the phone ' +
            'call this system exists to prevent.',
        );
      }

      /*
       * A date the reviewer corrected is applied, not ignored. `coalesce` keeps
       * whatever is on file when the drawer sends nothing, so reviewing without
       * touching the dates cannot blank them.
       */
      const toDate = (v: string | null | undefined): string | null => {
        if (!v) return null;
        const t = Date.parse(v);
        if (!Number.isFinite(t)) throw badRequest(`"${v}" is not a date this can read.`);
        return new Date(t).toISOString().slice(0, 10);
      };
      const effectiveDate = toDate(body.effectiveDate);
      const expiresAt = toDate(body.expiresAt);

      return withServiceContext(
        async (tx) => {
          const row = await tx.one<StoredItem>(
            `update ocs.compliance_items c
                set decision = $2::ocs.compliance_decision,
                    decision_note = $3,
                    decided_by = $4,
                    decided_at = now(),
                    effective_date = coalesce($5::date, c.effective_date),
                    expires_at = coalesce($6::date, c.expires_at)
              where c.id = $1
              returning ${SELECT}`,
            [
              id, accepted ? 'accepted' : 'rejected',
              note, auth.userId, effectiveDate, expiresAt,
            ],
          );
          if (!row) throw notFound('Compliance record');

          await writeAudit(tx, {
            companyId: row.clientId,
            actorUserId: auth.userId,
            actorEmail: auth.email,
            action: `compliance.${body.decision}ed`,
            entityType: 'compliance_item',
            entityId: id,
            summary: `${COMPLIANCE_LABELS[row.kind] ?? row.kind} ${body.decision}ed`,
            after: { decision: accepted ? 'accepted' : 'rejected', note },
            requestId: req.id,
            ipAddress: clientIp(req),
          });

          return present(row);
        },
        { reason: 'review_compliance' },
      );
    },
  );

  /**
   * Waive a requirement.
   *
   * A deliberate exception to a rule that exists for a reason, so it records
   * who made it and why, and the database refuses one without both.
   */
  app.post(
    '/api/compliance/:id/waive',
    { preHandler: [requireApiAuth, requireCapability('compliance:waive')] },
    async (req) => {
      const auth = req.apiAuth!;
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
      /*
       * The waive drawer sends `waivedReason`; this took `note`. Same fault as
       * the review endpoint above -- a required field under a name the caller
       * does not use is a 400 on every attempt, and waiving is how a legitimate
       * exception gets recorded, so the exception simply could not be recorded.
       */
      const raw = parse(
        z.object({
          note: z.string().trim().min(1).max(2000).optional(),
          waivedReason: z.string().trim().min(1).max(2000).optional(),
        }),
        req.body,
        'waiver',
      );
      const body = { note: raw.note ?? raw.waivedReason ?? '' };
      if (!body.note) {
        throw badRequest(
          'Say why this requirement is being waived. A waiver with no reason is ' +
            'indistinguishable from an oversight when somebody reads it back.',
        );
      }

      return withServiceContext(
        async (tx) => {
          const row = await tx.one<StoredItem>(
            `update ocs.compliance_items c
                set decision = 'waived', decision_note = $2,
                    decided_by = $3, decided_at = now()
              where c.id = $1
              returning ${SELECT}`,
            [id, body.note, auth.userId],
          );
          if (!row) throw notFound('Compliance record');

          await writeAudit(tx, {
            companyId: row.clientId,
            actorUserId: auth.userId,
            actorEmail: auth.email,
            action: 'compliance.waived',
            entityType: 'compliance_item',
            entityId: id,
            summary: `${COMPLIANCE_LABELS[row.kind] ?? row.kind} WAIVED: ${body.note}`,
            after: { note: body.note },
            requestId: req.id,
            ipAddress: clientIp(req),
          });

          return present(row);
        },
        { reason: 'waive_compliance' },
      );
    },
  );
}

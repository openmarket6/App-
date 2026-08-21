/**
 * Licenses, qualifiers and insurance policies.
 *
 * `status` is derived from `expires_on` on read rather than stored, so it can
 * never be stale. A stored status would need a job to keep it accurate and
 * would silently show "active" for a policy that lapsed overnight.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, principalOf, tenantOf } from '../auth/plugin.js';
import { withTenant } from '../db/tenant.js';
import { requireCompanyRole } from '../auth/rbac.js';
import { parse, clientIp, userAgent, created } from '../lib/http-helpers.js';
import { writeAudit } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';

const licenseType = z.enum([
  'state_certified', 'state_registered', 'county_local', 'municipal',
  'specialty', 'business_tax_receipt', 'other',
]);

const insuranceType = z.enum([
  'general_liability', 'workers_compensation', 'commercial_auto',
  'umbrella', 'professional_liability', 'builders_risk', 'other',
]);

/**
 * Effective status, computed in SQL from the expiry date. `reminder_days`
 * defines the "expiring soon" window per record, so a policy that needs 90
 * days' notice is treated differently from one that needs 30.
 */
const DERIVED_STATUS = `
  case
    when status in ('revoked','suspended','pending') then status::text
    when expires_on is null then 'active'
    when expires_on < current_date then 'expired'
    when expires_on <= current_date + make_interval(days => reminder_days) then 'expiring_soon'
    else 'active'
  end
`;

export async function complianceRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------------------
  // Licenses
  // ---------------------------------------------------------------------------

  app.get('/v1/licenses', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'viewer');

    return withTenant(ctx, async (tx) => ({
      data: await tx.many(
        `select id, license_type::text, license_number, trade, issuing_authority,
                ${DERIVED_STATUS} as status,
                issued_on, expires_on, reminder_days, qualifier_id, municipality_id,
                document_id, notes, created_at, updated_at,
                (expires_on - current_date) as days_remaining
           from ocs.licenses
          where company_id = $1 and deleted_at is null
          order by expires_on asc nulls last`,
        [ctx.companyId],
      ),
    }));
  });

  app.post('/v1/licenses', { preHandler: authenticate }, async (req, reply) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'admin');

    const body = parse(
      z.object({
        licenseType,
        licenseNumber: z.string().trim().min(1).max(80),
        trade: z.string().trim().max(80).optional(),
        issuingAuthority: z.string().trim().max(200).optional(),
        issuedOn: z.string().date().optional(),
        expiresOn: z.string().date().optional(),
        reminderDays: z.number().int().min(0).max(365).default(60),
        qualifierId: z.string().uuid().optional(),
        municipalityId: z.string().uuid().optional(),
        documentId: z.string().uuid().optional(),
        notes: z.string().trim().max(2000).optional(),
      }),
      req.body,
      'license',
    );

    const license = await withTenant(ctx, async (tx) => {
      const row = await tx.one(
        `insert into ocs.licenses
           (company_id, license_type, license_number, trade, issuing_authority,
            issued_on, expires_on, reminder_days, qualifier_id, municipality_id,
            document_id, notes)
         values ($1,$2::ocs.license_type,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         returning id, license_type::text, license_number, trade, expires_on, reminder_days`,
        [
          ctx.companyId,
          body.licenseType,
          body.licenseNumber,
          body.trade ?? null,
          body.issuingAuthority ?? null,
          body.issuedOn ?? null,
          body.expiresOn ?? null,
          body.reminderDays,
          body.qualifierId ?? null,
          body.municipalityId ?? null,
          body.documentId ?? null,
          body.notes ?? null,
        ],
      );

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'license.created',
        entityType: 'license',
        entityId: (row as { id?: string } | null)?.id ?? null,
        summary: `License ${body.licenseNumber} added`,
        after: row,
        requestId: req.id,
        ipAddress: clientIp(req),
        userAgent: userAgent(req),
      });

      return row;
    });

    return created(reply, license);
  });

  app.patch('/v1/licenses/:id', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'admin');

    const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
    const body = parse(
      z.object({
        licenseNumber: z.string().trim().max(80).optional(),
        trade: z.string().trim().max(80).optional(),
        issuedOn: z.string().date().optional(),
        expiresOn: z.string().date().optional(),
        reminderDays: z.number().int().min(0).max(365).optional(),
        documentId: z.string().uuid().optional(),
        notes: z.string().trim().max(2000).optional(),
        status: z.enum(['active', 'suspended', 'revoked', 'pending']).optional(),
      }),
      req.body,
      'license',
    );

    return withTenant(ctx, async (tx) => {
      const before = await tx.one(
        `select * from ocs.licenses where id = $1 and company_id = $2 and deleted_at is null`,
        [id, ctx.companyId],
      );
      if (!before) throw notFound('License');

      const updated = await tx.one(
        `update ocs.licenses
            set license_number = coalesce($3, license_number),
                trade = coalesce($4, trade),
                issued_on = coalesce($5, issued_on),
                expires_on = coalesce($6, expires_on),
                reminder_days = coalesce($7, reminder_days),
                document_id = coalesce($8, document_id),
                notes = coalesce($9, notes),
                status = coalesce($10::ocs.compliance_status, status),
                -- Changing the expiry restarts the reminder cycle, so a renewed
                -- license warns again next time rather than staying silent.
                last_reminder_sent_at = case when $6 is not null then null
                                             else last_reminder_sent_at end
          where id = $1 and company_id = $2 and deleted_at is null
          returning id, license_type::text, license_number, trade, expires_on,
                    ${DERIVED_STATUS} as status`,
        [
          id,
          ctx.companyId,
          body.licenseNumber ?? null,
          body.trade ?? null,
          body.issuedOn ?? null,
          body.expiresOn ?? null,
          body.reminderDays ?? null,
          body.documentId ?? null,
          body.notes ?? null,
          body.status ?? null,
        ],
      );

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'license.updated',
        entityType: 'license',
        entityId: id,
        before,
        after: updated,
        requestId: req.id,
        ipAddress: clientIp(req),
        userAgent: userAgent(req),
      });

      return updated;
    });
  });

  // ---------------------------------------------------------------------------
  // Insurance
  // ---------------------------------------------------------------------------

  app.get('/v1/insurance-policies', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'viewer');

    return withTenant(ctx, async (tx) => ({
      data: await tx.many(
        `select id, insurance_type::text, policy_number, carrier_name,
                agent_name, agent_email, agent_phone,
                ${DERIVED_STATUS} as status,
                coverage_amount, deductible, effective_on, expires_on, reminder_days,
                document_id, notes, created_at,
                (expires_on - current_date) as days_remaining
           from ocs.insurance_policies
          where company_id = $1 and deleted_at is null
          order by expires_on asc nulls last`,
        [ctx.companyId],
      ),
    }));
  });

  app.post('/v1/insurance-policies', { preHandler: authenticate }, async (req, reply) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'admin');

    const body = parse(
      z.object({
        insuranceType,
        policyNumber: z.string().trim().min(1).max(80),
        carrierName: z.string().trim().max(200).optional(),
        agentName: z.string().trim().max(200).optional(),
        agentEmail: z.string().email().max(200).optional(),
        agentPhone: z.string().trim().max(40).optional(),
        coverageAmount: z.number().nonnegative().max(1e12).optional(),
        deductible: z.number().nonnegative().max(1e10).optional(),
        effectiveOn: z.string().date().optional(),
        expiresOn: z.string().date().optional(),
        reminderDays: z.number().int().min(0).max(365).default(45),
        documentId: z.string().uuid().optional(),
        notes: z.string().trim().max(2000).optional(),
      }),
      req.body,
      'insurance policy',
    );

    const policy = await withTenant(ctx, async (tx) => {
      const row = await tx.one(
        `insert into ocs.insurance_policies
           (company_id, insurance_type, policy_number, carrier_name, agent_name,
            agent_email, agent_phone, coverage_amount, deductible, effective_on,
            expires_on, reminder_days, document_id, notes)
         values ($1,$2::ocs.insurance_type,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         returning id, insurance_type::text, policy_number, carrier_name, expires_on`,
        [
          ctx.companyId,
          body.insuranceType,
          body.policyNumber,
          body.carrierName ?? null,
          body.agentName ?? null,
          body.agentEmail ?? null,
          body.agentPhone ?? null,
          body.coverageAmount ?? null,
          body.deductible ?? null,
          body.effectiveOn ?? null,
          body.expiresOn ?? null,
          body.reminderDays,
          body.documentId ?? null,
          body.notes ?? null,
        ],
      );

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'insurance.created',
        entityType: 'insurance_policy',
        entityId: (row as { id?: string } | null)?.id ?? null,
        summary: `${body.insuranceType} policy ${body.policyNumber} added`,
        requestId: req.id,
        ipAddress: clientIp(req),
        userAgent: userAgent(req),
      });

      return row;
    });

    return created(reply, policy);
  });

  // ---------------------------------------------------------------------------
  // Qualifiers
  // ---------------------------------------------------------------------------

  app.get('/v1/qualifiers', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'viewer');

    return withTenant(ctx, async (tx) => ({
      data: await tx.many(
        `select id, user_id, full_name, email, phone, license_number,
                is_primary, is_active, created_at
           from ocs.qualifiers
          where company_id = $1 and deleted_at is null
          order by is_primary desc, full_name`,
        [ctx.companyId],
      ),
    }));
  });

  app.post('/v1/qualifiers', { preHandler: authenticate }, async (req, reply) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'admin');

    const body = parse(
      z.object({
        fullName: z.string().trim().min(1).max(200),
        email: z.string().email().max(200).optional(),
        phone: z.string().trim().max(40).optional(),
        licenseNumber: z.string().trim().max(80).optional(),
        isPrimary: z.boolean().default(false),
      }),
      req.body,
      'qualifier',
    );

    const qualifier = await withTenant(ctx, async (tx) => {
      // Only one primary qualifier per company (enforced by a partial unique
      // index); demote the incumbent first rather than failing the request.
      if (body.isPrimary) {
        await tx.query(
          `update ocs.qualifiers set is_primary = false
            where company_id = $1 and is_primary and deleted_at is null`,
          [ctx.companyId],
        );
      }

      const row = await tx.one(
        `insert into ocs.qualifiers
           (company_id, full_name, email, phone, license_number, is_primary)
         values ($1,$2,$3,$4,$5,$6)
         returning id, full_name, email, phone, license_number, is_primary, is_active`,
        [
          ctx.companyId,
          body.fullName,
          body.email ?? null,
          body.phone ?? null,
          body.licenseNumber ?? null,
          body.isPrimary,
        ],
      );

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'qualifier.created',
        entityType: 'qualifier',
        entityId: (row as { id?: string } | null)?.id ?? null,
        summary: `Qualifier ${body.fullName} added`,
        requestId: req.id,
      });

      return row;
    });

    return created(reply, qualifier);
  });

  /** Dashboard rollup: everything expiring, in one call. */
  app.get('/v1/compliance/summary', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'viewer');

    return withTenant(ctx, async (tx) => {
      const licenses = await tx.many(
        `select id, 'license' as kind, license_number as reference,
                coalesce(trade, license_type::text) as label,
                expires_on, (expires_on - current_date) as days_remaining,
                ${DERIVED_STATUS} as status
           from ocs.licenses
          where company_id = $1 and deleted_at is null and expires_on is not null`,
        [ctx.companyId],
      );

      const insurance = await tx.many(
        `select id, 'insurance' as kind, policy_number as reference,
                insurance_type::text as label,
                expires_on, (expires_on - current_date) as days_remaining,
                ${DERIVED_STATUS} as status
           from ocs.insurance_policies
          where company_id = $1 and deleted_at is null and expires_on is not null`,
        [ctx.companyId],
      );

      const items = [...licenses, ...insurance] as Array<{ status: string }>;
      return {
        items,
        counts: {
          expired: items.filter((i) => i.status === 'expired').length,
          expiringSoon: items.filter((i) => i.status === 'expiring_soon').length,
          active: items.filter((i) => i.status === 'active').length,
        },
      };
    });
  });
}

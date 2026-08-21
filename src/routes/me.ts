/**
 * Identity, company membership and onboarding.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, authenticateWithoutCompany, principalOf, tenantOf } from '../auth/plugin.js';
import { withTenant, withServiceContext } from '../db/tenant.js';
import { requireCompanyRole, requireMfa } from '../auth/rbac.js';
import { parse, clientIp, userAgent, created } from '../lib/http-helpers.js';
import { writeAudit } from '../lib/audit.js';
import { badRequest, notFound, conflict } from '../lib/errors.js';

const createCompanySchema = z.object({
  name: z.string().trim().min(1).max(200),
  legalName: z.string().trim().max(200).optional(),
  licenseNumber: z.string().trim().max(60).optional(),
  phone: z.string().trim().max(40).optional(),
  email: z.string().email().max(200).optional(),
  addressLine1: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().length(2).default('FL'),
  postalCode: z.string().trim().max(12).optional(),
});

const updateProfileSchema = z.object({
  fullName: z.string().trim().min(1).max(200).optional(),
  phone: z.string().trim().max(40).optional(),
});

const inviteSchema = z.object({
  email: z.string().email().max(200),
  role: z.enum(['owner', 'admin', 'member', 'viewer']).default('member'),
  fullName: z.string().trim().max(200).optional(),
});

const updateMemberSchema = z.object({
  role: z.enum(['owner', 'admin', 'member', 'viewer']).optional(),
  isActive: z.boolean().optional(),
});

export async function meRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Works before the caller has any company, which is the whole point: a
   * brand-new signup calls this to discover they need to create one.
   */
  app.get('/v1/me', { preHandler: authenticateWithoutCompany }, async (req) => {
    const p = principalOf(req);

    const companies = await withServiceContext(
      async (tx) =>
        tx.many<{ id: string; name: string; role: string; status: string }>(
          `select c.id, c.name, m.role::text, c.status::text
             from ocs.company_memberships m
             join ocs.companies c on c.id = m.company_id
            where m.user_id = $1 and m.is_active and c.deleted_at is null
            order by c.name`,
          [p.userId],
        ),
      { reason: 'me_companies' },
    );

    const profile = await withServiceContext(
      async (tx) =>
        tx.one<{ id: string; email: string; full_name: string | null; phone: string | null }>(
          `select id, email, full_name, phone from ocs.app_users where id = $1`,
          [p.userId],
        ),
      { reason: 'me_profile' },
    );

    return {
      user: {
        id: p.userId,
        email: p.email,
        fullName: profile?.full_name ?? null,
        phone: profile?.phone ?? null,
        platformRole: p.platformRole,
        mfaEnabled: p.mfaSatisfied,
      },
      companies,
      activeCompanyId: p.companyId || null,
      activeCompanyRole: p.companyId ? p.companyRole : null,
    };
  });

  app.patch('/v1/me', { preHandler: authenticateWithoutCompany }, async (req) => {
    const p = principalOf(req);
    const body = parse(updateProfileSchema, req.body, 'profile');

    const updated = await withServiceContext(
      async (tx) =>
        tx.one<{ id: string; full_name: string | null; phone: string | null }>(
          `update ocs.app_users
              set full_name = coalesce($2, full_name),
                  phone = coalesce($3, phone)
            where id = $1
            returning id, full_name, phone`,
          [p.userId, body.fullName ?? null, body.phone ?? null],
        ),
      { reason: 'update_own_profile' },
    );

    if (!updated) throw notFound('Profile');
    return { id: updated.id, fullName: updated.full_name, phone: updated.phone };
  });

  /**
   * Create a company and become its owner.
   *
   * Runs in service context because at this moment the caller belongs to no
   * company, so no tenant context exists to open. The scope is tight: it writes
   * exactly one company and one membership, both for the authenticated caller.
   */
  app.post('/v1/companies', { preHandler: authenticateWithoutCompany }, async (req, reply) => {
    const p = principalOf(req);
    const body = parse(createCompanySchema, req.body, 'company');

    const result = await withServiceContext(
      async (tx) => {
        const company = await tx.one<{ id: string; name: string }>(
          `insert into ocs.companies
             (name, legal_name, license_number, phone, email,
              address_line1, city, state, postal_code)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           returning id, name`,
          [
            body.name,
            body.legalName ?? null,
            body.licenseNumber ?? null,
            body.phone ?? null,
            body.email ?? null,
            body.addressLine1 ?? null,
            body.city ?? null,
            body.state,
            body.postalCode ?? null,
          ],
        );
        if (!company) throw badRequest('Could not create company');

        await tx.query(
          `insert into ocs.company_memberships (company_id, user_id, role, accepted_at)
           values ($1, $2, 'owner', now())`,
          [company.id, p.userId],
        );

        await writeAudit(tx, {
          companyId: company.id,
          actorUserId: p.userId,
          actorEmail: p.email,
          action: 'company.created',
          entityType: 'company',
          entityId: company.id,
          summary: `Company "${company.name}" created`,
          after: { name: company.name },
          requestId: req.id,
          ipAddress: clientIp(req),
          userAgent: userAgent(req),
        });

        return company;
      },
      { reason: 'create_company' },
    );

    return created(reply, { id: result.id, name: result.name, role: 'owner' });
  });

  app.get('/v1/company', { preHandler: authenticate }, async (req) => {
    const ctx = tenantOf(req);
    return withTenant(ctx, async (tx) => {
      const company = await tx.one(
        `select id, name, legal_name, status::text, license_number, federal_ein,
                phone, email, address_line1, address_line2, city, state, postal_code,
                created_at
           from ocs.companies where id = $1`,
        [ctx.companyId],
      );
      if (!company) throw notFound('Company');
      return company;
    });
  });

  app.patch('/v1/company', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'admin');

    const body = parse(createCompanySchema.partial(), req.body, 'company');

    return withTenant(ctx, async (tx) => {
      const before = await tx.one(`select * from ocs.companies where id = $1`, [ctx.companyId]);
      if (!before) throw notFound('Company');

      const updated = await tx.one(
        `update ocs.companies
            set name = coalesce($2, name),
                legal_name = coalesce($3, legal_name),
                license_number = coalesce($4, license_number),
                phone = coalesce($5, phone),
                email = coalesce($6, email),
                address_line1 = coalesce($7, address_line1),
                city = coalesce($8, city),
                state = coalesce($9, state),
                postal_code = coalesce($10, postal_code)
          where id = $1
          returning id, name, legal_name, status::text, license_number, phone, email,
                    address_line1, city, state, postal_code`,
        [
          ctx.companyId,
          body.name ?? null,
          body.legalName ?? null,
          body.licenseNumber ?? null,
          body.phone ?? null,
          body.email ?? null,
          body.addressLine1 ?? null,
          body.city ?? null,
          body.state ?? null,
          body.postalCode ?? null,
        ],
      );

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'company.updated',
        entityType: 'company',
        entityId: ctx.companyId,
        before,
        after: updated,
        requestId: req.id,
        ipAddress: clientIp(req),
        userAgent: userAgent(req),
      });

      return updated;
    });
  });

  app.get('/v1/company/members', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'viewer');

    return withTenant(ctx, async (tx) => ({
      data: await tx.many(
        `select m.id, m.user_id, m.role::text, m.is_active, m.invited_at, m.accepted_at,
                u.email, u.full_name, u.last_seen_at
           from ocs.company_memberships m
           join ocs.app_users u on u.id = m.user_id
          where m.company_id = $1
          order by u.full_name nulls last, u.email`,
        [ctx.companyId],
      ),
    }));
  });

  /**
   * Invite someone.
   *
   * Requires MFA: adding a member is how an attacker with a stolen password
   * would give themselves durable access, so it sits behind a second factor
   * along with the other account-control operations.
   */
  app.post('/v1/company/members', { preHandler: authenticate }, async (req, reply) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'admin');
    requireMfa(p);

    const body = parse(inviteSchema, req.body, 'invitation');

    // Only an owner may mint another owner.
    if (body.role === 'owner') requireCompanyRole(p, 'owner');

    const result = await withServiceContext(
      async (tx) => {
        // Create-or-find the person. They may already exist from another
        // company, or not exist at all until they first sign in.
        const user = await tx.one<{ id: string; email: string }>(
          `insert into ocs.app_users (email, full_name)
                values ($1, $2)
           on conflict (lower(email)) do update set email = excluded.email
             returning id, email`,
          [body.email, body.fullName ?? null],
        );
        if (!user) throw badRequest('Could not resolve invited user');

        const existing = await tx.one<{ id: string; is_active: boolean }>(
          `select id, is_active from ocs.company_memberships
            where company_id = $1 and user_id = $2`,
          [ctx.companyId, user.id],
        );

        if (existing?.is_active) {
          throw conflict('That person is already a member of this company');
        }

        const membership = await tx.one<{ id: string }>(
          `insert into ocs.company_memberships
             (company_id, user_id, role, invited_by, invited_at, is_active)
           values ($1, $2, $3::ocs.company_role, $4, now(), true)
           on conflict (company_id, user_id) do update
             set role = excluded.role, is_active = true, invited_at = now()
           returning id`,
          [ctx.companyId, user.id, body.role, p.userId],
        );

        await writeAudit(tx, {
          companyId: ctx.companyId,
          actorUserId: p.userId,
          actorEmail: p.email,
          action: 'company.member_invited',
          entityType: 'membership',
          entityId: membership?.id ?? null,
          summary: `Invited ${body.email} as ${body.role}`,
          after: { email: body.email, role: body.role },
          requestId: req.id,
          ipAddress: clientIp(req),
          userAgent: userAgent(req),
        });

        return { id: membership?.id, userId: user.id, email: user.email, role: body.role };
      },
      { reason: 'invite_member', companyId: ctx.companyId },
    );

    return created(reply, result);
  });

  app.patch('/v1/company/members/:memberId', { preHandler: authenticate }, async (req) => {
    const p = principalOf(req);
    const ctx = tenantOf(req);
    requireCompanyRole(p, 'admin');
    requireMfa(p);

    const { memberId } = parse(z.object({ memberId: z.string().uuid() }), req.params, 'parameters');
    const body = parse(updateMemberSchema, req.body, 'membership');

    if (body.role === 'owner') requireCompanyRole(p, 'owner');

    return withTenant(ctx, async (tx) => {
      const before = await tx.one<{ id: string; user_id: string; role: string; is_active: boolean }>(
        `select id, user_id, role::text, is_active from ocs.company_memberships
          where id = $1 and company_id = $2`,
        [memberId, ctx.companyId],
      );
      if (!before) throw notFound('Member');

      // Do not let the last owner be demoted or deactivated -- that would leave
      // the company with nobody able to administer it.
      const losingOwner =
        before.role === 'owner' && (body.role !== undefined && body.role !== 'owner' || body.isActive === false);

      if (losingOwner) {
        const owners = await tx.one<{ count: string }>(
          `select count(*)::text from ocs.company_memberships
            where company_id = $1 and role = 'owner' and is_active`,
          [ctx.companyId],
        );
        if (Number(owners?.count ?? 0) <= 1) {
          throw conflict('A company must always have at least one active owner');
        }
      }

      const updated = await tx.one(
        `update ocs.company_memberships
            set role = coalesce($3::ocs.company_role, role),
                is_active = coalesce($4, is_active)
          where id = $1 and company_id = $2
          returning id, user_id, role::text, is_active`,
        [memberId, ctx.companyId, body.role ?? null, body.isActive ?? null],
      );

      await writeAudit(tx, {
        companyId: ctx.companyId,
        actorUserId: p.userId,
        actorEmail: p.email,
        action: 'company.member_updated',
        entityType: 'membership',
        entityId: memberId,
        before,
        after: updated,
        requestId: req.id,
        ipAddress: clientIp(req),
        userAgent: userAgent(req),
      });

      return updated;
    });
  });
}

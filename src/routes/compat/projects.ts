/**
 * /api/projects — the site a permit is pulled for.
 *
 * A project is an address with facts attached: which jurisdiction it falls
 * under, what the work is worth, whether it sits in a flood zone or seaward of
 * the coastal construction control line, and whether an owner-builder is
 * pulling their own permit.
 *
 * Those facts belong here rather than on each application, because they are
 * true of the SITE. Asking again on every permit is how the same address ends
 * up recorded as flood zone AE on one application and X on the next, and the
 * first person to notice is a plans examiner.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant, withServiceContext, type Tx } from '../../db/tenant.js';
import { requireApiAuth, requireCapability } from './auth.js';
import { parse, clientIp, userAgent } from '../../lib/http-helpers.js';
import { writeAudit } from '../../lib/audit.js';
import { notFound, badRequest, forbidden } from '../../lib/errors.js';

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
    reason: `projects_${auth.role}`,
    ...(requestedClientId ? { companyId: requestedClientId } : {}),
  });
}

const SELECT = `
  p.id,
  p.company_id as "clientId",
  p.name,
  coalesce(p.address_line1, '') as "addressLine1",
  coalesce(p.city, '') as city,
  coalesce(p.county, '') as county,
  coalesce(p.postal_code, '') as zip,
  p.municipality_id as "jurisdictionId",
  p.parcel_number as "parcelId",
  coalesce(p.valuation_cents, 0)::bigint as "valuationCents",
  p.owner_builder as "ownerBuilder",
  p.flood_zone as "floodZone",
  p.coastal_construction_control_line as "coastalConstructionControlLine",
  p.created_at as "createdAt",
  c.name as "clientName",
  m.name as "jurisdictionName"
`;

const FROM = `
  from ocs.projects p
  left join ocs.companies c on c.id = p.company_id
  left join ocs.municipalities m on m.id = p.municipality_id
`;

export async function compatProjectsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/projects',
    { preHandler: [requireApiAuth, requireCapability('permit:read')] },
    async (req) => {
      const q = parse(
        z.object({
          clientId: z.string().uuid().optional(),
          jurisdictionId: z.string().uuid().optional(),
        }),
        req.query,
        'query',
      );

      return scoped(
        req,
        async (tx, companyId) => {
          const projects = await tx.many(
            `select ${SELECT} ${FROM}
              where p.deleted_at is null
                and ($1::uuid is null or p.company_id = $1::uuid)
                and ($2::uuid is null or p.municipality_id = $2::uuid)
              order by p.created_at desc
              limit 1000`,
            [companyId, q.jurisdictionId ?? null],
          );
          return { projects, total: projects.length };
        },
        q.clientId ?? null,
      );
    },
  );

  app.get(
    '/api/projects/:id',
    { preHandler: [requireApiAuth, requireCapability('permit:read')] },
    async (req) => {
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');

      return scoped(req, async (tx, companyId) => {
        const project = await tx.one(
          `select ${SELECT} ${FROM}
            where p.id = $1 and p.deleted_at is null
              and ($2::uuid is null or p.company_id = $2::uuid)`,
          [id, companyId],
        );
        if (!project) throw notFound('Project');

        const permits = await tx.many(
          `select id, permit_type as "permitType", status::text as stage,
                  permit_number as "agencyRecordId", created_at as "createdAt"
             from ocs.permits
            where project_id = $1 and deleted_at is null
            order by created_at desc`,
          [id],
        );

        return { ...(project as object), permits };
      });
    },
  );

  app.post(
    '/api/projects',
    { preHandler: [requireApiAuth, requireCapability('permit:create')] },
    async (req, reply) => {
      const auth = req.apiAuth!;
      const body = parse(
        z.object({
          clientId: z.string().uuid().optional(),
          name: z.string().trim().min(1).max(300),
          addressLine1: z.string().trim().min(1).max(300),
          city: z.string().trim().min(1).max(120),
          county: z.string().trim().min(1).max(120),
          zip: z.string().trim().min(3).max(12),
          jurisdictionId: z.string().uuid(),
          parcelId: z.string().trim().max(80).nullable().optional(),
          valuationCents: z.number().int().min(0).default(0),
          ownerBuilder: z.boolean().default(false),
          floodZone: z.string().trim().max(20).nullable().optional(),
          coastalConstructionControlLine: z.boolean().default(false),
        }),
        req.body,
        'project',
      );

      const companyId = auth.role === 'CLIENT' ? auth.clientId : (body.clientId ?? null);
      if (!companyId) throw badRequest('A project must belong to a contractor');

      const result = await scoped(
        req,
        async (tx) => {
          const jurisdiction = await tx.one<{ id: string; county: string | null; name: string }>(
            `select id, county, name from ocs.municipalities where id = $1`,
            [body.jurisdictionId],
          );
          if (!jurisdiction) throw badRequest('No such jurisdiction');

          /**
           * The jurisdiction already knows its county, so a mismatch means one
           * of the two is wrong on a row that will be filed. Rejected rather
           * than silently corrected: if the contractor believes this address is
           * in a different county, that is worth a conversation, not a quiet
           * overwrite.
           */
          if (
            jurisdiction.county &&
            jurisdiction.county.toLowerCase() !== body.county.toLowerCase()
          ) {
            throw badRequest(
              `${jurisdiction.name} is in ${jurisdiction.county} County, not ` +
                `${body.county}. Check the jurisdiction before filing anything for this address.`,
            );
          }

          const created = await tx.one<{ id: string }>(
            `insert into ocs.projects
               (company_id, name, address_line1, city, county, postal_code,
                municipality_id, parcel_number, valuation_cents, owner_builder,
                flood_zone, coastal_construction_control_line, created_by,
                project_number, status)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                     (select coalesce(max(project_number), 1000) + 1 from ocs.projects),
                     'active')
             returning id`,
            [
              companyId, body.name, body.addressLine1, body.city, body.county,
              body.zip, body.jurisdictionId, body.parcelId ?? null,
              body.valuationCents, body.ownerBuilder, body.floodZone ?? null,
              body.coastalConstructionControlLine, auth.userId,
            ],
          );

          await writeAudit(tx, {
            companyId,
            actorUserId: auth.userId,
            actorEmail: auth.email,
            action: 'project.created',
            entityType: 'project',
            entityId: created!.id,
            summary: `Project created: ${body.name}, ${body.addressLine1}`,
            after: {
              jurisdictionId: body.jurisdictionId,
              valuationCents: body.valuationCents,
              floodZone: body.floodZone ?? null,
              coastalConstructionControlLine: body.coastalConstructionControlLine,
            },
            requestId: req.id,
            ipAddress: clientIp(req),
            userAgent: userAgent(req),
          });

          return tx.one(`select ${SELECT} ${FROM} where p.id = $1`, [created!.id]);
        },
        auth.role === 'CLIENT' ? null : companyId,
      );

      reply.code(201);
      return result;
    },
  );

  app.patch(
    '/api/projects/:id',
    { preHandler: [requireApiAuth, requireCapability('permit:edit')] },
    async (req) => {
      const auth = req.apiAuth!;
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params, 'parameters');
      const body = parse(
        z.object({
          name: z.string().trim().min(1).max(300).optional(),
          addressLine1: z.string().trim().min(1).max(300).optional(),
          city: z.string().trim().min(1).max(120).optional(),
          county: z.string().trim().min(1).max(120).optional(),
          zip: z.string().trim().min(3).max(12).optional(),
          parcelId: z.string().trim().max(80).nullable().optional(),
          valuationCents: z.number().int().min(0).optional(),
          ownerBuilder: z.boolean().optional(),
          floodZone: z.string().trim().max(20).nullable().optional(),
          coastalConstructionControlLine: z.boolean().optional(),
        }).strict(),
        req.body,
        'project',
      );

      return scoped(req, async (tx, companyId) => {
        const before = await tx.one<{ id: string; company_id: string; valuation_cents: string | null }>(
          `select id, company_id, valuation_cents from ocs.projects
            where id = $1 and deleted_at is null
              and ($2::uuid is null or company_id = $2::uuid)`,
          [id, companyId],
        );
        if (!before) throw notFound('Project');

        await tx.query(
          `update ocs.projects
              set name = coalesce($2, name),
                  address_line1 = coalesce($3, address_line1),
                  city = coalesce($4, city),
                  county = coalesce($5, county),
                  postal_code = coalesce($6, postal_code),
                  parcel_number = case when $7::boolean then $8 else parcel_number end,
                  valuation_cents = coalesce($9::bigint, valuation_cents),
                  owner_builder = coalesce($10, owner_builder),
                  flood_zone = case when $11::boolean then $12 else flood_zone end,
                  coastal_construction_control_line =
                    coalesce($13, coastal_construction_control_line)
            where id = $1`,
          [
            id, body.name ?? null, body.addressLine1 ?? null, body.city ?? null,
            body.county ?? null, body.zip ?? null,
            body.parcelId !== undefined, body.parcelId ?? null,
            body.valuationCents ?? null, body.ownerBuilder ?? null,
            body.floodZone !== undefined, body.floodZone ?? null,
            body.coastalConstructionControlLine ?? null,
          ],
        );

        /**
         * A valuation change is audited on its own, because it is the number
         * the FEMA 50% rule turns on: it can move a job from a repair into a
         * substantial improvement that must meet current flood code.
         */
        if (body.valuationCents !== undefined) {
          await writeAudit(tx, {
            companyId: before.company_id,
            actorUserId: auth.userId,
            actorEmail: auth.email,
            action: 'project.valuation_changed',
            entityType: 'project',
            entityId: id,
            summary: `Valuation changed to ${(body.valuationCents / 100).toFixed(2)}`,
            before: { valuationCents: Number(before.valuation_cents ?? 0) },
            after: { valuationCents: body.valuationCents },
            requestId: req.id,
            ipAddress: clientIp(req),
          });
        }

        return tx.one(`select ${SELECT} ${FROM} where p.id = $1`, [id]);
      });
    },
  );
}

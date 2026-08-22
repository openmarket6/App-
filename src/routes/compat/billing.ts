/**
 * /api/billing — subscriptions, the compliance retainer, and what gets charged.
 *
 * The arithmetic is not here. It lives in domain/pricing.ts, which is pure and
 * tested against the published price list, so the rules that decide money can
 * be checked by reading them rather than by running the server. This file does
 * the parts that touch the world: reading what a contractor is on, writing what
 * changed, and raising charge lines.
 *
 * THE DISTINCTION THIS FILE MUST NOT BLUR
 *
 * The compliance retainer is money HELD, not money EARNED. It never touches
 * revenue. It has its own append-only ledger, the balance is derived from that
 * ledger rather than stored, and a release requires a person to approve it --
 * all enforced in migration 0020, not here.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTenant, withServiceContext, type Tx } from '../../db/tenant.js';
import { requireApiAuth, requireCapability } from './auth.js';
import { parse, clientIp, userAgent } from '../../lib/http-helpers.js';
import { writeAudit } from '../../lib/audit.js';
import { notFound, badRequest, forbidden, conflict } from '../../lib/errors.js';
import {
  planFor, planForTradeCount, snapshot, onboardingDueCents, retainerChange,
  activationCharges, SUPERVISOR_VISIT_CENTS, ALL_TRADES_THRESHOLD,
  PLANS, formatCents, type PlanKey,
} from '../../domain/pricing.js';

const PLAN_KEYS = PLANS.map((p) => p.key) as [PlanKey, ...PlanKey[]];

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
    reason: `billing_${auth.role}`,
    ...(requestedClientId ? { companyId: requestedClientId } : {}),
  });
}

const isStaff = (role: string): boolean => role !== 'CLIENT' && role !== 'PENDING';

const SUB_SELECT = `
  s.id,
  s.company_id  as "clientId",
  s.plan_key    as "planKey",
  s.trade_count as "tradeCount",
  s.status::text as status,
  s.monthly_price_cents     as "monthlyPriceCents",
  s.onboarding_paid_cents   as "onboardingPaidCents",
  s.retainer_required_cents as "retainerRequiredCents",
  s.pricing_snapshot as "pricingSnapshot",
  s.started_on   as "startedOn",
  s.current_period_end as "currentPeriodEnd",
  s.cancelled_at as "cancelledAt",
  s.created_at   as "createdAt",
  s.updated_at   as "updatedAt"
`;

const LIVE = `s.status in ('pending','active','past_due','paused')`;

export async function compatBillingRoutes(app: FastifyInstance): Promise<void> {
  /** The published price list, so the frontend never hard-codes a number. */
  app.get('/api/billing/plans', { preHandler: [requireApiAuth] }, async () => ({
    plans: PLANS.map((p) => ({
      key: p.key,
      name: p.name,
      kind: p.kind,
      tradeCount: p.tradeCount,
      monthlyPriceCents: p.monthlyPriceCents,
      onboardingFeeCents: p.onboardingFeeCents,
      complianceRetainerCents: p.complianceRetainerCents,
      pricePerPermitCents: p.pricePerPermitCents,
    })),
    supervisorVisitCents: SUPERVISOR_VISIT_CENTS,
    allTradesThreshold: ALL_TRADES_THRESHOLD,
    note:
      'The compliance retainer is held on account against licensing risk. It is ' +
      'not a service fee and is not counted as revenue.',
  }));

  /** What a contractor is on today, and what is held for them. */
  app.get(
    '/api/billing/subscription',
    { preHandler: [requireApiAuth, requireCapability('billing:read')] },
    async (req) => {
      const q = parse(
        z.object({ clientId: z.string().uuid().optional() }),
        req.query,
        'query',
      );

      return scoped(
        req,
        async (tx, companyId) => {
          const subscription = await tx.one<{ clientId: string; retainerRequiredCents: number }>(
            `select ${SUB_SELECT} from ocs.subscriptions s
              where ${LIVE} and ($1::uuid is null or s.company_id = $1::uuid)
              order by s.created_at desc limit 1`,
            [companyId],
          );
          if (!subscription) return { subscription: null, retainer: null };

          const held = await tx.one<{ balance: number }>(
            `select ocs.retainer_balance_cents($1) as balance`,
            [subscription.clientId],
          );

          const heldCents = held?.balance ?? 0;
          return {
            subscription,
            retainer: {
              heldCents,
              requiredCents: subscription.retainerRequiredCents,
              // Surfaced rather than left to be worked out: a shortfall means
              // the plan is running on less cover than it is meant to have.
              shortfallCents: Math.max(0, subscription.retainerRequiredCents - heldCents),
            },
          };
        },
        q.clientId ?? null,
      );
    },
  );

  /**
   * What a plan change would cost, without doing it.
   *
   * Exists so the number on the screen and the number charged come from the
   * same function. A quote computed in the frontend is a quote that will
   * eventually disagree with the invoice.
   */
  app.post(
    '/api/billing/quote',
    { preHandler: [requireApiAuth, requireCapability('billing:read')] },
    async (req) => {
      const body = parse(
        z.object({
          clientId: z.string().uuid().optional(),
          planKey: z.enum(PLAN_KEYS).optional(),
          tradeCount: z.number().int().min(0).max(99).optional(),
        }),
        req.body,
        'quote',
      );

      if (!body.planKey && body.tradeCount === undefined) {
        throw badRequest('Give either a plan key or a trade count');
      }

      const plan = body.planKey ? planFor(body.planKey) : planForTradeCount(body.tradeCount!);

      return scoped(
        req,
        async (tx, companyId) => {
          const current = await tx.one<{ onboardingPaidCents: number; clientId: string }>(
            `select ${SUB_SELECT} from ocs.subscriptions s
              where ${LIVE} and ($1::uuid is null or s.company_id = $1::uuid)
              order by s.created_at desc limit 1`,
            [companyId],
          );

          const targetCompany = current?.clientId ?? companyId;
          const held = targetCompany
            ? (await tx.one<{ balance: number }>(
                `select ocs.retainer_balance_cents($1) as balance`, [targetCompany],
              ))?.balance ?? 0
            : 0;

          const { lines, retainer } = activationCharges({
            toPlan: plan,
            onboardingAlreadyPaidCents: current?.onboardingPaidCents ?? 0,
            retainerHeldCents: held,
          });

          return {
            plan: { key: plan.key, name: plan.name, tradeCount: plan.tradeCount },
            // Separate lines, never a total. The caller has to record them on
            // different ledgers, and handing back one number is how a retainer
            // ends up misfiled as revenue.
            lines: lines.map((l) => ({ ...l, amount: formatCents(l.amountCents) })),
            retainer,
            dueNowCents: lines.reduce((sum, l) => sum + l.amountCents, 0),
            /**
             * Surfaced because it is the customer's money and they should be
             * told before, not after. Rule: a downgrade refunds no onboarding.
             */
            onboardingAlreadyPaidCents: current?.onboardingPaidCents ?? 0,
            notes: [
              plan.tradeCount >= ALL_TRADES_THRESHOLD
                ? `${ALL_TRADES_THRESHOLD} or more classifications is the One-Stop All Trades plan.`
                : null,
              retainer.action === 'needs_approval'
                ? 'Reducing a compliance retainer needs approval; nothing is released automatically.'
                : null,
              (current?.onboardingPaidCents ?? 0) > plan.onboardingFeeCents
                ? 'Onboarding already paid is higher than this plan requires. It is not refunded.'
                : null,
            ].filter(Boolean),
          };
        },
        body.clientId ?? null,
      );
    },
  );

  /**
   * Start or change a plan.
   *
   * Staff only. A contractor asking to change plan is a conversation, not a
   * button -- there is a signed agreement and a retainer behind it.
   */
  app.post(
    '/api/billing/subscription',
    { preHandler: [requireApiAuth, requireCapability('billing:manage')] },
    async (req, reply) => {
      const auth = req.apiAuth!;
      if (!isStaff(auth.role)) throw forbidden('Only staff can change a plan');

      const body = parse(
        z.object({
          clientId: z.string().uuid(),
          planKey: z.enum(PLAN_KEYS).optional(),
          tradeCount: z.number().int().min(0).max(99).optional(),
          note: z.string().max(2000).optional(),
          startedOn: z.string().date().optional(),
        }),
        req.body,
        'subscription',
      );

      if (!body.planKey && body.tradeCount === undefined) {
        throw badRequest('Give either a plan key or a trade count');
      }
      const plan = body.planKey ? planFor(body.planKey) : planForTradeCount(body.tradeCount!);

      const result = await withServiceContext(
        async (tx) => {
          const company = await tx.one<{ id: string }>(
            `select id from ocs.companies where id = $1 and deleted_at is null`,
            [body.clientId],
          );
          if (!company) throw notFound('Contractor');

          const current = await tx.one<{
            id: string; plan_key: string; trade_count: number; onboarding_paid_cents: number;
          }>(
            `select id, plan_key::text as plan_key, trade_count, onboarding_paid_cents
               from ocs.subscriptions
              where company_id = $1 and status in ('pending','active','past_due','paused')
              order by created_at desc limit 1`,
            [body.clientId],
          );

          const held = (await tx.one<{ balance: number }>(
            `select ocs.retainer_balance_cents($1) as balance`, [body.clientId],
          ))?.balance ?? 0;

          const onboardingPaid = current?.onboarding_paid_cents ?? 0;
          const onboardingDue = onboardingDueCents(plan, onboardingPaid);
          const retainer = retainerChange(plan, held);
          const capturedAt = new Date().toISOString();
          const snap = snapshot(plan, capturedAt);

          let subscriptionId: string;

          if (current) {
            if (current.plan_key === plan.key) {
              throw conflict(`That contractor is already on ${plan.name}`);
            }
            await tx.query(
              `update ocs.subscriptions
                  set plan_key = $2::ocs.plan_key,
                      trade_count = $3,
                      pricing_snapshot = $4::jsonb,
                      monthly_price_cents = $5,
                      -- Only ever increases; the database refuses a decrease.
                      onboarding_paid_cents = onboarding_paid_cents + $6,
                      retainer_required_cents = $7
                where id = $1`,
              [
                current.id, plan.key, plan.tradeCount, JSON.stringify(snap),
                plan.monthlyPriceCents, onboardingDue, plan.complianceRetainerCents,
              ],
            );
            subscriptionId = current.id;
          } else {
            const created = await tx.one<{ id: string }>(
              `insert into ocs.subscriptions
                 (company_id, plan_key, trade_count, status, pricing_snapshot,
                  monthly_price_cents, onboarding_paid_cents, retainer_required_cents,
                  started_on, created_by)
               values ($1, $2::ocs.plan_key, $3, 'pending', $4::jsonb, $5, $6, $7,
                       coalesce($8::date, current_date), $9)
               returning id`,
              [
                body.clientId, plan.key, plan.tradeCount, JSON.stringify(snap),
                plan.monthlyPriceCents, onboardingDue, plan.complianceRetainerCents,
                body.startedOn ?? null, auth.userId,
              ],
            );
            subscriptionId = created!.id;
          }

          await tx.query(
            `insert into ocs.subscription_changes
               (company_id, subscription_id, from_plan_key, to_plan_key,
                from_trade_count, to_trade_count, onboarding_charged_cents,
                retainer_delta_cents, requires_approval, pricing_snapshot, note, actor_user_id)
             values ($1,$2,$3::ocs.plan_key,$4::ocs.plan_key,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,
            [
              body.clientId, subscriptionId,
              current?.plan_key ?? null, plan.key,
              current?.trade_count ?? null, plan.tradeCount,
              onboardingDue,
              retainer.action === 'collect' ? retainer.collectCents
                : retainer.action === 'needs_approval' ? -retainer.releaseCents : 0,
              retainer.action === 'needs_approval',
              JSON.stringify(snap), body.note ?? null, auth.userId,
            ],
          );

          /**
           * A shortfall is collected as part of the change, because the cover
           * must be in place before the larger plan is. A RELEASE is not
           * written here at all -- it needs a person, and this endpoint records
           * that it is pending rather than acting on it.
           */
          if (retainer.action === 'collect') {
            await tx.query(
              `insert into ocs.retainer_ledger
                 (company_id, subscription_id, movement, amount_cents, reason, actor_user_id)
               values ($1, $2, 'collect', $3, $4, $5)`,
              [
                body.clientId, subscriptionId, retainer.collectCents,
                `Top up to ${plan.name}`, auth.userId,
              ],
            );
          }

          await writeAudit(tx, {
            companyId: body.clientId,
            actorUserId: auth.userId,
            actorEmail: auth.email,
            action: current ? 'billing.plan_changed' : 'billing.plan_started',
            entityType: 'subscription',
            entityId: subscriptionId,
            summary: current
              ? `Plan changed ${current.plan_key} -> ${plan.key}`
              : `Plan started on ${plan.key}`,
            before: current ? { planKey: current.plan_key } : undefined,
            after: {
              planKey: plan.key,
              onboardingChargedCents: onboardingDue,
              retainerAction: retainer.action,
            },
            requestId: req.id,
            ipAddress: clientIp(req),
            userAgent: userAgent(req),
          });

          const { lines } = activationCharges({
            toPlan: plan,
            onboardingAlreadyPaidCents: onboardingPaid,
            retainerHeldCents: held,
          });

          const subscription = await tx.one(
            `select ${SUB_SELECT} from ocs.subscriptions s where s.id = $1`,
            [subscriptionId],
          );

          return {
            subscription,
            charges: lines,
            retainer,
            pendingApproval: retainer.action === 'needs_approval'
              ? {
                  releaseCents: retainer.releaseCents,
                  message:
                    'The retainer for the new plan is lower. Nothing has been released: ' +
                    'money held against risk we may still be carrying needs a person to sign it off.',
                }
              : null,
          };
        },
        { reason: 'change_subscription' },
      );

      reply.code(201);
      return result;
    },
  );

  /** The retainer ledger for a contractor. Every movement, with its reason. */
  app.get(
    '/api/billing/retainer',
    { preHandler: [requireApiAuth, requireCapability('billing:read')] },
    async (req) => {
      const q = parse(z.object({ clientId: z.string().uuid().optional() }), req.query, 'query');

      return scoped(
        req,
        async (tx, companyId) => {
          const entries = await tx.many(
            `select r.id, r.movement::text as movement, r.amount_cents as "amountCents",
                    r.reason, r.approved_by as "approvedBy", u.name as "approvedByName",
                    r.actor_user_id as "actorUserId", r.created_at as "createdAt"
               from ocs.retainer_ledger r
               left join ocs.app_users u on u.id = r.approved_by
              where ($1::uuid is null or r.company_id = $1::uuid)
              order by r.id desc
              limit 500`,
            [companyId],
          );

          const balance = companyId
            ? (await tx.one<{ balance: number }>(
                `select ocs.retainer_balance_cents($1) as balance`, [companyId],
              ))?.balance ?? 0
            : entries.reduce((s, e) => s + ((e as { amountCents: number }).amountCents ?? 0), 0);

          return {
            entries,
            balanceCents: balance,
            balance: formatCents(balance),
            note: 'Held on account. Not revenue, and not a service fee.',
          };
        },
        q.clientId ?? null,
      );
    },
  );

  /**
   * Approve a retainer release.
   *
   * The reason this is a separate, deliberate act rather than a consequence of
   * downgrading: releasing funds held against liability that may still be open
   * is a judgement about the contractor's live jobs, and no arithmetic can make
   * it for you.
   */
  app.post(
    '/api/billing/retainer/release',
    { preHandler: [requireApiAuth, requireCapability('billing:manage')] },
    async (req, reply) => {
      const auth = req.apiAuth!;
      if (auth.role !== 'ADMIN') {
        throw forbidden('Only an administrator can release a compliance retainer');
      }

      const body = parse(
        z.object({
          clientId: z.string().uuid(),
          amountCents: z.number().int().positive(),
          reason: z.string().trim().min(1).max(500),
        }),
        req.body,
        'release',
      );

      const result = await withServiceContext(
        async (tx) => {
          const held = (await tx.one<{ balance: number }>(
            `select ocs.retainer_balance_cents($1) as balance`, [body.clientId],
          ))?.balance ?? 0;

          if (body.amountCents > held) {
            throw badRequest(
              `Only ${formatCents(held)} is held for this contractor; ` +
                `${formatCents(body.amountCents)} cannot be released.`,
            );
          }

          const sub = await tx.one<{ id: string }>(
            `select id from ocs.subscriptions
              where company_id = $1 and status in ('pending','active','past_due','paused')
              order by created_at desc limit 1`,
            [body.clientId],
          );

          await tx.query(
            `insert into ocs.retainer_ledger
               (company_id, subscription_id, movement, amount_cents, reason,
                approved_by, actor_user_id)
             values ($1, $2, 'release', $3, $4, $5, $5)`,
            [body.clientId, sub?.id ?? null, -body.amountCents, body.reason, auth.userId],
          );

          // Any pending change that was waiting on this is now settled.
          await tx.query(
            `update ocs.subscription_changes
                set approved_by = $2, approved_at = now()
              where company_id = $1 and requires_approval and approved_at is null`,
            [body.clientId, auth.userId],
          );

          await writeAudit(tx, {
            companyId: body.clientId,
            actorUserId: auth.userId,
            actorEmail: auth.email,
            action: 'billing.retainer_released',
            entityType: 'retainer',
            entityId: body.clientId,
            summary: `Released ${formatCents(body.amountCents)} of compliance retainer`,
            after: { amountCents: body.amountCents, reason: body.reason },
            requestId: req.id,
            ipAddress: clientIp(req),
          });

          const after = (await tx.one<{ balance: number }>(
            `select ocs.retainer_balance_cents($1) as balance`, [body.clientId],
          ))?.balance ?? 0;

          return {
            released: body.amountCents,
            balanceCents: after,
            balance: formatCents(after),
          };
        },
        { reason: 'release_retainer' },
      );

      reply.code(201);
      return result;
    },
  );

  /** Plan changes awaiting a decision. */
  app.get(
    '/api/billing/pending-approvals',
    { preHandler: [requireApiAuth, requireCapability('billing:manage')] },
    async () =>
      withServiceContext(
        async (tx) => {
          const pending = await tx.many(
            `select c.id, c.company_id as "clientId", co.name as "clientName",
                    c.from_plan_key as "fromPlanKey", c.to_plan_key as "toPlanKey",
                    c.retainer_delta_cents as "retainerDeltaCents",
                    c.note, c.created_at as "createdAt"
               from ocs.subscription_changes c
               join ocs.companies co on co.id = c.company_id
              where c.requires_approval and c.approved_at is null
              order by c.created_at`,
          );
          return { pending, total: pending.length };
        },
        { reason: 'list_pending_billing_approvals' },
      ),
  );
}

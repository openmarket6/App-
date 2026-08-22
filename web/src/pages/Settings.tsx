import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_COMPLIANCE_POLICY,
  COMPLIANCE_LABELS,
  EXPIRING_SOON_DAYS,
  TRADES,
  can,
  formatCents,
  type SubscriptionPlan,
  type Trade,
  type TradeRate,
} from '@flph/shared';
import { api, get } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { fmtDateTime } from '../lib/format.ts';
import type { PlanListResponse, RateBookResponse } from '../lib/api-shapes.ts';
import ErrorState from '../components/ErrorState.tsx';
import { LoadingPanel } from '../components/Spinner.tsx';

/** PUT is not in the api.ts helper set; this is that call with the method set. */
const put = <T,>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body });

/**
 * Firm settings.
 *
 * The Integrations tab has one rule that is not negotiable: it shows whether a
 * secret is set, never what it is. There is no reveal control and no masked
 * value to copy — a settings screen that can print a live API key is a
 * settings screen that will eventually print one into a screenshot, a support
 * ticket or a screen share.
 */

type Tab = 'firm' | 'rates' | 'plans' | 'compliance' | 'integrations';

const TAB_LABELS: Record<Tab, string> = {
  firm: 'Firm details',
  rates: 'Trade rate book',
  plans: 'Subscription plans',
  compliance: 'Compliance policy',
  integrations: 'Integrations',
};

const TABS: Tab[] = ['firm', 'rates', 'plans', 'compliance', 'integrations'];

export default function Settings() {
  const [params, setParams] = useSearchParams();
  const raw = String(params.get('tab') ?? 'firm');
  const tab: Tab = TABS.includes(raw as Tab) ? (raw as Tab) : 'firm';

  function setTab(next: Tab) {
    const p = new URLSearchParams(params);
    p.set('tab', next);
    setParams(p, { replace: true });
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-ink-soft max-w-3xl leading-relaxed">
          What the firm charges, what it requires on file, and what it is connected to. Price changes are never
          retroactive — an invoice keeps the numbers it was built with.
        </p>
      </div>

      <div className="border-b border-line">
        <nav className="flex gap-1 overflow-x-auto" aria-label="Settings sections">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-3.5 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors ${
                tab === t ? 'border-brand text-brand' : 'border-transparent text-ink-soft hover:text-ink'
              }`}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </nav>
      </div>

      {tab === 'firm' && <FirmTab />}
      {tab === 'rates' && <RatesTab />}
      {tab === 'plans' && <PlansTab />}
      {tab === 'compliance' && <CompliancePolicyTab />}
      {tab === 'integrations' && <IntegrationsTab />}
    </div>
  );
}

// --------------------------------------------------------------------------
// Firm
// --------------------------------------------------------------------------

interface HealthResponse {
  ok: boolean;
  driver: string;
  brand: string;
  time: string;
}

function FirmTab() {
  const q = useQuery({
    queryKey: ['health'],
    queryFn: () => get<HealthResponse>('/health'),
    staleTime: 60_000,
  });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div className="card card-pad">
        <h2 className="text-sm font-semibold">Firm</h2>
        <dl className="mt-3 space-y-3">
          <div>
            <dt className="label">Trading name</dt>
            <dd className="mt-0.5 text-sm">1 Contractor Solutions</dd>
          </div>
          <div>
            <dt className="label">Legal entity</dt>
            <dd className="mt-0.5 text-sm"></dd>
          </div>
          <div>
            <dt className="label">Mark</dt>
            <dd className="mt-1">
              <img src="/brand/1cs-mark.png" alt="1CS" className="h-9 w-auto" />
            </dd>
          </div>
          <div>
            <dt className="label">Brand name reported by the API</dt>
            <dd className="mt-0.5 text-sm">
              {q.isLoading ? <span className="text-ink-mute">Checking…</span> : (q.data?.brand ?? <span className="text-ink-mute">Unavailable</span>)}
            </dd>
          </div>
        </dl>
        <p className="mt-4 text-[12px] text-ink-soft leading-snug">
          Firm identity comes from the deployment's environment (<span className="font-mono">BRAND_NAME</span>,{' '}
          <span className="font-mono">BRAND_ORG</span>) and is what gets rendered into signable agreements. There is no
          endpoint to change it from this screen yet, so it is shown rather than pretended to be editable.
        </p>
      </div>

      <div className="card card-pad">
        <h2 className="text-sm font-semibold">Deployment</h2>
        {q.isLoading && <LoadingPanel label="Checking the API…" rows={2} />}
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} compact title="Could not reach the API" />}
        {q.data && (
          <dl className="mt-3 space-y-3">
            <div>
              <dt className="label">Store driver</dt>
              <dd className="mt-0.5 text-sm font-mono">{q.data.driver}</dd>
              <dd className="mt-0.5 text-[12px] text-ink-soft leading-snug">
                {q.data.driver === 'memory'
                  ? 'In-memory. Everything is lost when the function cold-starts — correct for local work, never for production.'
                  : q.data.driver === 'blobs'
                    ? 'Netlify Blobs. Durable across deploys.'
                    : 'Postgres via Prisma.'}
              </dd>
            </div>
            <div>
              <dt className="label">Server time</dt>
              <dd className="mt-0.5 text-sm tabular-nums">{fmtDateTime(q.data.time)}</dd>
              <dd className="mt-0.5 text-[12px] text-ink-soft leading-snug">
                This clock is what stamps supervision records and notarization retention dates.
              </dd>
            </div>
          </dl>
        )}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Trade rate book
// --------------------------------------------------------------------------

function RatesTab() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const canManage = !!user && can(user.role, 'billing:manage');

  const q = useQuery({
    queryKey: ['rates'],
    queryFn: () => get<RateBookResponse>('/billing/rates'),
  });

  const [draft, setDraft] = useState<TradeRate[] | null>(null);

  useEffect(() => {
    if (q.data?.rates) setDraft(q.data.rates);
  }, [q.data]);

  const save = useMutation({
    mutationFn: (rates: TradeRate[]) => put<RateBookResponse>('/billing/rates', { rates }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['rates'] }),
  });

  if (q.isLoading) return <LoadingPanel label="Loading the rate book…" rows={5} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load the rate book" />;

  const rows = draft ?? [];
  const byTrade = new Map(rows.map((r) => [r.trade, r]));
  const complete: TradeRate[] = TRADES.map(
    (t) =>
      byTrade.get(t) ?? { trade: t, feeCents: 0, manualSurchargeCents: 0, resubmittalCents: 0, active: false },
  );

  function edit(trade: Trade, patchRow: Partial<TradeRate>) {
    setDraft(complete.map((r) => (r.trade === trade ? { ...r, ...patchRow } : r)));
  }

  const dirty = JSON.stringify(complete) !== JSON.stringify(q.data?.rates ?? []);

  return (
    <div className="space-y-3">
      <div className="card card-pad">
        <h2 className="text-sm font-semibold">What we charge, per trade</h2>
        <p className="mt-1 text-[13px] text-ink-soft leading-relaxed max-w-3xl">
          Our fee only. Agency fees are pass-through and never appear here — they are billed at cost on the invoice, in
          their own subtotal. The manual surcharge exists because a paper-only county genuinely costs a coordinator a
          morning at a counter, and the resubmittal fee applies from the second correction cycle onwards.
        </p>
        {!canManage && (
          <p className="mt-2 text-[12px] text-ink-mute">Your role can read these but not change them.</p>
        )}
        {q.data?.updatedAt && (
          <p className="mt-2 text-[12px] text-ink-mute">Last changed {fmtDateTime(q.data.updatedAt)}.</p>
        )}
      </div>

      {save.isError && <ErrorState error={save.error} compact title="Could not save the rate book" />}

      <div className="card overflow-hidden">
        <table className="w-full border-collapse">
          <thead className="bg-page">
            <tr>
              <th className="th">Trade</th>
              <th className="th text-right">Our fee</th>
              <th className="th text-right">Manual surcharge</th>
              <th className="th text-right">Resubmittal</th>
              <th className="th text-center">Active</th>
            </tr>
          </thead>
          <tbody>
            {complete.map((r) => (
              <tr key={r.trade} className={r.active ? '' : 'opacity-60'}>
                <td className="td font-medium">{r.trade.charAt(0) + r.trade.slice(1).toLowerCase()}</td>
                <MoneyCell value={r.feeCents} disabled={!canManage} onChange={(v) => edit(r.trade, { feeCents: v })} />
                <MoneyCell
                  value={r.manualSurchargeCents}
                  disabled={!canManage}
                  onChange={(v) => edit(r.trade, { manualSurchargeCents: v })}
                />
                <MoneyCell
                  value={r.resubmittalCents}
                  disabled={!canManage}
                  onChange={(v) => edit(r.trade, { resubmittalCents: v })}
                />
                <td className="td text-center">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-line text-brand focus:ring-brand/30"
                    checked={r.active}
                    disabled={!canManage}
                    onChange={(e) => edit(r.trade, { active: e.target.checked })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {canManage && (
          <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
            <span className="text-[12px] text-ink-soft">
              Changing a rate is not retroactive — invoices keep the numbers they were built with.
            </span>
            <div className="flex gap-2">
              <button type="button" className="btn-ghost" disabled={!dirty} onClick={() => setDraft(q.data?.rates ?? [])}>
                Discard
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={!dirty || save.isPending}
                onClick={() => save.mutate(complete)}
              >
                {save.isPending ? 'Saving…' : 'Save the rate book'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MoneyCell({
  value,
  disabled,
  onChange,
}: {
  value: number;
  disabled: boolean;
  onChange: (cents: number) => void;
}) {
  return (
    <td className="td text-right">
      {disabled ? (
        <span className="tabular-nums">{formatCents(value)}</span>
      ) : (
        <input
          className="input py-1 text-right tabular-nums w-28 ml-auto"
          inputMode="decimal"
          value={(value / 100).toFixed(2)}
          onChange={(e) => {
            const n = Number(e.target.value.replace(/[^0-9.]/g, ''));
            onChange(Number.isFinite(n) ? Math.round(n * 100) : 0);
          }}
        />
      )}
    </td>
  );
}

// --------------------------------------------------------------------------
// Plans
// --------------------------------------------------------------------------

function PlansTab() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const canManage = !!user && can(user.role, 'billing:manage');

  const q = useQuery({
    queryKey: ['plans'],
    queryFn: () => get<PlanListResponse>('/billing/plans'),
  });

  const [draft, setDraft] = useState<SubscriptionPlan[] | null>(null);
  useEffect(() => {
    if (q.data?.plans) setDraft(q.data.plans);
  }, [q.data]);

  const save = useMutation({
    mutationFn: (plans: SubscriptionPlan[]) =>
      put<PlanListResponse>('/billing/plans', {
        plans: plans.map((p) => ({
          id: p.id,
          name: p.name,
          monthlyCents: p.monthlyCents,
          includedPermitsPerMonth: p.includedPermitsPerMonth,
          overagePerPermitCents: p.overagePerPermitCents,
          includedSiteVisitsPerPermit: p.includedSiteVisitsPerPermit,
          overagePerSiteVisitCents: p.overagePerSiteVisitCents,
          stripePriceId: p.stripePriceId,
          active: p.active,
        })),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['plans'] }),
  });

  if (q.isLoading) return <LoadingPanel label="Loading plans…" rows={4} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load plans" />;

  const plans = draft ?? [];
  const dirty = JSON.stringify(plans) !== JSON.stringify(q.data?.plans ?? []);

  function edit(id: string, patchPlan: Partial<SubscriptionPlan>) {
    setDraft(plans.map((p) => (p.id === id ? { ...p, ...patchPlan } : p)));
  }

  return (
    <div className="space-y-3">
      <div className="card card-pad">
        <h2 className="text-sm font-semibold">Managed-licence subscriptions</h2>
        <p className="mt-1 text-[13px] text-ink-soft leading-relaxed max-w-3xl">
          Supervision is the product on this line, so site visits are metered alongside permits. A plan somebody is
          subscribed to cannot be removed — deactivate it instead, or the subscription points at nothing and the next
          invoice has no price to read.
        </p>
      </div>

      {save.isError && <ErrorState error={save.error} compact title="Could not save the plans" />}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {plans.map((p) => (
          <div key={p.id} className={`card card-pad ${p.active ? '' : 'opacity-60'}`}>
            {canManage ? (
              <input
                className="input font-semibold"
                value={p.name}
                onChange={(e) => edit(p.id, { name: e.target.value })}
              />
            ) : (
              <h3 className="text-sm font-semibold">{p.name}</h3>
            )}

            <div className="mt-3 space-y-2.5">
              <PlanField
                label="Monthly"
                cents={p.monthlyCents}
                editable={canManage}
                onChange={(v) => edit(p.id, { monthlyCents: v })}
              />
              <PlanNumber
                label="Permits included per month"
                value={p.includedPermitsPerMonth}
                editable={canManage}
                onChange={(v) => edit(p.id, { includedPermitsPerMonth: v })}
              />
              <PlanField
                label="Overage per permit"
                cents={p.overagePerPermitCents}
                editable={canManage}
                onChange={(v) => edit(p.id, { overagePerPermitCents: v })}
              />
              <PlanNumber
                label="Site visits included per permit"
                value={p.includedSiteVisitsPerPermit}
                editable={canManage}
                onChange={(v) => edit(p.id, { includedSiteVisitsPerPermit: v })}
              />
              <PlanField
                label="Overage per site visit"
                cents={p.overagePerSiteVisitCents}
                editable={canManage}
                onChange={(v) => edit(p.id, { overagePerSiteVisitCents: v })}
              />
            </div>

            <div className="mt-3 border-t border-line pt-3">
              <div className="label">Stripe price</div>
              <div className="mt-0.5 text-[12px] font-mono break-all">
                {p.stripePriceId ?? <span className="text-ink-mute font-sans">Not linked — the plan is a draft until it is</span>}
              </div>
            </div>

            {canManage && (
              <label className="mt-3 flex items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-line text-brand focus:ring-brand/30"
                  checked={p.active}
                  onChange={(e) => edit(p.id, { active: e.target.checked })}
                />
                Active and sellable
              </label>
            )}
          </div>
        ))}
      </div>

      {canManage && (
        <div className="card card-pad flex items-center justify-between gap-3">
          <span className="text-[12px] text-ink-soft">Saving replaces the plan book wholesale.</span>
          <div className="flex gap-2">
            <button type="button" className="btn-ghost" disabled={!dirty} onClick={() => setDraft(q.data?.plans ?? [])}>
              Discard
            </button>
            <button type="button" className="btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate(plans)}>
              {save.isPending ? 'Saving…' : 'Save plans'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PlanField({
  label,
  cents,
  editable,
  onChange,
}: {
  label: string;
  cents: number;
  editable: boolean;
  onChange: (cents: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="text-[12px] text-ink-soft">{label}</span>
      {editable ? (
        <input
          className="input py-1 w-28 text-right tabular-nums"
          inputMode="decimal"
          value={(cents / 100).toFixed(2)}
          onChange={(e) => {
            const n = Number(e.target.value.replace(/[^0-9.]/g, ''));
            onChange(Number.isFinite(n) ? Math.round(n * 100) : 0);
          }}
        />
      ) : (
        <span className="text-[13px] font-medium tabular-nums">{formatCents(cents)}</span>
      )}
    </label>
  );
}

function PlanNumber({
  label,
  value,
  editable,
  onChange,
}: {
  label: string;
  value: number;
  editable: boolean;
  onChange: (n: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="text-[12px] text-ink-soft">{label}</span>
      {editable ? (
        <input
          className="input py-1 w-28 text-right tabular-nums"
          inputMode="numeric"
          value={value}
          onChange={(e) => onChange(Math.max(0, Math.round(Number(e.target.value.replace(/[^0-9]/g, '')) || 0)))}
        />
      ) : (
        <span className="text-[13px] font-medium tabular-nums">{value}</span>
      )}
    </label>
  );
}

// --------------------------------------------------------------------------
// Compliance policy
// --------------------------------------------------------------------------

function CompliancePolicyTab() {
  return (
    <div className="space-y-3">
      <div className="card card-pad">
        <h2 className="text-sm font-semibold">What we require on file before a contractor may file</h2>
        <p className="mt-1 text-[13px] text-ink-soft leading-relaxed max-w-3xl">
          This is the policy the permit gate reads. An item marked “blocks filing” means exactly that: while it is
          missing, expired or rejected, permit creation for that contractor is refused. Items warn rather than block
          when the exposure is real but not immediate.
        </p>
        <p className="mt-2 text-[13px] text-ink-soft leading-relaxed max-w-3xl">
          The limits below are a starting point drawn from what Florida jurisdictions and most general contractors ask
          for — not a legal minimum. Confirm them against your own carrier and counsel. Anything inside{' '}
          <span className="font-medium">{EXPIRING_SOON_DAYS} days</span> of expiry is flagged as expiring soon.
        </p>
        <p className="mt-2 text-[12px] text-ink-mute leading-snug">
          This deployment serves the firm default policy and has no endpoint to override it yet, so it is shown
          read-only rather than as a form that silently discards what you type.
        </p>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full border-collapse">
          <thead className="bg-page">
            <tr>
              <th className="th">Item</th>
              <th className="th">Requirement</th>
              <th className="th text-right">Minimum per occurrence</th>
              <th className="th">Note</th>
            </tr>
          </thead>
          <tbody>
            {DEFAULT_COMPLIANCE_POLICY.map((spec) => (
              <tr key={spec.kind}>
                <td className="td font-medium">{COMPLIANCE_LABELS[spec.kind]}</td>
                <td className="td">
                  {spec.required ? (
                    spec.blocksFiling ? (
                      <span className="badge-red">Required — blocks filing</span>
                    ) : (
                      <span className="badge-amber">Required — warns</span>
                    )
                  ) : (
                    <span className="badge-gray">Optional</span>
                  )}
                </td>
                <td className="td text-right tabular-nums">
                  {spec.minLimitPerOccurrenceCents != null ? formatCents(spec.minLimitPerOccurrenceCents) : '—'}
                </td>
                <td className="td text-[12px] text-ink-soft leading-snug max-w-md">{spec.note ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="border-t border-line px-4 py-2.5 text-[12px] text-ink-soft">
          A workers' comp exemption certificate on file satisfies the workers' comp requirement for qualifying officers.
          Optional items still count toward the completeness meter at half weight.
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Integrations
// --------------------------------------------------------------------------

interface ConnectorEntry {
  name: string;
  what: string;
  /** Env var names only. Never a value. */
  secrets: string[];
  activation: string;
}

const CONNECTORS: ConnectorEntry[] = [
  {
    name: 'Stripe',
    what: 'Card and ACH payments, and the hosted element contractors enter card details into. Card numbers never reach this server.',
    secrets: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
    activation:
      'Create a restricted key in the Stripe dashboard, set STRIPE_SECRET_KEY on the deployment, then add a webhook endpoint pointing at /api/billing/webhook and set STRIPE_WEBHOOK_SECRET to its signing secret. Card payments stay unavailable, and say so honestly on the onboarding screen, until the first of those is set.',
  },
  {
    name: 'QuickBooks Online',
    what: 'The accounting system of record. Invoices raised here are pushed so the books match; Stripe moves the money, this does not.',
    secrets: ['QUICKBOOKS_CLIENT_ID', 'QUICKBOOKS_CLIENT_SECRET', 'QUICKBOOKS_REDIRECT_URI'],
    activation:
      'Intuit offers no machine-to-machine grant, so a human has to click through consent once per company file. Set the three variables, then open the connect URL as an administrator, sign in, and pick the company. The realm id that comes back is the company file identifier and is stored with the tokens.',
  },
  {
    name: 'Accela',
    what: 'Live permit API for Accela jurisdictions. Reads record status, inspections and fees.',
    secrets: ['ACCELA_APP_ID', 'ACCELA_APP_SECRET'],
    activation:
      'Register the application on the Accela developer portal, then have each agency approve it for their environment. Set the app id and secret, and move the jurisdiction to the api_live tier only after a live record has actually been read.',
  },
  {
    name: 'OpenGov (PLCE)',
    what: 'Live permit API for OpenGov jurisdictions.',
    secrets: ['OPENGOV_CLIENT_ID', 'OPENGOV_CLIENT_SECRET'],
    activation:
      'Request API credentials from OpenGov for the specific agency, set the client id and secret, and confirm the base URL matches the agency’s region before promoting the tier.',
  },
  {
    name: 'Credential vault',
    what: 'AES-256-GCM encryption for stored portal logins and OAuth tokens. Nothing sensitive is stored in plain text.',
    secrets: ['VAULT_KEY'],
    activation:
      'Generate a 32-byte key (hex or base64) and set VAULT_KEY on the deployment. Rotating it invalidates every stored credential, so plan a re-entry pass. In production the app refuses to fall back to a development key.',
  },
  {
    name: 'Portal automation (RPA)',
    what: 'Read-only portal automation for jurisdictions with no API. Never used unless a human has read that portal’s terms of service.',
    secrets: [],
    activation:
      'Per jurisdiction: read the portal terms, then set automationApproved on the jurisdiction record and store a firm-owned login in the credential vault. Tier alone does not enable it — the approval flag is what does.',
  },
  {
    name: 'Object storage',
    what: 'Where uploaded plan sets, certificates and job photos actually live. Metadata stays in the store; bytes go here.',
    secrets: [],
    activation:
      'Driven by the store driver shown on the Firm details tab. On Netlify this is Blobs and needs no configuration; locally it is in memory and does not survive a restart.',
  },
];

function IntegrationsTab() {
  // If a status endpoint ever lands, this picks it up. Until then the tab is
  // honest about not knowing rather than guessing "connected".
  const statusQ = useQuery({
    queryKey: ['connectorStatus'],
    queryFn: () => get<{ connectors: Array<{ name: string; configured: boolean }> }>('/integrations/connectors'),
    retry: false,
  });

  const statusByName = new Map((statusQ.data?.connectors ?? []).map((c) => [c.name.toLowerCase(), c.configured]));
  const reported = statusQ.isSuccess && (statusQ.data?.connectors?.length ?? 0) > 0;

  return (
    <div className="space-y-3">
      <div className="card card-pad">
        <h2 className="text-sm font-semibold">Connectors</h2>
        <p className="mt-1 text-[13px] text-ink-soft leading-relaxed max-w-3xl">
          Each of these needs a manual step somewhere else — a key generated in a dashboard, an agency approving an
          application, a human clicking through a consent screen. The step is written out below so nobody has to
          reverse-engineer it from a failing request.
        </p>
        <p className="mt-2 text-[13px] font-medium">
          No secret value is ever shown on this screen — only the names of the variables and whether something is set.
        </p>
        {!reported && (
          <p className="mt-2 text-[12px] text-ink-mute leading-snug">
            This deployment does not expose a connector status endpoint, so the state below reads “not reported”. Check
            the variables on the host rather than assuming either answer.
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {CONNECTORS.map((c) => {
          const configured = statusByName.get(c.name.toLowerCase());
          return (
            <div key={c.name} className="card card-pad">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold">{c.name}</h3>
                  <p className="mt-1 text-[12px] text-ink-soft leading-snug">{c.what}</p>
                </div>
                <span
                  className={
                    configured === true ? 'badge-green shrink-0' : configured === false ? 'badge-gray shrink-0' : 'badge-gray shrink-0'
                  }
                >
                  {configured === true ? 'Configured' : configured === false ? 'Not configured' : 'Not reported'}
                </span>
              </div>

              {c.secrets.length > 0 && (
                <div className="mt-3">
                  <div className="label">Variables it reads</div>
                  <ul className="mt-1 flex flex-wrap gap-1.5">
                    {c.secrets.map((s) => (
                      <li key={s} className="rounded bg-page px-1.5 py-0.5 font-mono text-[11px] text-ink-soft">
                        {s}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="mt-3 border-t border-line pt-3">
                <div className="label">How it is activated</div>
                <p className="mt-1 text-[12px] text-ink-soft leading-relaxed">{c.activation}</p>
              </div>
            </div>
          );
        })}
      </div>

      <div className="card card-pad">
        <h2 className="text-sm font-semibold">Jurisdiction coverage</h2>
        <p className="mt-1 text-[13px] text-ink-soft leading-relaxed max-w-3xl">
          Which of the 119 Florida jurisdictions we can reach by API, by portal automation, and which are still paper —
          plus what each one is blocked on — lives on its own screen.
        </p>
        <Link to="/connectors" className="btn-ghost mt-3">
          Open portal connectors
        </Link>
      </div>
    </div>
  );
}

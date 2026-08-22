import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  COMPLIANCE_KINDS,
  COMPLIANCE_LABELS,
  DEFAULT_COMPLIANCE_POLICY,
  DOCUMENT_CATEGORIES,
  SERVICE_LINE_LABELS,
  can,
  formatCents,
  type Client,
  type ComplianceKind,
  type ComplianceStatus,
  type DocumentCategory,
  type PermitDocument,
  type SiteVisit,
} from '@flph/shared';
import { get, patch, post } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { daysAgo, fmtDate, fmtDateTime, humanEnum } from '../lib/format.ts';
import { fmtBytes, readFileAsUpload } from '../lib/upload.ts';
import type {
  ComplianceListResponse,
  ComplianceRow,
  DocumentListResponse,
  DocumentUploadResponse,
  InvoiceListResponse,
  SignatureListResponse,
  SignatureRequestRow,
  SiteVisitListResponse,
  SubscriptionResponse,
} from '../lib/api-shapes.ts';
import type { PermitListResponse, PermitRow } from '../lib/types.ts';
import ComplianceBadge, { complianceRowClass, expiryPhrase } from '../components/ComplianceBadge.tsx';
import DocumentLink from '../components/DocumentLink.tsx';
import DataTable, { type Column } from '../components/DataTable.tsx';
import Drawer from '../components/Drawer.tsx';
import EmptyState from '../components/EmptyState.tsx';
import ErrorState from '../components/ErrorState.tsx';
import Meter from '../components/Meter.tsx';
import RiskBadge from '../components/RiskBadge.tsx';
import Spinner, { LoadingPanel } from '../components/Spinner.tsx';
import StageBadge from '../components/StageBadge.tsx';

/**
 * One contractor, everything about them.
 *
 * The compliance tab is the centre of gravity. `assessCompliance` runs on the
 * server and its verdict arrives with the item list, so the banner at the top
 * of that tab is the same answer the permit-creation gate will give — spelled
 * out gap by gap rather than reduced to a red dot, because "not cleared to
 * file" is only actionable if you can see which certificate is the problem.
 */

type Tab = 'overview' | 'compliance' | 'documents' | 'agreements' | 'permits' | 'invoices' | 'supervision';

const TAB_LABELS: Record<Tab, string> = {
  overview: 'Overview',
  compliance: 'Compliance',
  documents: 'Documents',
  agreements: 'Agreements',
  permits: 'Permits',
  invoices: 'Invoices',
  supervision: 'Supervision',
};

const ONBOARDING_LABELS: Record<Client['onboardingStatus'], string> = {
  INVITED: 'Invited',
  IN_PROGRESS: 'Onboarding in progress',
  PENDING_REVIEW: 'Pending review',
  ACTIVE: 'Active',
  SUSPENDED: 'Suspended',
};

const SIGNING_CLASS: Record<SignatureRequestRow['status'], string> = {
  DRAFT: 'badge-gray',
  SENT: 'badge-blue',
  VIEWED: 'badge-blue',
  SIGNED: 'badge-green',
  DECLINED: 'badge-red',
  VOIDED: 'badge-gray',
  EXPIRED: 'badge-red',
};

export default function ContractorDetail() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const tabParam = String(params.get('tab') ?? 'overview');
  const clientQ = useQuery({
    queryKey: ['client', id],
    queryFn: () => get<Client>(`/clients/${id}`),
    enabled: !!id,
  });

  const client = clientQ.data ?? null;
  const managed = client?.serviceLine === 'MANAGED_LICENSE';

  const tabs: Tab[] = useMemo(() => {
    const base: Tab[] = ['overview', 'compliance', 'documents', 'agreements', 'permits', 'invoices'];
    return managed ? [...base, 'supervision'] : base;
  }, [managed]);

  const tab: Tab = tabs.includes(tabParam as Tab) ? (tabParam as Tab) : 'overview';

  function setTab(next: Tab) {
    const p = new URLSearchParams(params);
    p.set('tab', next);
    setParams(p, { replace: true });
  }

  if (clientQ.isLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Contractor</h1>
        <LoadingPanel label="Loading contractor…" rows={4} />
      </div>
    );
  }

  if (clientQ.isError) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Contractor</h1>
        <ErrorState error={clientQ.error} onRetry={() => void clientQ.refetch()} title="Could not load this contractor" />
      </div>
    );
  }

  if (!client) return null;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <button type="button" className="link text-[13px]" onClick={() => navigate('/clients')}>
            ← All contractors
          </button>
          <h1 className="mt-1 text-xl font-semibold">{client.name}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-ink-soft">
            <span className={managed ? 'badge-blue' : 'badge-gray'}>
              {managed ? 'Managed licence' : 'Expediting'}
            </span>
            <span className="badge-gray">{ONBOARDING_LABELS[client.onboardingStatus]}</span>
            {client.filingHold && <span className="badge-red">Filing hold</span>}
            {!client.active && <span className="badge-red">Deactivated</span>}
          </div>
        </div>
        <Link to={`/onboarding/${client.id}`} className="btn-ghost">
          Open onboarding checklist
        </Link>
      </div>

      {client.filingHold && (
        <div className="rounded-md border border-danger/20 bg-danger-soft px-4 py-3">
          <div className="text-sm font-semibold text-danger">New filings are blocked for this contractor</div>
          <div className="mt-1 text-sm text-ink-soft leading-relaxed">
            {client.filingHoldReason ?? 'No reason was recorded when the hold was placed.'}
          </div>
        </div>
      )}

      <div className="border-b border-line">
        <nav className="flex gap-1 overflow-x-auto" aria-label="Contractor sections">
          {tabs.map((t) => (
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

      {tab === 'overview' && <OverviewTab client={client} canSuspend={!!user && can(user.role, 'client:suspend')} />}
      {tab === 'compliance' && <ComplianceTab client={client} />}
      {tab === 'documents' && <DocumentsTab client={client} />}
      {tab === 'agreements' && <AgreementsTab client={client} />}
      {tab === 'permits' && <PermitsTab client={client} />}
      {tab === 'invoices' && <InvoicesTab client={client} />}
      {tab === 'supervision' && managed && <SupervisionTab client={client} />}
    </div>
  );
}

// --------------------------------------------------------------------------
// Overview
// --------------------------------------------------------------------------

function OverviewTab({ client, canSuspend }: { client: Client; canSuspend: boolean }) {
  /*
   * Singular, and one record rather than a list: a contractor has at most one
   * live subscription, which the endpoint enforces. Asking for a list and
   * taking [0] read as though there might be several, and pointed at an
   * address that does not exist.
   */
  const subsQ = useQuery({
    queryKey: ['subscription', client.id],
    queryFn: () => get<SubscriptionResponse>(`/billing/subscription?clientId=${client.id}`),
    enabled: client.serviceLine === 'MANAGED_LICENSE',
  });

  const subscription = subsQ.data?.subscription ?? null;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
      <div className="card card-pad xl:col-span-2 space-y-5">
        <section>
          <h2 className="text-sm font-semibold">Contact</h2>
          <dl className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
            <Detail label="Contact name" value={client.contactName} />
            <Detail
              label="Email"
              value={
                client.contactEmail ? (
                  <a className="link" href={`mailto:${client.contactEmail}`}>
                    {client.contactEmail}
                  </a>
                ) : null
              }
            />
            <Detail label="Phone" value={client.contactPhone} />
            <Detail
              label="Address"
              value={[client.addressLine1, client.city, client.state, client.zip].filter(Boolean).join(', ') || null}
            />
            <Detail label="Legal entity" value={client.legalName} />
            <Detail label="Federal EIN" value={client.federalEin} />
          </dl>
        </section>

        <section className="border-t border-line pt-4">
          <h2 className="text-sm font-semibold">Licence and service line</h2>
          <dl className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
            <Detail label="Service line" value={SERVICE_LINE_LABELS[client.serviceLine]} />
            <Detail label="Onboarding" value={ONBOARDING_LABELS[client.onboardingStatus]} />
            <Detail
              label="Licence number"
              value={
                client.licenseNumber ?? (
                  <span className="text-ink-soft">
                    {client.serviceLine === 'MANAGED_LICENSE'
                      ? 'None — our qualifier is the contractor of record'
                      : 'Not on file'}
                  </span>
                )
              }
            />
            <Detail label="Licence type" value={client.licenseType} />
            <Detail label="Licence expires" value={fmtDate(client.licenseExpiresAt)} />
            <Detail label="Onboarding completed" value={fmtDate(client.onboardingCompletedAt)} />
          </dl>
        </section>

        {client.serviceLine === 'MANAGED_LICENSE' && (
          <section className="border-t border-line pt-4">
            <h2 className="text-sm font-semibold">Subscription</h2>
            {subsQ.isLoading && <Spinner className="mt-3" label="Loading subscription…" />}
            {subsQ.isError && <ErrorState error={subsQ.error} compact title="Could not load the subscription" />}
            {!subsQ.isLoading && !subsQ.isError && !subscription && (
              <p className="mt-2 text-sm text-ink-soft leading-relaxed">
                No subscription on this account yet. A managed-licence contractor is billed monthly, so this is the row
                the recurring invoice reads from — add it under Settings → Subscription plans.
              </p>
            )}
            {subscription && (
              <dl className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
                <Detail label="Plan" value={subscription.plan?.name ?? 'Unknown plan'} />
                <Detail label="Status" value={humanEnum(subscription.status)} />
                <Detail
                  label="Monthly"
                  value={subscription.plan ? formatCents(subscription.plan.monthlyCents) : '—'}
                />
                <Detail
                  label="Current period"
                  value={`${fmtDate(subscription.currentPeriodStart)} – ${fmtDate(subscription.currentPeriodEnd)}`}
                />
                <Detail
                  label="Included per month"
                  value={
                    subscription.plan
                      ? `${subscription.plan.includedPermitsPerMonth} permits · ${subscription.plan.includedSiteVisitsPerPermit} site visits per permit`
                      : '—'
                  }
                />
                <Detail
                  label="Stripe subscription"
                  value={subscription.stripeSubscriptionId ?? <span className="text-ink-soft">Not linked</span>}
                />
              </dl>
            )}
          </section>
        )}
      </div>

      <div className="space-y-4">
        <FilingHoldCard client={client} canSuspend={canSuspend} />

        <div className="card card-pad">
          <h2 className="text-sm font-semibold">Connected systems</h2>
          <p className="mt-1 text-[12px] text-ink-soft leading-snug">
            Whether this contractor has been mirrored into the billing and accounting systems. No secret is shown here
            and none is stored on this record.
          </p>
          <ul className="mt-3 space-y-2.5">
            <IntegrationRow
              name="Stripe customer"
              value={client.stripeCustomerId}
              unset="Not created. Card-on-file and invoice payment stay unavailable until a Stripe customer exists."
            />
            <IntegrationRow
              name="QuickBooks customer"
              value={client.quickbooksCustomerId}
              unset="Not linked. Invoices raised here will not appear in the books until the customer is matched."
            />
          </ul>
        </div>
      </div>
    </div>
  );
}

function IntegrationRow({ name, value, unset }: { name: string; value: string | null; unset: string }) {
  return (
    <li className="flex items-start gap-3">
      <span className={value ? 'badge-green mt-0.5' : 'badge-gray mt-0.5'}>{value ? 'Linked' : 'Not linked'}</span>
      <div className="min-w-0">
        <div className="text-[13px] font-medium">{name}</div>
        <div className="text-[12px] text-ink-soft leading-snug break-all">{value ?? unset}</div>
      </div>
    </li>
  );
}

function FilingHoldCard({ client, canSuspend }: { client: Client; canSuspend: boolean }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');

  const mutate = useMutation({
    mutationFn: (body: { filingHold: boolean; filingHoldReason?: string | null }) =>
      patch<Client>(`/clients/${client.id}`, body),
    onSuccess: () => {
      setReason('');
      void qc.invalidateQueries({ queryKey: ['client', client.id] });
      void qc.invalidateQueries({ queryKey: ['clients'] });
    },
  });

  return (
    <div className={`card card-pad ${client.filingHold ? 'border-l-4 border-danger' : ''}`}>
      <h2 className="text-sm font-semibold">Filing hold</h2>
      <p className="mt-1 text-[12px] text-ink-soft leading-snug">
        A hold blocks every new permit under this contractor. The reason is what the coordinator who lifts it three
        weeks from now actually needs, so it is required.
      </p>

      {!canSuspend && (
        <p className="mt-3 text-[12px] text-ink-mute leading-snug">
          Your role cannot place or lift a filing hold. Ask an administrator.
        </p>
      )}

      {mutate.isError && <ErrorState error={mutate.error} compact title="Could not change the hold" />}

      {canSuspend && !client.filingHold && (
        <div className="mt-3 space-y-2">
          <label className="block">
            <span className="label">Reason</span>
            <textarea
              className="input mt-1 min-h-[72px]"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="General liability lapsed 14 Aug, renewal certificate not received."
            />
          </label>
          <button
            type="button"
            className="btn-danger w-full"
            disabled={!reason.trim() || mutate.isPending}
            onClick={() => mutate.mutate({ filingHold: true, filingHoldReason: reason.trim() })}
          >
            {mutate.isPending ? 'Placing hold…' : 'Place on filing hold'}
          </button>
        </div>
      )}

      {canSuspend && client.filingHold && (
        <div className="mt-3 space-y-2">
          <div className="rounded bg-danger-soft px-3 py-2 text-[13px] text-ink-soft leading-snug">
            {client.filingHoldReason ?? 'No reason recorded.'}
          </div>
          <button
            type="button"
            className="btn-ghost w-full"
            disabled={mutate.isPending}
            onClick={() => mutate.mutate({ filingHold: false })}
          >
            {mutate.isPending ? 'Lifting…' : 'Lift the hold'}
          </button>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// Compliance
// --------------------------------------------------------------------------

interface KindRow {
  kind: ComplianceKind;
  label: string;
  item: ComplianceRow | null;
  status: ComplianceStatus;
  required: boolean;
  blocksFiling: boolean;
  policyNote: string | null;
}

function ComplianceTab({ client }: { client: Client }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [uploadKind, setUploadKind] = useState<ComplianceKind | null>(null);
  const [reviewing, setReviewing] = useState<ComplianceRow | null>(null);

  const canUpload = !!user && (can(user.role, 'document:upload') || can(user.role, 'portal:upload_own'));
  const canReview = !!user && can(user.role, 'compliance:review');
  const canWaive = !!user && can(user.role, 'compliance:waive');

  const q = useQuery({
    queryKey: ['compliance', client.id],
    queryFn: () => get<ComplianceListResponse>(`/compliance?clientId=${client.id}`),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['compliance'] });
    void qc.invalidateQueries({ queryKey: ['clients'] });
  };

  const rows = useMemo<KindRow[]>(() => {
    const items = q.data?.items ?? [];
    const byKind = new Map<ComplianceKind, ComplianceRow>();
    for (const it of items) {
      const cur = byKind.get(it.kind);
      // Keep the copy that expires latest — renewals arrive alongside the old
      // certificate rather than replacing it.
      if (!cur || (Date.parse(it.expiresAt ?? '') || 0) > (Date.parse(cur.expiresAt ?? '') || 0)) byKind.set(it.kind, it);
    }

    const policyByKind = new Map(DEFAULT_COMPLIANCE_POLICY.map((p) => [p.kind, p]));
    const ordered: ComplianceKind[] = [
      ...DEFAULT_COMPLIANCE_POLICY.map((p) => p.kind),
      ...COMPLIANCE_KINDS.filter((k) => !policyByKind.has(k)),
    ];

    return ordered.map((kind) => {
      const item = byKind.get(kind) ?? null;
      const spec = policyByKind.get(kind);
      return {
        kind,
        label: COMPLIANCE_LABELS[kind],
        item,
        status: item?.effectiveStatus ?? 'MISSING',
        required: spec?.required ?? false,
        blocksFiling: spec?.blocksFiling ?? false,
        policyNote: spec?.note ?? null,
      };
    });
  }, [q.data]);

  const verdict = q.data?.verdict ?? null;

  const columns: Array<Column<KindRow>> = [
    {
      key: 'kind',
      header: 'Item',
      sortValue: (r) => r.label,
      render: (r) => (
        <div className="min-w-[210px]">
          <div className="font-medium">{r.label}</div>
          <div className="text-[12px] text-ink-mute leading-snug">
            {r.required ? (r.blocksFiling ? 'Required — blocks filing' : 'Required — warns only') : 'Optional'}
          </div>
        </div>
      ),
    },
    {
      key: 'carrier',
      header: 'Carrier / issuer',
      sortValue: (r) => r.item?.carrier ?? '',
      render: (r) => <span className="text-[13px]">{r.item?.carrier ?? '—'}</span>,
    },
    {
      key: 'policy',
      header: 'Policy no.',
      sortValue: (r) => r.item?.policyNumber ?? '',
      render: (r) => <span className="font-mono text-[12px]">{r.item?.policyNumber ?? '—'}</span>,
    },
    {
      key: 'limits',
      header: 'Limits',
      align: 'right',
      sortValue: (r) => r.item?.limitPerOccurrenceCents ?? -1,
      render: (r) => {
        if (!r.item || (r.item.limitPerOccurrenceCents == null && r.item.limitAggregateCents == null)) {
          return <span className="text-ink-mute">—</span>;
        }
        return (
          <span className="tabular-nums text-[13px] whitespace-nowrap">
            {r.item.limitPerOccurrenceCents != null ? formatCents(r.item.limitPerOccurrenceCents) : '—'}
            <span className="text-ink-mute"> / </span>
            {r.item.limitAggregateCents != null ? formatCents(r.item.limitAggregateCents) : '—'}
          </span>
        );
      },
    },
    {
      key: 'dates',
      header: 'Effective / expires',
      sortValue: (r) => r.item?.expiresAt ?? '',
      render: (r) => (
        <div className="text-[13px] whitespace-nowrap">
          <div>{r.item ? fmtDate(r.item.effectiveDate) : '—'}</div>
          <div className="text-ink-soft">{r.item ? fmtDate(r.item.expiresAt) : '—'}</div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (r) => r.status,
      render: (r) => (
        <div className="min-w-[130px]">
          <ComplianceBadge status={r.status} />
          <div className="mt-1 text-[11px] text-ink-soft leading-snug">
            {r.item ? expiryPhrase(r.item.daysUntilExpiry) : 'Nothing on file'}
          </div>
          {r.item?.reviewNote && (
            <div className="mt-1 text-[11px] text-danger leading-snug">{r.item.reviewNote}</div>
          )}
          {r.item?.waivedReason && (
            <div className="mt-1 text-[11px] text-ink-soft leading-snug">Waived: {r.item.waivedReason}</div>
          )}
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (r) => (
        <div className="flex flex-wrap gap-1.5 min-w-[180px]">
          {canUpload && (
            <button type="button" className="btn-ghost px-2 py-1 text-[12px]" onClick={() => setUploadKind(r.kind)}>
              {r.item ? 'Replace' : 'Upload'}
            </button>
          )}
          {canReview && r.item && (
            <button type="button" className="btn-ghost px-2 py-1 text-[12px]" onClick={() => setReviewing(r.item)}>
              Review
            </button>
          )}
          {canWaive && r.item && r.item.status !== 'WAIVED' && (
            <WaiveButton item={r.item} onDone={invalidate} />
          )}
          {!canUpload && !canReview && !canWaive && <span className="text-[12px] text-ink-mute">Read only</span>}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {q.isLoading && <LoadingPanel label="Loading compliance…" rows={4} />}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load compliance" />}

      {verdict && (
        <div className={`card card-pad border-l-4 ${verdict.clearedToFile ? 'border-good' : 'border-danger'}`}>
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className={verdict.clearedToFile ? 'badge-green' : 'badge-red'}>
                  {verdict.clearedToFile ? 'Cleared to file' : 'Not cleared to file'}
                </span>
                {client.filingHold && <span className="badge-red">Filing hold also active</span>}
              </div>
              <p className="mt-2 text-sm text-ink-soft leading-relaxed max-w-2xl">
                {verdict.clearedToFile
                  ? 'Every blocking requirement is on file and current. New permits under this contractor will pass the compliance gate.'
                  : 'Permit creation will be refused until the blocking items below are resolved. This is the same check the filing gate runs.'}
              </p>
            </div>
            <div className="w-[220px] shrink-0">
              <Meter
                value={verdict.completeness}
                label="Completeness"
                tone={verdict.clearedToFile ? undefined : 'danger'}
              />
              <div className="mt-1.5 text-[12px] text-ink-soft leading-snug">
                {verdict.nextExpiry
                  ? `Next expiry: ${COMPLIANCE_LABELS[verdict.nextExpiry.kind]} in ${verdict.nextExpiry.days} days.`
                  : 'Nothing on file expires in the measurable future.'}
              </div>
            </div>
          </div>

          {verdict.gaps.length > 0 && (
            <ul className="mt-4 space-y-2 border-t border-line pt-3">
              {verdict.gaps.map((g) => (
                <li key={g.kind} className="flex items-start gap-2.5">
                  <span className={g.blocksFiling ? 'badge-red mt-0.5 shrink-0' : 'badge-amber mt-0.5 shrink-0'}>
                    {g.blocksFiling ? 'Blocking' : 'Warning'}
                  </span>
                  <div className="min-w-0 text-[13px] leading-snug">
                    <span className="font-medium">{g.label}</span>
                    <span className="text-ink-soft"> — {g.detail}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!q.isLoading && !q.isError && (
        <DataTable<KindRow>
          columns={columns}
          rows={rows}
          rowKey={(r) => r.kind}
          rowClassName={(r) => (r.required ? complianceRowClass(r.status) : '')}
          empty={<EmptyState title="No compliance policy configured" hint="Set the firm's compliance policy in Settings." />}
          footer="Rows follow the firm's compliance policy. Expired and missing required items are tinted red; anything inside thirty days of expiry is amber."
        />
      )}

      {uploadKind && (
        <ComplianceUploadDrawer
          client={client}
          kind={uploadKind}
          existing={rows.find((r) => r.kind === uploadKind)?.item ?? null}
          onClose={() => setUploadKind(null)}
          onDone={() => {
            setUploadKind(null);
            invalidate();
          }}
        />
      )}

      {reviewing && canReview && (
        <ReviewDrawer
          item={reviewing}
          onClose={() => setReviewing(null)}
          onDone={() => {
            setReviewing(null);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

function WaiveButton({ item, onDone }: { item: ComplianceRow; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');

  const waive = useMutation({
    mutationFn: () => post(`/compliance/${item.id}/waive`, { waivedReason: reason.trim() }),
    onSuccess: () => {
      setOpen(false);
      setReason('');
      onDone();
    },
  });

  return (
    <>
      <button type="button" className="btn-ghost px-2 py-1 text-[12px]" onClick={() => setOpen(true)}>
        Waive
      </button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={`Waive ${COMPLIANCE_LABELS[item.kind]}`}
        subtitle="A deliberate exception to the firm's own policy."
        width="480px"
        footer={
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-danger"
              disabled={!reason.trim() || waive.isPending}
              onClick={() => waive.mutate()}
            >
              {waive.isPending ? 'Waiving…' : 'Waive this requirement'}
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-ink-soft leading-relaxed">
            A waiver is the one action that can turn “not cleared to file” into “cleared”. It is recorded against your
            account with the reason you give, and the reason is what a reviewer reads if the decision is ever
            questioned.
          </p>
          {waive.isError && <ErrorState error={waive.error} compact title="Could not waive this" />}
          <label className="block">
            <span className="label">Reason (required)</span>
            <textarea
              className="input mt-1 min-h-[100px]"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Owner-operator with a state-filed workers' comp exemption on record — exemption certificate is on file under its own item."
            />
          </label>
        </div>
      </Drawer>
    </>
  );
}

function ReviewDrawer({
  item,
  onClose,
  onDone,
}: {
  item: ComplianceRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [note, setNote] = useState(item.reviewNote ?? '');
  const [effectiveDate, setEffectiveDate] = useState(item.effectiveDate?.slice(0, 10) ?? '');
  const [expiresAt, setExpiresAt] = useState(item.expiresAt?.slice(0, 10) ?? '');

  const review = useMutation({
    mutationFn: (decision: 'APPROVE' | 'REJECT') =>
      patch(`/compliance/${item.id}/review`, {
        decision,
        reviewNote: note.trim() || null,
        ...(effectiveDate ? { effectiveDate: new Date(effectiveDate).toISOString() } : {}),
        ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
      }),
    onSuccess: onDone,
  });

  return (
    <Drawer
      open
      onClose={onClose}
      title={`Review ${COMPLIANCE_LABELS[item.kind]}`}
      subtitle="Approving marks it valid. Rejecting sends it back with your note."
      width="520px"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-danger"
            disabled={review.isPending || !note.trim()}
            title={note.trim() ? undefined : 'A rejection needs a note — the contractor has to know what to fix'}
            onClick={() => review.mutate('REJECT')}
          >
            Reject
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={review.isPending}
            onClick={() => review.mutate('APPROVE')}
          >
            {review.isPending ? 'Saving…' : 'Approve'}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        {review.isError && <ErrorState error={review.error} compact title="Could not record the review" />}

        <dl className="grid grid-cols-2 gap-x-6 gap-y-3">
          <Detail label="Carrier" value={item.carrier} />
          <Detail label="Policy number" value={item.policyNumber} />
          <Detail
            label="Per occurrence"
            value={item.limitPerOccurrenceCents != null ? formatCents(item.limitPerOccurrenceCents) : null}
          />
          <Detail
            label="Aggregate"
            value={item.limitAggregateCents != null ? formatCents(item.limitAggregateCents) : null}
          />
          <Detail label="Uploaded" value={fmtDateTime(item.createdAt)} />
          <Detail label="Current status" value={<ComplianceBadge status={item.effectiveStatus} />} />
        </dl>

        {item.documentId && (
          <DocumentLink documentId={item.documentId}>Open the uploaded certificate</DocumentLink>
        )}

        <p className="text-[12px] text-ink-soft leading-snug">
          Correct the dates from the certificate itself if the contractor typed them wrong — what is stored here is what
          the expiry gate reads.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="label">Effective date</span>
            <input type="date" className="input mt-1" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
          </label>
          <label className="block">
            <span className="label">Expiry date</span>
            <input type="date" className="input mt-1" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </label>
        </div>

        <label className="block">
          <span className="label">Note</span>
          <textarea
            className="input mt-1 min-h-[90px]"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Certificate does not name us as certificate holder — ask the agent to reissue."
          />
          <span className="mt-1 block text-[12px] text-ink-mute leading-snug">
            Required to reject. A rejection the contractor cannot act on comes back unchanged.
          </span>
        </label>
      </div>
    </Drawer>
  );
}

function ComplianceUploadDrawer({
  client,
  kind,
  existing,
  onClose,
  onDone,
}: {
  client: Client;
  kind: ComplianceKind;
  existing: ComplianceRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [carrier, setCarrier] = useState(existing?.carrier ?? '');
  const [policyNumber, setPolicyNumber] = useState(existing?.policyNumber ?? '');
  const [perOccurrence, setPerOccurrence] = useState('');
  const [aggregate, setAggregate] = useState('');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [expiresAt, setExpiresAt] = useState('');

  const spec = DEFAULT_COMPLIANCE_POLICY.find((p) => p.kind === kind) ?? null;

  const dollarsToCents = (s: string): number | null => {
    const n = Number(s.replace(/[^0-9.]/g, ''));
    return s.trim() && Number.isFinite(n) ? Math.round(n * 100) : null;
  };

  const submit = useMutation({
    mutationFn: async () => {
      let documentId: string | null = existing?.documentId ?? null;
      if (file) {
        const payload = await readFileAsUpload(file);
        const uploaded = await post<DocumentUploadResponse>('/documents', {
          ...payload,
          clientId: client.id,
          permitId: null,
          category: 'COMPLIANCE',
          requirementKey: `compliance:${kind.toLowerCase()}`,
        });
        documentId = uploaded.document.id;
      }

      await post('/compliance', {
        clientId: client.id,
        kind,
        carrier: carrier.trim() || null,
        policyNumber: policyNumber.trim() || null,
        limitPerOccurrenceCents: dollarsToCents(perOccurrence),
        limitAggregateCents: dollarsToCents(aggregate),
        effectiveDate: effectiveDate ? new Date(effectiveDate).toISOString() : null,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        documentId,
      });
    },
    onSuccess: onDone,
  });

  return (
    <Drawer
      open
      onClose={onClose}
      title={`${existing ? 'Replace' : 'Upload'} ${COMPLIANCE_LABELS[kind]}`}
      subtitle={client.name}
      width="540px"
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12px] text-ink-soft">Lands as awaiting review until a coordinator approves it.</span>
          <div className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn-primary" disabled={submit.isPending} onClick={() => submit.mutate()}>
              {submit.isPending ? 'Uploading…' : 'Save'}
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {submit.isError && <ErrorState error={submit.error} compact title="Could not save this item" />}

        {spec?.note && (
          <div className="rounded-md bg-brand-soft px-3 py-2 text-[13px] text-ink-soft leading-snug">{spec.note}</div>
        )}

        <label className="block">
          <span className="label">Certificate file</span>
          <input
            type="file"
            className="input mt-1 file:mr-3 file:rounded file:border-0 file:bg-page file:px-2 file:py-1 file:text-[12px]"
            accept=".pdf,.png,.jpg,.jpeg,.webp,.heic"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <span className="mt-1 block text-[12px] text-ink-mute leading-snug">
            {file ? `${file.name} · ${fmtBytes(file.size)}` : 'PDF or a photo of the certificate. Up to 20MB.'}
          </span>
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="label">Carrier / issuer</span>
            <input className="input mt-1" value={carrier} onChange={(e) => setCarrier(e.target.value)} />
          </label>
          <label className="block">
            <span className="label">Policy number</span>
            <input className="input mt-1" value={policyNumber} onChange={(e) => setPolicyNumber(e.target.value)} />
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="label">Per occurrence (USD)</span>
            <input
              className="input mt-1"
              inputMode="decimal"
              value={perOccurrence}
              onChange={(e) => setPerOccurrence(e.target.value)}
              placeholder="1000000"
            />
            {spec?.minLimitPerOccurrenceCents != null && (
              <span className="mt-1 block text-[12px] text-ink-mute">
                Firm minimum {formatCents(spec.minLimitPerOccurrenceCents)}
              </span>
            )}
          </label>
          <label className="block">
            <span className="label">Aggregate (USD)</span>
            <input
              className="input mt-1"
              inputMode="decimal"
              value={aggregate}
              onChange={(e) => setAggregate(e.target.value)}
              placeholder="2000000"
            />
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="label">Effective date</span>
            <input type="date" className="input mt-1" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
          </label>
          <label className="block">
            <span className="label">Expiry date</span>
            <input type="date" className="input mt-1" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </label>
        </div>
      </div>
    </Drawer>
  );
}

// --------------------------------------------------------------------------
// Documents
// --------------------------------------------------------------------------

function DocumentsTab({ client }: { client: Client }) {
  const q = useQuery({
    queryKey: ['documents', client.id],
    queryFn: () => get<DocumentListResponse>(`/documents?clientId=${client.id}`),
  });

  const grouped = useMemo(() => {
    const docs = q.data?.documents ?? [];
    const map = new Map<DocumentCategory, PermitDocument[]>();
    for (const d of docs) {
      const list = map.get(d.category) ?? [];
      list.push(d);
      map.set(d.category, list);
    }
    return DOCUMENT_CATEGORIES.filter((c) => (map.get(c)?.length ?? 0) > 0).map((c) => ({
      category: c,
      docs: map.get(c) ?? [],
    }));
  }, [q.data]);

  if (q.isLoading) return <LoadingPanel label="Loading documents…" rows={4} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load documents" />;

  if (grouped.length === 0) {
    return (
      <div className="card">
        <EmptyState
          title="Nothing in this contractor's folder yet"
          hint="Insurance certificates, signed agreements, plan sets and job photos all land here. The compliance tab is the quickest way to put the first one in."
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {grouped.map(({ category, docs }) => (
        <div key={category} className="card">
          <div className="flex items-baseline justify-between gap-3 px-5 pt-4 pb-2">
            <h2 className="text-sm font-semibold">{humanEnum(category)}</h2>
            <span className="text-[12px] text-ink-mute">{docs.length} file{docs.length === 1 ? '' : 's'}</span>
          </div>
          <ul className="divide-y divide-line">
            {docs.map((d) => (
              <li key={d.id} className="px-5 py-2.5 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <DocumentLink documentId={d.id} className="link text-[13px] font-medium text-left">
                    {d.fileName}
                  </DocumentLink>
                  <div className="text-[12px] text-ink-mute">
                    {fmtBytes(d.sizeBytes)} · v{d.version} · uploaded {fmtDateTime(d.uploadedAt)}
                    {d.permitId && ' · attached to a permit'}
                    {d.requirementKey && ` · ${d.requirementKey}`}
                  </div>
                </div>
                <span
                  className={
                    d.status === 'ACCEPTED'
                      ? 'badge-green shrink-0'
                      : d.status === 'REJECTED'
                        ? 'badge-red shrink-0'
                        : d.status === 'SUPERSEDED'
                          ? 'badge-gray shrink-0'
                          : 'badge-blue shrink-0'
                  }
                >
                  {humanEnum(d.status)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// --------------------------------------------------------------------------
// Agreements
// --------------------------------------------------------------------------

function AgreementsTab({ client }: { client: Client }) {
  const q = useQuery({
    queryKey: ['signing', client.id],
    queryFn: () => get<SignatureListResponse>(`/signing/requests?clientId=${client.id}`),
  });

  const requests = q.data?.requests ?? [];
  const compromised = requests.filter((r) => r.status === 'SIGNED' && r.intact === false);

  if (q.isLoading) return <LoadingPanel label="Loading agreements…" rows={4} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load agreements" />;

  return (
    <div className="space-y-4">
      {compromised.length > 0 && (
        <div className="rounded-md border-2 border-danger bg-danger-soft px-4 py-3">
          <div className="text-sm font-semibold text-danger">
            {compromised.length} signed agreement{compromised.length === 1 ? '' : 's'} no longer match the text that was
            signed
          </div>
          <p className="mt-1.5 text-sm text-ink-soft leading-relaxed max-w-3xl">
            The signature was recorded against a document whose SHA-256 hash does not match the stored body any more. A
            signature attests to specific words; if the words changed, the attestation covers something nobody agreed
            to. Do not rely on {compromised.length === 1 ? 'it' : 'them'} — void and reissue, and find out what edited
            the text.
          </p>
          <ul className="mt-2 space-y-1">
            {compromised.map((r) => (
              <li key={r.id} className="text-[13px] font-medium text-danger">
                {r.label} — signed {fmtDate(r.signedAt)} by {r.signature?.typedName ?? r.signerName}
              </li>
            ))}
          </ul>
        </div>
      )}

      {requests.length === 0 ? (
        <div className="card">
          <EmptyState
            title="No signature requests yet"
            hint={`A ${client.serviceLine === 'MANAGED_LICENSE' ? 'managed-licence' : 'expediting'} contractor signs a master service agreement, a hold harmless, a payment authorization and a permit agent authorization before they go live. Send them from the onboarding checklist.`}
            action={
              <Link to={`/onboarding/${client.id}`} className="btn-primary">
                Open onboarding
              </Link>
            }
          />
        </div>
      ) : (
        <div className="card overflow-hidden">
          <ul className="divide-y divide-line">
            {requests.map((r) => (
              <li
                key={r.id}
                className={`px-5 py-3.5 ${r.status === 'SIGNED' && r.intact === false ? 'bg-danger-soft/60' : ''}`}
              >
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[13px] font-medium">{r.label}</span>
                      <span className={SIGNING_CLASS[r.status]}>{humanEnum(r.status)}</span>
                      <span className="text-[11px] text-ink-mute">v{r.templateVersion}</span>
                      {r.status === 'SIGNED' && r.intact === false && (
                        <span className="badge-red">Signature no longer matches the document</span>
                      )}
                      {r.status === 'SIGNED' && r.intact === true && <span className="badge-green">Hash verified</span>}
                    </div>
                    <div className="mt-1 text-[12px] text-ink-soft">
                      {r.signerName || 'Unnamed signer'} · {r.signerEmail}
                      {r.signerTitle ? ` · ${r.signerTitle}` : ''}
                    </div>
                    {r.declineReason && (
                      <div className="mt-1 text-[12px] text-danger leading-snug">Declined: {r.declineReason}</div>
                    )}
                  </div>
                  <dl className="flex gap-6 text-[12px] shrink-0">
                    <div>
                      <dt className="label">Sent</dt>
                      <dd className="mt-0.5 tabular-nums">{fmtDateTime(r.sentAt)}</dd>
                    </div>
                    <div>
                      <dt className="label">Viewed</dt>
                      <dd className="mt-0.5 tabular-nums">{fmtDateTime(r.viewedAt)}</dd>
                    </div>
                    <div>
                      <dt className="label">Signed</dt>
                      <dd className="mt-0.5 tabular-nums">{fmtDateTime(r.signedAt)}</dd>
                    </div>
                  </dl>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// Permits
// --------------------------------------------------------------------------

function PermitsTab({ client }: { client: Client }) {
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ['permits', client.id],
    queryFn: () => get<PermitListResponse>(`/permits?clientId=${client.id}`),
  });

  const columns: Array<Column<PermitRow>> = [
    {
      key: 'permit',
      header: 'Permit',
      sortValue: (p) => p.agencyRecordId ?? '',
      render: (p) => (
        <Link to={`/permits/${p.id}`} className="font-mono text-[13px] text-brand hover:underline">
          {p.agencyRecordId ?? 'No number'}
        </Link>
      ),
    },
    {
      key: 'project',
      header: 'Project',
      sortValue: (p) => p.projectName ?? '',
      render: (p) => (
        <div className="min-w-[180px]">
          <div>{p.projectName ?? '—'}</div>
          {p.projectAddress && <div className="text-[12px] text-ink-mute truncate">{p.projectAddress}</div>}
        </div>
      ),
    },
    {
      key: 'jurisdiction',
      header: 'Jurisdiction',
      sortValue: (p) => p.jurisdictionName ?? '',
      render: (p) => <span className="whitespace-nowrap">{p.jurisdictionName ?? p.jurisdictionId}</span>,
    },
    {
      key: 'type',
      header: 'Type',
      sortValue: (p) => p.permitType,
      render: (p) => <span className="text-[13px] whitespace-nowrap">{humanEnum(p.permitType)}</span>,
    },
    { key: 'stage', header: 'Stage', sortValue: (p) => p.stage, render: (p) => <StageBadge stage={p.stage} /> },
    {
      key: 'risk',
      header: 'Risk',
      sortValue: (p) => p.risk.score,
      render: (p) => <RiskBadge level={p.risk.level} score={p.risk.score} reasons={p.risk.reasons} />,
    },
    {
      key: 'fees',
      header: 'Agency fees due',
      align: 'right',
      sortValue: (p) => Math.max(0, p.feesDueCents - p.feesPaidCents),
      render: (p) => {
        const due = Math.max(0, p.feesDueCents - p.feesPaidCents);
        return <span className="tabular-nums">{due === 0 ? '—' : formatCents(due)}</span>;
      },
    },
  ];

  return (
    <DataTable<PermitRow>
      columns={columns}
      rows={q.data?.permits ?? []}
      rowKey={(p) => p.id}
      loading={q.isLoading}
      error={q.error ?? undefined}
      onRetry={() => void q.refetch()}
      initialSort={{ key: 'risk', dir: 'desc' }}
      onRowClick={(p) => navigate(`/permits/${p.id}`)}
      empty={
        <EmptyState
          title="No permits for this contractor"
          hint="A permit starts from a project at a job address. The compliance gate runs at creation, so make sure this contractor is cleared to file first."
        />
      }
    />
  );
}

// --------------------------------------------------------------------------
// Invoices
// --------------------------------------------------------------------------

function InvoicesTab({ client }: { client: Client }) {
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ['invoices', client.id],
    queryFn: () => get<InvoiceListResponse>(`/billing/invoices?clientId=${client.id}`),
  });

  const invoices = q.data?.invoices ?? [];

  if (q.isLoading) return <LoadingPanel label="Loading invoices…" rows={4} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load invoices" />;

  if (invoices.length === 0) {
    return (
      <div className="card">
        <EmptyState
          title="No invoices for this contractor"
          hint="Invoices are raised from the fees screen against the permits filed in a period."
          action={
            <button type="button" className="btn-ghost" onClick={() => navigate('/invoices')}>
              Open fees and invoices
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      <ul className="divide-y divide-line">
        {invoices.map((inv) => {
          const balance = Math.max(0, inv.totalCents - inv.amountPaidCents);
          return (
            <li key={inv.id} className="px-5 py-3 flex items-start justify-between gap-4 flex-wrap">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[13px] font-medium">{inv.number}</span>
                  <span className={inv.status === 'PAID' ? 'badge-green' : inv.status === 'OVERDUE' ? 'badge-red' : 'badge-gray'}>
                    {humanEnum(inv.status)}
                  </span>
                </div>
                <div className="mt-0.5 text-[12px] text-ink-soft">
                  Issued {fmtDate(inv.issuedAt)} · due {fmtDate(inv.dueAt)} · {inv.lines.length} line
                  {inv.lines.length === 1 ? '' : 's'}
                </div>
              </div>
              <div className="text-right">
                <div className="text-[13px] font-semibold tabular-nums">{formatCents(inv.totalCents)}</div>
                <div className="text-[12px] text-ink-soft tabular-nums">
                  {inv.passThroughCents > 0 && <>incl. {formatCents(inv.passThroughCents)} agency fees · </>}
                  {balance > 0 ? `${formatCents(balance)} outstanding` : 'settled'}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-line px-5 py-2.5 text-[12px] text-ink-soft">
        Pass-through agency fees are shown separately from our fee on every invoice and are never marked up.
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Supervision
// --------------------------------------------------------------------------

function SupervisionTab({ client }: { client: Client }) {
  const visitsQ = useQuery({
    queryKey: ['siteVisits', client.id],
    queryFn: () => get<SiteVisitListResponse>(`/supervision/visits?clientId=${client.id}`),
  });
  const permitsQ = useQuery({
    queryKey: ['permits', client.id],
    queryFn: () => get<PermitListResponse>(`/permits?clientId=${client.id}`),
  });

  const grouped = useMemo(() => {
    const visits = visitsQ.data?.visits ?? [];
    const permits = (permitsQ.data?.permits ?? []).filter((p) => p.serviceLine === 'MANAGED_LICENSE');
    const byPermit = new Map<string, SiteVisit[]>();
    for (const v of visits) {
      const list = byPermit.get(v.permitId) ?? [];
      list.push(v);
      byPermit.set(v.permitId, list);
    }
    return permits.map((p) => ({
      permit: p,
      visits: (byPermit.get(p.id) ?? []).sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)),
    }));
  }, [visitsQ.data, permitsQ.data]);

  if (visitsQ.isLoading || permitsQ.isLoading) return <LoadingPanel label="Loading supervision record…" rows={4} />;
  if (visitsQ.isError) return <ErrorState error={visitsQ.error} onRetry={() => void visitsQ.refetch()} title="Could not load site visits" />;

  return (
    <div className="space-y-4">
      <div className="card card-pad">
        <h2 className="text-sm font-semibold">Why this record exists</h2>
        <p className="mt-1.5 text-sm text-ink-soft leading-relaxed max-w-3xl">
          On this service line our qualifier's licence is on the permit, which makes us the contractor of record and
          makes supervision a legal obligation rather than a service feature. The defence is a contemporaneous record,
          not a sworn statement written afterwards. The full defensibility verdict per permit — including qualifier
          capacity and photo coverage — is on the supervision screen.
        </p>
        <Link to="/supervision" className="btn-ghost mt-3">
          Open supervision
        </Link>
      </div>

      {grouped.length === 0 ? (
        <div className="card">
          <EmptyState
            title="No managed-licence permits yet"
            hint="Site visits are logged against a permit, so the record starts once the first managed permit is filed."
          />
        </div>
      ) : (
        grouped.map(({ permit, visits }) => {
          const last = visits[0] ?? null;
          const since = last ? daysAgo(last.occurredAt) : null;
          return (
            <div key={permit.id} className="card">
              <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3 flex-wrap">
                <div>
                  <Link to={`/permits/${permit.id}`} className="font-mono text-[13px] text-brand hover:underline">
                    {permit.agencyRecordId ?? 'No number'}
                  </Link>
                  <div className="mt-0.5 text-[12px] text-ink-soft">
                    {permit.projectName ?? permit.projectAddress ?? '—'} · {humanEnum(permit.permitType)}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <StageBadge stage={permit.stage} />
                  <span className="badge-gray tabular-nums">
                    {visits.length} visit{visits.length === 1 ? '' : 's'}
                  </span>
                  <span className={since != null && since > 14 ? 'badge-amber' : 'badge-gray'}>
                    {since == null ? 'Never visited' : `${since}d since last visit`}
                  </span>
                </div>
              </div>
              {visits.length === 0 ? (
                <div className="border-t border-line px-5 py-3 text-[13px] text-ink-soft">
                  No site visits logged against this permit. A managed-licence permit with no supervision record is not
                  defensible.
                </div>
              ) : (
                <ul className="divide-y divide-line border-t border-line">
                  {visits.slice(0, 4).map((v) => (
                    <li key={v.id} className="px-5 py-2.5">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-[13px] font-medium">{humanEnum(v.purpose)}</span>
                        <span className="text-[12px] text-ink-mute tabular-nums">{fmtDateTime(v.occurredAt)}</span>
                      </div>
                      <p className="mt-0.5 text-[13px] text-ink-soft leading-snug line-clamp-2">{v.observations}</p>
                      {v.amendedAt && (
                        <div className="mt-1 text-[11px] text-warn leading-snug">
                          Amended {fmtDateTime(v.amendedAt)} — {v.amendmentReason ?? 'no reason recorded'}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

// --------------------------------------------------------------------------

function Detail({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd className="mt-0.5 text-sm">{value === null || value === undefined || value === '' ? <span className="text-ink-mute">Not on file</span> : value}</dd>
    </div>
  );
}

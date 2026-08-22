import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  COMPLIANCE_LABELS,
  SIGNABLE_LABELS,
  TERMINAL_STAGES,
  formatCents,
  type Client,
} from '@flph/shared';
import { get } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { daysAgo, firstName, fmtDate, fmtDateTime, greeting, humanEnum } from '../lib/format.ts';
import type {
  ClientListResponse,
  ComplianceListResponse,
  DocumentListResponse,
  DraftingListResponse,
  InvoiceListResponse,
  SigningStatusResponse,
} from '../lib/api-shapes.ts';
import type { InspectionListResponse, PermitListResponse, PermitRow } from '../lib/types.ts';
import DataTable, { type Column } from '../components/DataTable.tsx';
import EmptyState from '../components/EmptyState.tsx';
import ErrorState from '../components/ErrorState.tsx';
import KpiCard from '../components/KpiCard.tsx';
import Meter from '../components/Meter.tsx';
import RiskBadge from '../components/RiskBadge.tsx';
import { LoadingPanel } from '../components/Spinner.tsx';
import StageBadge from '../components/StageBadge.tsx';

/**
 * The contractor's own dashboard.
 *
 * This is the screen that decides whether a contractor trusts the service, so
 * it leads with what is waiting on them rather than with how busy we have
 * been. Every item in the "needs you" list is a specific thing with a specific
 * consequence — "general liability expired 4 days ago, no new permits can be
 * filed" beats a red dot on a compliance tab every time.
 */

type Urgency = 'critical' | 'warning' | 'info';

interface Todo {
  id: string;
  urgency: Urgency;
  title: string;
  detail: string;
  to: string;
  action: string;
}

const URGENCY_ORDER: Record<Urgency, number> = { critical: 0, warning: 1, info: 2 };

const URGENCY_STYLE: Record<Urgency, { badge: string; border: string; label: string }> = {
  critical: { badge: 'badge-red', border: 'border-danger', label: 'Blocking' },
  warning: { badge: 'badge-amber', border: 'border-warn', label: 'Soon' },
  info: { badge: 'badge-blue', border: 'border-brand', label: 'When you can' },
};

export default function PortalDashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const clientsQ = useQuery({
    queryKey: ['clients', 'self'],
    queryFn: () => get<ClientListResponse>('/clients'),
  });

  const client: Client | null = clientsQ.data?.clients[0] ?? null;
  const clientId = user?.clientId ?? client?.id ?? null;

  const permitsQ = useQuery({ queryKey: ['permits'], queryFn: () => get<PermitListResponse>('/permits') });
  const complianceQ = useQuery({ queryKey: ['compliance', 'self'], queryFn: () => get<ComplianceListResponse>('/compliance') });
  const invoicesQ = useQuery({ queryKey: ['invoices'], queryFn: () => get<InvoiceListResponse>('/billing/invoices') });
  const documentsQ = useQuery({ queryKey: ['documents'], queryFn: () => get<DocumentListResponse>('/documents') });
  const draftingQ = useQuery({ queryKey: ['drafting'], queryFn: () => get<DraftingListResponse>('/drafting') });
  const inspectionsQ = useQuery({
    queryKey: ['inspections', 'upcoming'],
    queryFn: () => get<InspectionListResponse>('/inspections?upcoming=true'),
  });
  const signingQ = useQuery({
    queryKey: ['signing', 'status', clientId],
    queryFn: () => get<SigningStatusResponse>(`/signing/status/${clientId}`),
    enabled: !!clientId,
  });

  const permits = permitsQ.data?.permits ?? [];
  const active = permits.filter((p) => !TERMINAL_STAGES.includes(p.stage));
  const verdict = complianceQ.data?.verdict ?? null;
  const invoices = invoicesQ.data?.invoices ?? [];
  const inspections = inspectionsQ.data?.inspections ?? [];

  const todos = useMemo<Todo[]>(() => {
    const list: Todo[] = [];

    if (client?.filingHold) {
      list.push({
        id: 'hold',
        urgency: 'critical',
        title: 'New filings are on hold',
        detail:
          client.filingHoldReason ??
          'A coordinator has placed a hold on this account. Contact us and we will tell you exactly what lifts it.',
        to: '/support',
        action: 'Ask us about it',
      });
    }

    for (const gap of verdict?.gaps ?? []) {
      list.push({
        id: `gap-${gap.kind}`,
        urgency: gap.blocksFiling ? 'critical' : 'warning',
        title: gap.blocksFiling
          ? `${gap.label} — nothing can be filed until this is fixed`
          : `${gap.label} needs attention`,
        detail: gap.detail,
        to: '/onboarding',
        action: gap.status === 'MISSING' ? 'Upload it' : 'Send a replacement',
      });
    }

    for (const kind of signingQ.data?.verdict.compromised ?? []) {
      list.push({
        id: `sig-bad-${kind}`,
        urgency: 'critical',
        title: `${SIGNABLE_LABELS[kind]} needs re-signing`,
        detail:
          'The signed copy no longer matches the document text it was signed against. We will void it and send a fresh one — please do not treat the old one as in force.',
        to: '/support',
        action: 'Contact us',
      });
    }

    for (const kind of signingQ.data?.verdict.pending ?? []) {
      list.push({
        id: `sig-pending-${kind}`,
        urgency: 'warning',
        title: `${SIGNABLE_LABELS[kind]} is waiting for your signature`,
        detail: 'Sent to your contact email. Signing takes a minute and unblocks the rest of onboarding.',
        to: '/onboarding',
        action: 'Open onboarding',
      });
    }

    for (const kind of signingQ.data?.verdict.missing ?? []) {
      list.push({
        id: `sig-missing-${kind}`,
        urgency: 'info',
        title: `${SIGNABLE_LABELS[kind]} has not been sent yet`,
        detail: 'We raise this one. If it has been a while, nudge us — it is on our side, not yours.',
        to: '/support',
        action: 'Nudge us',
      });
    }

    for (const doc of (documentsQ.data?.documents ?? []).filter((d) => d.status === 'REJECTED')) {
      list.push({
        id: `doc-${doc.id}`,
        urgency: 'warning',
        title: `${doc.fileName} was sent back`,
        detail: `Uploaded ${fmtDate(doc.uploadedAt)}${doc.requirementKey ? ` against ${doc.requirementKey}` : ''}. A replacement is needed before the package is complete.`,
        to: doc.permitId ? `/permits/${doc.permitId}` : '/onboarding',
        action: 'Replace it',
      });
    }

    for (const inv of invoices) {
      const balance = inv.totalCents - inv.amountPaidCents;
      if (balance <= 0) continue;
      const overdue = inv.status === 'OVERDUE' || (inv.dueAt != null && Date.parse(inv.dueAt) < Date.now());
      if (inv.status !== 'SENT' && inv.status !== 'PARTIAL' && inv.status !== 'OVERDUE') continue;
      list.push({
        id: `inv-${inv.id}`,
        urgency: overdue ? 'warning' : 'info',
        title: `Invoice ${inv.number} — ${formatCents(balance)} outstanding`,
        detail: overdue
          ? `Was due ${fmtDate(inv.dueAt)}.${inv.passThroughCents > 0 ? ` Includes ${formatCents(inv.passThroughCents)} of agency fees we advanced on your behalf.` : ''}`
          : `Due ${fmtDate(inv.dueAt)}.${inv.passThroughCents > 0 ? ` Includes ${formatCents(inv.passThroughCents)} of agency fees we advanced at cost.` : ''}`,
        to: '/invoices',
        action: 'View the invoice',
      });
    }

    for (const d of draftingQ.data?.requests ?? []) {
      if (d.quotedCents != null && !d.approvedAt && d.status !== 'CANCELLED') {
        list.push({
          id: `draft-${d.id}`,
          urgency: 'info',
          title: `A drafting quote is waiting for your approval — ${formatCents(d.quotedCents)}`,
          detail: d.quoteNote ?? 'We do not start until you approve the number.',
          to: '/drafting',
          action: 'Review the quote',
        });
      }
    }

    return list.sort((a, b) => URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency]);
  }, [client, verdict, signingQ.data, documentsQ.data, invoices, draftingQ.data]);

  const outstanding = invoicesQ.data?.outstandingCents ?? 0;
  const corrections = active.filter((p) => p.stage === 'CORRECTIONS_REQUIRED').length;

  const columns: Array<Column<PermitRow>> = [
    {
      key: 'permit',
      header: 'Permit',
      sortValue: (p) => p.agencyRecordId ?? '',
      render: (p) => (
        <Link to={`/permits/${p.id}`} className="font-mono text-[13px] text-brand hover:underline">
          {p.agencyRecordId ?? 'Not yet numbered'}
        </Link>
      ),
    },
    {
      key: 'project',
      header: 'Job',
      sortValue: (p) => p.projectAddress ?? '',
      render: (p) => (
        <div className="min-w-[190px]">
          <div className="text-[13px]">{p.projectName ?? '—'}</div>
          {p.projectAddress && <div className="text-[12px] text-ink-mute truncate">{p.projectAddress}</div>}
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      sortValue: (p) => p.permitType,
      render: (p) => <span className="text-[13px] whitespace-nowrap">{humanEnum(p.permitType)}</span>,
    },
    {
      key: 'jurisdiction',
      header: 'Building department',
      sortValue: (p) => p.jurisdictionName ?? '',
      render: (p) => <span className="text-[13px] whitespace-nowrap">{p.jurisdictionName ?? '—'}</span>,
    },
    { key: 'stage', header: 'Where it is', sortValue: (p) => p.stage, render: (p) => <StageBadge stage={p.stage} /> },
    {
      key: 'days',
      header: 'Days there',
      align: 'right',
      sortValue: (p) => p.risk.daysInStage,
      render: (p) => (
        <span
          className="tabular-nums text-[13px]"
          title={p.risk.baselineDays != null ? `Typical here is ${p.risk.baselineDays} days` : 'No measured median here yet'}
        >
          {p.risk.daysInStage}
          {p.risk.baselineDays != null && <span className="text-ink-mute"> / {p.risk.baselineDays}</span>}
        </span>
      ),
    },
    {
      key: 'risk',
      header: 'Outlook',
      sortValue: (p) => p.risk.score,
      render: (p) => <RiskBadge level={p.risk.level} score={p.risk.score} reasons={p.risk.reasons} />,
    },
    {
      key: 'photos',
      header: '',
      render: (p) => (
        <Link to={`/permits/${p.id}/photos`} className="btn-ghost px-2 py-1 text-[12px] whitespace-nowrap">
          Add job photos
        </Link>
      ),
    },
  ];

  const loading = permitsQ.isLoading || clientsQ.isLoading;

  if (loading) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Your permits</h1>
        <LoadingPanel label="Pulling your jobs together…" rows={5} />
      </div>
    );
  }

  if (permitsQ.isError) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Your permits</h1>
        <ErrorState error={permitsQ.error} onRetry={() => void permitsQ.refetch()} title="Could not load your permits" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold">
            {greeting()}, {firstName(user?.name)}.
          </h1>
          <p className="mt-1 text-sm text-ink-soft">
            {client?.name ?? 'Your company'} ·{' '}
            {active.length === 0
              ? 'nothing open right now'
              : `${active.length} open permit${active.length === 1 ? '' : 's'}`}
            {todos.length > 0 && ` · ${todos.length} thing${todos.length === 1 ? '' : 's'} waiting on you`}
          </p>
        </div>
        <div className="flex gap-2">
          <Link to="/onboarding" className="btn-ghost">
            Your paperwork
          </Link>
          <Link to="/support" className="btn-primary">
            Ask us something
          </Link>
        </div>
      </div>

      {client?.filingHold && (
        <div className="rounded-md border-2 border-danger bg-danger-soft px-4 py-3">
          <div className="text-sm font-semibold text-danger">We cannot file anything new for you right now</div>
          <p className="mt-1 text-sm text-ink-soft leading-relaxed">
            {client.filingHoldReason ?? 'A hold has been placed on this account.'} Existing permits carry on as normal.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <KpiCard label="Open permits" value={active.length} hint="Everything we are currently working for you." />
        <KpiCard
          label="Waiting on corrections"
          value={corrections}
          accent={corrections > 0 ? 'warn' : 'none'}
          hint="The building department has asked for changes. We handle the response; you may be asked for a document."
        />
        <KpiCard
          label="Inspections booked"
          value={inspections.length}
          hint={
            inspections[0]?.scheduledFor
              ? `Next is ${fmtDate(inspections[0].scheduledFor)}.`
              : 'Nothing scheduled in the next few days.'
          }
        />
        <KpiCard
          label="Outstanding"
          value={formatCents(outstanding)}
          accent={outstanding > 0 ? 'warn' : 'none'}
          hint="Our fees plus any agency fees we advanced for you, shown separately on every invoice."
          to="/invoices"
        />
      </div>

      {/* --- needs you ------------------------------------------------------ */}
      <section>
        <div className="flex items-baseline justify-between gap-3 mb-3">
          <h2 className="text-sm font-semibold">Needs you</h2>
          {verdict && (
            <div className="w-52">
              <Meter
                value={verdict.completeness}
                size="sm"
                tone={verdict.clearedToFile ? undefined : 'danger'}
                hint="paperwork on file"
              />
            </div>
          )}
        </div>

        {todos.length === 0 ? (
          <div className="card">
            <EmptyState
              title="Nothing is waiting on you"
              hint="Your insurance is current, your agreements are signed and there is nothing unpaid. If a permit needs something from you, it will appear here first."
              compact
            />
          </div>
        ) : (
          <ul className="space-y-2">
            {todos.map((t) => {
              const style = URGENCY_STYLE[t.urgency];
              return (
                <li key={t.id} className={`card border-l-4 ${style.border}`}>
                  <div className="flex items-start justify-between gap-4 px-4 py-3 flex-wrap">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={style.badge}>{style.label}</span>
                        <span className="text-[14px] font-medium leading-snug">{t.title}</span>
                      </div>
                      <p className="mt-1 text-[13px] text-ink-soft leading-relaxed">{t.detail}</p>
                    </div>
                    <button
                      type="button"
                      className="btn-ghost shrink-0 whitespace-nowrap"
                      onClick={() => navigate(t.to)}
                    >
                      {t.action}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* --- permits -------------------------------------------------------- */}
      <section>
        <div className="flex items-baseline justify-between gap-3 mb-3">
          <h2 className="text-sm font-semibold">Your permits</h2>
          <span className="text-[12px] text-ink-mute">
            Days shown against the typical time that building department takes, measured from our own filings there.
          </span>
        </div>
        <DataTable<PermitRow>
          columns={columns}
          rows={permits}
          rowKey={(p) => p.id}
          dense
          initialSort={{ key: 'risk', dir: 'desc' }}
          rowClassName={(p) => (p.risk.level === 'CRITICAL' ? 'bg-danger-soft/40' : '')}
          empty={
            <EmptyState
              title="No permits yet"
              hint="Once your paperwork is in and a job is ready to file, your permits appear here with exactly where each one sits."
              action={
                <Link to="/onboarding" className="btn-primary">
                  Finish your paperwork
                </Link>
              }
            />
          }
        />
      </section>

      {/* --- inspections ---------------------------------------------------- */}
      <section>
        <h2 className="text-sm font-semibold mb-3">Upcoming inspections</h2>
        {inspectionsQ.isError ? (
          <ErrorState error={inspectionsQ.error} compact title="Could not load inspections" />
        ) : inspections.length === 0 ? (
          <div className="card">
            <EmptyState
              title="Nothing booked"
              hint="We schedule inspections as each permit reaches that stage and tell you the day before. Make sure the job is ready — a failed inspection costs a re-inspection fee and a week."
              compact
            />
          </div>
        ) : (
          <div className="card overflow-hidden">
            <ul className="divide-y divide-line">
              {inspections.map((ins) => {
                const permit = permits.find((p) => p.id === ins.permitId) ?? null;
                const days = ins.scheduledFor ? -(daysAgo(ins.scheduledFor) ?? 0) : null;
                return (
                  <li key={ins.id} className="px-5 py-3 flex items-start justify-between gap-4 flex-wrap">
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium">{ins.inspectionType}</div>
                      <div className="text-[12px] text-ink-soft">
                        {permit ? (
                          <Link to={`/permits/${permit.id}`} className="link">
                            {permit.agencyRecordId ?? 'Permit'}
                          </Link>
                        ) : (
                          'Permit'
                        )}
                        {permit?.projectAddress ? ` · ${permit.projectAddress}` : ''}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-[13px] tabular-nums">{fmtDateTime(ins.scheduledFor)}</div>
                      <div className="text-[11px] text-ink-mute">
                        {days == null ? '' : days <= 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>

      {/* --- paperwork snapshot ---------------------------------------------- */}
      {verdict && (
        <section className="card card-pad">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">Your paperwork</h2>
              <p className="mt-1 text-[13px] text-ink-soft leading-relaxed max-w-2xl">
                {verdict.clearedToFile
                  ? 'Everything we need to file on your behalf is on file and current.'
                  : 'Something we need is missing or out of date, which is what stops a new permit going in.'}
                {verdict.nextExpiry &&
                  ` Next to expire: ${COMPLIANCE_LABELS[verdict.nextExpiry.kind]}, in ${verdict.nextExpiry.days} days.`}
              </p>
            </div>
            <div className="w-56 shrink-0">
              <Meter value={verdict.completeness} label="Complete" tone={verdict.clearedToFile ? undefined : 'danger'} />
            </div>
          </div>
          <Link to="/onboarding" className="btn-ghost mt-3">
            Open your checklist
          </Link>
        </section>
      )}
    </div>
  );
}

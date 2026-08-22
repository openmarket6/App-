import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { PERMIT_STAGES, formatCents, type PermitStage } from '@flph/shared';
import { get } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { fmtDateTime, firstName, greeting, humanEnum } from '../lib/format.ts';
import type { DashboardResponse, JurisdictionListResponse, NeedsAttentionRow } from '../lib/types.ts';
import KpiCard from '../components/KpiCard.tsx';
import StageBadge, { STAGE_LABELS } from '../components/StageBadge.tsx';
import RiskBadge from '../components/RiskBadge.tsx';
import DataTable, { type Column } from '../components/DataTable.tsx';
import EmptyState from '../components/EmptyState.tsx';
import ErrorState from '../components/ErrorState.tsx';
import { LoadingPanel } from '../components/Spinner.tsx';

/**
 * The firm dashboard.
 *
 * Every number on this page is measured from our own rows — median review time
 * is our observed median in these jurisdictions, not a published service-level
 * target, and the "needs attention" list carries the risk engine's own reasons
 * rather than a re-derived explanation. A coordinator has to be able to read a
 * row out loud to a client without opening anything else.
 */

/** Stages we do not draw on the pipeline chart when nothing sits in them —
 *  fourteen columns of mostly zeroes reads as noise. */
const ALWAYS_SHOW: PermitStage[] = [
  'DRAFT',
  'READY_TO_SUBMIT',
  'SUBMITTED',
  'INTAKE_REVIEW',
  'IN_REVIEW',
  'CORRECTIONS_REQUIRED',
  'RESUBMITTED',
  'APPROVED',
  'ISSUED',
  'INSPECTIONS',
];

function HvhzBadge({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span className="badge-amber ml-1.5" title="High-velocity hurricane zone — product approval and NOA rules apply">
      HVHZ
    </span>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const q = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => get<DashboardResponse>('/dashboard'),
  });

  // The dashboard payload does not carry building-code flags, and "HVHZ" is a
  // fact about the jurisdiction rather than the permit, so it is read from the
  // authoritative list instead of inferred from a name. A failure here costs a
  // badge, never the page.
  const jq = useQuery({
    queryKey: ['jurisdictions', 'all'],
    queryFn: () => get<JurisdictionListResponse>('/jurisdictions'),
    staleTime: 10 * 60_000,
  });

  const hvhzIds = useMemo(
    () => new Set((jq.data?.jurisdictions ?? []).filter((j) => j.hvhz).map((j) => j.id)),
    [jq.data],
  );

  const data = q.data;

  const chartData = useMemo(() => {
    if (!data) return [];
    return PERMIT_STAGES.filter(
      (s) => ALWAYS_SHOW.includes(s) || (data.pipelineByStage[s] ?? 0) > 0,
    ).map((stage) => ({
      stage,
      label: STAGE_LABELS[stage],
      count: data.pipelineByStage[stage] ?? 0,
    }));
  }, [data]);

  const attentionColumns: Array<Column<NeedsAttentionRow>> = useMemo(
    () => [
      {
        key: 'permit',
        header: 'Permit',
        sortValue: (r) => r.agencyRecordId ?? '',
        render: (r) => (
          <Link to={`/permits/${r.permitId}`} className="font-mono text-[13px] text-brand hover:underline">
            {r.agencyRecordId ?? 'No agency number'}
          </Link>
        ),
      },
      {
        key: 'client',
        header: 'Client / project',
        sortValue: (r) => r.clientName ?? '',
        render: (r) => (
          <div className="min-w-[180px]">
            <div className="font-medium">{r.clientName ?? 'Unassigned'}</div>
            <div className="text-[12px] text-ink-soft truncate">{r.projectName ?? r.projectAddress ?? '—'}</div>
          </div>
        ),
      },
      {
        key: 'jurisdiction',
        header: 'Jurisdiction',
        sortValue: (r) => r.jurisdictionName ?? '',
        render: (r) => {
          const j = data?.busiestJurisdictions.find((b) => b.jurisdictionId === r.jurisdictionId);
          return (
            <span className="whitespace-nowrap">
              {r.jurisdictionName ?? r.jurisdictionId}
              <HvhzBadge show={hvhzIds.has(r.jurisdictionId)} />
              {j?.paperOnly && <span className="badge-gray ml-1.5">Paper</span>}
            </span>
          );
        },
      },
      {
        key: 'stage',
        header: 'Stage',
        sortValue: (r) => r.stage,
        render: (r) => <StageBadge stage={r.stage} />,
      },
      {
        key: 'days',
        header: 'Days',
        align: 'right',
        sortValue: (r) => r.daysInStage,
        render: (r) => (
          <span className="tabular-nums" title={r.baselineDays != null ? `Median here is ${r.baselineDays}d` : 'No measured median here yet'}>
            {r.daysInStage}
            {r.baselineDays != null && <span className="text-ink-mute"> / {r.baselineDays}</span>}
          </span>
        ),
      },
      {
        key: 'risk',
        header: 'Risk',
        sortValue: (r) => r.score,
        render: (r) => <RiskBadge level={r.risk} score={r.score} reasons={r.reasons} />,
      },
      {
        key: 'reasons',
        header: 'Why it is flagged',
        render: (r) => (
          <ul className="space-y-0.5 min-w-[260px]">
            {r.reasons.map((reason, i) => (
              <li key={i} className="text-[13px] text-ink-soft leading-snug">
                {reason}
              </li>
            ))}
          </ul>
        ),
      },
    ],
    [data, hvhzIds],
  );

  if (q.isLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <LoadingPanel label="Measuring the book…" rows={4} />
      </div>
    );
  }

  if (q.isError) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <ErrorState error={q.error} onRetry={() => q.refetch()} title="Could not load the dashboard" />
      </div>
    );
  }

  if (!data) return null;

  const k = data.kpis;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold">
            {greeting()}, {firstName(user?.name)}.
          </h1>
          <p className="mt-1 text-sm text-ink-soft">
            {data.scope === 'firm' ? 'Whole firm' : 'Your book'} · measured at {fmtDateTime(data.generatedAt)}
          </p>
        </div>
        <Link to="/pipeline" className="btn-ghost">
          Open the pipeline
        </Link>
      </div>

      {/* --- KPIs ---------------------------------------------------------- */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <KpiCard
          label="Active permits"
          value={k.activePermits}
          hint="Open filings — everything not closed, expired, withdrawn or denied."
          to="/pipeline"
        />
        <KpiCard
          label="At risk"
          value={k.atRisk}
          accent="danger"
          hint="Scored against each jurisdiction's own measured median, not a flat target."
          to="/pipeline?risk=AT_RISK"
        />
        <KpiCard
          label="Open corrections"
          value={k.openCorrections}
          accent="warn"
          hint="Agency comments logged and not yet resolved. Each one is a requirement we can promote."
          to="/pipeline?stage=CORRECTIONS_REQUIRED"
        />
        <KpiCard
          label="Ready to submit"
          value={k.readyToSubmit}
          hint="Packages complete and sitting on our side of the desk."
          to="/pipeline?stage=READY_TO_SUBMIT"
        />
        <KpiCard
          label="Median review time"
          value={k.medianReviewDays == null ? '—' : `${k.medianReviewDays}d`}
          hint={
            k.medianReviewDays == null
              ? 'Not enough decided filings to measure yet.'
              : `Submitted to first agency decision, across ${k.reviewSampleSize} measured filing${k.reviewSampleSize === 1 ? '' : 's'}.`
          }
        />
        <KpiCard
          label="First-pass approval"
          value={k.firstPassApprovalRate == null ? '—' : `${k.firstPassApprovalRate}%`}
          hint={
            k.firstPassApprovalRate == null
              ? 'No permits have reached a decision yet.'
              : `Decided with zero correction cycles, across ${k.firstPassDecidedCount} permit${k.firstPassDecidedCount === 1 ? '' : 's'}.`
          }
        />
        <KpiCard
          label="Inspections this week"
          value={k.inspectionsThisWeek}
          hint="Scheduled in the next seven days."
          to="/inspections"
        />
        <KpiCard
          label="Outstanding invoices"
          value={
            typeof k.outstandingInvoiceCents === 'number' ? formatCents(k.outstandingInvoiceCents) : '—'
          }
          hint={
            typeof k.outstandingInvoiceCents === 'number'
              ? `Billed and uncollected${k.overdueInvoices ? ` · ${k.overdueInvoices} overdue` : ''}.`
              : 'Invoice totals are not part of this view.'
          }
          to="/invoices"
        />
      </div>

      {/* --- pipeline + jurisdictions -------------------------------------- */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="card card-pad xl:col-span-2">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold">Pipeline by stage</h2>
            <span className="text-[12px] text-ink-mute">Click a bar to open that stage</span>
          </div>
          {chartData.every((d) => d.count === 0) ? (
            <EmptyState
              title="No permits in the pipeline"
              hint="Once a permit is created it lands in Draft and moves through these stages as the agency responds."
              compact
            />
          ) : (
            <div className="mt-4 h-[280px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 20, right: 8, left: -16, bottom: 44 }}>
                  <CartesianGrid stroke="#e3e6ea" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: '#5b6b7c' }}
                    interval={0}
                    angle={-35}
                    textAnchor="end"
                    height={60}
                    axisLine={{ stroke: '#e3e6ea' }}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: '#8a97a5' }}
                    allowDecimals={false}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    cursor={{ fill: '#f6f7f9' }}
                    contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: '#e3e6ea' }}
                    formatter={(v: number) => [v, 'Permits']}
                  />
                  <Bar
                    dataKey="count"
                    radius={[3, 3, 0, 0]}
                    cursor="pointer"
                    onClick={(entry: unknown) => {
                      const stage = (entry as { stage?: PermitStage } | undefined)?.stage;
                      if (stage) navigate(`/pipeline?stage=${stage}`);
                    }}
                  >
                    <LabelList dataKey="count" position="top" style={{ fontSize: 11, fill: '#5b6b7c' }} />
                    {chartData.map((d) => (
                      <Cell
                        key={d.stage}
                        fill={
                          d.stage === 'CORRECTIONS_REQUIRED'
                            ? '#a15c07'
                            : d.stage === 'DENIED' || d.stage === 'EXPIRED'
                              ? '#b42318'
                              : '#1a5490'
                        }
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div className="card">
          <div className="px-5 pt-5 pb-3">
            <h2 className="text-sm font-semibold">Busiest jurisdictions</h2>
            <p className="mt-1 text-[12px] text-ink-soft leading-snug">
              Review times measured from our own filings there — not the agency's published target.
            </p>
          </div>
          {data.busiestJurisdictions.length === 0 ? (
            <EmptyState title="No filings yet" hint="Jurisdiction performance appears once permits are filed." compact />
          ) : (
            <ul className="divide-y divide-line">
              {data.busiestJurisdictions.map((j) => (
                <li key={j.jurisdictionId} className="px-5 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium truncate">{j.name}</div>
                      <div className="mt-0.5 text-[12px] text-ink-mute">
                        {humanEnum(j.platform)} · {j.permitCount} filed · {j.activeCount} active
                        {j.paperOnly && ' · paper only'}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-[13px] font-semibold tabular-nums">
                        {j.medianReviewDays == null ? '—' : `${j.medianReviewDays}d`}
                      </div>
                      <div className="text-[11px] text-ink-mute">
                        {j.reviewSampleSize > 0 ? `n=${j.reviewSampleSize}` : 'unmeasured'}
                      </div>
                    </div>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2 text-[12px] text-ink-soft">
                    <span>First pass</span>
                    <div className="flex-1 h-1.5 rounded bg-page overflow-hidden">
                      <div
                        className="h-full bg-brand"
                        style={{ width: `${j.firstPassApprovalRate ?? 0}%` }}
                      />
                    </div>
                    <span className="tabular-nums">
                      {j.firstPassApprovalRate == null ? '—' : `${j.firstPassApprovalRate}%`}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* --- needs attention ----------------------------------------------- */}
      <div>
        <div className="flex items-baseline justify-between gap-3 mb-3">
          <h2 className="text-sm font-semibold">Needs attention</h2>
          <span className="text-[12px] text-ink-mute">
            {data.needsAttention.length} permit{data.needsAttention.length === 1 ? '' : 's'} scored at risk or critical
          </span>
        </div>
        <DataTable<NeedsAttentionRow>
          columns={attentionColumns}
          rows={data.needsAttention}
          rowKey={(r) => r.permitId}
          initialSort={{ key: 'risk', dir: 'desc' }}
          onRowClick={(r) => navigate(`/permits/${r.permitId}`)}
          rowClassName={(r) => (r.risk === 'CRITICAL' ? 'bg-danger-soft/40' : '')}
          empty={
            <EmptyState
              title="Nothing is flagged"
              hint="Every open permit is inside its jurisdiction's normal review window, with no stale statuses or expiring approvals."
            />
          }
        />
      </div>
    </div>
  );
}

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { TERMINAL_STAGES, type PermitStage } from '@flph/shared';
import { get } from '../lib/api.ts';
import { median } from '../lib/format.ts';
import type {
  CorrectionListResponse,
  JurisdictionListResponse,
  PermitListResponse,
  PermitRow,
} from '../lib/types.ts';
import DataTable, { type Column } from '../components/DataTable.tsx';
import EmptyState from '../components/EmptyState.tsx';
import ErrorState from '../components/ErrorState.tsx';
import { LoadingPanel } from '../components/Spinner.tsx';

/**
 * Cycle-time analysis.
 *
 * Every number here is measured from our own filings — submitted date to the
 * date the agency issued — and every chart carries its sample size, because a
 * 4-day median over two permits is not a fact about a jurisdiction.
 *
 * The unmapped-statuses table at the bottom is not a report. It is a work
 * queue: each row is an agency string our normalizer did not recognise, and
 * until someone adds a rule for it, every permit carrying that string has a
 * stage that may be stale.
 */

const DAY_MS = 86_400_000;

const DECIDED_STAGES: PermitStage[] = ['APPROVED', 'ISSUED', 'INSPECTIONS', 'CLOSED'];

function reviewDays(p: PermitRow): number | null {
  if (!p.submittedAt || !p.issuedAt) return null;
  const a = Date.parse(p.submittedAt);
  const b = Date.parse(p.issuedAt);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.floor((b - a) / DAY_MS);
}

function isDecided(p: PermitRow): boolean {
  return p.issuedAt != null || DECIDED_STAGES.includes(p.stage);
}

/** The month a decision landed in, as YYYY-MM. Falls back to updatedAt for
 *  permits decided without an issue date (denials, approvals never collected). */
function decisionMonth(p: PermitRow): string | null {
  const iso = p.issuedAt ?? (isDecided(p) ? p.updatedAt : null);
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key: string): string {
  const [y, m] = key.split('-');
  const d = new Date(Date.UTC(Number(y), Number(m) - 1, 1));
  return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
}

interface UnmappedRow {
  key: string;
  rawStatus: string;
  jurisdictionName: string;
  jurisdictionId: string;
  count: number;
  permitIds: string[];
}

export default function Reports() {
  const permitsQ = useQuery({
    queryKey: ['permits'],
    queryFn: () => get<PermitListResponse>('/permits'),
  });
  const correctionsQ = useQuery({
    queryKey: ['corrections'],
    queryFn: () => get<CorrectionListResponse>('/corrections'),
  });
  const jurisdictionsQ = useQuery({
    queryKey: ['jurisdictions', 'all'],
    queryFn: () => get<JurisdictionListResponse>('/jurisdictions'),
    staleTime: 5 * 60_000,
  });
  const permits = useMemo(() => permitsQ.data?.permits ?? [], [permitsQ.data]);
  const corrections = useMemo(() => correctionsQ.data?.corrections ?? [], [correctionsQ.data]);
  const jurisdictionNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const j of jurisdictionsQ.data?.jurisdictions ?? []) m.set(j.id, j.name);
    return m;
  }, [jurisdictionsQ.data]);

  // --- median review days by jurisdiction ---------------------------------
  const reviewByJurisdiction = useMemo(() => {
    const buckets = new Map<string, { name: string; days: number[] }>();
    for (const p of permits) {
      const d = reviewDays(p);
      if (d == null) continue;
      const name = p.jurisdictionName ?? jurisdictionNames.get(p.jurisdictionId) ?? p.jurisdictionId;
      const bucket = buckets.get(p.jurisdictionId) ?? { name, days: [] };
      bucket.days.push(d);
      buckets.set(p.jurisdictionId, bucket);
    }
    return [...buckets.entries()]
      .map(([id, b]) => ({ id, name: b.name, days: median(b.days) ?? 0, n: b.days.length }))
      .sort((a, b) => b.days - a.days)
      .slice(0, 15);
  }, [permits, jurisdictionNames]);

  const overallMedian = useMemo(
    () => median(permits.map(reviewDays).filter((d): d is number => d != null)),
    [permits],
  );

  // --- first-pass approval trend ------------------------------------------
  const firstPassTrend = useMemo(() => {
    const buckets = new Map<string, { decided: number; firstPass: number }>();
    for (const p of permits) {
      if (!isDecided(p)) continue;
      const key = decisionMonth(p);
      if (!key) continue;
      const b = buckets.get(key) ?? { decided: 0, firstPass: 0 };
      b.decided += 1;
      if (p.correctionCycles === 0) b.firstPass += 1;
      buckets.set(key, b);
    }
    return [...buckets.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-12)
      .map(([key, b]) => ({
        key,
        label: monthLabel(key),
        rate: Math.round((b.firstPass / b.decided) * 100),
        decided: b.decided,
      }));
  }, [permits]);

  // --- correction reasons --------------------------------------------------
  const correctionReasons = useMemo(() => {
    const buckets = new Map<string, { total: number; open: number; promoted: number }>();
    for (const c of corrections) {
      const key = c.discipline?.trim() || 'Unattributed';
      const b = buckets.get(key) ?? { total: 0, open: 0, promoted: 0 };
      b.total += 1;
      if (!c.resolvedAt) b.open += 1;
      if (c.promotedToRequirement) b.promoted += 1;
      buckets.set(key, b);
    }
    return [...buckets.entries()]
      .map(([discipline, b]) => ({ discipline, ...b }))
      .sort((a, b) => b.total - a.total);
  }, [corrections]);

  // --- unmapped statuses ---------------------------------------------------
  const unmapped = useMemo<UnmappedRow[]>(() => {
    const buckets = new Map<string, UnmappedRow>();
    for (const p of permits) {
      if (!p.unmappedStatus) continue;
      const key = `${p.jurisdictionId}::${p.unmappedStatus.toLowerCase()}`;
      const existing = buckets.get(key);
      if (existing) {
        existing.count += 1;
        existing.permitIds.push(p.id);
      } else {
        buckets.set(key, {
          key,
          rawStatus: p.unmappedStatus,
          jurisdictionId: p.jurisdictionId,
          jurisdictionName: p.jurisdictionName ?? jurisdictionNames.get(p.jurisdictionId) ?? p.jurisdictionId,
          count: 1,
          permitIds: [p.id],
        });
      }
    }
    return [...buckets.values()].sort((a, b) => b.count - a.count);
  }, [permits, jurisdictionNames]);

  const unmappedColumns: Array<Column<UnmappedRow>> = useMemo(
    () => [
      {
        key: 'raw',
        header: 'Raw agency string',
        sortValue: (r) => r.rawStatus,
        render: (r) => (
          <span className="font-mono text-[12px] bg-page border border-line rounded px-1.5 py-0.5">
            {r.rawStatus}
          </span>
        ),
      },
      {
        key: 'jurisdiction',
        header: 'Jurisdiction',
        sortValue: (r) => r.jurisdictionName,
        render: (r) => <span className="whitespace-nowrap">{r.jurisdictionName}</span>,
      },
      {
        key: 'count',
        header: 'Permits affected',
        align: 'right',
        sortValue: (r) => r.count,
        render: (r) => <span className="tabular-nums font-semibold">{r.count}</span>,
      },
      {
        key: 'permits',
        header: 'Open one',
        render: (r) => (
          <div className="flex flex-wrap gap-1.5">
            {r.permitIds.slice(0, 4).map((id) => (
              <Link key={id} to={`/permits/${id}`} className="link font-mono text-[11px]">
                {id.slice(0, 8)}
              </Link>
            ))}
            {r.permitIds.length > 4 && (
              <span className="text-[11px] text-ink-mute">+{r.permitIds.length - 4} more</span>
            )}
          </div>
        ),
      },
    ],
    [],
  );

  const anyLoading = permitsQ.isLoading || correctionsQ.isLoading || jurisdictionsQ.isLoading;
  const firstError = permitsQ.error ?? correctionsQ.error ?? jurisdictionsQ.error;

  if (anyLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Reports</h1>
        <LoadingPanel label="Measuring cycle times…" rows={6} />
      </div>
    );
  }

  if (firstError) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Reports</h1>
        <ErrorState
          error={firstError}
          title="Could not load the reporting data"
          onRetry={() => {
            void permitsQ.refetch();
            void correctionsQ.refetch();
            void jurisdictionsQ.refetch();
          }}
        />
      </div>
    );
  }

  const activeCount = permits.filter((p) => !TERMINAL_STAGES.includes(p.stage)).length;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Reports</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Cycle times measured from our own filings — submitted to issued. {permits.length} permits in the book,{' '}
          {activeCount} still open.
          {overallMedian != null && <> Firm-wide median review is {overallMedian}d.</>}
        </p>
      </div>

      {/* --- median review by jurisdiction ---------------------------------- */}
      <div className="card card-pad">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <h2 className="text-sm font-semibold">Median review days by jurisdiction</h2>
          <span className="text-[12px] text-ink-mute">
            Slowest 15 with a measured sample · n shown per bar
          </span>
        </div>
        {reviewByJurisdiction.length === 0 ? (
          <EmptyState
            title="Nothing measured yet"
            hint="A jurisdiction gets a median once a permit there has both a submitted date and an issued date. Until then the risk engine falls back to a 21-day baseline."
            compact
          />
        ) : (
          <div className="mt-4" style={{ height: Math.max(200, reviewByJurisdiction.length * 30 + 40) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                layout="vertical"
                data={reviewByJurisdiction}
                margin={{ top: 4, right: 56, left: 8, bottom: 4 }}
              >
                <CartesianGrid stroke="#dce3eb" horizontal={false} />
                <XAxis
                  type="number"
                  tick={{ fontSize: 11, fill: '#5f7089' }}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={170}
                  tick={{ fontSize: 11, fill: '#48586e' }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  cursor={{ fill: '#f2f5f7' }}
                  contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: '#dce3eb' }}
                  formatter={(v: number, _n, item: { payload?: { n?: number } }) => [
                    `${v} days (n=${item?.payload?.n ?? 0})`,
                    'Median review',
                  ]}
                />
                <Bar dataKey="days" radius={[0, 3, 3, 0]} barSize={16}>
                  <LabelList
                    dataKey="days"
                    position="right"
                    formatter={(v: number) => `${v}d`}
                    style={{ fontSize: 11, fill: '#48586e' }}
                  />
                  {reviewByJurisdiction.map((r) => (
                    <Cell key={r.id} fill={r.n < 5 ? '#5f7089' : '#185ac6'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
        <p className="mt-2 text-[12px] text-ink-mute">
          Grey bars have fewer than five observations — the risk engine will not use them as a baseline yet.
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {/* --- first-pass trend --------------------------------------------- */}
        <div className="card card-pad">
          <h2 className="text-sm font-semibold">First-pass approval rate</h2>
          <p className="mt-1 text-[12px] text-ink-soft">
            Share of permits decided with zero correction cycles, by the month the decision landed.
          </p>
          {firstPassTrend.length === 0 ? (
            <EmptyState title="No decided permits yet" hint="The trend starts once permits reach a decision." compact />
          ) : (
            <div className="mt-4 h-[240px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={firstPassTrend} margin={{ top: 8, right: 12, left: -18, bottom: 4 }}>
                  <CartesianGrid stroke="#dce3eb" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: '#48586e' }}
                    axisLine={{ stroke: '#dce3eb' }}
                    tickLine={false}
                  />
                  <YAxis
                    domain={[0, 100]}
                    tick={{ fontSize: 11, fill: '#5f7089' }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v: number) => `${v}%`}
                  />
                  <Tooltip
                    contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: '#dce3eb' }}
                    formatter={(v: number, _n, item: { payload?: { decided?: number } }) => [
                      `${v}% of ${item?.payload?.decided ?? 0} decided`,
                      'First pass',
                    ]}
                  />
                  <Line
                    type="monotone"
                    dataKey="rate"
                    stroke="#185ac6"
                    strokeWidth={2}
                    dot={{ r: 3, fill: '#185ac6' }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* --- correction reasons -------------------------------------------- */}
        <div className="card">
          <div className="px-5 pt-5">
            <h2 className="text-sm font-semibold">Correction reasons by frequency</h2>
            <p className="mt-1 text-[12px] text-ink-soft">
              Grouped by the discipline the agency raised it under. Each promoted line is a lesson that now appears on
              every future checklist in that jurisdiction.
            </p>
          </div>
          {correctionReasons.length === 0 ? (
            <EmptyState
              title="No corrections logged"
              hint="Corrections are the raw material for the requirements database — log them as they arrive."
              compact
            />
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className="th">Discipline</th>
                    <th className="th text-right">Total</th>
                    <th className="th text-right">Open</th>
                    <th className="th text-right">Promoted</th>
                    <th className="th">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {correctionReasons.map((r) => (
                    <tr key={r.discipline}>
                      <td className="td font-medium">{r.discipline}</td>
                      <td className="td text-right tabular-nums">{r.total}</td>
                      <td className="td text-right tabular-nums">
                        {r.open > 0 ? <span className="text-warn font-semibold">{r.open}</span> : '—'}
                      </td>
                      <td className="td text-right tabular-nums">
                        {r.promoted > 0 ? <span className="text-good font-semibold">{r.promoted}</span> : '—'}
                      </td>
                      <td className="td">
                        <div className="h-1.5 w-full min-w-[80px] rounded bg-page overflow-hidden">
                          <div
                            className="h-full bg-warn"
                            style={{ width: `${(r.total / (correctionReasons[0]?.total || 1)) * 100}%` }}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* --- unmapped statuses: the maintenance queue ------------------------ */}
      <div>
        <div className="card card-pad border-l-4 border-warn mb-3">
          <h2 className="text-sm font-semibold">Unmapped statuses — normalization rule maintenance queue</h2>
          <p className="mt-1.5 text-[13px] text-ink-soft leading-relaxed">
            Every string below is something an agency told us that no normalization rule matched. We deliberately do not
            guess a stage from an unrecognised string — a wrong stage silently drops a permit out of a follow-up queue,
            whereas a missing one shows up here. Each row is a rule somebody needs to add to{' '}
            <span className="font-mono text-[12px]">normalize.ts</span>; until then, treat the stage on those permits as
            possibly stale.
          </p>
        </div>
        <DataTable<UnmappedRow>
          columns={unmappedColumns}
          rows={unmapped}
          rowKey={(r) => r.key}
          dense
          initialSort={{ key: 'count', dir: 'desc' }}
          empty={
            <EmptyState
              title="Every agency status maps cleanly"
              hint="No permit is carrying an unrecognised status string right now. This queue fills itself as agencies invent new wording."
            />
          }
          footer={
            unmapped.length > 0
              ? `${unmapped.length} distinct string${unmapped.length === 1 ? '' : 's'} across ${unmapped.reduce((s, r) => s + r.count, 0)} permits.`
              : undefined
          }
        />
      </div>
    </div>
  );
}

import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PERMIT_STAGES,
  RISK_LEVELS,
  SERVICE_LINES,
  SERVICE_LINE_LABELS,
  can,
  formatCents,
  type PermitStage,
  type RiskLevel,
  type ServiceLine,
  type SupervisionGap,
} from '@flph/shared';
import { ApiError, get, post } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { humanEnum } from '../lib/format.ts';
import type { JurisdictionListResponse, PermitListResponse, PermitRow } from '../lib/types.ts';
import StageBadge, { STAGE_LABELS } from '../components/StageBadge.tsx';
import RiskBadge from '../components/RiskBadge.tsx';
import DataTable, { type Column } from '../components/DataTable.tsx';
import EmptyState from '../components/EmptyState.tsx';
import ErrorState, { errorCode, errorMessage } from '../components/ErrorState.tsx';
import { LoadingPanel } from '../components/Spinner.tsx';

/**
 * The permit pipeline.
 *
 * One fetch, filtered in the browser. The list endpoint can filter server-side,
 * but doing it here keeps the filter dropdowns populated with every option in
 * the book rather than only the options that survive the current filter — a
 * filter UI that empties itself as you use it is worse than a slightly larger
 * payload.
 */

type View = 'board' | 'table';

interface Filters {
  stage: string;
  jurisdictionId: string;
  clientId: string;
  risk: string;
  serviceLine: string;
  q: string;
}

const EMPTY_FILTERS: Filters = { stage: '', jurisdictionId: '', clientId: '', risk: '', serviceLine: '', q: '' };

function matches(p: PermitRow, f: Filters): boolean {
  if (f.stage && p.stage !== f.stage) return false;
  if (f.jurisdictionId && p.jurisdictionId !== f.jurisdictionId) return false;
  if (f.clientId && p.clientId !== f.clientId) return false;
  if (f.risk && p.risk.level !== f.risk) return false;
  if (f.serviceLine && p.serviceLine !== f.serviceLine) return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    const hay = [
      p.agencyRecordId,
      p.projectName,
      p.projectAddress,
      p.clientName,
      p.jurisdictionName,
      p.permitType,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

/** How long this permit has been sitting where it is. The risk engine already
 *  computed it against the right anchor — do not recompute it here. */
const daysInStage = (p: PermitRow) => p.risk.daysInStage;

export default function Pipeline() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();

  const [view, setView] = useState<View>('board');
  const [filters, setFilters] = useState<Filters>({
    ...EMPTY_FILTERS,
    // The dashboard links here with ?stage=IN_REVIEW; ?risk= is used the same way.
    stage: PERMIT_STAGES.includes(String(params.get('stage')) as PermitStage) ? String(params.get('stage')) : '',
    risk: RISK_LEVELS.includes(String(params.get('risk')) as RiskLevel) ? String(params.get('risk')) : '',
  });

  /** Advance failures are per-card: a supervision gap on one managed-licence
   *  permit must not blank the board or bleed onto the next card. */
  const [advanceError, setAdvanceError] = useState<
    Record<string, { message: string; gaps: SupervisionGap[] }>
  >({});

  const canEdit = !!user && can(user.role, 'permit:edit');
  const canCreate = !!user && can(user.role, 'permit:create');

  const q = useQuery({
    queryKey: ['permits'],
    queryFn: () => get<PermitListResponse>('/permits'),
  });

  const jq = useQuery({
    queryKey: ['jurisdictions', 'all'],
    queryFn: () => get<JurisdictionListResponse>('/jurisdictions'),
    staleTime: 10 * 60_000,
  });

  const hvhzIds = useMemo(
    () => new Set((jq.data?.jurisdictions ?? []).filter((j) => j.hvhz).map((j) => j.id)),
    [jq.data],
  );

  const all = useMemo(() => q.data?.permits ?? [], [q.data]);
  const rows = useMemo(() => all.filter((p) => matches(p, filters)), [all, filters]);

  const jurisdictionOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of all) m.set(p.jurisdictionId, p.jurisdictionName ?? p.jurisdictionId);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [all]);

  const clientOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of all) m.set(p.clientId, p.clientName ?? p.clientId);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [all]);

  const advance = useMutation({
    mutationFn: ({ id, stage }: { id: string; stage: PermitStage }) =>
      post(`/permits/${id}/advance`, { stage }),
    onMutate: ({ id }) =>
      setAdvanceError((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['permits'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (err, { id }) => {
      // 409 supervision_not_defensible carries the exact gaps. Showing "request
      // failed" here would hide the one thing a coordinator can act on.
      const gaps =
        errorCode(err) === 'supervision_not_defensible' && err instanceof ApiError
          ? ((err.details as { gaps?: SupervisionGap[] } | undefined)?.gaps ?? [])
          : [];
      setAdvanceError((prev) => ({ ...prev, [id]: { message: errorMessage(err), gaps } }));
    },
  });

  function setFilter<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((prev) => ({ ...prev, [key]: value }));
    if (key === 'stage') {
      const next = new URLSearchParams(params);
      if (value) next.set('stage', String(value));
      else next.delete('stage');
      setParams(next, { replace: true });
    }
  }

  const columns: Array<Column<PermitRow>> = useMemo(
    () => [
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
        key: 'client',
        header: 'Client',
        sortValue: (p) => p.clientName ?? '',
        render: (p) => <span className="whitespace-nowrap">{p.clientName ?? '—'}</span>,
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
        render: (p) => (
          <span className="whitespace-nowrap">
            {p.jurisdictionName ?? p.jurisdictionId}
            {hvhzIds.has(p.jurisdictionId) && <span className="badge-amber ml-1.5">HVHZ</span>}
          </span>
        ),
      },
      {
        key: 'type',
        header: 'Type',
        sortValue: (p) => p.permitType,
        render: (p) => <span className="whitespace-nowrap text-[13px]">{humanEnum(p.permitType)}</span>,
      },
      {
        key: 'stage',
        header: 'Stage',
        sortValue: (p) => p.stage,
        render: (p) => <StageBadge stage={p.stage} />,
      },
      {
        key: 'days',
        header: 'Days',
        align: 'right',
        sortValue: (p) => daysInStage(p),
        render: (p) => <span className="tabular-nums">{daysInStage(p)}</span>,
      },
      {
        key: 'risk',
        header: 'Risk',
        sortValue: (p) => p.risk.score,
        render: (p) => <RiskBadge level={p.risk.level} score={p.risk.score} reasons={p.risk.reasons} />,
      },
      {
        key: 'fees',
        header: 'Fees due',
        align: 'right',
        sortValue: (p) => Math.max(0, p.feesDueCents - p.feesPaidCents),
        render: (p) => {
          const due = Math.max(0, p.feesDueCents - p.feesPaidCents);
          return <span className="tabular-nums">{due === 0 ? '—' : formatCents(due)}</span>;
        },
      },
    ],
    [hvhzIds],
  );

  const boardStages: PermitStage[] = filters.stage ? [filters.stage as PermitStage] : [...PERMIT_STAGES];

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold">Permit pipeline</h1>
          <p className="mt-1 text-sm text-ink-soft">
            {rows.length} of {all.length} permit{all.length === 1 ? '' : 's'}
            {rows.length !== all.length ? ' matching these filters' : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border border-line overflow-hidden bg-white">
            {(['board', 'table'] as View[]).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={`px-3 py-2 text-sm font-medium capitalize transition-colors ${
                  view === v ? 'bg-brand text-white' : 'text-ink-soft hover:bg-page'
                }`}
              >
                {v}
              </button>
            ))}
          </div>
          {canCreate && (
            <Link to="/permits/new" className="btn-primary">
              New permit
            </Link>
          )}
        </div>
      </div>

      {/* --- filters -------------------------------------------------------- */}
      <div className="card card-pad">
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          <div>
            <label className="label" htmlFor="f-stage">Stage</label>
            <select
              id="f-stage"
              className="input mt-1"
              value={filters.stage}
              onChange={(e) => setFilter('stage', e.target.value)}
            >
              <option value="">All stages</option>
              {PERMIT_STAGES.map((s) => (
                <option key={s} value={s}>
                  {STAGE_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="f-jur">Jurisdiction</label>
            <select
              id="f-jur"
              className="input mt-1"
              value={filters.jurisdictionId}
              onChange={(e) => setFilter('jurisdictionId', e.target.value)}
            >
              <option value="">All jurisdictions</option>
              {jurisdictionOptions.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="f-client">Client</label>
            <select
              id="f-client"
              className="input mt-1"
              value={filters.clientId}
              onChange={(e) => setFilter('clientId', e.target.value)}
            >
              <option value="">All clients</option>
              {clientOptions.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="f-risk">Risk</label>
            <select
              id="f-risk"
              className="input mt-1"
              value={filters.risk}
              onChange={(e) => setFilter('risk', e.target.value)}
            >
              <option value="">Any risk</option>
              {RISK_LEVELS.map((r) => (
                <option key={r} value={r}>
                  {humanEnum(r)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="f-line">Service line</label>
            <select
              id="f-line"
              className="input mt-1"
              value={filters.serviceLine}
              onChange={(e) => setFilter('serviceLine', e.target.value)}
            >
              <option value="">Both lines</option>
              {SERVICE_LINES.map((s) => (
                <option key={s} value={s}>
                  {SERVICE_LINE_LABELS[s as ServiceLine]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="f-q">Search</label>
            <input
              id="f-q"
              className="input mt-1"
              placeholder="Number, address, client…"
              value={filters.q}
              onChange={(e) => setFilter('q', e.target.value)}
            />
          </div>
        </div>
        {Object.values(filters).some(Boolean) && (
          <button
            type="button"
            className="link mt-3 text-[13px]"
            onClick={() => {
              setFilters(EMPTY_FILTERS);
              const next = new URLSearchParams(params);
              next.delete('stage');
              setParams(next, { replace: true });
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} title="Could not load permits" />}
      {q.isLoading && <LoadingPanel label="Loading permits…" rows={5} />}

      {!q.isLoading && !q.isError && all.length === 0 && (
        <div className="card">
          <EmptyState
            title="No permits yet"
            hint="A permit starts from a project. Create the project first, then file against it — the compliance gate runs at creation, so a contractor with lapsed insurance is caught before the row exists."
            action={canCreate ? <Link to="/permits/new" className="btn-primary">New permit</Link> : undefined}
          />
        </div>
      )}

      {!q.isLoading && !q.isError && all.length > 0 && rows.length === 0 && (
        <div className="card">
          <EmptyState
            title="No permits match these filters"
            hint="Widen the stage or risk filter, or clear the search box."
            action={
              <button type="button" className="btn-ghost" onClick={() => setFilters(EMPTY_FILTERS)}>
                Clear filters
              </button>
            }
          />
        </div>
      )}

      {/* --- board ---------------------------------------------------------- */}
      {view === 'board' && rows.length > 0 && (
        <div className="overflow-x-auto pb-2">
          <div className="flex gap-3 min-w-max">
            {boardStages.map((stage) => {
              const cards = rows.filter((p) => p.stage === stage);
              return (
                <div key={stage} className="w-[272px] shrink-0">
                  <div className="flex items-center justify-between px-1 pb-2">
                    <span className="label">{STAGE_LABELS[stage]}</span>
                    <span className="badge-gray tabular-nums">{cards.length}</span>
                  </div>
                  <div className="space-y-2 min-h-[60px]">
                    {cards.length === 0 && (
                      <div className="rounded-card border border-dashed border-line px-3 py-4 text-[12px] text-ink-mute text-center">
                        Empty
                      </div>
                    )}
                    {cards.map((p) => (
                      <PermitCard
                        key={p.id}
                        permit={p}
                        hvhz={hvhzIds.has(p.jurisdictionId)}
                        canEdit={canEdit}
                        moving={advance.isPending && advance.variables?.id === p.id}
                        error={advanceError[p.id]}
                        onMove={(next) => advance.mutate({ id: p.id, stage: next })}
                        onOpen={() => navigate(`/permits/${p.id}`)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* --- table ---------------------------------------------------------- */}
      {view === 'table' && rows.length > 0 && (
        <DataTable<PermitRow>
          columns={columns}
          rows={rows}
          rowKey={(p) => p.id}
          dense
          initialSort={{ key: 'risk', dir: 'desc' }}
          onRowClick={(p) => navigate(`/permits/${p.id}`)}
          footer={`${rows.length} permit${rows.length === 1 ? '' : 's'} · sorted by risk score by default`}
        />
      )}
    </div>
  );
}

function PermitCard({
  permit: p,
  hvhz,
  canEdit,
  moving,
  error,
  onMove,
  onOpen,
}: {
  permit: PermitRow;
  hvhz: boolean;
  canEdit: boolean;
  moving: boolean;
  error?: { message: string; gaps: SupervisionGap[] };
  onMove: (stage: PermitStage) => void;
  onOpen: () => void;
}) {
  return (
    <div className="card p-3">
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={onOpen}
          className="font-mono text-[13px] text-brand hover:underline text-left truncate"
        >
          {p.agencyRecordId ?? 'No number'}
        </button>
        <span className="text-[12px] text-ink-mute tabular-nums shrink-0" title="Days in this stage">
          {daysInStage(p)}d
        </span>
      </div>

      <div className="mt-1.5 text-[13px] font-medium leading-snug truncate">{p.clientName ?? 'Unassigned'}</div>
      <div className="text-[12px] text-ink-soft leading-snug truncate">
        {p.projectName ?? p.projectAddress ?? '—'}
      </div>

      <div className="mt-2 flex flex-wrap gap-1">
        {hvhz && <span className="badge-amber">HVHZ</span>}
        <RiskBadge level={p.risk.level} score={p.risk.score} reasons={p.risk.reasons} />
        <span className="badge-gray">
          {p.serviceLine === 'MANAGED_LICENSE' ? 'Managed licence' : 'Expediting'}
        </span>
      </div>

      {p.unmappedStatus && (
        <div className="mt-2 rounded bg-warn-soft px-2 py-1 text-[11px] text-warn leading-snug">
          Agency status “{p.unmappedStatus}” is unmapped — this stage may be stale.
        </div>
      )}

      {canEdit && (
        <label className="mt-2 block">
          <span className="sr-only">Move {p.agencyRecordId ?? 'permit'} to another stage</span>
          <select
            className="input py-1 text-[12px]"
            value=""
            disabled={moving}
            onChange={(e) => {
              const next = e.target.value as PermitStage;
              if (next) onMove(next);
              e.target.value = '';
            }}
          >
            <option value="">{moving ? 'Moving…' : 'Move to…'}</option>
            {PERMIT_STAGES.filter((s) => s !== p.stage).map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
      )}

      {error && (
        <div className="mt-2 rounded border border-danger/20 bg-danger-soft px-2 py-1.5">
          <div className="text-[11px] font-semibold text-danger leading-snug">{error.message}</div>
          {error.gaps.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {error.gaps.map((g, i) => (
                <li key={i} className="text-[11px] text-ink-soft leading-snug">
                  <span className={g.severity === 'blocking' ? 'font-semibold text-danger' : 'text-warn'}>
                    {g.severity === 'blocking' ? 'Blocking' : 'Warning'}
                  </span>{' '}
                  — {g.detail}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

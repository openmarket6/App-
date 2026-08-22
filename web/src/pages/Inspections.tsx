import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  INSPECTION_RESULTS,
  can,
  type Inspection,
  type InspectionResult,
} from '@flph/shared';
import { get, patch, post } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { fmtDate, fmtDateTime, humanEnum } from '../lib/format.ts';
import type { InspectionListResponse, InspectionRow, PermitListResponse, PermitRow } from '../lib/types.ts';
import DataTable, { type Column } from '../components/DataTable.tsx';
import Drawer from '../components/Drawer.tsx';
import EmptyState from '../components/EmptyState.tsx';
import ErrorState, { errorMessage } from '../components/ErrorState.tsx';
import KpiCard from '../components/KpiCard.tsx';
import { LoadingPanel } from '../components/Spinner.tsx';

/**
 * The inspection board.
 *
 * Upcoming work is grouped by day rather than listed by date, because the
 * question a coordinator has at 7am is "what is happening today" and a sorted
 * list makes them do the date arithmetic themselves.
 *
 * The other deliberate thing here is the re-inspection link. When a result is
 * recorded as failed the API creates the follow-up visit immediately, and that
 * row is easy to lose in a history table. Every failure on this page names its
 * re-inspection and links to it, so "third re-inspection on the same rough-in"
 * is a question somebody can actually ask.
 */

const RESULT_CLASS: Record<InspectionResult, string> = {
  SCHEDULED: 'badge-blue',
  PASSED: 'badge-green',
  FAILED: 'badge-red',
  PARTIAL: 'badge-amber',
  CANCELLED: 'badge-gray',
  NO_SHOW: 'badge-amber',
};

const DAY_MS = 86_400_000;

type Bucket = 'today' | 'tomorrow' | 'week' | 'later' | 'undated';

const BUCKET_LABEL: Record<Bucket, string> = {
  today: 'Today',
  tomorrow: 'Tomorrow',
  week: 'Rest of this week',
  later: 'Later',
  undated: 'No date agreed yet',
};

const BUCKET_HINT: Record<Bucket, string> = {
  today: 'Somebody has to be on site for these.',
  tomorrow: 'Confirm access and that the work is actually ready.',
  week: 'Within the next seven days.',
  later: 'Booked beyond the week.',
  undated: 'Requested or expected, but the agency has not given a slot. These are the ones that quietly stall.',
};

const BUCKET_ORDER: Bucket[] = ['today', 'tomorrow', 'week', 'later', 'undated'];

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function bucketFor(iso: string | null, now: number): Bucket {
  if (!iso) return 'undated';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'undated';
  const today = startOfDay(now);
  const day = startOfDay(t);
  if (day <= today) return 'today';
  if (day === today + DAY_MS) return 'tomorrow';
  if (day < today + 7 * DAY_MS) return 'week';
  return 'later';
}

/** An inspection joined to the permit it hangs off. Inspections carry no names of their own. */
interface Row extends InspectionRow {
  permit: PermitRow | null;
  /** The follow-up visit the API created when this one was recorded failed. */
  reinspection: Inspection | null;
  /** Set when this row is itself the follow-up. */
  reinspectionOf: Inspection | null;
}

export default function Inspections() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [recordError, setRecordError] = useState<Record<string, string>>({});

  const canSchedule = !!user && can(user.role, 'inspection:schedule');
  const canRecord = !!user && can(user.role, 'inspection:record');

  const inspectionsQ = useQuery({
    queryKey: ['inspections'],
    queryFn: () => get<InspectionListResponse>('/inspections'),
  });

  const permitsQ = useQuery({
    queryKey: ['permits'],
    queryFn: () => get<PermitListResponse>('/permits'),
  });

  const rows = useMemo<Row[]>(() => {
    const inspections = inspectionsQ.data?.inspections ?? [];
    const permitById = new Map((permitsQ.data?.permits ?? []).map((p) => [p.id, p]));
    const byOriginal = new Map<string, Inspection>();
    const byId = new Map<string, Inspection>();
    for (const i of inspections) {
      byId.set(i.id, i);
      if (i.reinspectionOfId) byOriginal.set(i.reinspectionOfId, i);
    }
    return inspections.map((i) => ({
      ...i,
      permit: permitById.get(i.permitId) ?? null,
      reinspection: byOriginal.get(i.id) ?? null,
      reinspectionOf: i.reinspectionOfId ? (byId.get(i.reinspectionOfId) ?? null) : null,
    }));
  }, [inspectionsQ.data, permitsQ.data]);

  const now = Date.now();

  const upcoming = useMemo(
    () =>
      rows
        .filter((r) => r.result === 'SCHEDULED')
        .filter((r) => {
          if (!r.scheduledFor) return true;
          const t = Date.parse(r.scheduledFor);
          // Anything scheduled for earlier today still needs somebody on site,
          // so the cut is the start of today rather than this instant.
          return !Number.isFinite(t) || t >= startOfDay(now);
        })
        .sort((a, b) => Date.parse(a.scheduledFor ?? '9999') - Date.parse(b.scheduledFor ?? '9999')),
    [rows, now],
  );

  const grouped = useMemo(() => {
    const m = new Map<Bucket, Row[]>();
    for (const r of upcoming) {
      const b = bucketFor(r.scheduledFor, now);
      const list = m.get(b) ?? [];
      list.push(r);
      m.set(b, list);
    }
    return m;
  }, [upcoming, now]);

  const history = useMemo(
    () =>
      rows
        .filter((r) => !upcoming.some((u) => u.id === r.id))
        .sort((a, b) => Date.parse(b.scheduledFor ?? '') - Date.parse(a.scheduledFor ?? '')),
    [rows, upcoming],
  );

  const record = useMutation({
    mutationFn: ({ id, result }: { id: string; result: InspectionResult }) =>
      patch<{ inspection: Inspection; reinspection: Inspection | null }>(`/inspections/${id}`, { result }),
    onMutate: ({ id }) =>
      setRecordError((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['inspections'] });
      void qc.invalidateQueries({ queryKey: ['permits'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (err, { id }) => setRecordError((prev) => ({ ...prev, [id]: errorMessage(err) })),
  });

  const failedWithoutFollowUp = rows.filter((r) => r.result === 'FAILED' && !r.reinspection).length;
  const todayCount = grouped.get('today')?.length ?? 0;
  const undatedCount = grouped.get('undated')?.length ?? 0;

  const columns: Array<Column<Row>> = useMemo(
    () => [
      {
        key: 'permit',
        header: 'Permit',
        sortValue: (r) => r.permit?.agencyRecordId ?? '',
        render: (r) => (
          <Link to={`/permits/${r.permitId}`} className="font-mono text-[13px] text-brand hover:underline">
            {r.permit?.agencyRecordId ?? 'No number'}
          </Link>
        ),
      },
      {
        key: 'client',
        header: 'Contractor',
        sortValue: (r) => r.permit?.clientName ?? '',
        render: (r) => <span className="whitespace-nowrap">{r.permit?.clientName ?? '—'}</span>,
      },
      {
        key: 'project',
        header: 'Project',
        sortValue: (r) => r.permit?.projectName ?? '',
        render: (r) => (
          <div className="min-w-[170px]">
            <div>{r.permit?.projectName ?? '—'}</div>
            {r.permit?.projectAddress && (
              <div className="text-[12px] text-ink-mute truncate">{r.permit.projectAddress}</div>
            )}
          </div>
        ),
      },
      {
        key: 'jurisdiction',
        header: 'Jurisdiction',
        sortValue: (r) => r.permit?.jurisdictionName ?? '',
        render: (r) => <span className="whitespace-nowrap">{r.permit?.jurisdictionName ?? '—'}</span>,
      },
      {
        key: 'type',
        header: 'Inspection',
        sortValue: (r) => r.inspectionType,
        render: (r) => (
          <div className="min-w-[150px]">
            <div className="font-medium">{r.inspectionType}</div>
            {r.reinspectionOf && (
              <div className="text-[11px] text-warn">
                Re-inspection of a failure on {fmtDate(r.reinspectionOf.scheduledFor)}
              </div>
            )}
          </div>
        ),
      },
      {
        key: 'scheduled',
        header: 'Scheduled for',
        sortValue: (r) => (r.scheduledFor ? Date.parse(r.scheduledFor) : null),
        render: (r) => <span className="whitespace-nowrap">{fmtDateTime(r.scheduledFor)}</span>,
      },
      {
        key: 'result',
        header: 'Result',
        sortValue: (r) => r.result,
        render: (r) => (
          <div className="min-w-[160px] space-y-1">
            <span className={RESULT_CLASS[r.result]}>{humanEnum(r.result)}</span>
            {r.result === 'FAILED' && <FollowUp row={r} />}
            {r.inspectorNote && <div className="text-[11px] text-ink-soft leading-snug">{r.inspectorNote}</div>}
          </div>
        ),
      },
      ...(canRecord
        ? [
            {
              key: 'record',
              header: 'Record',
              render: (r: Row) => (
                <ResultPicker
                  row={r}
                  pending={record.isPending && record.variables?.id === r.id}
                  error={recordError[r.id]}
                  onPick={(result) => record.mutate({ id: r.id, result })}
                />
              ),
            } as Column<Row>,
          ]
        : []),
    ],
    [canRecord, record.isPending, record.variables, recordError],
  );

  const loading = inspectionsQ.isLoading || permitsQ.isLoading;
  const error = inspectionsQ.error ?? permitsQ.error;

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold">Inspections</h1>
          <p className="mt-1 text-sm text-ink-soft">
            {upcoming.length} upcoming · {history.length} in the record. A failed result creates its re-inspection
            immediately, and every failure below links to it.
          </p>
        </div>
        {canSchedule && (
          <button type="button" className="btn-primary" onClick={() => setScheduleOpen(true)}>
            Schedule an inspection
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <KpiCard
          label="Today"
          value={todayCount}
          accent={todayCount > 0 ? 'brand' : 'none'}
          hint="Booked for today. Somebody has to be on site or the slot is lost."
        />
        <KpiCard label="Upcoming" value={upcoming.length} hint="Everything still scheduled, dated or not." />
        <KpiCard
          label="No date agreed"
          value={undatedCount}
          accent={undatedCount > 0 ? 'warn' : 'none'}
          hint="Scheduled in our record but with no agency slot. These are the ones that stall silently."
        />
        <KpiCard
          label="Failures without a follow-up"
          value={failedWithoutFollowUp}
          accent={failedWithoutFollowUp > 0 ? 'danger' : 'none'}
          hint="A failed inspection should always have a re-inspection behind it. Any count here is a gap."
        />
      </div>

      {error && (
        <ErrorState error={error} onRetry={() => void inspectionsQ.refetch()} title="Could not load inspections" />
      )}
      {loading && !error && <LoadingPanel label="Loading inspections…" rows={5} />}

      {!loading && !error && (
        <>
          {/* --- upcoming, by day ------------------------------------------ */}
          <div className="space-y-4">
            <h2 className="text-base font-semibold">Upcoming</h2>
            {upcoming.length === 0 ? (
              <div className="card">
                <EmptyState
                  title="Nothing scheduled"
                  hint="Inspections appear once a permit is issued and a visit is booked with the agency. Schedule the first one from a permit, or with the button above."
                  action={
                    canSchedule ? (
                      <button type="button" className="btn-primary" onClick={() => setScheduleOpen(true)}>
                        Schedule an inspection
                      </button>
                    ) : undefined
                  }
                />
              </div>
            ) : (
              BUCKET_ORDER.filter((b) => (grouped.get(b)?.length ?? 0) > 0).map((b) => (
                <DayGroup
                  key={b}
                  bucket={b}
                  rows={grouped.get(b) ?? []}
                  canRecord={canRecord}
                  recordError={recordError}
                  recordingId={record.isPending ? (record.variables?.id ?? null) : null}
                  onRecord={(id, result) => record.mutate({ id, result })}
                />
              ))
            )}
          </div>

          {/* --- history ---------------------------------------------------- */}
          <div className="space-y-3">
            <h2 className="text-base font-semibold">History</h2>
            <DataTable<Row>
              columns={columns}
              rows={history}
              rowKey={(r) => r.id}
              dense
              initialSort={{ key: 'scheduled', dir: 'desc' }}
              rowClassName={(r) => (r.result === 'FAILED' ? 'bg-danger-soft/30' : '')}
              empty={
                <EmptyState
                  title="No inspection history yet"
                  hint="Once results start coming back — passed, failed, partial — they land here with the permit, contractor and jurisdiction they belong to."
                  compact
                />
              }
              footer={`${history.length} recorded inspection${history.length === 1 ? '' : 's'}`}
            />
          </div>
        </>
      )}

      {canSchedule && scheduleOpen && (
        <ScheduleDrawer
          permits={permitsQ.data?.permits ?? []}
          onClose={() => setScheduleOpen(false)}
          onScheduled={() => {
            setScheduleOpen(false);
            void qc.invalidateQueries({ queryKey: ['inspections'] });
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Upcoming, grouped by day
// ---------------------------------------------------------------------------

function DayGroup({
  bucket,
  rows,
  canRecord,
  recordError,
  recordingId,
  onRecord,
}: {
  bucket: Bucket;
  rows: Row[];
  canRecord: boolean;
  recordError: Record<string, string>;
  recordingId: string | null;
  onRecord: (id: string, result: InspectionResult) => void;
}) {
  return (
    <div className="card overflow-hidden">
      <div className="flex items-baseline justify-between gap-3 border-b border-line bg-page px-4 py-2.5">
        <div>
          <span className="label">{BUCKET_LABEL[bucket]}</span>
          <span className="ml-2 text-[12px] text-ink-soft">{BUCKET_HINT[bucket]}</span>
        </div>
        <span className="badge-gray tabular-nums">{rows.length}</span>
      </div>
      <ul className="divide-y divide-line">
        {rows.map((r) => (
          <li key={r.id} className="px-4 py-3">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium">{r.inspectionType}</span>
                  <Link to={`/permits/${r.permitId}`} className="font-mono text-[12px] text-brand hover:underline">
                    {r.permit?.agencyRecordId ?? 'No number'}
                  </Link>
                  {r.reinspectionOf && <span className="badge-amber">Re-inspection</span>}
                </div>
                <div className="mt-0.5 text-[12px] text-ink-soft leading-snug">
                  {r.permit?.clientName ?? 'Unassigned contractor'} ·{' '}
                  {r.permit?.projectName ?? r.permit?.projectAddress ?? 'No project'} ·{' '}
                  {r.permit?.jurisdictionName ?? 'Unknown jurisdiction'}
                </div>
                <div className="mt-0.5 text-[12px] text-ink-mute">
                  {r.scheduledFor ? fmtDateTime(r.scheduledFor) : 'No slot from the agency yet'}
                </div>
              </div>
              {canRecord && (
                <ResultPicker
                  row={r}
                  pending={recordingId === r.id}
                  error={recordError[r.id]}
                  onPick={(result) => onRecord(r.id, result)}
                />
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The link out of a failure. Kept next to the result so it is impossible to miss. */
function FollowUp({ row }: { row: Row }) {
  if (!row.reinspection) {
    return (
      <div className="text-[11px] text-danger leading-snug">
        No re-inspection on record — this job is stalled until one is booked.
      </div>
    );
  }
  return (
    <div className="text-[11px] leading-snug">
      <span className="text-ink-mute">Re-inspection </span>
      <Link to={`/permits/${row.permitId}`} className="link">
        {row.reinspection.inspectionType}
      </Link>
      <span className="text-ink-mute">
        {' '}
        · {row.reinspection.scheduledFor ? fmtDate(row.reinspection.scheduledFor) : 'no date yet'} ·{' '}
        {humanEnum(row.reinspection.result)}
      </span>
    </div>
  );
}

function ResultPicker({
  row,
  pending,
  error,
  onPick,
}: {
  row: Row;
  pending: boolean;
  error?: string;
  onPick: (result: InspectionResult) => void;
}) {
  return (
    <div className="shrink-0">
      <label className="block">
        <span className="sr-only">Record a result for {row.inspectionType}</span>
        <select
          className="input py-1 text-[12px]"
          value=""
          disabled={pending}
          onChange={(e) => {
            const result = e.target.value as InspectionResult;
            if (result) onPick(result);
            e.target.value = '';
          }}
        >
          <option value="">{pending ? 'Saving…' : 'Record result…'}</option>
          {INSPECTION_RESULTS.filter((r) => r !== row.result).map((r) => (
            <option key={r} value={r}>
              {humanEnum(r)}
            </option>
          ))}
        </select>
      </label>
      {error && <div className="mt-1 max-w-[220px] text-[11px] text-danger leading-snug">{error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

function ScheduleDrawer({
  permits,
  onClose,
  onScheduled,
}: {
  permits: PermitRow[];
  onClose: () => void;
  onScheduled: () => void;
}) {
  const [permitId, setPermitId] = useState('');
  const [inspectionType, setInspectionType] = useState('');
  const [scheduledFor, setScheduledFor] = useState('');

  const create = useMutation({
    mutationFn: () =>
      post('/inspections', {
        permitId,
        inspectionType: inspectionType.trim(),
        // An inspection with no agreed slot still has to exist — it is the row
        // that keeps the job in somebody's queue.
        scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : null,
      }),
    onSuccess: onScheduled,
  });

  const valid = !!permitId && inspectionType.trim().length > 0;

  return (
    <Drawer
      open
      onClose={onClose}
      title="Schedule an inspection"
      subtitle="Books the visit in our record. Confirm the slot with the agency separately."
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12px] text-ink-soft">Leave the date blank if the agency has not given one.</span>
          <div className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={!valid || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending ? 'Scheduling…' : 'Schedule'}
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {create.isError && <ErrorState error={create.error} title="Could not schedule that inspection" compact />}

        <FormField label="Permit" required>
          <select className="input" value={permitId} onChange={(e) => setPermitId(e.target.value)}>
            <option value="">Choose a permit…</option>
            {permits.map((p) => (
              <option key={p.id} value={p.id}>
                {p.agencyRecordId ?? 'No number'} — {p.clientName ?? 'Unassigned'} — {p.projectAddress ?? p.projectName ?? ''}
              </option>
            ))}
          </select>
        </FormField>

        <FormField
          label="Inspection type"
          required
          hint="Use the agency's own wording — “Roof dry-in”, “Framing”, “Final building”. It is what the inspector's sheet will say."
        >
          <input
            className="input"
            value={inspectionType}
            onChange={(e) => setInspectionType(e.target.value)}
            placeholder="Roof dry-in"
          />
        </FormField>

        <FormField label="Scheduled for" hint="Optional. An undated inspection still shows on the board so it is not forgotten.">
          <input
            type="datetime-local"
            className="input"
            value={scheduledFor}
            onChange={(e) => setScheduledFor(e.target.value)}
          />
        </FormField>
      </div>
    </Drawer>
  );
}

function FormField({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="label">
        {label}
        {required && <span className="text-danger"> *</span>}
      </span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-[12px] text-ink-mute leading-snug">{hint}</span>}
    </label>
  );
}

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_DRAFTING_RATES,
  DRAFTING_LABELS,
  DRAFTING_SERVICES,
  can,
  formatCents,
  type DraftingService,
  type DraftingStatus,
} from '@flph/shared';
import { get, patch, post } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { fmtDate, fmtDateTime } from '../lib/format.ts';
import { fmtBytes, readFileAsUpload } from '../lib/upload.ts';
import type {
  ClientListResponse,
  DocumentUploadResponse,
  DraftingListResponse,
  DraftingRow,
  ProjectListResponse,
  UserListResponse,
} from '../lib/api-shapes.ts';
import DataTable, { type Column } from '../components/DataTable.tsx';
import Drawer from '../components/Drawer.tsx';
import EmptyState from '../components/EmptyState.tsx';
import ErrorState, { errorMessage } from '../components/ErrorState.tsx';
import KpiCard from '../components/KpiCard.tsx';
import { LoadingPanel } from '../components/Spinner.tsx';

/**
 * The drafting and engineering queue.
 *
 * What makes doing this in-house worth anything is the last column: delivery
 * files the produced plan set into the permit package and ticks off the
 * requirement lines it was ordered to satisfy. So the board is organised
 * around getting work to DELIVERED, and every card carries the server's own
 * `nextStep` rather than a status re-interpreted here.
 */

const BOARD: DraftingStatus[] = [
  'REQUESTED',
  'QUOTED',
  'AWAITING_CLIENT_APPROVAL',
  'IN_PRODUCTION',
  'INTERNAL_REVIEW',
  'AWAITING_SEAL',
  'DELIVERED',
];

const STATUS_LABELS: Record<DraftingStatus, string> = {
  REQUESTED: 'Requested',
  QUOTED: 'Quoted',
  AWAITING_CLIENT_APPROVAL: 'Awaiting approval',
  IN_PRODUCTION: 'In production',
  INTERNAL_REVIEW: 'Internal review',
  AWAITING_SEAL: 'Awaiting seal',
  DELIVERED: 'Delivered',
  REVISION_REQUESTED: 'Revision requested',
  CANCELLED: 'Cancelled',
};

const STATUS_CLASS: Record<DraftingStatus, string> = {
  REQUESTED: 'badge-gray',
  QUOTED: 'badge-blue',
  AWAITING_CLIENT_APPROVAL: 'badge-amber',
  IN_PRODUCTION: 'badge-blue',
  INTERNAL_REVIEW: 'badge-blue',
  AWAITING_SEAL: 'badge-amber',
  DELIVERED: 'badge-green',
  REVISION_REQUESTED: 'badge-amber',
  CANCELLED: 'badge-gray',
};

export default function Drafting() {
  const { user, isStaff } = useAuth();
  const [requestOpen, setRequestOpen] = useState(false);
  const [quoting, setQuoting] = useState<DraftingRow | null>(null);
  const [delivering, setDelivering] = useState<DraftingRow | null>(null);

  const canQuote = !!user && can(user.role, 'drafting:quote');
  const canProduce = !!user && can(user.role, 'drafting:produce');
  const canRequest = !!user && (can(user.role, 'drafting:request') || can(user.role, 'portal:request_drafting'));

  const q = useQuery({
    queryKey: ['drafting'],
    queryFn: () => get<DraftingListResponse>('/drafting'),
  });

  const clientsQ = useQuery({
    queryKey: ['clients'],
    queryFn: () => get<ClientListResponse>('/clients'),
    staleTime: 5 * 60_000,
  });

  const clientName = useMemo(
    () => new Map((clientsQ.data?.clients ?? []).map((c) => [c.id, c.name])),
    [clientsQ.data],
  );

  const requests = q.data?.requests ?? [];
  const open = requests.filter((r) => r.status !== 'DELIVERED' && r.status !== 'CANCELLED');
  const awaitingSeal = requests.filter((r) => r.status === 'AWAITING_SEAL').length;
  const unquoted = requests.filter((r) => r.status === 'REQUESTED').length;
  const quotedValue = open.reduce((s, r) => s + (r.quotedCents ?? 0), 0);

  const extraColumns = (['REVISION_REQUESTED', 'CANCELLED'] as DraftingStatus[]).filter((s) =>
    requests.some((r) => r.status === s),
  );
  const columns = [...BOARD, ...extraColumns];

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold">Drafting and engineering</h1>
          <p className="mt-1 text-sm text-ink-soft max-w-3xl leading-relaxed">
            {isStaff
              ? 'Every request across the book. A delivered plan set is filed into the permit package and marked against the requirement lines it satisfies — that is the whole reason this sits inside the permit system rather than beside it.'
              : 'Plan sets, calculations and engineering produced in house. Because we already know the jurisdiction, the wind zone and what that plans examiner asked for last time, the drawings arrive built for the review they are going into.'}
          </p>
        </div>
        {canRequest && (
          <button type="button" className="btn-primary" onClick={() => setRequestOpen(true)}>
            Request drafting
          </button>
        )}
      </div>

      {isStaff && (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <KpiCard label="Open requests" value={open.length} hint="Everything not delivered or cancelled." />
          <KpiCard
            label="Waiting on a quote"
            value={unquoted}
            accent={unquoted > 0 ? 'warn' : 'none'}
            hint="Requested and not yet scoped. Nothing moves until a number exists."
          />
          <KpiCard
            label="Awaiting seal"
            value={awaitingSeal}
            accent={awaitingSeal > 0 ? 'warn' : 'none'}
            hint="Finished work sitting on the engineer of record's desk."
          />
          <KpiCard
            label="Quoted value, open"
            value={formatCents(quotedValue)}
            hint="Sum of quoted prices on open requests. Unquoted work counts as zero here."
          />
        </div>
      )}

      {q.isLoading && <LoadingPanel label="Loading the drafting queue…" rows={5} />}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load drafting requests" />}

      {!q.isLoading && !q.isError && requests.length === 0 && (
        <div className="card">
          <EmptyState
            title="No drafting requests yet"
            hint={
              isStaff
                ? 'Contractors raise these from their portal, and staff can raise one on their behalf. Each request attaches to a project so the delivered set lands in the right permit package.'
                : 'Tell us what you need drawn and attach the project. We will scope it, send a price, and only start once you have approved the number.'
            }
            action={
              canRequest ? (
                <button type="button" className="btn-primary" onClick={() => setRequestOpen(true)}>
                  Request drafting
                </button>
              ) : undefined
            }
          />
        </div>
      )}

      {/* --- staff board ---------------------------------------------------- */}
      {isStaff && requests.length > 0 && (
        <div className="overflow-x-auto pb-2">
          <div className="flex gap-3 min-w-max">
            {columns.map((status) => {
              const cards = requests.filter((r) => r.status === status);
              return (
                <div key={status} className="w-[290px] shrink-0">
                  <div className="flex items-center justify-between px-1 pb-2">
                    <span className="label">{STATUS_LABELS[status]}</span>
                    <span className="badge-gray tabular-nums">{cards.length}</span>
                  </div>
                  <div className="space-y-2 min-h-[60px]">
                    {cards.length === 0 && (
                      <div className="rounded-card border border-dashed border-line px-3 py-4 text-center text-[12px] text-ink-mute">
                        Empty
                      </div>
                    )}
                    {cards.map((r) => (
                      <RequestCard
                        key={r.id}
                        request={r}
                        clientName={clientName.get(r.clientId) ?? null}
                        canQuote={canQuote}
                        canProduce={canProduce}
                        onQuote={() => setQuoting(r)}
                        onDeliver={() => setDelivering(r)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* --- contractor list ------------------------------------------------ */}
      {!isStaff && requests.length > 0 && <ContractorList requests={requests} />}

      {requestOpen && canRequest && <RequestDrawer onClose={() => setRequestOpen(false)} />}
      {quoting && canQuote && <QuoteDrawer request={quoting} onClose={() => setQuoting(null)} />}
      {delivering && canProduce && <DeliverDrawer request={delivering} onClose={() => setDelivering(null)} />}
    </div>
  );
}

// --------------------------------------------------------------------------

function RequestCard({
  request: r,
  clientName,
  canQuote,
  canProduce,
  onQuote,
  onDeliver,
}: {
  request: DraftingRow;
  clientName: string | null;
  canQuote: boolean;
  canProduce: boolean;
  onQuote: () => void;
  onDeliver: () => void;
}) {
  const qc = useQueryClient();
  const usersQ = useQuery({
    queryKey: ['users'],
    queryFn: () => get<UserListResponse>('/users'),
    staleTime: 10 * 60_000,
    enabled: canProduce,
    retry: false,
  });

  const move = useMutation({
    mutationFn: (body: Record<string, unknown>) => patch(`/drafting/${r.id}`, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['drafting'] }),
  });

  const staff = (usersQ.data?.users ?? []).filter((u) => u.role !== 'CLIENT' && u.role !== 'PENDING' && u.active);
  const assignee = staff.find((u) => u.id === r.assignedToUserId) ?? null;

  const nextStatuses: DraftingStatus[] = ['IN_PRODUCTION', 'INTERNAL_REVIEW', 'AWAITING_SEAL', 'REVISION_REQUESTED', 'CANCELLED'];

  return (
    <div className="card p-3">
      <div className="flex items-start justify-between gap-2">
        <Link to={`/clients/${r.clientId}`} className="text-[13px] font-medium text-brand hover:underline truncate">
          {clientName ?? 'Unknown contractor'}
        </Link>
        {r.requiresSeal && (
          <span className="badge-amber shrink-0" title="At least one ordered service needs a Florida PE or RA seal">
            Seal
          </span>
        )}
      </div>

      <ul className="mt-1.5 space-y-0.5">
        {r.services.map((s) => (
          <li key={s} className="text-[12px] text-ink-soft leading-snug">
            {DRAFTING_LABELS[s]}
          </li>
        ))}
      </ul>

      <p className="mt-2 text-[12px] text-ink-soft leading-snug line-clamp-3">{r.brief}</p>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className={STATUS_CLASS[r.status]}>{STATUS_LABELS[r.status]}</span>
        {r.quotedCents != null && <span className="badge-gray tabular-nums">{formatCents(r.quotedCents)}</span>}
        {r.targetDeliveryAt && <span className="text-ink-mute">Target {fmtDate(r.targetDeliveryAt)}</span>}
      </div>

      <div className="mt-2 rounded bg-page px-2 py-1.5 text-[11px] text-ink-soft leading-snug">{r.nextStep}</div>

      {move.isError && <div className="mt-2 text-[11px] text-danger leading-snug">{errorMessage(move.error)}</div>}

      {(canQuote || canProduce) && (
        <div className="mt-2 space-y-1.5 border-t border-line pt-2">
          {canQuote && r.status !== 'DELIVERED' && r.status !== 'CANCELLED' && (
            <button type="button" className="btn-ghost w-full px-2 py-1 text-[12px]" onClick={onQuote}>
              {r.quotedCents == null ? 'Send a quote' : 'Requote'}
            </button>
          )}
          {canProduce && (
            <>
              {staff.length > 0 && (
                <label className="block">
                  <span className="sr-only">Assign this request</span>
                  <select
                    className="input py-1 text-[12px]"
                    value={r.assignedToUserId ?? ''}
                    disabled={move.isPending}
                    onChange={(e) => move.mutate({ assignedToUserId: e.target.value || null })}
                  >
                    <option value="">{assignee ? 'Unassign' : 'Assign to…'}</option>
                    {staff.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {r.status !== 'DELIVERED' && (
                <label className="block">
                  <span className="sr-only">Move to another status</span>
                  <select
                    className="input py-1 text-[12px]"
                    value=""
                    disabled={move.isPending}
                    onChange={(e) => {
                      const next = e.target.value as DraftingStatus;
                      if (next) move.mutate({ status: next });
                      e.target.value = '';
                    }}
                  >
                    <option value="">{move.isPending ? 'Moving…' : 'Move to…'}</option>
                    {nextStatuses
                      .filter((s) => s !== r.status)
                      .map((s) => (
                        <option key={s} value={s}>
                          {STATUS_LABELS[s]}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              {r.status !== 'DELIVERED' && r.status !== 'CANCELLED' && (
                <button type="button" className="btn-primary w-full px-2 py-1 text-[12px]" onClick={onDeliver}>
                  Deliver
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------

function ContractorList({ requests }: { requests: DraftingRow[] }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const canApprove = !!user && can(user.role, 'portal:request_drafting');

  const approve = useMutation({
    mutationFn: (id: string) => post(`/drafting/${id}/approve`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['drafting'] }),
  });

  const columns: Array<Column<DraftingRow>> = [
    {
      key: 'services',
      header: 'What we are drawing',
      sortValue: (r) => r.services[0] ?? '',
      render: (r) => (
        <div className="min-w-[220px]">
          <div className="text-[13px] font-medium">{r.services.map((s) => DRAFTING_LABELS[s]).join(', ')}</div>
          <div className="mt-0.5 text-[12px] text-ink-soft leading-snug line-clamp-2">{r.brief}</div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (r) => r.status,
      render: (r) => <span className={STATUS_CLASS[r.status]}>{STATUS_LABELS[r.status]}</span>,
    },
    {
      key: 'next',
      header: 'What happens next',
      render: (r) => <span className="text-[13px] text-ink-soft leading-snug block min-w-[200px]">{r.nextStep}</span>,
    },
    {
      key: 'quote',
      header: 'Quote',
      align: 'right',
      sortValue: (r) => r.quotedCents ?? -1,
      render: (r) => (
        <div className="whitespace-nowrap">
          <div className="tabular-nums text-[13px]">{r.quotedCents == null ? 'Not quoted' : formatCents(r.quotedCents)}</div>
          {r.quoteNote && <div className="text-[11px] text-ink-mute max-w-[200px] leading-snug">{r.quoteNote}</div>}
        </div>
      ),
    },
    {
      key: 'target',
      header: 'Target delivery',
      sortValue: (r) => r.targetDeliveryAt ?? '',
      render: (r) => <span className="text-[13px] whitespace-nowrap">{fmtDate(r.targetDeliveryAt)}</span>,
    },
    {
      key: 'action',
      header: '',
      render: (r) =>
        canApprove && r.quotedCents != null && !r.approvedAt && r.status !== 'CANCELLED' ? (
          <button
            type="button"
            className="btn-primary px-2.5 py-1 text-[12px]"
            disabled={approve.isPending}
            onClick={() => approve.mutate(r.id)}
          >
            {approve.isPending ? 'Approving…' : 'Approve the quote'}
          </button>
        ) : r.approvedAt ? (
          <span className="text-[12px] text-ink-mute whitespace-nowrap">Approved {fmtDate(r.approvedAt)}</span>
        ) : null,
    },
  ];

  return (
    <div className="space-y-2">
      {approve.isError && <ErrorState error={approve.error} compact title="Could not approve that quote" />}
      <DataTable<DraftingRow>
        columns={columns}
        rows={requests}
        rowKey={(r) => r.id}
        initialSort={{ key: 'target', dir: 'asc' }}
        empty={<EmptyState title="Nothing in the drafting queue" />}
        footer="We start work once you have approved the quote — never before."
      />
    </div>
  );
}

// --------------------------------------------------------------------------

function RequestDrawer({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [services, setServices] = useState<DraftingService[]>([]);
  const [projectId, setProjectId] = useState('');
  const [brief, setBrief] = useState('');
  const [files, setFiles] = useState<File[]>([]);

  const projectsQ = useQuery({
    queryKey: ['projects'],
    queryFn: () => get<ProjectListResponse>('/projects'),
  });

  const project = (projectsQ.data?.projects ?? []).find((p) => p.id === projectId) ?? null;

  const submit = useMutation({
    mutationFn: async () => {
      const inputDocumentIds: string[] = [];
      for (const file of files) {
        const payload = await readFileAsUpload(file);
        const uploaded = await post<DocumentUploadResponse>('/documents', {
          ...payload,
          clientId: project?.clientId,
          permitId: null,
          category: 'OTHER',
          requirementKey: 'drafting_input',
        });
        inputDocumentIds.push(uploaded.document.id);
      }
      return post('/drafting', { projectId, services, brief: brief.trim(), inputDocumentIds });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['drafting'] });
      onClose();
    },
  });

  const estimate = services.reduce((sum, s) => {
    const rate = DEFAULT_DRAFTING_RATES.find((r) => r.service === s);
    return sum + (rate?.baseCents ?? 0);
  }, 0);
  const anyQuoteRequired = services.some((s) => DEFAULT_DRAFTING_RATES.find((r) => r.service === s)?.quoteRequired);

  const valid = services.length > 0 && !!projectId && brief.trim().length > 0;

  return (
    <Drawer
      open
      onClose={onClose}
      title="Request drafting"
      subtitle="Pick what you need, attach the project, and tell us what it is for."
      width="600px"
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12px] text-ink-soft">Nothing is charged until you approve a quote.</span>
          <div className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn-primary" disabled={!valid || submit.isPending} onClick={() => submit.mutate()}>
              {submit.isPending ? 'Sending…' : 'Send request'}
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        {submit.isError && <ErrorState error={submit.error} compact title="Could not send the request" />}

        <fieldset>
          <legend className="label">Services</legend>
          <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
            {DRAFTING_SERVICES.map((s) => {
              const rate = DEFAULT_DRAFTING_RATES.find((r) => r.service === s);
              const checked = services.includes(s);
              return (
                <label
                  key={s}
                  className={`flex items-start gap-2 rounded-md border px-3 py-2 cursor-pointer transition-colors ${
                    checked ? 'border-brand bg-brand-soft' : 'border-line hover:bg-page'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 rounded border-line text-brand focus:ring-brand/30"
                    checked={checked}
                    onChange={(e) =>
                      setServices((prev) => (e.target.checked ? [...prev, s] : prev.filter((x) => x !== s)))
                    }
                  />
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium leading-snug">{DRAFTING_LABELS[s]}</span>
                    <span className="block text-[11px] text-ink-mute leading-snug">
                      {rate
                        ? `${rate.quoteRequired ? 'Quoted per job' : `From ${formatCents(rate.baseCents)}`} · typically ${rate.typicalTurnaroundDays} days${rate.requiresSeal ? ' · sealed' : ''}`
                        : ''}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          {services.length > 0 && (
            <p className="mt-2 text-[12px] text-ink-soft leading-snug">
              Indicative starting point: {formatCents(estimate)}.{' '}
              {anyQuoteRequired
                ? 'At least one of these is scoped per job, so treat that number as a floor rather than a price — we will send a real quote.'
                : 'Your quote will confirm it.'}
            </p>
          )}
        </fieldset>

        <label className="block">
          <span className="label">Project</span>
          {projectsQ.isLoading ? (
            <div className="mt-1 text-[13px] text-ink-mute">Loading projects…</div>
          ) : projectsQ.isError ? (
            <ErrorState error={projectsQ.error} compact title="Could not load projects" />
          ) : (
            <select className="input mt-1" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Choose a project</option>
              {(projectsQ.data?.projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {p.addressLine1}, {p.city}
                </option>
              ))}
            </select>
          )}
          <span className="mt-1 block text-[12px] text-ink-mute leading-snug">
            The project carries the jurisdiction and wind zone, which is what lets the drawings be built for the review
            they are going into rather than adjusted afterwards.
          </span>
        </label>

        <label className="block">
          <span className="label">Brief</span>
          <textarea
            className="input mt-1 min-h-[120px]"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="Re-roof of a 1968 ranch, existing 3-tab going to architectural shingle. Need the wind uplift calcs and an attachment detail for the county. Survey and existing photos attached."
          />
          <span className="mt-1 block text-[12px] text-ink-mute leading-snug">In your words. We would rather read too much than guess.</span>
        </label>

        <label className="block">
          <span className="label">Reference files</span>
          <input
            type="file"
            multiple
            className="input mt-1 file:mr-3 file:rounded file:border-0 file:bg-page file:px-2 file:py-1 file:text-[12px]"
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          />
          {files.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {files.map((f) => (
                <li key={f.name} className="text-[12px] text-ink-soft">
                  {f.name} · {fmtBytes(f.size)}
                </li>
              ))}
            </ul>
          )}
          <span className="mt-1 block text-[12px] text-ink-mute leading-snug">
            Sketches, a survey, photos of what is there now. Up to 20MB each.
          </span>
        </label>
      </div>
    </Drawer>
  );
}

// --------------------------------------------------------------------------

function QuoteDrawer({ request, onClose }: { request: DraftingRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState(request.quotedCents != null ? (request.quotedCents / 100).toFixed(2) : '');
  const [note, setNote] = useState(request.quoteNote ?? '');
  const [target, setTarget] = useState(request.targetDeliveryAt?.slice(0, 10) ?? '');

  const quote = useMutation({
    mutationFn: () =>
      post(`/drafting/${request.id}/quote`, {
        quotedCents: Math.round(Number(amount.replace(/[^0-9.]/g, '')) * 100),
        quoteNote: note.trim() || null,
        targetDeliveryAt: target ? new Date(target).toISOString() : null,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['drafting'] });
      onClose();
    },
  });

  const cents = Math.round(Number(amount.replace(/[^0-9.]/g, '')) * 100);
  const valid = Number.isFinite(cents) && cents >= 0 && amount.trim() !== '';

  return (
    <Drawer
      open
      onClose={onClose}
      title="Quote this request"
      subtitle={request.services.map((s) => DRAFTING_LABELS[s]).join(', ')}
      width="520px"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" disabled={!valid || quote.isPending} onClick={() => quote.mutate()}>
            {quote.isPending ? 'Sending…' : 'Send the quote'}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        {quote.isError && <ErrorState error={quote.error} compact title="Could not send the quote" />}

        <div className="rounded-md bg-page px-3 py-2.5 text-[13px] text-ink-soft leading-snug">{request.brief}</div>

        <label className="block">
          <span className="label">Price (USD)</span>
          <input className="input mt-1" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1850.00" />
          {valid && <span className="mt-1 block text-[12px] text-ink-mute">Stored as {formatCents(cents)}.</span>}
        </label>

        <label className="block">
          <span className="label">Target delivery</span>
          <input type="date" className="input mt-1" value={target} onChange={(e) => setTarget(e.target.value)} />
        </label>

        <label className="block">
          <span className="label">Note to the contractor</span>
          <textarea
            className="input mt-1 min-h-[100px]"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Includes the sealed uplift calcs and one revision after the first county comment."
          />
        </label>

        <p className="text-[12px] text-ink-soft leading-snug">
          Sending a quote moves this to “awaiting approval”. Production does not start until the contractor approves the
          number.
        </p>
      </div>
    </Drawer>
  );
}

// --------------------------------------------------------------------------

function DeliverDrawer({ request, onClose }: { request: DraftingRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [files, setFiles] = useState<File[]>([]);
  const [note, setNote] = useState('');

  const deliver = useMutation({
    mutationFn: async () => {
      const outputDocumentIds: string[] = [];
      for (const file of files) {
        const payload = await readFileAsUpload(file);
        const uploaded = await post<DocumentUploadResponse>('/documents', {
          ...payload,
          clientId: request.clientId,
          permitId: null,
          category: 'PLAN_SET',
        });
        outputDocumentIds.push(uploaded.document.id);
      }
      return post(`/drafting/${request.id}/deliver`, {
        outputDocumentIds,
        permitId: request.permitId,
        note: note.trim() || undefined,
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['drafting'] });
      void qc.invalidateQueries({ queryKey: ['documents'] });
      onClose();
    },
  });

  return (
    <Drawer
      open
      onClose={onClose}
      title="Deliver the finished work"
      subtitle={request.services.map((s) => DRAFTING_LABELS[s]).join(', ')}
      width="560px"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={files.length === 0 || deliver.isPending}
            onClick={() => deliver.mutate()}
          >
            {deliver.isPending ? 'Delivering…' : 'Deliver'}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        {deliver.isError && <ErrorState error={deliver.error} compact title="Could not deliver this" />}

        <div className="rounded-md bg-brand-soft px-3 py-2.5 text-[13px] text-ink-soft leading-relaxed">
          Delivering attaches these files to the permit and marks the requirement lines the ordered services are
          expected to satisfy
          {request.satisfiesRequirementKeys.length > 0 && (
            <>
              {' '}
              — <span className="font-mono text-[12px]">{request.satisfiesRequirementKeys.join(', ')}</span>
            </>
          )}
          . Where one set answers two lines, the second is an alias pointing at the same bytes and the same SHA-256.
        </div>

        {!request.permitId && (
          <div className="rounded-md border border-warn/25 bg-warn-soft px-3 py-2 text-[13px] text-warn leading-snug">
            This request is not attached to a permit yet, so the output lands in the contractor's folder and will be in
            the package the moment a permit is created.
          </div>
        )}

        <label className="block">
          <span className="label">Output files</span>
          <input
            type="file"
            multiple
            className="input mt-1 file:mr-3 file:rounded file:border-0 file:bg-page file:px-2 file:py-1 file:text-[12px]"
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          />
          {files.length > 0 ? (
            <ul className="mt-2 space-y-0.5">
              {files.map((f) => (
                <li key={f.name} className="text-[12px] text-ink-soft">
                  {f.name} · {fmtBytes(f.size)}
                </li>
              ))}
            </ul>
          ) : (
            <span className="mt-1 block text-[12px] text-ink-mute">At least one file is required to deliver.</span>
          )}
        </label>

        {request.requiresSeal && !request.sealedAt && (
          <div className="rounded-md border border-warn/25 bg-warn-soft px-3 py-2 text-[13px] text-warn leading-snug">
            One or more of these services normally needs a Florida PE or RA seal and no seal has been recorded on this
            request. Confirm the uploaded set is sealed before you deliver it.
          </div>
        )}

        <label className="block">
          <span className="label">Delivery note</span>
          <textarea className="input mt-1 min-h-[80px]" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>

        {request.deliveredAt && (
          <p className="text-[12px] text-ink-mute">Previously delivered {fmtDateTime(request.deliveredAt)}.</p>
        )}
      </div>
    </Drawer>
  );
}

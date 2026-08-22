import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { can } from '@flph/shared';
import { get, patch, post } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { fmtDate, fmtDateTime, humanEnum } from '../lib/format.ts';
import {
  NOTARY_PROVIDERS,
  NOTARY_PROVIDER_LABELS,
  NOTARY_TYPES,
  type ClientListResponse,
  type DocumentListResponse,
  type NotaryListResponse,
  type NotaryProvider,
  type NotaryRequest,
  type NotaryStatus,
  type NotaryType,
} from '../lib/api-shapes.ts';
import DataTable, { type Column } from '../components/DataTable.tsx';
import DocumentLink from '../components/DocumentLink.tsx';
import Drawer from '../components/Drawer.tsx';
import EmptyState from '../components/EmptyState.tsx';
import ErrorState from '../components/ErrorState.tsx';
import KpiCard from '../components/KpiCard.tsx';
import { LoadingPanel } from '../components/Spinner.tsx';

/**
 * The notarization queue.
 *
 * This screen tracks notarizations. It does not perform them, and that
 * distinction is the whole design — see the note rendered at the top of the
 * page, which is not filler. What is stored is the chain of custody: which
 * registered provider handled it, which commissioned notary, their commission
 * number, where the session recording lives, and the date ten years out before
 * which nothing may be destroyed.
 */

const STATUS_CLASS: Record<NotaryStatus, string> = {
  REQUESTED: 'badge-gray',
  SCHEDULED: 'badge-blue',
  COMPLETED: 'badge-green',
  FAILED: 'badge-red',
  CANCELLED: 'badge-gray',
};

export default function Notary() {
  const { user } = useAuth();
  const [statusFilter, setStatusFilter] = useState('');
  const [open, setOpen] = useState<NotaryRequest | null>(null);
  const [creating, setCreating] = useState(false);

  const canManage = !!user && can(user.role, 'document:upload');

  const q = useQuery({
    queryKey: ['notary'],
    queryFn: () => get<NotaryListResponse>('/notary'),
  });

  const clientsQ = useQuery({
    queryKey: ['clients'],
    queryFn: () => get<ClientListResponse>('/clients'),
    staleTime: 5 * 60_000,
  });

  const documentsQ = useQuery({
    queryKey: ['documents'],
    queryFn: () => get<DocumentListResponse>('/documents'),
    staleTime: 60_000,
  });

  const clientName = useMemo(
    () => new Map((clientsQ.data?.clients ?? []).map((c) => [c.id, c.name])),
    [clientsQ.data],
  );
  const docName = useMemo(
    () => new Map((documentsQ.data?.documents ?? []).map((d) => [d.id, d.fileName])),
    [documentsQ.data],
  );

  const requests = q.data?.requests ?? [];
  const rows = requests.filter((r) => !statusFilter || r.status === statusFilter);
  const completedRon = requests.filter((r) => r.status === 'COMPLETED' && r.type === 'RON');
  const missingRecording = completedRon.filter((r) => !r.sessionRecordingRef).length;

  const columns: Array<Column<NotaryRequest>> = [
    {
      key: 'document',
      header: 'Document',
      sortValue: (r) => docName.get(r.documentId) ?? '',
      render: (r) => (
        <div className="min-w-[200px]">
          <DocumentLink documentId={r.documentId} className="link text-[13px] font-medium text-left">
            {docName.get(r.documentId) ?? r.documentId.slice(0, 8)}
          </DocumentLink>
          <div className="text-[12px] text-ink-mute">
            <Link to={`/clients/${r.clientId}`} className="hover:underline">
              {clientName.get(r.clientId) ?? 'Unknown contractor'}
            </Link>
          </div>
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      sortValue: (r) => r.type,
      render: (r) => (
        <span className={r.type === 'RON' ? 'badge-blue' : 'badge-gray'}>
          {r.type === 'RON' ? 'Remote online' : 'In person'}
        </span>
      ),
    },
    {
      key: 'provider',
      header: 'Provider',
      sortValue: (r) => r.provider ?? '',
      render: (r) => (
        <span className="text-[13px]">{r.provider ? NOTARY_PROVIDER_LABELS[r.provider] : <span className="text-ink-mute">Not chosen</span>}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (r) => r.status,
      render: (r) => <span className={STATUS_CLASS[r.status]}>{humanEnum(r.status)}</span>,
    },
    {
      key: 'scheduled',
      header: 'Scheduled',
      sortValue: (r) => r.scheduledFor ?? '',
      render: (r) => <span className="whitespace-nowrap text-[13px]">{fmtDateTime(r.scheduledFor)}</span>,
    },
    {
      key: 'notary',
      header: 'Notary',
      sortValue: (r) => r.notaryName ?? '',
      render: (r) => (
        <div className="min-w-[150px]">
          <div className="text-[13px]">{r.notaryName ?? <span className="text-ink-mute">—</span>}</div>
          {r.notaryCommissionNumber && (
            <div className="font-mono text-[11px] text-ink-mute">
              {r.notaryCommissionNumber}
              {r.notaryCommissionExpiresAt && ` · exp ${fmtDate(r.notaryCommissionExpiresAt)}`}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'recording',
      header: 'Recording / retention',
      render: (r) => {
        if (r.status !== 'COMPLETED') return <span className="text-ink-mute">—</span>;
        return (
          <div className="min-w-[190px]">
            {r.sessionRecordingRef ? (
              <div className="font-mono text-[11px] break-all">{r.sessionRecordingRef}</div>
            ) : r.type === 'RON' ? (
              <span className="badge-red">No recording reference</span>
            ) : (
              <span className="text-[12px] text-ink-mute">Not applicable in person</span>
            )}
            {r.retentionUntil && (
              <div className="mt-0.5 text-[11px] text-ink-soft">Retain until {fmtDate(r.retentionUntil)}</div>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold">Notarization</h1>
          <p className="mt-1 text-sm text-ink-soft max-w-3xl leading-relaxed">
            Permit applications in many Florida jurisdictions, owner-builder affidavits and the notice of commencement
            under Chapter 713 all have to be notarized. This queue tracks where each one is.
          </p>
        </div>
        {canManage && (
          <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
            Request notarization
          </button>
        )}
      </div>

      <div className="card card-pad border-l-4 border-brand">
        <h2 className="text-sm font-semibold">Why a registered provider, and not this app</h2>
        <p className="mt-1.5 text-[13px] text-ink-soft leading-relaxed max-w-3xl">
          Florida's online notarization rules (Chapter 117, Part II) set a bar deliberately higher than an electronic
          signature. A remote online notarization requires <span className="font-medium text-ink">identity proofing</span>{' '}
          through third-party knowledge-based authentication,{' '}
          <span className="font-medium text-ink">credential analysis</span> of the government ID itself, a notary
          holding a separate RON commission, and an audio-video recording of the session{' '}
          <span className="font-medium text-ink">retained for ten years</span> (§117.245). Each of those is a regulated
          capability belonging to a commissioned notary and an approved provider — so we hold the pointer to the record
          and the provider holds the regulated artefact.
        </p>
        <p className="mt-2 text-[13px] text-ink-soft leading-relaxed max-w-3xl">
          One judgement this screen cannot make for you: under §117.05(12) a notary may not notarize a signature on a
          document they are a party to. Where the firm is the permit agent on the document being notarized, an in-house
          notary is the wrong choice.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <KpiCard label="Open" value={q.data?.openCount ?? 0} hint="Requested or scheduled and not yet performed." />
        <KpiCard
          label="Completed"
          value={requests.filter((r) => r.status === 'COMPLETED').length}
          hint="Notarial acts performed and evidenced."
        />
        <KpiCard
          label="RON sessions"
          value={completedRon.length}
          hint="Remote online notarizations. Each carries a ten-year retention obligation."
        />
        <KpiCard
          label="Missing a recording"
          value={missingRecording}
          accent={missingRecording > 0 ? 'danger' : 'none'}
          hint="Completed RON with no session recording reference. The API refuses these, so a non-zero number needs investigating."
        />
      </div>

      <div className="card card-pad">
        <label className="label" htmlFor="n-status">Status</label>
        <select
          id="n-status"
          className="input mt-1 max-w-xs"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="">Any status</option>
          {(['REQUESTED', 'SCHEDULED', 'COMPLETED', 'FAILED', 'CANCELLED'] as NotaryStatus[]).map((s) => (
            <option key={s} value={s}>
              {humanEnum(s)}
            </option>
          ))}
        </select>
      </div>

      {q.isLoading && <LoadingPanel label="Loading the notary queue…" rows={4} />}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load notarization requests" />}

      {!q.isLoading && !q.isError && (
        <DataTable<NotaryRequest>
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          dense
          initialSort={{ key: 'scheduled', dir: 'asc' }}
          onRowClick={(r) => setOpen(r)}
          rowClassName={(r) => (r.status === 'FAILED' ? 'bg-danger-soft/40' : '')}
          empty={
            <EmptyState
              title={requests.length === 0 ? 'Nothing in the notary queue' : 'No requests match this filter'}
              hint={
                requests.length === 0
                  ? 'Raise a request against the document that needs notarizing, then record which provider and which commissioned notary performed it.'
                  : 'Try a different status.'
              }
              action={
                canManage && requests.length === 0 ? (
                  <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
                    Request notarization
                  </button>
                ) : undefined
              }
            />
          }
          footer="Click a row to schedule it or record the completed act."
        />
      )}

      {open && (
        <RequestDrawer
          request={open}
          documentName={docName.get(open.documentId) ?? null}
          clientName={clientName.get(open.clientId) ?? null}
          canManage={canManage}
          onClose={() => setOpen(null)}
        />
      )}
      {creating && canManage && <CreateDrawer onClose={() => setCreating(false)} />}
    </div>
  );
}

// --------------------------------------------------------------------------

function RequestDrawer({
  request,
  documentName,
  clientName,
  canManage,
  onClose,
}: {
  request: NotaryRequest;
  documentName: string | null;
  clientName: string | null;
  canManage: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const done = request.status === 'COMPLETED';

  const [provider, setProvider] = useState<NotaryProvider | ''>(request.provider ?? '');
  const [scheduledFor, setScheduledFor] = useState(request.scheduledFor?.slice(0, 16) ?? '');
  const [notaryName, setNotaryName] = useState(request.notaryName ?? '');
  const [commission, setCommission] = useState(request.notaryCommissionNumber ?? '');
  const [commissionExpires, setCommissionExpires] = useState(request.notaryCommissionExpiresAt?.slice(0, 10) ?? '');
  const [recordingRef, setRecordingRef] = useState(request.sessionRecordingRef ?? '');
  const [journalRef, setJournalRef] = useState(request.journalEntryRef ?? '');

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['notary'] });

  const schedule = useMutation({
    mutationFn: () =>
      patch(`/notary/${request.id}`, {
        provider: provider || null,
        scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : null,
        notaryName: notaryName.trim() || null,
        notaryCommissionNumber: commission.trim() || null,
        notaryCommissionExpiresAt: commissionExpires ? new Date(commissionExpires).toISOString() : null,
      }),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });

  const complete = useMutation({
    mutationFn: () =>
      post(`/notary/${request.id}/complete`, {
        provider,
        notaryName: notaryName.trim(),
        notaryCommissionNumber: commission.trim(),
        notaryCommissionExpiresAt: commissionExpires ? new Date(commissionExpires).toISOString() : null,
        sessionRecordingRef: recordingRef.trim() || null,
        journalEntryRef: journalRef.trim() || null,
      }),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });

  const canComplete =
    !!provider &&
    notaryName.trim().length > 0 &&
    commission.trim().length > 0 &&
    (request.type !== 'RON' || recordingRef.trim().length > 0);

  return (
    <Drawer
      open
      onClose={onClose}
      title={documentName ?? 'Notarization request'}
      subtitle={`${clientName ?? 'Contractor'} · ${request.type === 'RON' ? 'Remote online notarization' : 'In person'}`}
      width="600px"
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className={STATUS_CLASS[request.status]}>{humanEnum(request.status)}</span>
          <div className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Close
            </button>
            {canManage && !done && (
              <>
                <button type="button" className="btn-ghost" disabled={schedule.isPending} onClick={() => schedule.mutate()}>
                  {schedule.isPending ? 'Saving…' : 'Save scheduling'}
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={!canComplete || complete.isPending}
                  onClick={() => complete.mutate()}
                >
                  {complete.isPending ? 'Recording…' : 'Record as completed'}
                </button>
              </>
            )}
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {schedule.isError && <ErrorState error={schedule.error} compact title="Could not save" />}
        {complete.isError && <ErrorState error={complete.error} compact title="Could not record completion" />}

        {done && (
          <div className="rounded-md border border-good/30 bg-good-soft px-3 py-2.5">
            <div className="text-[13px] font-semibold text-good">
              Completed {fmtDateTime(request.completedAt)} — this is a finished record and cannot be edited
            </div>
            {request.retentionUntil && (
              <p className="mt-1 text-[12px] text-ink-soft leading-snug">
                The provider must retain the session recording and journal entry until{' '}
                <span className="font-medium">{fmtDate(request.retentionUntil)}</span> — ten years from the notarial
                act, §117.245, F.S.
              </p>
            )}
          </div>
        )}

        <label className="block">
          <span className="label">Provider</span>
          <select
            className="input mt-1"
            value={provider}
            disabled={done || !canManage}
            onChange={(e) => setProvider(e.target.value as NotaryProvider | '')}
          >
            <option value="">Not chosen</option>
            {NOTARY_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {NOTARY_PROVIDER_LABELS[p]}
              </option>
            ))}
          </select>
          {request.type === 'RON' && provider === 'IN_HOUSE' && (
            <span className="mt-1 block text-[12px] text-warn leading-snug">
              A remote online notarization has to run through a registered RON provider. In-house is only right where a
              commissioned notary is physically present.
            </span>
          )}
        </label>

        <label className="block">
          <span className="label">Scheduled for</span>
          <input
            type="datetime-local"
            className="input mt-1"
            value={scheduledFor}
            disabled={done || !canManage}
            onChange={(e) => setScheduledFor(e.target.value)}
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="label">Notary name</span>
            <input className="input mt-1" value={notaryName} disabled={done || !canManage} onChange={(e) => setNotaryName(e.target.value)} />
          </label>
          <label className="block">
            <span className="label">Commission number</span>
            <input className="input mt-1 font-mono" value={commission} disabled={done || !canManage} onChange={(e) => setCommission(e.target.value)} />
          </label>
        </div>

        <label className="block">
          <span className="label">Commission expires</span>
          <input
            type="date"
            className="input mt-1"
            value={commissionExpires}
            disabled={done || !canManage}
            onChange={(e) => setCommissionExpires(e.target.value)}
          />
        </label>

        <div className="border-t border-line pt-4 space-y-3">
          <div>
            <h3 className="text-sm font-semibold">Evidence held by the provider</h3>
            <p className="mt-0.5 text-[12px] text-ink-soft leading-snug">
              We store the pointer, not the artefact. A completed RON with nowhere to find the recording is not a
              complete record, and the API refuses it.
            </p>
          </div>
          <label className="block">
            <span className="label">
              Session recording reference{request.type === 'RON' ? ' (required for RON)' : ''}
            </span>
            <input
              className="input mt-1 font-mono text-[13px]"
              value={recordingRef}
              disabled={done || !canManage}
              onChange={(e) => setRecordingRef(e.target.value)}
              placeholder="proof://session/9f13c2…"
            />
          </label>
          <label className="block">
            <span className="label">Journal entry reference</span>
            <input
              className="input mt-1 font-mono text-[13px]"
              value={journalRef}
              disabled={done || !canManage}
              onChange={(e) => setJournalRef(e.target.value)}
            />
          </label>
        </div>

        {request.externalId && (
          <p className="text-[12px] text-ink-mute">
            Provider reference <span className="font-mono">{request.externalId}</span>
          </p>
        )}
      </div>
    </Drawer>
  );
}

// --------------------------------------------------------------------------

function CreateDrawer({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [clientId, setClientId] = useState('');
  const [documentId, setDocumentId] = useState('');
  const [type, setType] = useState<NotaryType>('RON');
  const [provider, setProvider] = useState<NotaryProvider | ''>('');
  const [scheduledFor, setScheduledFor] = useState('');

  const clientsQ = useQuery({ queryKey: ['clients'], queryFn: () => get<ClientListResponse>('/clients') });
  const documentsQ = useQuery({
    queryKey: ['documents', clientId],
    queryFn: () => get<DocumentListResponse>(clientId ? `/documents?clientId=${clientId}` : '/documents'),
  });

  const create = useMutation({
    mutationFn: () =>
      post('/notary', {
        documentId,
        type,
        provider: provider || null,
        scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : null,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['notary'] });
      onClose();
    },
  });

  return (
    <Drawer
      open
      onClose={onClose}
      title="Request notarization"
      subtitle="Against a document already in the vault."
      width="560px"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" disabled={!documentId || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? 'Creating…' : 'Create request'}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        {create.isError && <ErrorState error={create.error} compact title="Could not create the request" />}

        <label className="block">
          <span className="label">Contractor</span>
          <select
            className="input mt-1"
            value={clientId}
            onChange={(e) => {
              setClientId(e.target.value);
              setDocumentId('');
            }}
          >
            <option value="">All contractors</option>
            {(clientsQ.data?.clients ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="label">Document</span>
          {documentsQ.isLoading ? (
            <div className="mt-1 text-[13px] text-ink-mute">Loading documents…</div>
          ) : (
            <select className="input mt-1" value={documentId} onChange={(e) => setDocumentId(e.target.value)}>
              <option value="">Choose the document to notarize</option>
              {(documentsQ.data?.documents ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.fileName} ({humanEnum(d.category)})
                </option>
              ))}
            </select>
          )}
        </label>

        <label className="block">
          <span className="label">Type</span>
          <select className="input mt-1" value={type} onChange={(e) => setType(e.target.value as NotaryType)}>
            {NOTARY_TYPES.map((t) => (
              <option key={t} value={t}>
                {t === 'RON' ? 'Remote online notarization' : 'In person'}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-[12px] text-ink-mute leading-snug">
            RON needs a commissioned online notary and a registered provider, and creates a ten-year retention
            obligation on the session recording.
          </span>
        </label>

        <label className="block">
          <span className="label">Provider</span>
          <select className="input mt-1" value={provider} onChange={(e) => setProvider(e.target.value as NotaryProvider | '')}>
            <option value="">Decide later</option>
            {NOTARY_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {NOTARY_PROVIDER_LABELS[p]}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="label">Scheduled for</span>
          <input type="datetime-local" className="input mt-1" value={scheduledFor} onChange={(e) => setScheduledFor(e.target.value)} />
        </label>
      </div>
    </Drawer>
  );
}

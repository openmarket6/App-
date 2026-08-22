import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { DOCUMENT_CATEGORIES, type PermitDocument } from '@flph/shared';
import { get } from '../lib/api.ts';
import { fmtDate, fmtDateTime, humanEnum } from '../lib/format.ts';
import { fmtBytes } from '../lib/upload.ts';
import type {
  ClientListResponse,
  ComplianceExpiringResponse,
  DocumentListResponse,
  ExpiringComplianceRow,
} from '../lib/api-shapes.ts';
import type { PermitListResponse } from '../lib/types.ts';
import ComplianceBadge, { complianceRowClass, expiryPhrase } from '../components/ComplianceBadge.tsx';
import DataTable, { type Column } from '../components/DataTable.tsx';
import DocumentLink from '../components/DocumentLink.tsx';
import EmptyState from '../components/EmptyState.tsx';
import ErrorState from '../components/ErrorState.tsx';
import KpiCard from '../components/KpiCard.tsx';
import { LoadingPanel } from '../components/Spinner.tsx';

/**
 * Firm-wide compliance and documents.
 *
 * The expiring table is the reason this screen exists. A lapsed general
 * liability policy is not usually discovered when it lapses — it is discovered
 * on inspection day, by an inspector, at the most expensive possible moment. A
 * list sorted by soonest expiry is the cheap version of that discovery, and it
 * keeps already-expired rows rather than dropping them at zero, because a
 * lapse that scrolls off the list is a lapse nobody chases.
 */

const WINDOWS = [15, 30, 45, 60, 90];

export default function Compliance() {
  const [days, setDays] = useState(45);
  const [docFilters, setDocFilters] = useState({ clientId: '', category: '', permitId: '', q: '' });

  const expiringQ = useQuery({
    queryKey: ['compliance', 'expiring', days],
    queryFn: () => get<ComplianceExpiringResponse>(`/compliance/expiring?days=${days}`),
  });

  const clientsQ = useQuery({
    queryKey: ['clients'],
    queryFn: () => get<ClientListResponse>('/clients'),
    staleTime: 5 * 60_000,
  });

  const permitsQ = useQuery({
    queryKey: ['permits'],
    queryFn: () => get<PermitListResponse>('/permits'),
    staleTime: 60_000,
  });

  const docQuery = useMemo(() => {
    const p = new URLSearchParams();
    if (docFilters.clientId) p.set('clientId', docFilters.clientId);
    if (docFilters.category) p.set('category', docFilters.category);
    if (docFilters.permitId) p.set('permitId', docFilters.permitId);
    const qs = p.toString();
    return qs ? `/documents?${qs}` : '/documents';
  }, [docFilters.clientId, docFilters.category, docFilters.permitId]);

  const documentsQ = useQuery({
    queryKey: ['documents', docFilters.clientId, docFilters.category, docFilters.permitId],
    queryFn: () => get<DocumentListResponse>(docQuery),
  });

  const clientName = useMemo(
    () => new Map((clientsQ.data?.clients ?? []).map((c) => [c.id, c.name])),
    [clientsQ.data],
  );

  const permitLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of permitsQ.data?.permits ?? []) {
      m.set(p.id, `${p.agencyRecordId ?? 'No number'} — ${p.projectName ?? p.projectAddress ?? 'Unnamed project'}`);
    }
    return m;
  }, [permitsQ.data]);

  const expiring = expiringQ.data?.items ?? [];
  const expired = expiringQ.data?.expiredCount ?? 0;
  const heldContractors = new Set(expiring.filter((r) => r.clientOnFilingHold).map((r) => r.clientId)).size;

  const documents = useMemo(() => {
    const rows = documentsQ.data?.documents ?? [];
    if (!docFilters.q.trim()) return rows;
    const q = docFilters.q.toLowerCase();
    return rows.filter(
      (d) =>
        d.fileName.toLowerCase().includes(q) ||
        d.requirementKey.toLowerCase().includes(q) ||
        (clientName.get(d.clientId) ?? '').toLowerCase().includes(q),
    );
  }, [documentsQ.data, docFilters.q, clientName]);

  const expiringColumns: Array<Column<ExpiringComplianceRow>> = [
    {
      key: 'client',
      header: 'Contractor',
      sortValue: (r) => r.clientName ?? '',
      render: (r) => (
        <div className="min-w-[170px]">
          <Link to={`/clients/${r.clientId}?tab=compliance`} className="font-medium text-brand hover:underline">
            {r.clientName ?? 'Unknown contractor'}
          </Link>
          {r.clientOnFilingHold && <div className="mt-0.5"><span className="badge-red">On filing hold</span></div>}
        </div>
      ),
    },
    {
      key: 'kind',
      header: 'Item',
      sortValue: (r) => r.label,
      render: (r) => <span className="text-[13px]">{r.label}</span>,
    },
    {
      key: 'carrier',
      header: 'Carrier / issuer',
      sortValue: (r) => r.carrier ?? '',
      render: (r) => <span className="text-[13px]">{r.carrier ?? '—'}</span>,
    },
    {
      key: 'policy',
      header: 'Policy no.',
      sortValue: (r) => r.policyNumber ?? '',
      render: (r) => <span className="font-mono text-[12px]">{r.policyNumber ?? '—'}</span>,
    },
    {
      key: 'expires',
      header: 'Expires',
      sortValue: (r) => r.expiresAt ?? '',
      render: (r) => <span className="whitespace-nowrap text-[13px]">{fmtDate(r.expiresAt)}</span>,
    },
    {
      key: 'days',
      header: 'Days left',
      align: 'right',
      sortValue: (r) => r.daysUntilExpiry ?? 9999,
      render: (r) => (
        <span
          className={`tabular-nums font-medium ${
            (r.daysUntilExpiry ?? 0) < 0 ? 'text-danger' : (r.daysUntilExpiry ?? 0) <= 14 ? 'text-warn' : ''
          }`}
          title={expiryPhrase(r.daysUntilExpiry)}
        >
          {r.daysUntilExpiry ?? '—'}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (r) => r.effectiveStatus,
      render: (r) => <ComplianceBadge status={r.effectiveStatus} />,
    },
  ];

  const documentColumns: Array<Column<PermitDocument>> = [
    {
      key: 'file',
      header: 'File',
      sortValue: (d) => d.fileName,
      render: (d) => (
        <div className="min-w-[220px]">
          <DocumentLink documentId={d.id} className="link text-[13px] font-medium text-left">
            {d.fileName}
          </DocumentLink>
          <div className="text-[12px] text-ink-mute">
            {fmtBytes(d.sizeBytes)} · v{d.version}
            {d.supersedesId && ' · supersedes an earlier revision'}
          </div>
        </div>
      ),
    },
    {
      key: 'client',
      header: 'Contractor',
      sortValue: (d) => clientName.get(d.clientId) ?? '',
      render: (d) => (
        <Link to={`/clients/${d.clientId}?tab=documents`} className="text-[13px] text-brand hover:underline">
          {clientName.get(d.clientId) ?? d.clientId.slice(0, 8)}
        </Link>
      ),
    },
    {
      key: 'category',
      header: 'Category',
      sortValue: (d) => d.category,
      render: (d) => <span className="badge-gray whitespace-nowrap">{humanEnum(d.category)}</span>,
    },
    {
      key: 'permit',
      header: 'Permit',
      sortValue: (d) => d.permitId ?? '',
      render: (d) =>
        d.permitId ? (
          <Link to={`/permits/${d.permitId}`} className="text-[12px] text-brand hover:underline">
            {permitLabel.get(d.permitId) ?? d.permitId.slice(0, 8)}
          </Link>
        ) : (
          <span className="text-[12px] text-ink-mute">Contractor folder</span>
        ),
    },
    {
      key: 'requirement',
      header: 'Requirement',
      sortValue: (d) => d.requirementKey,
      render: (d) => <span className="font-mono text-[12px]">{d.requirementKey || '—'}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (d) => d.status,
      render: (d) => (
        <span
          className={
            d.status === 'ACCEPTED'
              ? 'badge-green'
              : d.status === 'REJECTED'
                ? 'badge-red'
                : d.status === 'SUPERSEDED'
                  ? 'badge-gray'
                  : 'badge-blue'
          }
        >
          {humanEnum(d.status)}
        </span>
      ),
    },
    {
      key: 'uploaded',
      header: 'Uploaded',
      sortValue: (d) => d.uploadedAt,
      render: (d) => <span className="whitespace-nowrap text-[12px] text-ink-soft">{fmtDateTime(d.uploadedAt)}</span>,
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Documents and compliance</h1>
        <p className="mt-1 text-sm text-ink-soft max-w-3xl leading-relaxed">
          Everything the firm holds on paper, in two views: what is about to lapse, and where a specific file went.
          Expired items stay in the top table on purpose — dropping them at zero is how a lapse gets forgotten.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <KpiCard
          label="Expiring in window"
          value={expiring.length}
          hint={`Compliance items inside the next ${days} days, expired ones included.`}
        />
        <KpiCard
          label="Already expired"
          value={expired}
          accent={expired > 0 ? 'danger' : 'none'}
          hint="Past the expiry date. Anything blocking here stops new filings for that contractor."
        />
        <KpiCard
          label="Contractors on hold"
          value={heldContractors}
          accent={heldContractors > 0 ? 'warn' : 'none'}
          hint="Of the contractors in this list, how many already have a filing hold placed."
          to="/clients"
        />
        <KpiCard
          label="Documents"
          value={documentsQ.data?.total ?? '—'}
          hint="Files matching the browser filters below. Every revision stays addressable."
        />
      </div>

      {/* --- expiring ------------------------------------------------------ */}
      <section className="space-y-3">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold">Expiring soon</h2>
            <p className="mt-0.5 text-[12px] text-ink-soft">Sorted by soonest first. Expired rows sort to the top.</p>
          </div>
          <label className="flex items-center gap-2">
            <span className="label">Window</span>
            <select className="input py-1.5 w-auto" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {WINDOWS.map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          </label>
        </div>

        {expiringQ.isLoading && <LoadingPanel label="Checking expiry dates…" rows={4} />}
        {expiringQ.isError && (
          <ErrorState error={expiringQ.error} onRetry={() => void expiringQ.refetch()} title="Could not load expiring items" />
        )}
        {!expiringQ.isLoading && !expiringQ.isError && (
          <DataTable<ExpiringComplianceRow>
            columns={expiringColumns}
            rows={expiring}
            rowKey={(r) => r.id}
            dense
            initialSort={{ key: 'days', dir: 'asc' }}
            rowClassName={(r) => complianceRowClass(r.effectiveStatus)}
            empty={
              <EmptyState
                title={`Nothing expires in the next ${days} days`}
                hint="Widen the window if you are planning further ahead. Waived and rejected items are deliberately left out of this list."
              />
            }
            footer={`${expiring.length} item${expiring.length === 1 ? '' : 's'} · ${expired} already expired`}
          />
        )}
      </section>

      {/* --- document browser ---------------------------------------------- */}
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">Document browser</h2>
          <p className="mt-0.5 text-[12px] text-ink-soft">
            Documents version rather than overwrite, so a superseded revision is still here and still downloadable.
          </p>
        </div>

        <div className="card card-pad">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
            <div>
              <label className="label" htmlFor="d-client">Contractor</label>
              <select
                id="d-client"
                className="input mt-1"
                value={docFilters.clientId}
                onChange={(e) => setDocFilters((f) => ({ ...f, clientId: e.target.value, permitId: '' }))}
              >
                <option value="">All contractors</option>
                {(clientsQ.data?.clients ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="d-cat">Category</label>
              <select
                id="d-cat"
                className="input mt-1"
                value={docFilters.category}
                onChange={(e) => setDocFilters((f) => ({ ...f, category: e.target.value }))}
              >
                <option value="">All categories</option>
                {DOCUMENT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {humanEnum(c)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="d-permit">Permit</label>
              <select
                id="d-permit"
                className="input mt-1"
                value={docFilters.permitId}
                onChange={(e) => setDocFilters((f) => ({ ...f, permitId: e.target.value }))}
              >
                <option value="">Any permit</option>
                {(permitsQ.data?.permits ?? [])
                  .filter((p) => !docFilters.clientId || p.clientId === docFilters.clientId)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.agencyRecordId ?? 'No number'} — {p.projectName ?? p.projectAddress ?? 'Unnamed'}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="d-q">Search</label>
              <input
                id="d-q"
                className="input mt-1"
                placeholder="File name, requirement key…"
                value={docFilters.q}
                onChange={(e) => setDocFilters((f) => ({ ...f, q: e.target.value }))}
              />
            </div>
          </div>
          {(docFilters.clientId || docFilters.category || docFilters.permitId || docFilters.q) && (
            <button
              type="button"
              className="link mt-3 text-[13px]"
              onClick={() => setDocFilters({ clientId: '', category: '', permitId: '', q: '' })}
            >
              Clear filters
            </button>
          )}
        </div>

        <DataTable<PermitDocument>
          columns={documentColumns}
          rows={documents}
          rowKey={(d) => d.id}
          dense
          loading={documentsQ.isLoading}
          error={documentsQ.error ?? undefined}
          onRetry={() => void documentsQ.refetch()}
          initialSort={{ key: 'uploaded', dir: 'desc' }}
          empty={
            <EmptyState
              title="No documents match these filters"
              hint="Try a wider category, or clear the contractor filter. A contractor with nothing here has not uploaded anything yet — their onboarding checklist is where that starts."
            />
          }
          footer={`${documents.length} file${documents.length === 1 ? '' : 's'}`}
        />
      </section>
    </div>
  );
}

import { useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  INSPECTION_RESULTS,
  SERVICE_LINE_LABELS,
  can,
  canAll,
  formatCents,
  type Correction,
  type Inspection,
  type InspectionResult,
  type Jurisdiction,
  type PermitDocument,
  type PermitStage,
  type RequirementItem,
  type StatusEvent,
} from '@flph/shared';
import { api, get, patch, post } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { fmtDate, fmtDateTime, humanEnum } from '../lib/format.ts';
import { readFileAsUpload } from '../lib/upload.ts';
import type { PermitDetailResponse } from '../lib/types.ts';
import StageBadge, { stageLabel } from '../components/StageBadge.tsx';
import RiskBadge from '../components/RiskBadge.tsx';
import EmptyState from '../components/EmptyState.tsx';
import ErrorState, { errorMessage } from '../components/ErrorState.tsx';
import Spinner, { LoadingPanel } from '../components/Spinner.tsx';

/**
 * One permit, everything about it.
 *
 * Two things on this page are deliberate rather than decorative. Requirements
 * carry their `source` and `because` so a coordinator can tell a client why a
 * document is needed instead of "the city wants it" — and the status timeline
 * shows the agency's raw string next to the stage we mapped it to, because an
 * unmapped status means this permit's stage is stale and somebody has to look.
 */

type Tab = 'requirements' | 'documents' | 'corrections' | 'inspections' | 'history';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'requirements', label: 'Requirements' },
  { id: 'documents', label: 'Documents' },
  { id: 'corrections', label: 'Corrections' },
  { id: 'inspections', label: 'Inspections' },
  { id: 'history', label: 'Status history' },
];

const SOURCE_LABEL: Record<RequirementItem['source'], string> = {
  base: 'Every permit',
  permit_type: 'This permit type',
  conditional: 'Conditional',
  override: 'Learned from a correction',
};

const SOURCE_CLASS: Record<RequirementItem['source'], string> = {
  base: 'badge-gray',
  permit_type: 'badge-blue',
  conditional: 'badge-amber',
  override: 'badge-green',
};

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="text-[12px] text-ink-mute shrink-0">{label}</span>
      <span className="text-[13px] text-right min-w-0">{children}</span>
    </div>
  );
}

export default function PermitDetail() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('requirements');

  const canEdit = !!user && can(user.role, 'permit:edit');
  const canUpload = !!user && can(user.role, 'document:upload');
  const canPromote = !!user && canAll(user.role, ['permit:edit', 'jurisdiction:edit']);
  const canRecordInspection = !!user && can(user.role, 'inspection:record');

  const q = useQuery({
    queryKey: ['permit', id],
    queryFn: () => get<PermitDetailResponse>(`/permits/${id}`),
    enabled: !!id,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['permit', id] });
    void qc.invalidateQueries({ queryKey: ['permits'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
  };

  if (q.isLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Permit</h1>
        <LoadingPanel label="Loading permit…" rows={6} />
      </div>
    );
  }

  if (q.isError) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Permit</h1>
        <ErrorState error={q.error} onRetry={() => q.refetch()} title="Could not load this permit" />
        <Link to="/pipeline" className="link text-sm">
          Back to the pipeline
        </Link>
      </div>
    );
  }

  const d = q.data;
  if (!d) return null;

  const { permit, project, client, jurisdiction, risk, requirements } = d;
  const required = requirements.filter((r) => r.required);
  const optional = requirements.filter((r) => !r.required);
  const feesOutstanding = Math.max(0, permit.feesDueCents - permit.feesPaidCents);

  return (
    <div className="space-y-4">
      {/* --- header --------------------------------------------------------- */}
      <div>
        <Link to="/pipeline" className="link text-[13px]">
          ← Pipeline
        </Link>
        <div className="mt-2 flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold flex items-center gap-2 flex-wrap">
              <span className="font-mono text-brand">{permit.agencyRecordId ?? 'No agency number yet'}</span>
              <StageBadge stage={permit.stage} />
              <RiskBadge level={risk.level} score={risk.score} reasons={risk.reasons} />
            </h1>
            <p className="mt-1 text-sm text-ink-soft">
              {humanEnum(permit.permitType)} · {jurisdiction?.name ?? permit.jurisdictionId}
              {jurisdiction?.hvhz && <span className="badge-amber ml-2">HVHZ</span>}
              {jurisdiction?.paperOnly && <span className="badge-gray ml-1.5">Paper only</span>}
            </p>
          </div>
          <div className="text-right text-[12px] text-ink-mute">
            <div>Internal id <span className="font-mono">{permit.id}</span></div>
            <div>Last synced {permit.lastSyncedAt ? fmtDateTime(permit.lastSyncedAt) : 'never'}</div>
          </div>
        </div>
      </div>

      {permit.unmappedStatus && (
        <div className="rounded-md border border-warn/30 bg-warn-soft px-4 py-3">
          <div className="text-sm font-semibold text-warn">Unmapped agency status</div>
          <p className="mt-1 text-sm text-ink-soft leading-relaxed">
            The agency reported “{permit.unmappedStatus}” and no normalization rule matched it, so the stage above was
            left where it was rather than guessed. Treat {stageLabel(permit.stage)} as possibly stale until someone adds
            a rule for this string.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 items-start">
        {/* --- left column: tabs ------------------------------------------- */}
        <div className="xl:col-span-2 card">
          <div className="flex gap-1 border-b border-line px-2 pt-2 overflow-x-auto">
            {TABS.map((t) => {
              const count =
                t.id === 'documents'
                  ? d.documents.length
                  : t.id === 'corrections'
                    ? d.corrections.length
                    : t.id === 'inspections'
                      ? d.inspections.length
                      : t.id === 'history'
                        ? d.statusEvents.length
                        : requirements.length;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={`px-3 py-2 text-[13px] font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${
                    tab === t.id
                      ? 'border-brand text-brand'
                      : 'border-transparent text-ink-soft hover:text-ink'
                  }`}
                >
                  {t.label}
                  <span className="ml-1.5 text-[11px] text-ink-mute tabular-nums">{count}</span>
                </button>
              );
            })}
          </div>

          <div className="p-4">
            {tab === 'requirements' && (
              <RequirementsTab
                required={required}
                optional={optional}
                permitId={permit.id}
                clientId={permit.clientId}
                documents={d.documents}
                canUpload={canUpload}
                onUploaded={invalidate}
                hasJurisdiction={!!jurisdiction && !!project}
              />
            )}
            {tab === 'documents' && <DocumentsTab documents={d.documents} />}
            {tab === 'corrections' && (
              <CorrectionsTab
                corrections={d.corrections}
                requirements={requirements}
                canEdit={canEdit}
                canPromote={canPromote}
                onChanged={invalidate}
              />
            )}
            {tab === 'inspections' && (
              <InspectionsTab
                inspections={d.inspections}
                canRecord={canRecordInspection}
                onChanged={invalidate}
              />
            )}
            {tab === 'history' && <HistoryTab events={d.statusEvents} unmapped={permit.unmappedStatus} />}
          </div>
        </div>

        {/* --- right column: facts ----------------------------------------- */}
        <div className="space-y-4">
          <div className="card card-pad">
            <h2 className="label">Client</h2>
            <div className="mt-2 divide-y divide-line">
              <Fact label="Contractor">{client?.name ?? '—'}</Fact>
              <Fact label="Service line">{SERVICE_LINE_LABELS[permit.serviceLine] ?? permit.serviceLine}</Fact>
              <Fact label="Contact">{client?.contactName ?? '—'}</Fact>
              <Fact label="Licence">{client?.licenseNumber ?? 'Our qualifier of record'}</Fact>
              {client?.filingHold && (
                <Fact label="Filing hold">
                  <span className="badge-red">{client.filingHoldReason ?? 'On hold'}</span>
                </Fact>
              )}
            </div>
          </div>

          <div className="card card-pad">
            <h2 className="label">Project</h2>
            <div className="mt-2 divide-y divide-line">
              <Fact label="Name">{project?.name ?? '—'}</Fact>
              <Fact label="Address">
                {project ? `${project.addressLine1}, ${project.city} ${project.zip}` : '—'}
              </Fact>
              <Fact label="Parcel">{project?.parcelId ?? '—'}</Fact>
              <Fact label="Valuation">
                {project ? formatCents(project.valuationCents) : '—'}
              </Fact>
              <Fact label="Flood zone">{project?.floodZone ?? '—'}</Fact>
              {project?.coastalConstructionControlLine && (
                <Fact label="CCCL"><span className="badge-amber">Seaward of the control line</span></Fact>
              )}
            </div>
          </div>

          <JurisdictionPanel jurisdiction={jurisdiction} />

          <div className="card card-pad">
            <h2 className="label">Fees</h2>
            <div className="mt-2 divide-y divide-line">
              <Fact label="Assessed">{formatCents(permit.feesDueCents)}</Fact>
              <Fact label="Paid">{formatCents(permit.feesPaidCents)}</Fact>
              <Fact label="Outstanding">
                <span className={feesOutstanding > 0 ? 'font-semibold text-danger' : ''}>
                  {formatCents(feesOutstanding)}
                </span>
              </Fact>
            </div>
          </div>

          <div className="card card-pad">
            <h2 className="label">Key dates</h2>
            <div className="mt-2 divide-y divide-line">
              <Fact label="Created">{fmtDate(permit.createdAt)}</Fact>
              <Fact label="Submitted">{fmtDate(permit.submittedAt)}</Fact>
              <Fact label="Issued">{fmtDate(permit.issuedAt)}</Fact>
              <Fact label="Expires">{fmtDate(permit.expiresAt)}</Fact>
              <Fact label="Closed">{fmtDate(permit.closedAt)}</Fact>
              <Fact label="Correction cycles">
                <span className="tabular-nums">{permit.correctionCycles}</span>
              </Fact>
            </div>
          </div>

          <SyncPanel
            permitId={permit.id}
            jurisdiction={jurisdiction}
            canEdit={canEdit}
            lastSyncedAt={permit.lastSyncedAt}
            onSynced={invalidate}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Requirements
// ---------------------------------------------------------------------------

function RequirementRow({
  item,
  permitId,
  clientId,
  documents,
  canUpload,
  onUploaded,
}: {
  item: RequirementItem;
  permitId: string;
  clientId: string;
  documents: PermitDocument[];
  canUpload: boolean;
  onUploaded: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  const satisfied = documents.filter((doc) => doc.requirementKey === item.key);

  const upload = useMutation({
    // The documents endpoint takes base64 JSON rather than multipart. Keeping
    // one upload shape across the app means the size and type checks live in a
    // single place instead of being re-implemented per form.
    mutationFn: async (file: File) => {
      const payload = await readFileAsUpload(file);
      return post('/documents', {
        ...payload,
        permitId,
        clientId,
        requirementKey: item.key,
        category: 'SUBMITTAL',
      });
    },
    onSuccess: () => {
      setError(null);
      onUploaded();
    },
    onError: (err) => setError(errorMessage(err)),
  });

  return (
    <li className="py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium">{item.label}</div>
          {item.detail && <div className="mt-0.5 text-[13px] text-ink-soft leading-snug">{item.detail}</div>}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className={SOURCE_CLASS[item.source]} title={`Requirement source: ${item.source}`}>
              {SOURCE_LABEL[item.source]}
            </span>
            <span className="font-mono text-[11px] text-ink-mute">{item.key}</span>
            {satisfied.length > 0 && (
              <span className="badge-green">
                {satisfied.length} file{satisfied.length === 1 ? '' : 's'} on record
              </span>
            )}
          </div>
          {item.because && (
            <div className="mt-1.5 text-[12px] text-ink-soft leading-snug">
              <span className="font-semibold text-ink">Why:</span> {item.because}
            </div>
          )}
        </div>

        {canUpload && (
          <div className="shrink-0">
            <input
              ref={inputRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) upload.mutate(file);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              className="btn-ghost px-2.5 py-1 text-[12px]"
              disabled={upload.isPending}
              onClick={() => inputRef.current?.click()}
            >
              {upload.isPending ? 'Uploading…' : 'Upload'}
            </button>
          </div>
        )}
      </div>
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    </li>
  );
}

function RequirementsTab({
  required,
  optional,
  permitId,
  clientId,
  documents,
  canUpload,
  onUploaded,
  hasJurisdiction,
}: {
  required: RequirementItem[];
  optional: RequirementItem[];
  permitId: string;
  clientId: string;
  documents: PermitDocument[];
  canUpload: boolean;
  onUploaded: () => void;
  hasJurisdiction: boolean;
}) {
  if (required.length === 0 && optional.length === 0) {
    return (
      <EmptyState
        title="No checklist composed"
        hint={
          hasJurisdiction
            ? 'The requirements engine returned nothing for this permit type in this jurisdiction.'
            : 'This permit is missing its project or jurisdiction record, so the checklist could not be composed.'
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-[12px] text-ink-soft leading-relaxed">
        Composed in layers — everything a permit needs, then this permit type, then conditions on this project, then
        what corrections in this jurisdiction have taught us. Each line carries its source so you can explain it.
      </p>

      <section>
        <h3 className="label">Required · {required.length}</h3>
        <ul className="mt-1 divide-y divide-line">
          {required.map((item) => (
            <RequirementRow
              key={`${item.source}:${item.key}`}
              item={item}
              permitId={permitId}
              clientId={clientId}
              documents={documents}
              canUpload={canUpload}
              onUploaded={onUploaded}
            />
          ))}
          {required.length === 0 && <li className="py-3 text-[13px] text-ink-mute">Nothing mandatory.</li>}
        </ul>
      </section>

      <section>
        <h3 className="label">Optional / conditional · {optional.length}</h3>
        <ul className="mt-1 divide-y divide-line">
          {optional.map((item) => (
            <RequirementRow
              key={`${item.source}:${item.key}`}
              item={item}
              permitId={permitId}
              clientId={clientId}
              documents={documents}
              canUpload={canUpload}
              onUploaded={onUploaded}
            />
          ))}
          {optional.length === 0 && (
            <li className="py-3 text-[13px] text-ink-mute">Nothing optional for this filing.</li>
          )}
        </ul>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

function DocumentsTab({ documents }: { documents: PermitDocument[] }) {
  if (documents.length === 0) {
    return (
      <EmptyState
        title="No documents on this permit"
        hint="Upload against a requirement on the Requirements tab. Documents version rather than overwrite, so the revision that went on each correction cycle stays recoverable."
      />
    );
  }

  const sorted = [...documents].sort(
    (a, b) => a.requirementKey.localeCompare(b.requirementKey) || b.version - a.version,
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className="th">File</th>
            <th className="th">Requirement</th>
            <th className="th">Version</th>
            <th className="th">Went on cycle</th>
            <th className="th">Status</th>
            <th className="th">Uploaded</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((doc) => (
            <tr key={doc.id}>
              <td className="td">
                <div className="font-medium">{doc.fileName}</div>
                <div className="text-[12px] text-ink-mute">
                  {humanEnum(doc.category)} · {(doc.sizeBytes / 1024).toFixed(0)} KB
                </div>
              </td>
              <td className="td font-mono text-[12px]">{doc.requirementKey}</td>
              <td className="td tabular-nums">
                v{doc.version}
                {doc.supersedesId && <div className="text-[11px] text-ink-mute">supersedes v{doc.version - 1}</div>}
              </td>
              <td className="td tabular-nums">
                {doc.submittedOnCycle == null ? (
                  <span className="text-ink-mute">Not submitted</span>
                ) : doc.submittedOnCycle === 0 ? (
                  'Original submittal'
                ) : (
                  `Correction cycle ${doc.submittedOnCycle}`
                )}
              </td>
              <td className="td">
                <span
                  className={
                    doc.status === 'ACCEPTED'
                      ? 'badge-green'
                      : doc.status === 'REJECTED'
                        ? 'badge-red'
                        : doc.status === 'SUPERSEDED'
                          ? 'badge-gray'
                          : 'badge-blue'
                  }
                >
                  {humanEnum(doc.status)}
                </span>
              </td>
              <td className="td text-[12px] text-ink-soft">{fmtDate(doc.uploadedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

function PromoteForm({
  correction,
  requirements,
  onDone,
}: {
  correction: Correction;
  requirements: RequirementItem[];
  onDone: () => void;
}) {
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);

  const existingKeys = useMemo(
    () => [...new Set(requirements.map((r) => r.key))].sort(),
    [requirements],
  );

  const promote = useMutation({
    mutationFn: () =>
      post(`/corrections/${correction.id}/promote`, {
        requirementKey: key.trim(),
        op: 'add',
        label: label.trim() || null,
        detail: correction.text,
      }),
    onSuccess: () => {
      setError(null);
      onDone();
    },
    onError: (err) => setError(errorMessage(err)),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!key.trim()) {
      setError('A requirement key is needed — this is what the checklist engine keys the new line on.');
      return;
    }
    promote.mutate();
  }

  return (
    <form onSubmit={submit} className="mt-3 rounded-md border border-line bg-page p-3">
      <p className="text-[12px] text-ink-soft leading-snug">
        Promoting writes a standing requirement for this jurisdiction, so the next contractor filing here sees it before
        submitting and never receives this correction.
      </p>
      <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div>
          <label className="label" htmlFor={`key-${correction.id}`}>Requirement key</label>
          <input
            id={`key-${correction.id}`}
            className="input mt-1"
            list={`keys-${correction.id}`}
            placeholder="e.g. product_approval"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <datalist id={`keys-${correction.id}`}>
            {existingKeys.map((k) => (
              <option key={k} value={k} />
            ))}
          </datalist>
        </div>
        <div>
          <label className="label" htmlFor={`label-${correction.id}`}>Checklist label</label>
          <input
            id={`label-${correction.id}`}
            className="input mt-1"
            placeholder="What a coordinator should see"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
      </div>
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
      <div className="mt-3 flex gap-2">
        <button type="submit" className="btn-primary px-3 py-1.5 text-[13px]" disabled={promote.isPending}>
          {promote.isPending ? 'Promoting…' : 'Promote to requirement'}
        </button>
        <button type="button" className="btn-ghost px-3 py-1.5 text-[13px]" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function CorrectionsTab({
  corrections,
  requirements,
  canEdit,
  canPromote,
  onChanged,
}: {
  corrections: Correction[];
  requirements: RequirementItem[];
  canEdit: boolean;
  canPromote: boolean;
  onChanged: () => void;
}) {
  const [promoting, setPromoting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resolve = useMutation({
    mutationFn: (correctionId: string) => patch(`/corrections/${correctionId}`, { resolved: true }),
    onSuccess: () => {
      setError(null);
      onChanged();
    },
    onError: (err) => setError(errorMessage(err)),
  });

  if (corrections.length === 0) {
    return (
      <EmptyState
        title="No corrections on this permit"
        hint="First-pass approvals are the goal. When one does arrive, log it here and promote it — that is how the requirements database learns what this jurisdiction actually rejects."
      />
    );
  }

  return (
    <div>
      {error && <ErrorState error={error} compact title="Could not update the correction" />}
      <ul className="divide-y divide-line">
        {corrections.map((c) => (
          <li key={c.id} className="py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="badge-blue">Cycle {c.cycle}</span>
                  {c.discipline && <span className="badge-gray">{c.discipline}</span>}
                  {c.resolvedAt ? (
                    <span className="badge-green">Resolved {fmtDate(c.resolvedAt)}</span>
                  ) : (
                    <span className="badge-amber">Open</span>
                  )}
                  {c.promotedToRequirement && <span className="badge-green">Promoted</span>}
                  <span className="text-[12px] text-ink-mute">Issued {fmtDate(c.issuedAt)}</span>
                </div>
                <p className="mt-1.5 text-[13px] leading-relaxed whitespace-pre-wrap">{c.text}</p>
              </div>
              <div className="shrink-0 flex flex-col gap-1.5">
                {canEdit && !c.resolvedAt && (
                  <button
                    type="button"
                    className="btn-ghost px-2.5 py-1 text-[12px]"
                    disabled={resolve.isPending}
                    onClick={() => resolve.mutate(c.id)}
                  >
                    Resolve
                  </button>
                )}
                {canPromote && !c.promotedToRequirement && (
                  <button
                    type="button"
                    className="btn-ghost px-2.5 py-1 text-[12px]"
                    onClick={() => setPromoting(promoting === c.id ? null : c.id)}
                  >
                    Promote to requirement
                  </button>
                )}
              </div>
            </div>
            {promoting === c.id && (
              <PromoteForm
                correction={c}
                requirements={requirements}
                onDone={() => {
                  setPromoting(null);
                  onChanged();
                }}
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inspections
// ---------------------------------------------------------------------------

const RESULT_CLASS: Record<InspectionResult, string> = {
  SCHEDULED: 'badge-blue',
  PASSED: 'badge-green',
  FAILED: 'badge-red',
  PARTIAL: 'badge-amber',
  CANCELLED: 'badge-gray',
  NO_SHOW: 'badge-amber',
};

function InspectionsTab({
  inspections,
  canRecord,
  onChanged,
}: {
  inspections: Inspection[];
  canRecord: boolean;
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  const record = useMutation({
    mutationFn: ({ id, result }: { id: string; result: InspectionResult }) =>
      patch(`/inspections/${id}`, { result }),
    onSuccess: () => {
      setError(null);
      onChanged();
    },
    onError: (err) => setError(errorMessage(err)),
  });

  if (inspections.length === 0) {
    return (
      <EmptyState
        title="No inspections scheduled"
        hint="Inspections appear here once the permit is issued and a visit is booked with the agency."
      />
    );
  }

  return (
    <div>
      {error && <ErrorState error={error} compact title="Could not record the result" />}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="th">Type</th>
              <th className="th">Scheduled</th>
              <th className="th">Result</th>
              <th className="th">Note</th>
              {canRecord && <th className="th">Record</th>}
            </tr>
          </thead>
          <tbody>
            {inspections.map((i) => (
              <tr key={i.id}>
                <td className="td">
                  <div className="font-medium">{i.inspectionType}</div>
                  {i.reinspectionOfId && <div className="text-[11px] text-warn">Re-inspection</div>}
                </td>
                <td className="td whitespace-nowrap">{fmtDateTime(i.scheduledFor)}</td>
                <td className="td">
                  <span className={RESULT_CLASS[i.result]}>{humanEnum(i.result)}</span>
                </td>
                <td className="td text-[13px] text-ink-soft">{i.inspectorNote ?? '—'}</td>
                {canRecord && (
                  <td className="td">
                    <select
                      className="input py-1 text-[12px]"
                      value=""
                      disabled={record.isPending}
                      onChange={(e) => {
                        const result = e.target.value as InspectionResult;
                        if (result) record.mutate({ id: i.id, result });
                        e.target.value = '';
                      }}
                    >
                      <option value="">Set result…</option>
                      {INSPECTION_RESULTS.filter((r) => r !== i.result).map((r) => (
                        <option key={r} value={r}>
                          {humanEnum(r)}
                        </option>
                      ))}
                    </select>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[12px] text-ink-soft">
        Recording a failure automatically creates the re-inspection so the job does not stall waiting for someone to
        remember.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status history
// ---------------------------------------------------------------------------

function HistoryTab({ events, unmapped }: { events: StatusEvent[]; unmapped: string | null }) {
  if (events.length === 0) {
    return (
      <EmptyState
        title="No status events yet"
        hint="Every status write — API connector, portal automation or a coordinator typing what they read — lands here in the same shape."
      />
    );
  }

  return (
    <div>
      {unmapped && (
        <div className="mb-4 rounded-md border border-warn/30 bg-warn-soft px-3 py-2">
          <div className="text-[13px] font-semibold text-warn">“{unmapped}” has no normalization rule</div>
          <p className="mt-0.5 text-[12px] text-ink-soft leading-snug">
            This is the maintenance queue for the normalization rules — the Reports page lists every unmapped string
            across the book.
          </p>
        </div>
      )}
      <ol className="relative border-l border-line ml-2">
        {events.map((e) => {
          const isUnmapped = e.stage == null && !!e.rawStatus;
          return (
            <li key={e.id} className="ml-4 pb-4 last:pb-0">
              <span
                className={`absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full border-2 border-white ${
                  isUnmapped ? 'bg-warn' : 'bg-brand'
                }`}
              />
              <div className="flex flex-wrap items-center gap-2">
                {e.stage ? (
                  <StageBadge stage={e.stage} />
                ) : (
                  <span className="badge-amber">Unmapped — stage unchanged</span>
                )}
                <span className="text-[12px] text-ink-mute">{fmtDateTime(e.at)}</span>
                <span className="badge-gray">{e.sourceChannel}</span>
              </div>
              {e.rawStatus && (
                <div className="mt-1 text-[13px]">
                  <span className="text-ink-mute">Agency said </span>
                  <span className="font-mono text-[12px] bg-page border border-line rounded px-1 py-0.5">
                    {e.rawStatus}
                  </span>
                  {e.stage && <span className="text-ink-mute"> → {stageLabel(e.stage)}</span>}
                </div>
              )}
              {e.note && <div className="mt-1 text-[13px] text-ink-soft leading-snug">{e.note}</div>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Jurisdiction facts + sync
// ---------------------------------------------------------------------------

function JurisdictionPanel({ jurisdiction: j }: { jurisdiction: Jurisdiction | null }) {
  return (
    <div className="card card-pad">
      <h2 className="label">Jurisdiction</h2>
      {!j ? (
        <p className="mt-2 text-[13px] text-ink-soft">
          This permit points at a jurisdiction that is not in the dataset. That is a data problem, not a display one.
        </p>
      ) : (
        <div className="mt-2 divide-y divide-line">
          <Fact label="Name">
            <Link to="/jurisdictions" className="link">
              {j.name}
            </Link>
          </Fact>
          <Fact label="Platform">{humanEnum(j.platform)}</Fact>
          <Fact label="Integration tier">
            <span className="badge-gray">{humanEnum(j.integrationTier)}</span>
          </Fact>
          <Fact label="HVHZ">{j.hvhz ? <span className="badge-amber">Yes</span> : 'No'}</Fact>
          <Fact label="Wind-borne debris">{j.windBorneDebris ? 'Yes' : 'No'}</Fact>
          <Fact label="Design wind speed">
            {j.designWindSpeedMph == null ? 'Unverified' : `${j.designWindSpeedMph} mph`}
          </Fact>
          <Fact label="Median review">
            {j.medianReviewDays == null ? 'Unmeasured' : `${j.medianReviewDays}d (n=${j.reviewSampleSize})`}
          </Fact>
          <Fact label="Portal">
            {j.portalUrl ? (
              <a href={j.portalUrl} target="_blank" rel="noreferrer" className="link break-all">
                Open portal
              </a>
            ) : (
              <span className="text-warn">Not verified — confirm by phone</span>
            )}
          </Fact>
          <Fact label="Phone">{j.contactPhone ?? '—'}</Fact>
        </div>
      )}
    </div>
  );
}

function SyncPanel({
  permitId,
  jurisdiction: j,
  canEdit,
  lastSyncedAt,
  onSynced,
}: {
  permitId: string;
  jurisdiction: Jurisdiction | null;
  canEdit: boolean;
  lastSyncedAt: string | null;
  onSynced: () => void;
}) {
  const [rawStatus, setRawStatus] = useState('');
  const [note, setNote] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sync = useMutation({
    mutationFn: () => post<{ normalization: { stage: string | null } }>(`/permits/${permitId}/status`, {
      rawStatus: rawStatus.trim(),
      ...(note.trim() ? { note: note.trim() } : {}),
    }),
    onSuccess: (data) => {
      setError(null);
      setResult(
        data.normalization.stage
          ? `Mapped to ${stageLabel(data.normalization.stage as PermitStage)}.`
          : 'No rule matched that string — it was recorded as unmapped and the stage was left alone.',
      );
      setRawStatus('');
      setNote('');
      onSynced();
    },
    onError: (err) => {
      setResult(null);
      setError(errorMessage(err));
    },
  });

  /** Why this jurisdiction cannot poll itself. Not an apology — the reason is
   *  the thing a coordinator needs in order to fix it. */
  const autoSyncBlocker =
    !j
      ? 'No jurisdiction record, so nothing can be polled.'
      : j.paperOnly
        ? `${j.name} accepts paper or email only. Manual entry is the permanent, correct channel here.`
        : j.integrationTier === 'api_live'
          ? null
          : !j.portalUrl
            ? `No verified portal URL for ${j.name}. Call the building department and record the URL on the Jurisdictions page first.`
            : !j.automationApproved
              ? `Automation is not approved for ${j.name} — a human has to read this portal's terms of service and record the decision before any adapter runs.`
              : `${j.name} is on the ${humanEnum(j.integrationTier)} tier. Status still arrives by hand until the connector is turned on.`;

  return (
    <div className="card card-pad">
      <h2 className="label">Sync status</h2>
      <p className="mt-1.5 text-[12px] text-ink-soft leading-snug">
        {autoSyncBlocker ?? `${j?.name} is live on API. This form still writes through the same door a connector does.`}
      </p>

      {!canEdit ? (
        <p className="mt-3 text-[12px] text-ink-mute">
          Read-only role — status writes need <span className="font-mono">permit:edit</span>.
        </p>
      ) : (
        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!rawStatus.trim()) {
              setError('Type the agency status exactly as the portal shows it.');
              return;
            }
            sync.mutate();
          }}
        >
          <div>
            <label className="label" htmlFor="raw-status">Agency status, verbatim</label>
            <input
              id="raw-status"
              className="input mt-1"
              placeholder="e.g. Plan Review — Comments Issued"
              value={rawStatus}
              onChange={(e) => setRawStatus(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="sync-note">Note (optional)</label>
            <input
              id="sync-note"
              className="input mt-1"
              placeholder="Who you spoke to, what they said"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <button type="submit" className="btn-primary w-full" disabled={sync.isPending}>
            {sync.isPending ? <Spinner label="Syncing…" /> : 'Sync now'}
          </button>
        </form>
      )}

      {result && <div className="mt-2 rounded bg-brand-soft px-2 py-1.5 text-[12px] text-brand">{result}</div>}
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
      <p className="mt-2 text-[11px] text-ink-mute">
        Last write {lastSyncedAt ? fmtDateTime(lastSyncedAt) : 'never'}.
      </p>
    </div>
  );
}

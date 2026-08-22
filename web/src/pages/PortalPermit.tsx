import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  can,
  formatCents,
  type Correction,
  type Inspection,
  type InspectionResult,
  type PermitDocument,
  type RequirementItem,
} from '@flph/shared';
import { get, post } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { fmtDate, fmtDateTime, humanEnum } from '../lib/format.ts';
import { fmtBytes, readFileAsUpload } from '../lib/upload.ts';
import type { PermitDetailResponse } from '../lib/types.ts';
import type { PortalMessagesResponse, PortalUploadResponse } from '../lib/portal-shapes.ts';
import {
  DOC_STATUS_CLASS,
  DOC_STATUS_LABEL,
  PERMIT_SECTIONS,
  permitFolderPath,
  sectionForRequirement,
  stageNarrative,
} from '../lib/portal-copy.ts';
import DocumentLink from '../components/DocumentLink.tsx';
import EmptyState from '../components/EmptyState.tsx';
import ErrorState, { errorMessage } from '../components/ErrorState.tsx';
import { LoadingPanel } from '../components/Spinner.tsx';
import StageBadge, { stageLabel } from '../components/StageBadge.tsx';

/**
 * One permit, from the contractor's side of the desk.
 *
 * The staff page for the same permit is a working surface — risk scores,
 * normalization rules, the sync form. None of that belongs here. What a
 * contractor needs from this screen is three answers: where is it, what is
 * stopping it, and what do you need from me. So the page is ordered that way,
 * and the only thing above the fold that is not an answer is the button that
 * asks us a question.
 *
 * The message thread is the job's conversation, not a support form. Internal
 * staff notes are stripped by the API before they leave it, so this page never
 * holds one — and it deliberately offers no "internal" affordance at all,
 * because a control that a contractor can see is a control somebody will one
 * day render for the wrong audience.
 */

const RESULT_LABEL: Record<InspectionResult, string> = {
  SCHEDULED: 'Booked',
  PASSED: 'Passed',
  FAILED: 'Failed',
  PARTIAL: 'Partial',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'Inspector did not attend',
};

const RESULT_CLASS: Record<InspectionResult, string> = {
  SCHEDULED: 'badge-blue',
  PASSED: 'badge-green',
  FAILED: 'badge-red',
  PARTIAL: 'badge-amber',
  CANCELLED: 'badge-gray',
  NO_SHOW: 'badge-amber',
};

export default function PortalPermit() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const qc = useQueryClient();

  const canUpload = !!user && (can(user.role, 'portal:upload_own') || can(user.role, 'document:upload'));
  const canMessage = !!user && (can(user.role, 'portal:read_own') || can(user.role, 'permit:read'));

  const q = useQuery({
    queryKey: ['permit', id],
    queryFn: () => get<PermitDetailResponse>(`/permits/${id}`),
    enabled: !!id,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['permit', id] });
    void qc.invalidateQueries({ queryKey: ['portal', 'tree'] });
    void qc.invalidateQueries({ queryKey: ['portal', 'folder'] });
    void qc.invalidateQueries({ queryKey: ['portal', 'actions'] });
  };

  const d = q.data;
  const permit = d?.permit ?? null;
  const project = d?.project ?? null;
  const documents = useMemo(() => d?.documents ?? [], [d]);
  const requirements = useMemo(() => d?.requirements ?? [], [d]);
  const corrections = useMemo(() => d?.corrections ?? [], [d]);

  /**
   * What is genuinely outstanding.
   *
   * A requirement counts as met by any document filed against it that has not
   * been sent back or replaced. Anything sent back is listed separately: it is
   * a different action ("send another one") from a gap ("send one").
   */
  const { missing, sentBack } = useMemo(() => {
    const byKey = new Map<string, PermitDocument[]>();
    for (const doc of documents) {
      const list = byKey.get(doc.requirementKey) ?? [];
      list.push(doc);
      byKey.set(doc.requirementKey, list);
    }
    const missingItems = requirements
      .filter((r) => r.required)
      .filter((r) => !(byKey.get(r.key) ?? []).some((doc) => doc.status !== 'REJECTED' && doc.status !== 'SUPERSEDED'));
    return { missing: missingItems, sentBack: documents.filter((doc) => doc.status === 'REJECTED') };
  }, [documents, requirements]);

  const openCorrections = useMemo(() => corrections.filter((c) => !c.resolvedAt), [corrections]);

  if (q.isLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Your permit</h1>
        <LoadingPanel label="Loading this job…" rows={6} />
      </div>
    );
  }

  if (q.isError) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Your permit</h1>
        <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load this permit" />
        <Link to="/pipeline" className="link text-sm">
          Back to your jobs
        </Link>
      </div>
    );
  }

  if (!d || !permit) return null;

  const nothingOutstanding = missing.length === 0 && sentBack.length === 0 && openCorrections.length === 0;
  const feesOutstanding = Math.max(0, permit.feesDueCents - permit.feesPaidCents);

  return (
    <div className="space-y-5">
      {/* --- header --------------------------------------------------------- */}
      <div>
        <Link to="/pipeline" className="link text-[13px]">
          ← Your jobs
        </Link>
        <div className="mt-2 card card-pad">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <h1 className="text-xl font-semibold leading-tight">
                {humanEnum(permit.permitType)} at {project?.addressLine1 ?? 'your job'}
              </h1>
              <p className="mt-1 text-sm text-ink-soft">
                {project ? `${project.addressLine1}, ${project.city} ${project.zip}` : 'Address not recorded'}
                {d.jurisdiction ? ` · ${d.jurisdiction.name}` : ''}
              </p>
              <p className="mt-0.5 text-[13px] text-ink-mute">
                Permit number{' '}
                <span className="font-mono text-ink">{permit.agencyRecordId ?? 'not issued yet'}</span>
                {permit.issuedAt && ` · issued ${fmtDate(permit.issuedAt)}`}
                {permit.expiresAt && ` · expires ${fmtDate(permit.expiresAt)}`}
              </p>
            </div>
            <div className="shrink-0">
              <StageBadge stage={permit.stage} />
            </div>
          </div>

          <div className="mt-3 rounded-md bg-page px-3.5 py-3">
            <div className="label">What is happening now</div>
            <p className="mt-1 text-[14px] leading-relaxed">{stageNarrative(permit.stage)}</p>
            {permit.stage === 'CORRECTIONS_REQUIRED' && openCorrections.length > 0 && (
              <p className="mt-1 text-[13px] text-warn">
                {openCorrections.length} correction{openCorrections.length === 1 ? '' : 's'} to answer — they are
                listed below.
              </p>
            )}
          </div>

          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[12px] text-ink-soft">
            <span>
              Correction cycles so far: <span className="tabular-nums text-ink">{permit.correctionCycles}</span>
            </span>
            {permit.feesDueCents > 0 && (
              <span>
                Agency fees: <span className="tabular-nums text-ink">{formatCents(permit.feesDueCents)}</span>
                {feesOutstanding > 0 ? (
                  <>
                    {' '}
                    · <span className="text-warn">{formatCents(feesOutstanding)} still to pay</span> ·{' '}
                    <Link to="/invoices" className="link">
                      invoices
                    </Link>
                  </>
                ) : (
                  ' · paid'
                )}
              </span>
            )}
            {project?.jurisdictionId && d.jurisdiction?.contactPhone && (
              <span>
                Building department: <span className="text-ink">{d.jurisdiction.contactPhone}</span>
              </span>
            )}
          </div>
        </div>
      </div>

      {/* --- what we need from you ------------------------------------------ */}
      <section>
        <h2 className="text-sm font-semibold mb-2">What we need from you</h2>
        {nothingOutstanding ? (
          <div className="card border-l-4 border-good">
            <EmptyState
              title="Nothing on this job needs you right now"
              hint="Everything the department has asked for is either filed or with us. If that changes it appears here and on your home screen the same day."
              compact
            />
          </div>
        ) : (
          <div className="rounded-card border-2 border-warn bg-warn-soft/30 p-3 sm:p-4 space-y-3">
            {openCorrections.map((c) => (
              <CorrectionRow
                key={c.id}
                correction={c}
                projectId={project?.id ?? null}
                permitId={permit.id}
                canUpload={canUpload}
                onUploaded={invalidate}
              />
            ))}

            {sentBack.map((doc) => (
              <div key={doc.id} className="card px-4 py-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="badge-red">Sent back</span>
                      <span className="text-[14px] font-medium break-all">{doc.fileName}</span>
                    </div>
                    <p className="mt-1 text-[13px] text-ink-soft leading-relaxed">
                      Uploaded {fmtDate(doc.uploadedAt)}
                      {doc.requirementKey ? ` against ${doc.requirementKey.replace(/_/g, ' ')}` : ''}. We need a
                      replacement before the package is complete.
                    </p>
                  </div>
                  {canUpload && project && (
                    <QuickUpload
                      folderPath={permitFolderPath(
                        project.id,
                        permit.id,
                        sectionForRequirement(doc.requirementKey),
                      )}
                      requirementKey={doc.requirementKey}
                      label="Send a replacement"
                      onUploaded={invalidate}
                    />
                  )}
                </div>
              </div>
            ))}

            {missing.map((r) => (
              <RequirementRow
                key={r.key}
                item={r}
                projectId={project?.id ?? null}
                permitId={permit.id}
                canUpload={canUpload}
                onUploaded={invalidate}
              />
            ))}

            {!canUpload && (
              <p className="text-[12px] text-ink-soft">
                Your login cannot upload files.{' '}
                <Link to="/support" className="link">
                  Message your coordinator
                </Link>{' '}
                and send them across, or ask your company administrator for upload access.
              </p>
            )}
          </div>
        )}
      </section>

      {/* --- timeline and inspections --------------------------------------- */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] items-start">
        <section>
          <h2 className="text-sm font-semibold mb-2">Where it has been</h2>
          <div className="card card-pad">
            {d.statusEvents.length === 0 ? (
              <EmptyState
                title="Nothing recorded yet"
                hint="Every time the building department moves this permit — or we speak to them and they tell us something — it lands here with the date."
                compact
              />
            ) : (
              <ol>
                {d.statusEvents.map((e, i) => (
                  <li key={e.id} className="flex gap-3">
                    <div className="w-[86px] shrink-0 pt-0.5 text-right">
                      <div className="text-[12px] tabular-nums text-ink">{fmtDate(e.at)}</div>
                      <div className="text-[11px] tabular-nums text-ink-mute">
                        {new Date(e.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                      </div>
                    </div>
                    <div
                      className={`relative min-w-0 flex-1 border-l border-line pl-4 ${
                        i === d.statusEvents.length - 1 ? 'pb-0' : 'pb-5'
                      }`}
                    >
                      <span
                        className={`absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-white ${
                          i === 0 ? 'bg-brand' : 'bg-line'
                        }`}
                        aria-hidden
                      />
                      <div className="text-[14px] font-medium leading-snug">
                        {e.stage ? stageLabel(e.stage) : 'Update from the department'}
                      </div>
                      {e.stage && <p className="mt-0.5 text-[12px] text-ink-soft">{stageNarrative(e.stage)}</p>}
                      {e.rawStatus && (
                        <p className="mt-1 text-[11px] text-ink-mute">
                          The department's own words: <span className="italic">“{e.rawStatus}”</span>
                        </p>
                      )}
                      {e.note && <p className="mt-1 text-[12px] text-ink-soft leading-snug">{e.note}</p>}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>

        <section>
          <h2 className="text-sm font-semibold mb-2">Inspections</h2>
          {d.inspections.length === 0 ? (
            <div className="card">
              <EmptyState
                title="None booked yet"
                hint="Inspections start once the permit is issued. We book them, and tell you the day before so the job can be ready."
                compact
              />
            </div>
          ) : (
            <ul className="card divide-y divide-line overflow-hidden">
              {d.inspections.map((ins: Inspection) => (
                <li key={ins.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium">{ins.inspectionType}</div>
                      <div className="text-[12px] text-ink-soft tabular-nums">
                        {ins.scheduledFor ? fmtDateTime(ins.scheduledFor) : 'Date not set'}
                      </div>
                    </div>
                    <span className={`${RESULT_CLASS[ins.result]} shrink-0`}>{RESULT_LABEL[ins.result]}</span>
                  </div>
                  {ins.inspectorNote && (
                    <p className="mt-1.5 text-[12px] text-ink-soft leading-relaxed">
                      Inspector wrote: {ins.inspectorNote}
                    </p>
                  )}
                  {ins.reinspectionOfId && (
                    <p className="mt-1 text-[11px] text-ink-mute">This is a re-inspection.</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* --- messages -------------------------------------------------------- */}
      <MessageThread permitId={permit.id} canPost={canMessage} currentUserId={user?.id ?? null} />

      {/* --- documents ------------------------------------------------------- */}
      <section>
        <div className="flex items-baseline justify-between gap-3 mb-2">
          <h2 className="text-sm font-semibold">Documents on this job</h2>
          <Link
            to={project ? `/files/projects/${project.id}/permits/${permit.id}` : '/files'}
            className="link text-[12px]"
          >
            Open these folders
          </Link>
        </div>

        {documents.length === 0 ? (
          <div className="card">
            <EmptyState
              title="Nothing filed on this permit yet"
              hint="Plans, product approvals, the submittal package and anything the department sends back all land here, in the same folders you see under Files."
              compact
            />
          </div>
        ) : (
          <div className="space-y-3">
            {PERMIT_SECTIONS.map((section) => {
              const docs = documents.filter((doc) => section.categories.includes(doc.category));
              if (docs.length === 0) return null;
              return (
                <div key={section.key} className="card overflow-hidden">
                  <div className="border-b border-line px-4 py-2.5">
                    <div className="flex items-baseline justify-between gap-3 flex-wrap">
                      <span className="text-[13px] font-semibold">{section.name}</span>
                      <span className="text-[11px] tabular-nums text-ink-mute">
                        {docs.length} file{docs.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[12px] text-ink-soft">{section.hint}</p>
                  </div>
                  <ul className="divide-y divide-line">
                    {[...docs]
                      .sort((a, b) => Date.parse(b.uploadedAt) - Date.parse(a.uploadedAt))
                      .map((doc) => (
                        <li key={doc.id} className="px-4 py-2.5">
                          <div className="flex items-start justify-between gap-3 flex-wrap">
                            <DocumentLink
                              documentId={doc.id}
                              className="link text-[13px] font-medium text-left break-all"
                            >
                              {doc.fileName}
                            </DocumentLink>
                            <span className={`${DOC_STATUS_CLASS[doc.status]} shrink-0`}>
                              {DOC_STATUS_LABEL[doc.status]}
                            </span>
                          </div>
                          <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-ink-mute">
                            <span className="tabular-nums">v{doc.version}</span>
                            <span className="tabular-nums">{fmtBytes(doc.sizeBytes)}</span>
                            <span>{fmtDate(doc.uploadedAt)}</span>
                          </div>
                        </li>
                      ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Outstanding items                                                           */
/* -------------------------------------------------------------------------- */

function RequirementRow({
  item,
  projectId,
  permitId,
  canUpload,
  onUploaded,
}: {
  item: RequirementItem;
  projectId: string | null;
  permitId: string;
  canUpload: boolean;
  onUploaded: () => void;
}) {
  return (
    <div className="card px-4 py-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="badge-amber">Still needed</span>
            <span className="text-[14px] font-medium leading-snug">{item.label}</span>
          </div>
          {item.detail && <p className="mt-1 text-[13px] text-ink-soft leading-relaxed">{item.detail}</p>}
          {item.because && (
            <p className="mt-1 text-[12px] text-ink-mute">Required because: {item.because}.</p>
          )}
        </div>
        {canUpload && projectId && (
          <QuickUpload
            folderPath={permitFolderPath(projectId, permitId, sectionForRequirement(item.key))}
            requirementKey={item.key}
            label="Upload it"
            onUploaded={onUploaded}
          />
        )}
      </div>
    </div>
  );
}

function CorrectionRow({
  correction: c,
  projectId,
  permitId,
  canUpload,
  onUploaded,
}: {
  correction: Correction;
  projectId: string | null;
  permitId: string;
  canUpload: boolean;
  onUploaded: () => void;
}) {
  return (
    <div className="card border-l-4 border-danger px-4 py-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="badge-red">Correction</span>
            <span className="text-[13px] font-medium">
              Cycle {c.cycle}
              {c.discipline ? ` · ${c.discipline}` : ''}
            </span>
            <span className="text-[12px] text-ink-mute">issued {fmtDate(c.issuedAt)}</span>
          </div>
          <p className="mt-1.5 text-[13px] leading-relaxed whitespace-pre-wrap">{c.text}</p>
          <p className="mt-1 text-[12px] text-ink-soft">
            We write the response. If it needs something only you have — a revised drawing, a product sheet, a photo of
            what is actually on the roof — send it here and we will get it back to the examiner.
          </p>
        </div>
        {canUpload && projectId && (
          <QuickUpload
            folderPath={permitFolderPath(projectId, permitId, 'corrections')}
            requirementKey={null}
            label="Send something for this"
            onUploaded={onUploaded}
          />
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Upload straight into the right folder                                       */
/* -------------------------------------------------------------------------- */

/**
 * One button that files into a known folder.
 *
 * The contractor never chooses a category — the folder path carries it, and
 * the API refuses a body that tries to name one. So "Upload it" next to the
 * missing item is the whole interaction.
 */
function QuickUpload({
  folderPath,
  requirementKey,
  label,
  onUploaded,
}: {
  folderPath: string;
  requirementKey: string | null;
  label: string;
  onUploaded: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function send(files: File[]) {
    if (files.length === 0) return;
    setError(null);
    setBusy(true);
    let ok = 0;
    for (const file of files) {
      try {
        const payload = await readFileAsUpload(file);
        await post<PortalUploadResponse>(
          `/portal/folders/${folderPath
            .split('/')
            .map((s) => encodeURIComponent(s))
            .join('/')}/upload`,
          {
            fileName: payload.fileName,
            contentType: payload.contentType,
            sizeBytes: payload.sizeBytes,
            dataBase64: payload.dataBase64,
            ...(requirementKey ? { requirementKey } : {}),
          },
        );
        ok += 1;
      } catch (e) {
        setError(`${file.name}: ${errorMessage(e)}`);
      }
    }
    setDone((n) => n + ok);
    setBusy(false);
    if (ok > 0) onUploaded();
  }

  return (
    <div className="shrink-0 text-right">
      <button type="button" className="btn-primary whitespace-nowrap" disabled={busy} onClick={() => ref.current?.click()}>
        {busy ? 'Uploading…' : label}
      </button>
      <input
        ref={ref}
        type="file"
        multiple
        className="sr-only"
        onChange={(e) => {
          void send(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
      {done > 0 && !busy && (
        <div className="mt-1 text-[11px] text-good">
          {done} file{done === 1 ? '' : 's'} filed
        </div>
      )}
      {error && <div className="mt-1 max-w-[220px] text-[11px] text-danger leading-snug">{error}</div>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Message thread                                                              */
/* -------------------------------------------------------------------------- */

function MessageThread({
  permitId,
  canPost,
  currentUserId,
}: {
  permitId: string;
  canPost: boolean;
  currentUserId: string | null;
}) {
  const qc = useQueryClient();
  const [body, setBody] = useState('');

  const q = useQuery({
    queryKey: ['portal', 'messages', permitId],
    queryFn: () => get<PortalMessagesResponse>(`/portal/permits/${permitId}/messages`),
    enabled: !!permitId,
  });

  const send = useMutation({
    // No `internal` flag is ever sent from here. There is no version of this
    // page where a contractor writes a staff-only note.
    mutationFn: () => post<PortalMessagesResponse>(`/portal/permits/${permitId}/messages`, { body: body.trim() }),
    onSuccess: () => {
      setBody('');
      void qc.invalidateQueries({ queryKey: ['portal', 'messages', permitId] });
    },
  });

  const messages = q.data?.messages ?? [];

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (body.trim() && !send.isPending) send.mutate();
  }

  return (
    <section>
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <h2 className="text-sm font-semibold">About this job</h2>
        <span className="text-[12px] text-ink-mute">Straight to the coordinator handling it</span>
      </div>

      <div className="card">
        <div className="max-h-[420px] overflow-y-auto px-4 py-4 space-y-3">
          {q.isLoading && <LoadingPanel label="Loading the conversation…" rows={2} />}
          {q.isError && (
            <ErrorState error={q.error} onRetry={() => void q.refetch()} compact title="Could not load the messages" />
          )}

          {!q.isLoading && !q.isError && messages.length === 0 && (
            <EmptyState
              title="Nothing said about this job yet"
              hint="Ask us anything — where it actually is, what the examiner meant, whether you can start. It lands with the coordinator on this permit, not a general inbox."
              compact
            />
          )}

          {messages.map((m) => {
            const mine = !!currentUserId && m.authorUserId === currentUserId;
            return (
              <article
                key={m.id}
                className={`rounded-md px-3.5 py-3 ${mine ? 'border border-brand/30 bg-brand-soft' : 'border border-line'}`}
              >
                <div className="flex items-baseline justify-between gap-3 flex-wrap">
                  <span className="text-[12px] font-semibold">{mine ? 'You' : '1 Contractor Solutions'}</span>
                  <span className="text-[11px] tabular-nums text-ink-mute">{fmtDateTime(m.at)}</span>
                </div>
                <p className="mt-1.5 text-[13px] leading-relaxed whitespace-pre-wrap">{m.body}</p>
              </article>
            );
          })}
        </div>

        {canPost ? (
          <form onSubmit={onSubmit} className="border-t border-line px-4 py-3 space-y-2">
            {send.isError && <ErrorState error={send.error} compact title="Could not send that" />}
            <textarea
              className="input min-h-[88px]"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Anything about this job — a question, something that changed on site, a date you need to hit."
            />
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <span className="text-[12px] text-ink-mute">
                Everything here is kept with the permit, so whoever picks it up has the history.
              </span>
              <button type="submit" className="btn-primary" disabled={!body.trim() || send.isPending}>
                {send.isPending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </form>
        ) : (
          <div className="border-t border-line px-4 py-3 text-[12px] text-ink-mute">
            Your login can read this conversation but not add to it.
          </div>
        )}
      </div>
    </section>
  );
}

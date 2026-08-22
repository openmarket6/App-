import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { can } from '@flph/shared';
import { get, post } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import ErrorState, { errorMessage } from '../components/ErrorState.tsx';
import EmptyState from '../components/EmptyState.tsx';
import Spinner from '../components/Spinner.tsx';
import { fmtDateTime } from '../lib/format.ts';

interface Status {
  configured: boolean;
  blockers: string[];
  serviceAccountEmail: string | null;
  sharedDriveId: string | null;
  sharedDriveName: string | null;
  calendarId: string | null;
  notes?: string[];
  lastReconcileAt: string | null;
  lastReconcileSummary: {
    clients: number;
    projects: number;
    permits: number;
    documents: number;
    events: number;
    failures: number;
  } | null;
}

interface DriveAddition {
  id: string;
  name: string;
  folderPath: string;
  modifiedTime: string;
  webViewLink: string | null;
}

/**
 * Google connection.
 *
 * Reports whether each secret is SET and never any part of a value — a
 * settings screen that shows the first four characters of a private key is a
 * settings screen that leaks a private key over somebody's shoulder.
 */
export default function GoogleSettings() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const canEdit = !!user && can(user.role, 'settings:edit');
  const [reconcileNote, setReconcileNote] = useState<string | null>(null);

  const statusQ = useQuery({
    queryKey: ['google', 'status'],
    queryFn: () => get<Status>('/google/status'),
  });

  const additionsQ = useQuery({
    queryKey: ['google', 'drive-additions'],
    queryFn: () => get<{ files: DriveAddition[]; since: string | null }>('/google/drive-additions'),
    enabled: !!statusQ.data?.configured,
  });

  const reconcile = useMutation({
    mutationFn: () => post<{ clients: number; projects: number; permits: number; documents: number; events: number; failures: number }>('/google/reconcile', {}),
    onSuccess: (r) => {
      setReconcileNote(
        `${r.clients} contractors, ${r.projects} jobs, ${r.permits} permits, ${r.documents} files, ${r.events} calendar entries.` +
          (r.failures > 0 ? ` ${r.failures} failed — see the log.` : ''),
      );
      void qc.invalidateQueries({ queryKey: ['google'] });
    },
    onError: (e) => setReconcileNote(errorMessage(e)),
  });

  if (statusQ.isLoading) return <Spinner />;
  if (statusQ.isError) return <ErrorState error={statusQ.error} title="Could not read the Google connection" />;

  const s = statusQ.data!;

  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-semibold">Google Drive & Calendar</h1>
      <p className="mt-1 text-sm text-ink-soft max-w-2xl leading-relaxed">
        Every contractor gets a folder, every job a folder inside it, and every permit its own set of shelves — created
        automatically as records are created here. Drive is a mirror you can browse and share; this application stays
        the source of truth.
      </p>

      <div className={`card card-pad mt-6 ${s.configured ? 'border-l-4 border-l-good' : 'border-l-4 border-l-warn'}`}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="label">Connection</div>
            <div className="mt-1 text-lg font-semibold">
              {s.configured ? 'Connected' : 'Not connected yet'}
            </div>
            {s.configured && s.sharedDriveName && (
              <p className="mt-1 text-sm text-ink-soft">
                Writing into <span className="font-medium text-ink">{s.sharedDriveName}</span>. Confirm that is the
                drive you meant before anyone relies on it.
              </p>
            )}
          </div>
          {canEdit && s.configured && (
            <button className="btn-ghost shrink-0" disabled={reconcile.isPending} onClick={() => reconcile.mutate()}>
              {reconcile.isPending ? 'Reconciling…' : 'Reconcile now'}
            </button>
          )}
        </div>

        {reconcileNote && <div className="mt-3 rounded-md bg-page border border-line px-3 py-2 text-sm">{reconcileNote}</div>}

        {!s.configured && s.blockers.length > 0 && (
          <ol className="mt-4 space-y-2">
            {s.blockers.map((b, i) => (
              <li key={i} className="flex gap-2.5 text-sm">
                <span className="mt-0.5 h-5 w-5 shrink-0 rounded-full bg-warn-soft text-warn grid place-items-center text-[11px] font-semibold">
                  {i + 1}
                </span>
                <span className="text-ink-soft leading-relaxed">{b}</span>
              </li>
            ))}
          </ol>
        )}

        {s.notes && s.notes.length > 0 && (
          <div className="mt-4 space-y-1.5">
            {s.notes.map((n, i) => (
              <p key={i} className="text-[13px] text-ink-mute leading-relaxed">{n}</p>
            ))}
          </div>
        )}
      </div>

      <div className="grid sm:grid-cols-2 gap-4 mt-4">
        <div className="card card-pad">
          <div className="label">Service account</div>
          <div className="mt-1 font-mono text-[12px] break-all">
            {s.serviceAccountEmail ?? <span className="text-ink-mute font-sans">Not set</span>}
          </div>
          <p className="mt-2 text-[12px] text-ink-mute leading-relaxed">
            This address must be a <span className="font-medium">Content manager</span> on the shared drive. A service
            account has no storage of its own, so a normal My&nbsp;Drive folder will reject every upload.
          </p>
        </div>
        <div className="card card-pad">
          <div className="label">Calendar</div>
          <div className="mt-1 font-mono text-[12px] break-all">
            {s.calendarId ?? <span className="text-ink-mute font-sans">Not set</span>}
          </div>
          <p className="mt-2 text-[12px] text-ink-mute leading-relaxed">
            Inspections, permit expiry, drafting deadlines and insurance renewals. Share the calendar with the service
            account and give it <span className="font-medium">Make changes to events</span>.
          </p>
        </div>
      </div>

      {s.lastReconcileSummary && (
        <div className="card card-pad mt-4">
          <div className="flex items-baseline justify-between">
            <div className="label">Last reconcile</div>
            <div className="text-[12px] text-ink-mute">{fmtDateTime(s.lastReconcileAt)}</div>
          </div>
          <div className="mt-3 grid grid-cols-3 sm:grid-cols-6 gap-4">
            {(
              [
                ['Contractors', s.lastReconcileSummary.clients],
                ['Jobs', s.lastReconcileSummary.projects],
                ['Permits', s.lastReconcileSummary.permits],
                ['Files', s.lastReconcileSummary.documents],
                ['Calendar', s.lastReconcileSummary.events],
                ['Failures', s.lastReconcileSummary.failures],
              ] as const
            ).map(([label, n]) => (
              <div key={label}>
                <div className={`text-xl font-semibold ${label === 'Failures' && n > 0 ? 'text-danger' : ''}`}>{n}</div>
                <div className="text-[11px] uppercase tracking-wider text-ink-mute mt-0.5">{label}</div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[12px] text-ink-mute">Runs automatically every 30 minutes.</p>
        </div>
      )}

      {s.configured && (
        <div className="card mt-4">
          <div className="card-pad border-b border-line">
            <div className="label">Added in Drive, not linked here</div>
            <p className="mt-1 text-[13px] text-ink-soft leading-relaxed">
              Files someone dropped straight into a Drive folder. They are reported rather than imported — pulling
              arbitrary files into a permit record is a decision a person should make once, not something that happens
              quietly.
            </p>
          </div>
          {additionsQ.isLoading ? (
            <div className="card-pad"><Spinner /></div>
          ) : (additionsQ.data?.files.length ?? 0) === 0 ? (
            <div className="card-pad">
              <EmptyState
                title="Nothing unlinked"
                hint="Every file in the shared drive came from here."
              />
            </div>
          ) : (
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">File</th>
                  <th className="th">Folder</th>
                  <th className="th">Modified</th>
                </tr>
              </thead>
              <tbody>
                {additionsQ.data!.files.map((f) => (
                  <tr key={f.id}>
                    <td className="td">
                      {f.webViewLink ? (
                        <a className="link" href={f.webViewLink} target="_blank" rel="noreferrer">{f.name}</a>
                      ) : (
                        f.name
                      )}
                    </td>
                    <td className="td text-ink-soft">{f.folderPath}</td>
                    <td className="td text-ink-soft">{fmtDateTime(f.modifiedTime)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

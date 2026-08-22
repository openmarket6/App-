import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_SUPERVISION_REQUIREMENT,
  SITE_VISIT_PURPOSES,
  SITE_VISIT_PURPOSE_LABELS,
  can,
  type SiteVisit,
  type SiteVisitPurpose,
} from '@flph/shared';
import { get, patch, post } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { daysAgo, fmtDate, fmtDateTime } from '../lib/format.ts';
import { fmtBytes, readFileAsUpload, tryGeolocate } from '../lib/upload.ts';
import type {
  ClientListResponse,
  DocumentUploadResponse,
  SiteVisitListResponse,
  SupervisionVerdictResponse,
} from '../lib/api-shapes.ts';
import type { PermitListResponse, PermitRow } from '../lib/types.ts';
import Drawer from '../components/Drawer.tsx';
import EmptyState from '../components/EmptyState.tsx';
import ErrorState from '../components/ErrorState.tsx';
import KpiCard from '../components/KpiCard.tsx';
import { LoadingPanel } from '../components/Spinner.tsx';
import StageBadge from '../components/StageBadge.tsx';

/**
 * Managed-licence supervision evidence.
 *
 * Everything on this screen exists to answer one question in front of a
 * regulator: was the work our licence is on actually supervised? The answer is
 * not a claim, it is a contemporaneous record — which is why `recordedAt` is
 * stamped by the server and never accepted from this form, why a visit cannot
 * be logged for a date in the future, and why an amended narrative always
 * shows as amended with the reason it was changed.
 */

/** Local ISO string for a datetime-local input, so the default is "now" in the
 *  PM's own timezone rather than UTC. */
function localNow(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export default function Supervision() {
  const { user } = useAuth();
  const [logging, setLogging] = useState<PermitRow | null>(null);
  const [amending, setAmending] = useState<SiteVisit | null>(null);

  const canLog = !!user && can(user.role, 'supervision:log');
  const canAmend = !!user && can(user.role, 'supervision:amend');

  const permitsQ = useQuery({
    queryKey: ['permits'],
    queryFn: () => get<PermitListResponse>('/permits'),
  });

  const visitsQ = useQuery({
    queryKey: ['siteVisits'],
    queryFn: () => get<SiteVisitListResponse>('/supervision/visits'),
  });

  const clientsQ = useQuery({
    queryKey: ['clients'],
    queryFn: () => get<ClientListResponse>('/clients'),
    staleTime: 5 * 60_000,
  });

  const managed = useMemo(
    () => (permitsQ.data?.permits ?? []).filter((p) => p.serviceLine === 'MANAGED_LICENSE'),
    [permitsQ.data],
  );

  // One verdict per permit. The verdict weighs qualifier capacity and licence
  // expiry as well as the visits, none of which the browser holds, so it is
  // asked for rather than recomputed here.
  const verdictQueries = useQueries({
    queries: managed.map((p) => ({
      queryKey: ['supervisionVerdict', p.id],
      queryFn: () => get<SupervisionVerdictResponse>(`/supervision/verdict/${p.id}`),
      staleTime: 60_000,
    })),
  });

  const visitsByPermit = useMemo(() => {
    const map = new Map<string, SiteVisit[]>();
    for (const v of visitsQ.data?.visits ?? []) {
      const list = map.get(v.permitId) ?? [];
      list.push(v);
      map.set(v.permitId, list);
    }
    for (const list of map.values()) list.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
    return map;
  }, [visitsQ.data]);

  const clientName = useMemo(
    () => new Map((clientsQ.data?.clients ?? []).map((c) => [c.id, c.name])),
    [clientsQ.data],
  );

  const verdicts = verdictQueries.map((q) => q.data ?? null);
  const notDefensible = verdicts.filter((v) => v && !v.verdict.defensible).length;
  const overdue = managed.filter((p) => {
    const last = visitsByPermit.get(p.id)?.[0];
    const since = last ? daysAgo(last.occurredAt) : null;
    return since != null && since > DEFAULT_SUPERVISION_REQUIREMENT.maxDaysBetweenVisits;
  }).length;
  const totalVisits = visitsQ.data?.total ?? 0;

  const loading = permitsQ.isLoading || visitsQ.isLoading;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Supervision</h1>
        <p className="mt-1 text-sm text-ink-soft max-w-3xl leading-relaxed">
          On the managed-licence line our qualifier's licence is on the permit, which makes us the contractor of record
          and makes supervision a legal obligation rather than a service feature. Florida disciplines qualifiers who
          lend a licence to work they did not actually supervise, and the defence is this record — written at the time,
          not reconstructed afterwards.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <KpiCard label="Managed permits" value={managed.length} hint="Permits filed under our qualifier's licence." />
        <KpiCard
          label="Not defensible"
          value={notDefensible}
          accent={notDefensible > 0 ? 'danger' : 'none'}
          hint="At least one blocking gap in the supervision record. These cannot advance to inspections."
        />
        <KpiCard
          label="Visit overdue"
          value={overdue}
          accent={overdue > 0 ? 'warn' : 'none'}
          hint={`More than ${DEFAULT_SUPERVISION_REQUIREMENT.maxDaysBetweenVisits} days since the last site visit on an active job.`}
        />
        <KpiCard label="Visits logged" value={totalVisits} hint="Across every managed permit, all time." />
      </div>

      <div className="card card-pad">
        <h2 className="text-sm font-semibold">How this record is kept honest</h2>
        <ul className="mt-2 space-y-1.5 text-[13px] text-ink-soft leading-snug">
          <li>
            <span className="font-medium text-ink">The server stamps when it was written.</span> You supply when you
            were on site; <span className="font-mono text-[12px]">recordedAt</span> comes from the server clock and
            cannot be sent from this form. The gap between the two is measured by something the person writing it does
            not control, and that gap is what gives the record its weight.
          </li>
          <li>
            <span className="font-medium text-ink">A visit cannot be logged for the future.</span> A visit next Tuesday
            is a plan. A record that cannot tell a plan from an observation is not evidence.
          </li>
          <li>
            <span className="font-medium text-ink">Amendments are visible.</span> Editing the narrative stamps who
            changed it, when, and why — and never touches when it happened, when it was recorded, or who was there.
          </li>
        </ul>
      </div>

      {permitsQ.isError && (
        <ErrorState error={permitsQ.error} onRetry={() => void permitsQ.refetch()} title="Could not load permits" />
      )}
      {loading && <LoadingPanel label="Loading the supervision record…" rows={5} />}

      {!loading && managed.length === 0 && (
        <div className="card">
          <EmptyState
            title="No managed-licence permits"
            hint="Supervision records only apply where our qualifier is the contractor of record. Nothing on the expediting line needs one."
          />
        </div>
      )}

      {!loading &&
        managed.map((permit, i) => (
          <PermitSupervisionCard
            key={permit.id}
            permit={permit}
            clientName={clientName.get(permit.clientId) ?? null}
            verdict={verdictQueries[i]?.data ?? null}
            verdictLoading={verdictQueries[i]?.isLoading ?? false}
            visits={visitsByPermit.get(permit.id) ?? []}
            canLog={canLog}
            canAmend={canAmend}
            onLog={() => setLogging(permit)}
            onAmend={setAmending}
          />
        ))}

      {logging && canLog && <LogVisitDrawer permit={logging} onClose={() => setLogging(null)} />}
      {amending && canAmend && <AmendDrawer visit={amending} onClose={() => setAmending(null)} />}
    </div>
  );
}

// --------------------------------------------------------------------------

function PermitSupervisionCard({
  permit,
  clientName,
  verdict,
  verdictLoading,
  visits,
  canLog,
  canAmend,
  onLog,
  onAmend,
}: {
  permit: PermitRow;
  clientName: string | null;
  verdict: SupervisionVerdictResponse | null;
  verdictLoading: boolean;
  visits: SiteVisit[];
  canLog: boolean;
  canAmend: boolean;
  onLog: () => void;
  onAmend: (v: SiteVisit) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const v = verdict?.verdict ?? null;
  const shown = expanded ? visits : visits.slice(0, 3);

  return (
    <div className={`card ${v && !v.defensible ? 'border-l-4 border-danger' : ''}`}>
      <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Link to={`/permits/${permit.id}`} className="font-mono text-[13px] text-brand hover:underline">
              {permit.agencyRecordId ?? 'No agency number'}
            </Link>
            <StageBadge stage={permit.stage} />
            {v && (
              <span className={v.defensible ? 'badge-green' : 'badge-red'}>
                {v.defensible ? 'Defensible' : 'Not defensible'}
              </span>
            )}
            {verdictLoading && <span className="badge-gray">Checking…</span>}
          </div>
          <div className="mt-1 text-[13px]">
            <Link to={`/clients/${permit.clientId}`} className="font-medium text-brand hover:underline">
              {clientName ?? 'Unknown contractor'}
            </Link>
            <span className="text-ink-soft"> · {permit.projectName ?? permit.projectAddress ?? 'Unnamed project'}</span>
          </div>
          {verdict?.qualifier && (
            <div className="mt-0.5 text-[12px] text-ink-mute">
              Qualifier {verdict.qualifier.name} · {verdict.qualifier.licenseType} {verdict.qualifier.licenseNumber}
              {verdict.qualifier.licenseExpiresAt && ` · expires ${fmtDate(verdict.qualifier.licenseExpiresAt)}`}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <div className="text-right">
            <div className="text-lg font-semibold tabular-nums leading-none">{v?.visitCount ?? visits.length}</div>
            <div className="text-[11px] text-ink-mute">visits</div>
          </div>
          <div className="text-right">
            <div
              className={`text-lg font-semibold tabular-nums leading-none ${
                (v?.daysSinceLastVisit ?? 0) > DEFAULT_SUPERVISION_REQUIREMENT.maxDaysBetweenVisits ? 'text-warn' : ''
              }`}
            >
              {v?.daysSinceLastVisit ?? '—'}
            </div>
            <div className="text-[11px] text-ink-mute">days since</div>
          </div>
          {canLog && (
            <button type="button" className="btn-primary" onClick={onLog}>
              Log a visit
            </button>
          )}
        </div>
      </div>

      {v && v.gaps.length > 0 && (
        <ul className="border-t border-line px-5 py-3 space-y-1.5">
          {v.gaps.map((g, i) => (
            <li key={i} className="flex items-start gap-2.5">
              <span className={g.severity === 'blocking' ? 'badge-red mt-0.5 shrink-0' : 'badge-amber mt-0.5 shrink-0'}>
                {g.severity === 'blocking' ? 'Blocking' : 'Warning'}
              </span>
              <span className="text-[13px] text-ink-soft leading-snug">{g.detail}</span>
            </li>
          ))}
        </ul>
      )}

      {visits.length === 0 ? (
        <div className="border-t border-line px-5 py-3 text-[13px] text-ink-soft">
          Nothing logged against this permit yet.
        </div>
      ) : (
        <>
          <ul className="divide-y divide-line border-t border-line">
            {shown.map((visit) => (
              <VisitRow key={visit.id} visit={visit} canAmend={canAmend} onAmend={() => onAmend(visit)} />
            ))}
          </ul>
          {visits.length > 3 && (
            <button
              type="button"
              className="link border-t border-line w-full px-5 py-2 text-left text-[13px]"
              onClick={() => setExpanded((e) => !e)}
            >
              {expanded ? 'Show fewer' : `Show all ${visits.length} visits`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function VisitRow({ visit, canAmend, onAmend }: { visit: SiteVisit; canAmend: boolean; onAmend: () => void }) {
  const lagMinutes = Math.round((Date.parse(visit.recordedAt) - Date.parse(visit.occurredAt)) / 60_000);
  const lagLabel =
    !Number.isFinite(lagMinutes) || lagMinutes < 0
      ? null
      : lagMinutes < 90
        ? `${lagMinutes} min after the visit`
        : `${Math.round(lagMinutes / 60)} h after the visit`;

  return (
    <li className={`px-5 py-3 ${visit.amendedAt ? 'bg-warn-soft/40' : ''}`}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[13px] font-medium">{SITE_VISIT_PURPOSE_LABELS[visit.purpose]}</span>
            <span className="text-[12px] text-ink-soft tabular-nums">on site {fmtDateTime(visit.occurredAt)}</span>
            {visit.photoDocumentIds.length < DEFAULT_SUPERVISION_REQUIREMENT.minPhotosPerVisit && (
              <span className="badge-amber" title="Photographs are the part of this record that is hard to dispute">
                {visit.photoDocumentIds.length} photo{visit.photoDocumentIds.length === 1 ? '' : 's'}
              </span>
            )}
          </div>
          <p className="mt-1 text-[13px] text-ink-soft leading-relaxed whitespace-pre-wrap">{visit.observations}</p>
          {visit.directionGiven && (
            <p className="mt-1.5 text-[13px] leading-relaxed">
              <span className="label">Direction given</span>{' '}
              <span className="text-ink-soft whitespace-pre-wrap">{visit.directionGiven}</span>
            </p>
          )}
          {visit.location && (
            <p className="mt-1 text-[11px] text-ink-mute tabular-nums">
              {visit.location.lat.toFixed(5)}, {visit.location.lng.toFixed(5)}
              {visit.location.accuracyM != null && ` · ±${visit.location.accuracyM} m`}
            </p>
          )}
          {visit.amendedAt && (
            <div className="mt-2 rounded border border-warn/25 bg-warn-soft px-2.5 py-1.5">
              <div className="text-[12px] font-semibold text-warn">Amended {fmtDateTime(visit.amendedAt)}</div>
              <div className="text-[12px] text-ink-soft leading-snug">
                {visit.amendmentReason ?? 'No reason recorded.'}
              </div>
            </div>
          )}
        </div>
        <div className="text-right shrink-0">
          <div className="text-[11px] text-ink-mute leading-snug">
            Recorded {fmtDateTime(visit.recordedAt)}
            {lagLabel && <span className="block">{lagLabel}</span>}
            <span className="block">server clock</span>
          </div>
          {canAmend && (
            <button type="button" className="btn-ghost mt-2 px-2 py-1 text-[12px]" onClick={onAmend}>
              Amend
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

// --------------------------------------------------------------------------

function LogVisitDrawer({ permit, onClose }: { permit: PermitRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [purpose, setPurpose] = useState<SiteVisitPurpose>('PROGRESS');
  const [occurredAt, setOccurredAt] = useState(localNow());
  const [observations, setObservations] = useState('');
  const [directionGiven, setDirectionGiven] = useState('');
  const [photos, setPhotos] = useState<File[]>([]);
  const [attachLocation, setAttachLocation] = useState(true);

  const future = Date.parse(occurredAt) > Date.now() + 5 * 60_000;
  const valid = observations.trim().length > 0 && !!occurredAt && !future;

  const log = useMutation({
    mutationFn: async () => {
      const photoDocumentIds: string[] = [];
      for (const file of photos) {
        const payload = await readFileAsUpload(file);
        const uploaded = await post<DocumentUploadResponse>('/documents', {
          ...payload,
          clientId: permit.clientId,
          permitId: permit.id,
          category: 'SUPERVISION_PHOTO',
          capturedAt: new Date(file.lastModified).toISOString(),
        });
        photoDocumentIds.push(uploaded.document.id);
      }

      const location = attachLocation ? await tryGeolocate() : null;

      // No `recordedAt` here, deliberately. The create route is strict and
      // rejects one outright rather than ignoring it.
      return post('/supervision/visits', {
        permitId: permit.id,
        purpose,
        occurredAt: new Date(occurredAt).toISOString(),
        observations: observations.trim(),
        directionGiven: directionGiven.trim() || null,
        photoDocumentIds,
        location,
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['siteVisits'] });
      void qc.invalidateQueries({ queryKey: ['supervisionVerdict'] });
      onClose();
    },
  });

  return (
    <Drawer
      open
      onClose={onClose}
      title="Log a site visit"
      subtitle={`${permit.agencyRecordId ?? 'No number'} · ${permit.projectAddress ?? permit.projectName ?? ''}`}
      width="600px"
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12px] text-ink-soft">The server stamps when this was written.</span>
          <div className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn-primary" disabled={!valid || log.isPending} onClick={() => log.mutate()}>
              {log.isPending ? 'Saving…' : 'Log the visit'}
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {log.isError && <ErrorState error={log.error} compact title="Could not log the visit" />}

        <label className="block">
          <span className="label">Purpose</span>
          <select className="input mt-1" value={purpose} onChange={(e) => setPurpose(e.target.value as SiteVisitPurpose)}>
            {SITE_VISIT_PURPOSES.map((p) => (
              <option key={p} value={p}>
                {SITE_VISIT_PURPOSE_LABELS[p]}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="label">When you were on site</span>
          <input
            type="datetime-local"
            className="input mt-1"
            value={occurredAt}
            max={localNow()}
            onChange={(e) => setOccurredAt(e.target.value)}
          />
          {future ? (
            <span className="mt-1 block text-[12px] text-danger leading-snug">
              That is in the future. A site visit is an observation, not a plan — the API refuses this too.
            </span>
          ) : (
            <span className="mt-1 block text-[12px] text-ink-mute leading-snug">
              Your arrival time. The moment this record is written is stamped separately by the server.
            </span>
          )}
        </label>

        <label className="block">
          <span className="label">Observations (required)</span>
          <textarea
            className="input mt-1 min-h-[130px]"
            value={observations}
            onChange={(e) => setObservations(e.target.value)}
            placeholder="Dry-in complete on the north and east slopes. Nails at 6in edge / 12in field, spot-checked four squares. Valley metal in and lapped correctly."
          />
          <span className="mt-1 block text-[12px] text-ink-mute leading-snug">
            What you saw. No template — specifics are what make this hard to dispute later.
          </span>
        </label>

        <label className="block">
          <span className="label">Direction given</span>
          <textarea
            className="input mt-1 min-h-[80px]"
            value={directionGiven}
            onChange={(e) => setDirectionGiven(e.target.value)}
            placeholder="Told the crew lead to re-lap the third valley course before the underlayment inspection."
          />
        </label>

        <label className="block">
          <span className="label">Photos</span>
          <input
            type="file"
            multiple
            accept="image/*"
            className="input mt-1 file:mr-3 file:rounded file:border-0 file:bg-page file:px-2 file:py-1 file:text-[12px]"
            onChange={(e) => setPhotos(Array.from(e.target.files ?? []))}
          />
          {photos.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {photos.map((f) => (
                <li key={f.name} className="text-[12px] text-ink-soft">
                  {f.name} · {fmtBytes(f.size)}
                </li>
              ))}
            </ul>
          )}
          <span className="mt-1 block text-[12px] text-ink-mute leading-snug">
            {photos.length < DEFAULT_SUPERVISION_REQUIREMENT.minPhotosPerVisit
              ? `The firm standard is ${DEFAULT_SUPERVISION_REQUIREMENT.minPhotosPerVisit} photos per visit. Fewer will log, but the visit reads as a thin record.`
              : 'Photographs are the part of this record that is hardest to dispute.'}
          </span>
        </label>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-line text-brand focus:ring-brand/30"
            checked={attachLocation}
            onChange={(e) => setAttachLocation(e.target.checked)}
          />
          <span className="leading-snug">
            Attach my device location to this visit
            <span className="block text-[12px] text-ink-mute">
              Recorded with its accuracy so a reviewer can judge it. If your browser refuses, the visit still logs
              without a location.
            </span>
          </span>
        </label>
      </div>
    </Drawer>
  );
}

// --------------------------------------------------------------------------

function AmendDrawer({ visit, onClose }: { visit: SiteVisit; onClose: () => void }) {
  const qc = useQueryClient();
  const [observations, setObservations] = useState(visit.observations);
  const [directionGiven, setDirectionGiven] = useState(visit.directionGiven ?? '');
  const [reason, setReason] = useState('');

  const amend = useMutation({
    mutationFn: () =>
      patch(`/supervision/visits/${visit.id}`, {
        amendmentReason: reason.trim(),
        observations: observations.trim(),
        directionGiven: directionGiven.trim() || null,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['siteVisits'] });
      void qc.invalidateQueries({ queryKey: ['supervisionVerdict'] });
      onClose();
    },
  });

  return (
    <Drawer
      open
      onClose={onClose}
      title="Amend this visit"
      subtitle={`${SITE_VISIT_PURPOSE_LABELS[visit.purpose]} · ${fmtDateTime(visit.occurredAt)}`}
      width="560px"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!reason.trim() || !observations.trim() || amend.isPending}
            onClick={() => amend.mutate()}
          >
            {amend.isPending ? 'Saving…' : 'Record the amendment'}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        {amend.isError && <ErrorState error={amend.error} compact title="Could not amend the visit" />}

        <div className="rounded-md border border-warn/25 bg-warn-soft px-3 py-2.5 text-[13px] text-warn leading-snug">
          This visit will be marked as amended, with your name, the time, and the reason you give below. When it
          happened, when it was recorded and who was on site cannot be changed — those are the facts the record exists
          to fix in place.
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px]">
          <div>
            <dt className="label">On site</dt>
            <dd className="mt-0.5 tabular-nums">{fmtDateTime(visit.occurredAt)}</dd>
          </div>
          <div>
            <dt className="label">Recorded</dt>
            <dd className="mt-0.5 tabular-nums">{fmtDateTime(visit.recordedAt)}</dd>
          </div>
        </dl>

        <label className="block">
          <span className="label">Observations</span>
          <textarea className="input mt-1 min-h-[130px]" value={observations} onChange={(e) => setObservations(e.target.value)} />
        </label>

        <label className="block">
          <span className="label">Direction given</span>
          <textarea className="input mt-1 min-h-[80px]" value={directionGiven} onChange={(e) => setDirectionGiven(e.target.value)} />
        </label>

        <label className="block">
          <span className="label">Reason for the amendment (required)</span>
          <textarea
            className="input mt-1 min-h-[90px]"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Original entry said north slope; the dry-in checked was the south slope. Corrected from the photos taken at the time."
          />
        </label>
      </div>
    </Drawer>
  );
}

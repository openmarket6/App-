import { useCallback, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { can, type PermitDocument } from '@flph/shared';
import { get, post } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { fmtDateTime, humanEnum } from '../lib/format.ts';
import { fmtBytes, readFileAsUpload, tryGeolocate } from '../lib/upload.ts';
import type { DocumentListResponse, DocumentUploadResponse } from '../lib/api-shapes.ts';
import type { PermitDetailResponse } from '../lib/types.ts';
import { DocumentImage } from '../components/DocumentLink.tsx';
import EmptyState from '../components/EmptyState.tsx';
import ErrorState, { errorMessage } from '../components/ErrorState.tsx';
import { LoadingPanel } from '../components/Spinner.tsx';
import StageBadge from '../components/StageBadge.tsx';

/**
 * Job photos for one permit.
 *
 * Photos are the cheapest evidence anybody on a job site can produce, and they
 * are worth most when they carry when and where. So the page asks for
 * location, says plainly why, and carries on without it if the browser or the
 * person says no — a permission prompt that blocks the upload behind it turns
 * a thirty-second task into a support call.
 *
 * `capturedAt` is the camera's timestamp taken from the file, not the upload
 * time. Those are different facts and the record keeps both.
 */

const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

interface Rejected {
  name: string;
  reason: string;
}

export default function JobPhotos() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);

  const [dragging, setDragging] = useState(false);
  const [queue, setQueue] = useState<File[]>([]);
  const [rejected, setRejected] = useState<Rejected[]>([]);
  const [wantLocation, setWantLocation] = useState(true);
  const [locationNote, setLocationNote] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const canUpload = !!user && (can(user.role, 'portal:upload_own') || can(user.role, 'document:upload'));

  const permitQ = useQuery({
    queryKey: ['permit', id],
    queryFn: () => get<PermitDetailResponse>(`/permits/${id}`),
    enabled: !!id,
  });

  const photosQ = useQuery({
    queryKey: ['documents', 'photos', id],
    queryFn: () => get<DocumentListResponse>(`/documents?permitId=${id}&category=JOB_PHOTO`),
    enabled: !!id,
  });

  const photos = useMemo(
    () =>
      [...(photosQ.data?.documents ?? [])].sort(
        (a, b) => Date.parse(b.capturedAt ?? b.uploadedAt) - Date.parse(a.capturedAt ?? a.uploadedAt),
      ),
    [photosQ.data],
  );

  const accept = useCallback((files: File[]) => {
    const ok: File[] = [];
    const bad: Rejected[] = [];
    for (const f of files) {
      if (!f.type.startsWith('image/')) {
        bad.push({ name: f.name, reason: `${f.type || 'unknown type'} is not an image — job photos are images only.` });
        continue;
      }
      if (f.size > MAX_PHOTO_BYTES) {
        bad.push({
          name: f.name,
          reason: `${fmtBytes(f.size)} is over the 15MB limit. Most phones can send a smaller copy.`,
        });
        continue;
      }
      ok.push(f);
    }
    setQueue((prev) => [...prev, ...ok]);
    setRejected(bad);
  }, []);

  const upload = useMutation({
    mutationFn: async () => {
      let geo: { lat: number; lng: number; accuracyM: number | null } | null = null;
      if (wantLocation) {
        geo = await tryGeolocate();
        setLocationNote(
          geo
            ? `Location attached: ${geo.lat.toFixed(5)}, ${geo.lng.toFixed(5)}${geo.accuracyM != null ? ` (±${geo.accuracyM} m)` : ''}.`
            : 'Your browser did not give a location, so these were uploaded without one. Nothing else changes.',
        );
      } else {
        setLocationNote(null);
      }

      setProgress({ done: 0, total: queue.length });
      for (const [i, file] of queue.entries()) {
        const payload = await readFileAsUpload(file);
        await post<DocumentUploadResponse>('/documents/photos', {
          ...payload,
          permitId: id,
          // The camera's own timestamp, not when it reached us.
          capturedAt: new Date(file.lastModified).toISOString(),
          geo: geo ? { lat: geo.lat, lng: geo.lng } : null,
        });
        setProgress({ done: i + 1, total: queue.length });
      }
    },
    onSuccess: () => {
      setQueue([]);
      setProgress(null);
      void qc.invalidateQueries({ queryKey: ['documents'] });
      void qc.invalidateQueries({ queryKey: ['permit', id] });
    },
    onError: () => setProgress(null),
  });

  if (permitQ.isLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Job photos</h1>
        <LoadingPanel label="Loading the permit…" rows={3} />
      </div>
    );
  }

  if (permitQ.isError) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Job photos</h1>
        <ErrorState error={permitQ.error} onRetry={() => void permitQ.refetch()} title="Could not load this permit" />
      </div>
    );
  }

  const permit = permitQ.data?.permit ?? null;
  const project = permitQ.data?.project ?? null;

  return (
    <div className="space-y-5">
      <div>
        <Link to={`/permits/${id}`} className="link text-[13px]">
          ← Back to the permit
        </Link>
        <h1 className="mt-1 text-xl font-semibold">Job photos</h1>
        {permit && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-ink-soft">
            <span className="font-mono text-[13px]">{permit.agencyRecordId ?? 'Not yet numbered'}</span>
            <StageBadge stage={permit.stage} />
            <span>
              {project?.addressLine1 ?? project?.name ?? 'Job site'} · {humanEnum(permit.permitType)}
            </span>
          </div>
        )}
      </div>

      {!canUpload && (
        <div className="card">
          <EmptyState
            title="Your role cannot upload photos"
            hint="You can see what has already been uploaded below."
            compact
          />
        </div>
      )}

      {canUpload && (
        <div className="card card-pad">
          {/* --- drop zone ------------------------------------------------- */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              accept(Array.from(e.dataTransfer.files));
            }}
            onClick={() => inputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
            }}
            className={`rounded-card border-2 border-dashed px-6 py-10 text-center cursor-pointer transition-colors ${
              dragging ? 'border-brand bg-brand-soft' : 'border-line hover:border-brand/40 hover:bg-page'
            }`}
          >
            <div className="text-sm font-medium">Drop photos here, or click to choose them</div>
            <div className="mt-1 text-[12px] text-ink-soft">
              Images only — JPEG, PNG, HEIC or WebP. Up to 15MB each. Take as many as you like; they are cheap and they
              settle arguments.
            </div>
          </div>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept="image/*"
            capture="environment"
            className="sr-only"
            onChange={(e) => {
              accept(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />

          {/* --- location -------------------------------------------------- */}
          <div className="mt-4 rounded-md bg-page px-3.5 py-3">
            <label className="flex items-start gap-2.5">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-line text-brand focus:ring-brand/30"
                checked={wantLocation}
                onChange={(e) => setWantLocation(e.target.checked)}
              />
              <span className="min-w-0">
                <span className="block text-[13px] font-medium">Attach this device's location to these photos</span>
                <span className="mt-0.5 block text-[12px] text-ink-soft leading-relaxed">
                  A photo that can show it was taken at the address on the permit is worth considerably more than one
                  that cannot — for inspections, for supervision records, and for any dispute about what was done
                  where. Your browser will ask for permission the first time. If you decline, or it fails, the photos
                  upload anyway without a location and nothing else changes.
                </span>
              </span>
            </label>
            {locationNote && <p className="mt-2 text-[12px] text-ink-soft">{locationNote}</p>}
          </div>

          {/* --- rejects --------------------------------------------------- */}
          {rejected.length > 0 && (
            <ul className="mt-3 space-y-1">
              {rejected.map((r) => (
                <li key={r.name} className="rounded bg-danger-soft px-3 py-2 text-[12px] text-danger leading-snug">
                  <span className="font-medium">{r.name}</span> — {r.reason}
                </li>
              ))}
            </ul>
          )}

          {/* --- queue ----------------------------------------------------- */}
          {queue.length > 0 && (
            <div className="mt-4">
              <div className="flex items-baseline justify-between gap-3">
                <span className="label">
                  {queue.length} photo{queue.length === 1 ? '' : 's'} ready
                </span>
                <button type="button" className="link text-[13px]" onClick={() => setQueue([])} disabled={upload.isPending}>
                  Clear
                </button>
              </div>
              <ul className="mt-2 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
                {queue.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="rounded border border-line overflow-hidden">
                    <QueuedThumb file={f} />
                    <div className="px-1.5 py-1">
                      <div className="text-[11px] truncate" title={f.name}>
                        {f.name}
                      </div>
                      <div className="text-[10px] text-ink-mute">{fmtBytes(f.size)}</div>
                    </div>
                  </li>
                ))}
              </ul>

              {upload.isError && (
                <div className="mt-3">
                  <ErrorState error={upload.error} compact title="Some photos did not upload" />
                  <p className="mt-1 text-[12px] text-ink-soft">
                    {errorMessage(upload.error)} Anything that already went up is safe — try the rest again.
                  </p>
                </div>
              )}

              <div className="mt-3 flex items-center justify-between gap-3 flex-wrap">
                <span className="text-[12px] text-ink-soft">
                  {progress
                    ? `Uploading ${progress.done} of ${progress.total}…`
                    : 'Each photo is hashed on arrival, so a silent replacement later would be visible.'}
                </span>
                <button type="button" className="btn-primary" disabled={upload.isPending} onClick={() => upload.mutate()}>
                  {upload.isPending
                    ? 'Uploading…'
                    : `Upload ${queue.length} photo${queue.length === 1 ? '' : 's'}`}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* --- already uploaded -------------------------------------------- */}
      <section>
        <div className="flex items-baseline justify-between gap-3 mb-3">
          <h2 className="text-sm font-semibold">Already on this job</h2>
          <span className="text-[12px] text-ink-mute">
            {photos.length} photo{photos.length === 1 ? '' : 's'} · newest capture first
          </span>
        </div>

        {photosQ.isLoading && <LoadingPanel label="Loading photos…" rows={2} />}
        {photosQ.isError && (
          <ErrorState error={photosQ.error} onRetry={() => void photosQ.refetch()} title="Could not load the photos" />
        )}

        {!photosQ.isLoading && !photosQ.isError && photos.length === 0 && (
          <div className="card">
            <EmptyState
              title="No photos on this job yet"
              hint="Before, during and after is the useful set. Progress shots at each stage make a re-inspection argument much shorter."
              compact
            />
          </div>
        )}

        {photos.length > 0 && (
          <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {photos.map((p) => (
              <PhotoCard key={p.id} photo={p} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// --------------------------------------------------------------------------

function QueuedThumb({ file }: { file: File }) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  return <img src={url} alt="" className="h-24 w-full object-cover" onLoad={() => URL.revokeObjectURL(url)} />;
}

function PhotoCard({ photo }: { photo: PermitDocument }) {
  return (
    <li className="card overflow-hidden">
      <DocumentImage documentId={photo.id} alt={photo.fileName} className="h-32 w-full object-cover" />
      <div className="px-2.5 py-2">
        <div className="text-[12px] font-medium truncate" title={photo.fileName}>
          {photo.fileName}
        </div>
        <div className="mt-0.5 text-[11px] text-ink-soft leading-snug">
          {photo.capturedAt ? (
            <>
              Taken {fmtDateTime(photo.capturedAt)}
              <span className="block text-ink-mute">Uploaded {fmtDateTime(photo.uploadedAt)}</span>
            </>
          ) : (
            <>Uploaded {fmtDateTime(photo.uploadedAt)}</>
          )}
        </div>
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="text-[10px] text-ink-mute">{fmtBytes(photo.sizeBytes)}</span>
          {photo.geo && (
            <span
              className="badge-gray"
              title={`${photo.geo.lat.toFixed(5)}, ${photo.geo.lng.toFixed(5)}`}
            >
              Located
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

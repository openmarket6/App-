import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, ApiError } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { fmtDateTime } from '../lib/format.ts';
import { readFileAsUpload, tryGeolocate } from '../lib/upload.ts';
import {
  enqueue, listQueue, flush, discard, retry, type FieldAction,
} from '../lib/fieldQueue.ts';
import EmptyState from '../components/EmptyState.tsx';
import ErrorState, { errorMessage } from '../components/ErrorState.tsx';
import { LoadingPanel } from '../components/Spinner.tsx';

/**
 * The supervisor's field screen.
 *
 * Built for a phone held in one hand on a job site, not for a desk. Three
 * things drive every decision here:
 *
 * 1. THE ORDER IS THE INSTRUCTION. Overdue first, then today. A supervisor
 *    scrolling to find what to do next is a supervisor who misses a mandatory
 *    visit, and a missed mandatory visit is a hole in the record this business
 *    sells.
 *
 * 2. NOTHING IS LOST TO SIGNAL. Every action is written to the outbox before it
 *    is sent (see lib/fieldQueue.ts). A photograph of a roof deck cannot be
 *    retaken once the deck is covered, so it must survive a dead zone, a
 *    locked phone and a closed tab.
 *
 * 3. SAY WHAT IS STILL NEEDED, NOW. The moment to tell somebody they are one
 *    photograph short is while they are standing on the site. Told an hour
 *    later, it is a second trip.
 */

const PHOTO_TYPES = [
  { value: 'site_overview', label: 'Site overview' },
  { value: 'work_in_progress', label: 'Work in progress' },
  { value: 'completed_work', label: 'Completed work' },
  { value: 'defect', label: 'Defect' },
  { value: 'materials', label: 'Materials / product approval' },
  { value: 'safety', label: 'Safety' },
  { value: 'other', label: 'Other' },
] as const;

interface QueuedVisit {
  id: string;
  permitId: string | null;
  milestoneName: string | null;
  status: string;
  isMandatory: boolean;
  scheduledFor: string | null;
  checkedInAt: string | null;
  requiredPhotoCount: number;
  photoCount: number;
  siteAddress: string | null;
  siteCity: string | null;
  contractorName: string | null;
  overdue: boolean;
}

interface MyVisitsResponse {
  visits: QueuedVisit[];
  total: number;
  overdueCount: number;
  note?: string;
}

/** 20 MB, matching the endpoint. Rejected here so the outbox never holds one. */
const MAX_PHOTO_BYTES = 20 * 1024 * 1024;

function sendAction(action: FieldAction): Promise<unknown> {
  const path = {
    'check-in': `/supervision/visits/${action.visitId}/check-in`,
    photo: `/supervision/visits/${action.visitId}/photos`,
    'sign-off': `/supervision/visits/${action.visitId}/sign-off`,
  }[action.kind];
  return post(path, action.body);
}

export default function FieldVisits() {
  const { user } = useAuth();
  const qc = useQueryClient();

  const [open, setOpen] = useState<string | null>(null);
  const [outbox, setOutbox] = useState<FieldAction[]>([]);
  const [online, setOnline] = useState(
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const flushing = useRef(false);

  const visitsQ = useQuery({
    queryKey: ['myVisits'],
    queryFn: () => get<MyVisitsResponse>('/supervision/my-visits'),
    // The queue changes while somebody is on site. Stale data here means
    // driving to a visit that was reassigned an hour ago.
    refetchInterval: 60_000,
  });

  const refreshOutbox = useCallback(async () => {
    try {
      setOutbox(await listQueue());
    } catch {
      // No IndexedDB (private mode on some browsers). The screen still works
      // online; it just cannot hold anything back.
      setOutbox([]);
    }
  }, []);

  const drain = useCallback(async () => {
    if (flushing.current) return;
    flushing.current = true;
    setBusy(true);
    try {
      const result = await flush(async (a) => {
        try {
          await sendAction(a);
        } catch (err) {
          if (err instanceof ApiError) throw Object.assign(err, { status: err.status });
          throw err;
        }
      });
      if (result.sent > 0) {
        await qc.invalidateQueries({ queryKey: ['myVisits'] });
        setNote(`${result.sent} update${result.sent === 1 ? '' : 's'} sent.`);
      }
      if (result.blocked > 0) {
        setNote(
          `${result.blocked} item${result.blocked === 1 ? '' : 's'} could not be sent and ` +
            'need you to look at them.',
        );
      }
    } finally {
      flushing.current = false;
      setBusy(false);
      await refreshOutbox();
    }
  }, [qc, refreshOutbox]);

  useEffect(() => {
    void refreshOutbox();
  }, [refreshOutbox]);

  /*
   * Flush the moment signal comes back, without waiting for a tap. Somebody
   * walking from a stairwell to a truck should not have to remember to press
   * anything -- the whole point of the outbox is that they do not have to
   * think about it.
   */
  useEffect(() => {
    const up = () => {
      setOnline(true);
      void drain();
    };
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    if (navigator.onLine) void drain();
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, [drain]);

  const visits = visitsQ.data?.visits ?? [];
  const pendingFor = useCallback(
    (visitId: string) => outbox.filter((a) => a.visitId === visitId),
    [outbox],
  );
  const blocked = useMemo(() => outbox.filter((a) => a.blocked), [outbox]);

  if (!user) return null;

  return (
    <div className="mx-auto w-full max-w-2xl px-3 pb-24 pt-3 sm:px-4">
      <header className="mb-3">
        <h1 className="text-xl font-semibold">Today’s visits</h1>
        <p className="text-sm text-ink-mute">
          {visitsQ.data
            ? `${visits.length} open${
                visitsQ.data.overdueCount ? `, ${visitsQ.data.overdueCount} overdue` : ''
              }`
            : 'Loading your queue…'}
        </p>
      </header>

      {/*
        * The connection banner is always visible rather than a toast. A
        * supervisor needs to know at a glance whether what they just did has
        * actually left the phone, and a message that fades away cannot answer
        * that question thirty seconds later.
        */}
      <div
        className={`mb-3 rounded-lg border px-3 py-2 text-sm ${
          online
            ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
            : 'border-amber-300 bg-amber-50 text-amber-900'
        }`}
      >
        {online ? (
          outbox.length === 0 ? (
            <span>Connected. Everything is saved.</span>
          ) : (
            <span>
              Connected. {outbox.length} item{outbox.length === 1 ? '' : 's'} waiting to send.{' '}
              <button className="underline" onClick={() => void drain()} disabled={busy}>
                {busy ? 'Sending…' : 'Send now'}
              </button>
            </span>
          )
        ) : (
          <span>
            No signal. Keep working — {outbox.length} item
            {outbox.length === 1 ? '' : 's'} saved on this phone and will send by themselves.
          </span>
        )}
      </div>

      {note && (
        <div className="mb-3 rounded-lg border border-line bg-white px-3 py-2 text-sm">
          {note}{' '}
          <button className="underline text-ink-mute" onClick={() => setNote(null)}>
            dismiss
          </button>
        </div>
      )}

      {blocked.length > 0 && (
        <section className="mb-4 rounded-lg border border-rose-300 bg-rose-50 p-3">
          <h2 className="text-sm font-semibold text-rose-900">Needs you</h2>
          <p className="mt-1 text-xs text-rose-800">
            These were refused for a reason retrying will not fix.
          </p>
          <ul className="mt-2 space-y-2">
            {blocked.map((a) => (
              <li key={a.id} className="rounded border border-rose-200 bg-white p-2 text-sm">
                <div className="font-medium">{a.label}</div>
                <div className="text-xs text-rose-800">{a.lastError}</div>
                <div className="mt-1 flex gap-3 text-xs">
                  <button
                    className="underline"
                    onClick={async () => {
                      await retry(a.id);
                      await refreshOutbox();
                      void drain();
                    }}
                  >
                    Try again
                  </button>
                  <button
                    className="underline text-ink-mute"
                    onClick={async () => {
                      await discard(a.id);
                      await refreshOutbox();
                    }}
                  >
                    Discard
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {visitsQ.isLoading && <LoadingPanel label="Loading your visits" />}
      {visitsQ.isError && <ErrorState error={visitsQ.error} onRetry={() => void visitsQ.refetch()} />}

      {visitsQ.data?.note && (
        <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {visitsQ.data.note}
        </div>
      )}

      {visitsQ.data && visits.length === 0 && !visitsQ.data.note && (
        <EmptyState
          title="Nothing assigned"
          hint="No open site visits. New ones appear here as they are scheduled."
        />
      )}

      <ul className="space-y-3">
        {visits.map((v) => (
          <VisitCard
            key={v.id}
            visit={v}
            expanded={open === v.id}
            pending={pendingFor(v.id)}
            onToggle={() => setOpen(open === v.id ? null : v.id)}
            onQueued={async () => {
              await refreshOutbox();
              if (navigator.onLine) void drain();
            }}
          />
        ))}
      </ul>
    </div>
  );
}

// -----------------------------------------------------------------------------

function VisitCard({
  visit, expanded, pending, onToggle, onQueued,
}: {
  visit: QueuedVisit;
  expanded: boolean;
  pending: FieldAction[];
  onToggle: () => void;
  onQueued: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [photoType, setPhotoType] = useState<string>('work_in_progress');
  const [caption, setCaption] = useState('');
  const [findings, setFindings] = useState('');
  const [approved, setApproved] = useState(true);
  const [corrections, setCorrections] = useState('');
  const [signature, setSignature] = useState('');
  const cameraRef = useRef<HTMLInputElement>(null);

  const queuedPhotos = pending.filter((a) => a.kind === 'photo').length;
  const checkedIn = Boolean(visit.checkedInAt) || pending.some((a) => a.kind === 'check-in');
  // Counted optimistically: a photograph in the outbox is a photograph taken.
  // Telling somebody they are short when the picture is already on the phone
  // would send them back up a ladder for nothing.
  const photos = visit.photoCount + queuedPhotos;
  const short = Math.max(0, visit.requiredPhotoCount - photos);

  const guard = async (fn: () => Promise<void>) => {
    setError(null);
    setWorking(true);
    try {
      await fn();
      await onQueued();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setWorking(false);
    }
  };

  const checkIn = () =>
    guard(async () => {
      /*
       * Location is asked for and never required. A supervisor on a roof with
       * no GPS fix is still on the roof; refusing them teaches people to stop
       * logging visits, which costs far more evidence than a coordinate.
       */
      const where = await tryGeolocate();
      await enqueue({
        visitId: visit.id,
        kind: 'check-in',
        label: `Arrived — ${visit.milestoneName ?? 'visit'}`,
        body: where
          ? { lat: where.lat, lng: where.lng, accuracyM: where.accuracyM }
          : {},
      });
    });

  const addPhotos = (files: FileList | null) =>
    guard(async () => {
      if (!files || files.length === 0) return;
      const where = await tryGeolocate();
      for (const file of Array.from(files)) {
        if (file.size > MAX_PHOTO_BYTES) {
          throw new Error(`${file.name} is too large. Around 20 MB is the limit.`);
        }
        const payload = await readFileAsUpload(file);
        await enqueue({
          visitId: visit.id,
          kind: 'photo',
          label: `Photo — ${PHOTO_TYPES.find((t) => t.value === photoType)?.label ?? photoType}`,
          body: {
            ...payload,
            photoType,
            caption: caption.trim() || null,
            // The camera's own timestamp where the file has one. When it does
            // not, now -- which is still the truth on a phone in a hand.
            takenAt: new Date(file.lastModified || Date.now()).toISOString(),
            lat: where?.lat ?? null,
            lng: where?.lng ?? null,
          },
        });
      }
      setCaption('');
      if (cameraRef.current) cameraRef.current.value = '';
    });

  const signOff = () =>
    guard(async () => {
      if (!findings.trim()) throw new Error('Say what you saw. That is the record.');
      if (!approved && !corrections.trim()) {
        throw new Error(
          'If the work is not approved, say what has to change. A refusal with no ' +
            'direction leaves the crew guessing.',
        );
      }
      if (!signature.trim()) throw new Error('Sign it with your name.');
      if (short > 0) {
        throw new Error(
          `This visit needs ${visit.requiredPhotoCount} photographs and has ${photos}. ` +
            'Take the rest before you leave — a signed-off visit with no photographic ' +
            'record is a claim that somebody was there, not evidence.',
        );
      }
      await enqueue({
        visitId: visit.id,
        kind: 'sign-off',
        label: `Signed off — ${visit.milestoneName ?? 'visit'}`,
        body: {
          findings: findings.trim(),
          workApproved: approved,
          correctionsRequired: approved ? null : corrections.trim(),
          signatureName: signature.trim(),
        },
      });
      setFindings('');
      setCorrections('');
      setSignature('');
    });

  return (
    <li
      className={`rounded-xl border bg-white ${
        visit.overdue ? 'border-rose-300' : 'border-line'
      }`}
    >
      <button
        className="flex w-full items-start gap-3 p-3 text-left"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{visit.milestoneName ?? 'Site visit'}</span>
            {visit.isMandatory && (
              <span className="rounded bg-ink px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                Mandatory
              </span>
            )}
            {visit.overdue && (
              <span className="rounded bg-rose-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                Overdue
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-sm text-ink-mute">
            {[visit.siteAddress, visit.siteCity].filter(Boolean).join(', ') ||
              'No site address on file'}
          </div>
          <div className="mt-0.5 text-xs text-ink-mute">
            {visit.contractorName ?? 'Contractor not named'}
            {visit.scheduledFor ? ` · due ${fmtDateTime(visit.scheduledFor)}` : ''}
          </div>
          <div className="mt-1 text-xs">
            {checkedIn ? (
              <span className="text-emerald-700">On site</span>
            ) : (
              <span className="text-ink-mute">Not checked in</span>
            )}
            {' · '}
            <span className={short > 0 ? 'text-amber-700' : 'text-emerald-700'}>
              {photos}/{visit.requiredPhotoCount} photos
            </span>
            {pending.length > 0 && (
              <span className="text-ink-mute"> · {pending.length} waiting to send</span>
            )}
          </div>
        </div>
        <span aria-hidden className="pt-1 text-ink-mute">{expanded ? '−' : '+'}</span>
      </button>

      {expanded && (
        <div className="border-t border-line p-3">
          {error && (
            <div className="mb-3 rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900">
              {error}
            </div>
          )}

          {!checkedIn && (
            <button
              className="mb-4 w-full rounded-lg bg-ink px-4 py-3 text-base font-semibold text-white disabled:opacity-50"
              onClick={() => void checkIn()}
              disabled={working}
            >
              {working ? 'Saving…' : "I'm on site"}
            </button>
          )}

          <section className="mb-4">
            <h3 className="mb-2 text-sm font-semibold">Photographs</h3>
            <label className="mb-2 block text-xs text-ink-mute">
              What does this show?
              <select
                className="mt-1 w-full rounded border border-line bg-white px-2 py-2 text-base"
                value={photoType}
                onChange={(e) => setPhotoType(e.target.value)}
              >
                {PHOTO_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </label>
            <input
              className="mb-2 w-full rounded border border-line px-2 py-2 text-base"
              placeholder="Caption (optional)"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
            />
            {/*
              * `capture="environment"` opens the rear camera directly instead
              * of the photo library. On a job site the picture being taken is
              * the one in front of you, and one fewer tap matters when you are
              * holding a ladder.
              */}
            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              className="hidden"
              onChange={(e) => void addPhotos(e.target.files)}
            />
            <button
              className="w-full rounded-lg border-2 border-ink px-4 py-3 text-base font-semibold disabled:opacity-50"
              onClick={() => cameraRef.current?.click()}
              disabled={working}
            >
              Take a photo
            </button>
            <p className={`mt-2 text-xs ${short > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>
              {short > 0
                ? `${short} more needed before this visit can be signed off.`
                : 'Enough photographs to sign off.'}
            </p>
          </section>

          <section>
            <h3 className="mb-2 text-sm font-semibold">Sign off</h3>
            <textarea
              className="mb-2 w-full rounded border border-line px-2 py-2 text-base"
              rows={4}
              placeholder="What did you see? This is the record."
              value={findings}
              onChange={(e) => setFindings(e.target.value)}
            />
            <div className="mb-2 flex gap-2">
              <button
                className={`flex-1 rounded-lg px-3 py-3 text-sm font-semibold ${
                  approved ? 'bg-emerald-600 text-white' : 'border border-line'
                }`}
                onClick={() => setApproved(true)}
              >
                Work approved
              </button>
              <button
                className={`flex-1 rounded-lg px-3 py-3 text-sm font-semibold ${
                  !approved ? 'bg-rose-600 text-white' : 'border border-line'
                }`}
                onClick={() => setApproved(false)}
              >
                Corrections needed
              </button>
            </div>
            {!approved && (
              <textarea
                className="mb-2 w-full rounded border border-line px-2 py-2 text-base"
                rows={3}
                placeholder="What has to change? The crew acts on this."
                value={corrections}
                onChange={(e) => setCorrections(e.target.value)}
              />
            )}
            <input
              className="mb-2 w-full rounded border border-line px-2 py-2 text-base"
              placeholder="Your name"
              value={signature}
              onChange={(e) => setSignature(e.target.value)}
            />
            <button
              className="w-full rounded-lg bg-ink px-4 py-3 text-base font-semibold text-white disabled:opacity-50"
              onClick={() => void signOff()}
              disabled={working}
            >
              {working ? 'Saving…' : 'Sign off this visit'}
            </button>
          </section>
        </div>
      )}
    </li>
  );
}

import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PERMIT_TYPES,
  can,
  dollarsToCents,
  formatCents,
  type PermitRequestStatus,
  type PermitType,
} from '@flph/shared';
import { get, post } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { fmtDate, fmtDateTime, humanEnum } from '../lib/format.ts';
import { fmtBytes, readFileAsUpload } from '../lib/upload.ts';
import type { DocumentUploadResponse } from '../lib/api-shapes.ts';
import type { PermitRequestListResponse, PermitRequestRow } from '../lib/portal-shapes.ts';
import EmptyState from '../components/EmptyState.tsx';
import ErrorState, { errorMessage } from '../components/ErrorState.tsx';
import { LoadingPanel } from '../components/Spinner.tsx';

/**
 * Ask us to pull a permit.
 *
 * This is intake, not filing, and the page says so in as many places as it
 * takes. A contractor who believes they have just filed a permit will not
 * chase the address question, will not send the survey, and will be angry in
 * two weeks — so "a coordinator confirms the jurisdiction and the permit type"
 * appears before the form, inside it, and on the confirmation.
 *
 * The one field that matters is the scope of work in their own words. Address
 * and permit type we can check; what the job actually is, only they know.
 */

const STATUS_LABEL: Record<PermitRequestStatus, string> = {
  SUBMITTED: 'With our team',
  IN_TRIAGE: 'Being worked out',
  NEEDS_INFO: 'We need something from you',
  ACCEPTED: 'Accepted — it is a permit now',
  DECLINED: 'Declined',
  WITHDRAWN: 'Withdrawn',
};

const STATUS_CLASS: Record<PermitRequestStatus, string> = {
  SUBMITTED: 'badge-blue',
  IN_TRIAGE: 'badge-blue',
  NEEDS_INFO: 'badge-amber',
  ACCEPTED: 'badge-green',
  DECLINED: 'badge-red',
  WITHDRAWN: 'badge-gray',
};

const WITHDRAWABLE: PermitRequestStatus[] = ['SUBMITTED', 'IN_TRIAGE', 'NEEDS_INFO'];

interface Attachment {
  id: string;
  fileName: string;
  sizeBytes: number;
}

export default function PortalRequestPermit() {
  const { user } = useAuth();
  const qc = useQueryClient();

  const canRequest = !!user && can(user.role, 'portal:request_permit');
  const canUpload = !!user && (can(user.role, 'portal:upload_own') || can(user.role, 'document:upload'));

  const [scopeOfWork, setScopeOfWork] = useState('');
  const [addressLine1, setAddressLine1] = useState('');
  const [city, setCity] = useState('');
  const [zip, setZip] = useState('');
  const [county, setCounty] = useState('');
  const [permitType, setPermitType] = useState<PermitType | ''>('');
  const [valueDollars, setValueDollars] = useState('');
  const [desiredStartDate, setDesiredStartDate] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<PermitRequestRow | null>(null);

  const requestsQ = useQuery({
    queryKey: ['portal', 'permit-requests'],
    queryFn: () => get<PermitRequestListResponse>('/portal/permit-requests'),
  });

  const submit = useMutation({
    mutationFn: () => {
      const dollars = Number(valueDollars.replace(/[^0-9.]/g, ''));
      return post<PermitRequestRow>('/portal/permit-requests', {
        scopeOfWork: scopeOfWork.trim(),
        addressLine1: addressLine1.trim(),
        city: city.trim(),
        zip: zip.trim(),
        county: county.trim() || null,
        suggestedPermitType: permitType || null,
        // Dollars in the box, integer cents on the wire. A float here rounds
        // its way into a fee schedule.
        estimatedValueCents: valueDollars.trim() && Number.isFinite(dollars) ? dollarsToCents(dollars) : null,
        desiredStartDate: desiredStartDate || null,
        attachmentIds: attachments.map((a) => a.id),
      });
    },
    onSuccess: (row) => {
      setSubmitted(row);
      setScopeOfWork('');
      setAddressLine1('');
      setCity('');
      setZip('');
      setCounty('');
      setPermitType('');
      setValueDollars('');
      setDesiredStartDate('');
      setAttachments([]);
      void qc.invalidateQueries({ queryKey: ['portal', 'permit-requests'] });
      void qc.invalidateQueries({ queryKey: ['portal', 'actions'] });
    },
  });

  const withdraw = useMutation({
    mutationFn: (id: string) => post<PermitRequestRow>(`/portal/permit-requests/${id}/withdraw`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['portal', 'permit-requests'] }),
  });

  async function attachFiles(files: File[]) {
    if (files.length === 0) return;
    setAttachError(null);
    setAttaching(true);
    for (const file of files) {
      try {
        const payload = await readFileAsUpload(file);
        // There is no permit yet, so these are filed against the contractor
        // rather than a job. Triage moves them onto the permit it creates.
        const res = await post<DocumentUploadResponse>('/documents', {
          ...payload,
          permitId: null,
          category: 'OTHER',
        });
        setAttachments((prev) => [
          ...prev,
          { id: res.document.id, fileName: res.document.fileName, sizeBytes: res.document.sizeBytes },
        ]);
      } catch (e) {
        setAttachError(`${file.name}: ${errorMessage(e)}`);
      }
    }
    setAttaching(false);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!scopeOfWork.trim()) {
      setFormError('Tell us what the work is — that is the field we cannot guess.');
      return;
    }
    if (!addressLine1.trim() || !city.trim() || !zip.trim()) {
      setFormError('We need the street address, the city and the zip to work out which building department this is.');
      return;
    }
    submit.mutate();
  }

  const requests = requestsQ.data?.requests ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Request a permit</h1>
        <p className="mt-1 text-sm text-ink-soft leading-relaxed max-w-2xl">
          Tell us about the job and we take it from there. This is a request, not a filing — a coordinator confirms
          which building department covers the address and which permit type it actually needs, then it becomes a
          tracked permit you can follow. Nothing has been filed with anyone until you see it accepted.
        </p>
      </div>

      {!canRequest && (
        <div className="card">
          <EmptyState
            title="Your login cannot send us a job"
            hint="Whoever administers your company's logins can give you this, or send the details to your coordinator and we will raise it for you."
            action={
              <Link to="/support" className="btn-primary">
                Message your coordinator
              </Link>
            }
          />
        </div>
      )}

      {submitted && (
        <div className="rounded-md border border-good/30 bg-good-soft px-4 py-3">
          <div className="text-sm font-semibold text-good">We have got it. Nothing is filed yet.</div>
          <p className="mt-1 text-[13px] text-ink-soft leading-relaxed">
            {submitted.addressLine1}, {submitted.city} {submitted.zip}. {submitted.nextStep} You will see it in the
            list below, and it turns into a permit here the moment we accept it.
          </p>
        </div>
      )}

      {canRequest && (
        <form onSubmit={onSubmit} className="card card-pad space-y-4">
          <label className="block">
            <span className="label">
              What is the work? <span className="text-danger">Required</span>
            </span>
            <textarea
              className="input mt-1 min-h-[120px]"
              value={scopeOfWork}
              onChange={(e) => setScopeOfWork(e.target.value)}
              placeholder="Tear off and replace 28 squares of shingle on a single-family house, plywood as needed, new underlayment, ridge vent. Existing structure, no framing changes."
            />
            <span className="mt-1 block text-[12px] text-ink-soft leading-relaxed">
              In your own words, the way you would tell a foreman. The more specific this is, the fewer questions come
              back and the less likely a plans examiner sends it back for scope.
            </span>
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block sm:col-span-2">
              <span className="label">Job address</span>
              <input
                className="input mt-1"
                value={addressLine1}
                onChange={(e) => setAddressLine1(e.target.value)}
                placeholder="1420 Sunset Harbour Dr"
                autoComplete="address-line1"
              />
            </label>

            <label className="block">
              <span className="label">City</span>
              <input
                className="input mt-1"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="Miami Beach"
                autoComplete="address-level2"
              />
            </label>

            <label className="block">
              <span className="label">Zip</span>
              <input
                className="input mt-1"
                value={zip}
                onChange={(e) => setZip(e.target.value)}
                placeholder="33139"
                inputMode="numeric"
                autoComplete="postal-code"
              />
            </label>

            <label className="block">
              <span className="label">County (optional)</span>
              <input
                className="input mt-1"
                value={county}
                onChange={(e) => setCounty(e.target.value)}
                placeholder="Miami-Dade"
              />
              <span className="mt-1 block text-[12px] text-ink-mute">
                Leave it blank if you are not sure — we work it out from the address.
              </span>
            </label>

            <label className="block">
              <span className="label">Permit type you think it is (optional)</span>
              <select
                className="input mt-1"
                value={permitType}
                onChange={(e) => setPermitType(e.target.value as PermitType | '')}
              >
                <option value="">Not sure — you tell me</option>
                {PERMIT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {humanEnum(t)}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-[12px] text-ink-mute">A guess is fine. We confirm it in triage.</span>
            </label>

            <label className="block">
              <span className="label">Estimated job value (optional)</span>
              <div className="mt-1 flex items-center gap-2">
                <span className="text-sm text-ink-mute">$</span>
                <input
                  className="input"
                  value={valueDollars}
                  onChange={(e) => setValueDollars(e.target.value)}
                  placeholder="24,500"
                  inputMode="decimal"
                />
              </div>
              <span className="mt-1 block text-[12px] text-ink-mute">
                Most departments set their fee off this. A rough number is better than none.
              </span>
            </label>

            <label className="block">
              <span className="label">When do you want to start? (optional)</span>
              <input
                type="date"
                className="input mt-1"
                value={desiredStartDate}
                onChange={(e) => setDesiredStartDate(e.target.value)}
              />
              <span className="mt-1 block text-[12px] text-ink-mute">
                Tells us how hard to push, and whether the review time at that department is going to be a problem.
              </span>
            </label>
          </div>

          {/* --- attachments ------------------------------------------------ */}
          <div>
            <span className="label">Anything you already have (optional)</span>
            <p className="mt-1 text-[12px] text-ink-soft leading-relaxed">
              Sketches, a survey, product data sheets, photos of what is there now. Nothing here is required — send
              what you have and we will tell you what else the department wants.
            </p>
            {canUpload ? (
              <>
                <input
                  type="file"
                  multiple
                  className="input mt-2 py-1.5 text-[13px]"
                  disabled={attaching}
                  onChange={(e) => {
                    void attachFiles(Array.from(e.target.files ?? []));
                    e.target.value = '';
                  }}
                />
                {attaching && <p className="mt-1 text-[12px] text-ink-soft">Uploading…</p>}
                {attachError && <p className="mt-1 text-[12px] text-danger">{attachError}</p>}
                {attachments.length > 0 && (
                  <ul className="mt-2 divide-y divide-line rounded-md border border-line">
                    {attachments.map((a) => (
                      <li key={a.id} className="flex items-center justify-between gap-3 px-3 py-2">
                        <span className="min-w-0 truncate text-[13px]" title={a.fileName}>
                          {a.fileName}
                        </span>
                        <span className="flex items-center gap-3 shrink-0">
                          <span className="text-[11px] tabular-nums text-ink-mute">{fmtBytes(a.sizeBytes)}</span>
                          <button
                            type="button"
                            className="link text-[12px]"
                            onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                          >
                            Remove
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="mt-2 text-[12px] text-ink-mute">
                Your login cannot upload files. Send the request without them and email your coordinator anything you
                have.
              </p>
            )}
          </div>

          {formError && <div className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">{formError}</div>}
          {submit.isError && <ErrorState error={submit.error} compact title="Could not send that request" />}

          <div className="flex items-center justify-between gap-3 flex-wrap border-t border-line pt-4">
            <p className="text-[12px] text-ink-soft max-w-md leading-relaxed">
              Sending this does not file anything. A coordinator reads it, confirms the jurisdiction and the permit
              type, and comes back to you — usually the same day.
            </p>
            <button type="submit" className="btn-primary" disabled={submit.isPending || attaching}>
              {submit.isPending ? 'Sending…' : 'Send it to us'}
            </button>
          </div>
        </form>
      )}

      {/* --- existing requests --------------------------------------------- */}
      <section>
        <div className="flex items-baseline justify-between gap-3 mb-3">
          <h2 className="text-sm font-semibold">Jobs you have sent us</h2>
          {requestsQ.data && (
            <span className="text-[12px] text-ink-mute">
              {requestsQ.data.openCount} still open of {requestsQ.data.total}
            </span>
          )}
        </div>

        {requestsQ.isLoading && <LoadingPanel label="Loading your requests…" rows={2} />}
        {requestsQ.isError && (
          <ErrorState
            error={requestsQ.error}
            onRetry={() => void requestsQ.refetch()}
            title="Could not load your requests"
          />
        )}

        {!requestsQ.isLoading && !requestsQ.isError && requests.length === 0 && (
          <div className="card">
            <EmptyState
              title="You have not sent us a job yet"
              hint="Fill in the form above — scope of work and an address is enough to start. Everything you send appears here with exactly where it has got to."
              compact
            />
          </div>
        )}

        {requests.length > 0 && (
          <ul className="space-y-3">
            {requests.map((r) => (
              <li key={r.id} className="card card-pad">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={STATUS_CLASS[r.status]}>{STATUS_LABEL[r.status]}</span>
                      <span className="text-[14px] font-medium">
                        {r.addressLine1}, {r.city} {r.zip}
                      </span>
                    </div>
                    <p className="mt-1.5 text-[13px] leading-relaxed whitespace-pre-wrap">{r.scopeOfWork}</p>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-soft">
                      <span>Sent {fmtDateTime(r.createdAt)}</span>
                      {r.suggestedPermitType && <span>You suggested {humanEnum(r.suggestedPermitType)}</span>}
                      {r.estimatedValueCents != null && <span>Valued {formatCents(r.estimatedValueCents)}</span>}
                      {r.desiredStartDate && <span>Wanted to start {fmtDate(r.desiredStartDate)}</span>}
                      {r.attachmentIds.length > 0 && (
                        <span>
                          {r.attachmentIds.length} attachment{r.attachmentIds.length === 1 ? '' : 's'}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="shrink-0 flex flex-col items-end gap-2">
                    {r.status === 'ACCEPTED' && r.permitId && (
                      <Link to={`/permits/${r.permitId}`} className="btn-primary whitespace-nowrap">
                        Open the permit
                      </Link>
                    )}
                    {canRequest && WITHDRAWABLE.includes(r.status) && (
                      <button
                        type="button"
                        className="btn-ghost whitespace-nowrap"
                        disabled={withdraw.isPending}
                        onClick={() => withdraw.mutate(r.id)}
                      >
                        {withdraw.isPending && withdraw.variables === r.id ? 'Withdrawing…' : 'Withdraw it'}
                      </button>
                    )}
                  </div>
                </div>

                <p
                  className={`mt-3 rounded-md px-3 py-2 text-[13px] leading-relaxed ${
                    r.status === 'NEEDS_INFO'
                      ? 'bg-warn-soft text-warn'
                      : r.status === 'DECLINED'
                        ? 'bg-danger-soft text-danger'
                        : 'bg-page text-ink-soft'
                  }`}
                >
                  <span className="font-semibold">What happens next: </span>
                  {r.nextStep}
                </p>
              </li>
            ))}
          </ul>
        )}

        {withdraw.isError && (
          <div className="mt-3">
            <ErrorState error={withdraw.error} compact title="Could not withdraw that request" />
          </div>
        )}
      </section>
    </div>
  );
}

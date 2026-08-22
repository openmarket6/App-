import { useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  COMPLIANCE_LABELS,
  DEFAULT_COMPLIANCE_POLICY,
  REQUIRED_SIGNABLES,
  SIGNABLE_LABELS,
  can,
  formatCents,
  type Client,
  type ComplianceKind,
  type SignableKind,
} from '@flph/shared';
import { ApiError, get, post } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { fmtDate } from '../lib/format.ts';
import { fmtBytes, readFileAsUpload } from '../lib/upload.ts';
import type {
  ClientListResponse,
  ComplianceListResponse,
  ComplianceRow,
  DocumentUploadResponse,
  SetupIntentResponse,
  SignatureListResponse,
  SigningStatusResponse,
} from '../lib/api-shapes.ts';
import ComplianceBadge, { expiryPhrase } from '../components/ComplianceBadge.tsx';
import EmptyState from '../components/EmptyState.tsx';
import ErrorState, { errorMessage } from '../components/ErrorState.tsx';
import Meter from '../components/Meter.tsx';
import { LoadingPanel } from '../components/Spinner.tsx';
import SignDocument from '../components/SignDocument.tsx';

/**
 * The onboarding checklist.
 *
 * Five steps, and the order is not cosmetic — each one unblocks the next.
 * Company details produce the signer we send agreements to; insurance decides
 * whether anything can be filed at all; the payment method is what makes the
 * first invoice collectable.
 *
 * The payment step is the one with a sharp edge. Card details are entered into
 * Stripe's hosted element and nowhere else: this page renders the mount point
 * and asks the API for a setup intent, and if that endpoint does not exist yet
 * it says so plainly. A hand-rolled card form here would drag this deployment
 * into PCI DSS SAQ D scope, and "temporarily" is not a mitigation.
 */

type StepState = 'done' | 'pending' | 'blocked' | 'not_applicable';

/** What POST /signing/requests reports about who was actually told. */
interface SendDelivery {
  notifiedUsers: number;
  emailQueued: boolean;
  emailConfigured: boolean;
  note: string | null;
}

const STEP_BADGE: Record<StepState, { label: string; cls: string }> = {
  done: { label: 'Done', cls: 'badge-green' },
  pending: { label: 'Pending', cls: 'badge-amber' },
  blocked: { label: 'Blocked', cls: 'badge-red' },
  not_applicable: { label: 'Not needed', cls: 'badge-gray' },
};

export default function Onboarding() {
  const { clientId: paramId } = useParams();
  const { user, isStaff } = useAuth();

  // Staff arrive at /onboarding/:clientId. A contractor arrives at /onboarding
  // and gets their own — their token is what decides which, not the URL.
  const ownId = user?.clientId ?? null;
  const clientId = paramId ?? ownId;

  const clientQ = useQuery({
    queryKey: ['client', clientId],
    queryFn: () => get<Client>(`/clients/${clientId}`),
    enabled: !!clientId,
  });

  // A contractor account with no clientId on it cannot resolve a folder. Fall
  // back to the scoped list, which returns exactly their row.
  const fallbackQ = useQuery({
    queryKey: ['clients', 'self'],
    queryFn: () => get<ClientListResponse>('/clients'),
    enabled: !clientId,
  });

  const client = clientQ.data ?? fallbackQ.data?.clients[0] ?? null;

  if ((clientQ.isLoading && !!clientId) || (fallbackQ.isLoading && !clientId)) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Onboarding</h1>
        <LoadingPanel label="Loading your checklist…" rows={5} />
      </div>
    );
  }

  const error = clientQ.error ?? fallbackQ.error;
  if (error) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Onboarding</h1>
        <ErrorState error={error} title="Could not load this account" onRetry={() => void clientQ.refetch()} />
      </div>
    );
  }

  if (!client) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Onboarding</h1>
        <div className="card">
          <EmptyState
            title="No contractor account is linked to this login"
            hint="An administrator has to attach your login to a contractor record before the checklist can show anything. Nothing you do here will be lost — it simply has nowhere to attach yet."
          />
        </div>
      </div>
    );
  }

  return <Checklist client={client} isStaff={isStaff} canEditClient={!!user && can(user.role, 'client:edit')} />;
}

function Checklist({
  client,
  isStaff,
  canEditClient,
}: {
  client: Client;
  isStaff: boolean;
  canEditClient: boolean;
}) {
  const { user } = useAuth();
  const complianceQ = useQuery({
    queryKey: ['compliance', client.id],
    queryFn: () => get<ComplianceListResponse>(`/compliance?clientId=${client.id}`),
  });

  const signingQ = useQuery({
    queryKey: ['signing', 'status', client.id],
    queryFn: () => get<SigningStatusResponse>(`/signing/status/${client.id}`),
  });

  const signaturesQ = useQuery({
    queryKey: ['signing', client.id],
    queryFn: () => get<SignatureListResponse>(`/signing/requests?clientId=${client.id}`),
  });

  const managed = client.serviceLine === 'MANAGED_LICENSE';

  // --- step 1: company details ---------------------------------------------
  const detailFields: Array<[string, string | null]> = [
    ['Trading name', client.name],
    ['Legal entity name', client.legalName],
    ['Contact name', client.contactName],
    ['Contact email', client.contactEmail],
    ['Contact phone', client.contactPhone],
    ['Street address', client.addressLine1],
    ['City', client.city],
    ['State', client.state],
    ['ZIP', client.zip],
    ['Federal EIN', client.federalEin],
  ];
  const missingDetails = detailFields.filter(([, v]) => !v).map(([k]) => k);
  const detailsState: StepState = missingDetails.length === 0 ? 'done' : 'pending';

  // --- step 2: licence -----------------------------------------------------
  const licenceState: StepState = managed
    ? 'not_applicable'
    : client.licenseNumber && client.licenseType
      ? 'done'
      : 'pending';

  // --- step 3: insurance ---------------------------------------------------
  const verdict = complianceQ.data?.verdict ?? null;
  const insuranceState: StepState = !verdict
    ? 'pending'
    : verdict.gaps.some((g) => g.blocksFiling)
      ? 'blocked'
      : verdict.gaps.length === 0
        ? 'done'
        : 'pending';

  // --- step 4: agreements --------------------------------------------------
  const signingVerdict = signingQ.data?.verdict ?? null;
  const agreementsState: StepState = !client.contactEmail
    ? 'blocked'
    : !signingVerdict
      ? 'pending'
      : signingVerdict.compromised.length > 0
        ? 'blocked'
        : signingVerdict.complete
          ? 'done'
          : 'pending';

  // --- step 5: payment -----------------------------------------------------
  const paymentState: StepState = client.stripeCustomerId ? 'done' : 'pending';

  const states = [detailsState, licenceState, insuranceState, agreementsState, paymentState];
  const applicable = states.filter((s) => s !== 'not_applicable');
  const doneCount = applicable.filter((s) => s === 'done').length;
  const progress = applicable.length ? (doneCount / applicable.length) * 100 : 100;

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold">
            {isStaff ? `Onboarding — ${client.name}` : 'Getting you set up'}
          </h1>
          <p className="mt-1 text-sm text-ink-soft max-w-2xl leading-relaxed">
            Five steps stand between this account and its first filing. Nothing here is busywork: the insurance step is
            what the permit gate reads, and the agreements are what make us your permit agent on the application.
          </p>
        </div>
        {isStaff && (
          <Link to={`/clients/${client.id}`} className="btn-ghost">
            Open contractor record
          </Link>
        )}
      </div>

      <div className="card card-pad">
        <Meter
          value={progress}
          label={`${doneCount} of ${applicable.length} steps complete`}
          hint={client.onboardingCompletedAt ? `Onboarding signed off ${fmtDate(client.onboardingCompletedAt)}` : undefined}
        />
        <ol className="mt-4 grid grid-cols-2 md:grid-cols-5 gap-2">
          {[
            ['Company details', detailsState],
            ['Licence', licenceState],
            ['Insurance', insuranceState],
            ['Agreements', agreementsState],
            ['Payment method', paymentState],
          ].map(([label, state], i) => (
            <li key={String(label)} className="rounded-md border border-line px-3 py-2">
              <div className="text-[11px] text-ink-mute">Step {i + 1}</div>
              <div className="text-[13px] font-medium leading-snug">{String(label)}</div>
              <span className={`${STEP_BADGE[state as StepState].cls} mt-1.5`}>
                {STEP_BADGE[state as StepState].label}
              </span>
            </li>
          ))}
        </ol>
      </div>

      {/* --- step 1 ------------------------------------------------------- */}
      <Step
        n={1}
        title="Company details"
        state={detailsState}
        blurb="These land on every permit application and on the agreements you sign, so they have to match your registration exactly."
      >
        <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-3">
          {detailFields.map(([label, value]) => (
            <div key={label}>
              <dt className="label">{label}</dt>
              <dd className={`mt-0.5 text-sm ${value ? '' : 'text-danger'}`}>{value || 'Missing'}</dd>
            </div>
          ))}
        </dl>
        {missingDetails.length > 0 && (
          <p className="mt-3 text-[13px] text-ink-soft leading-snug">
            {canEditClient
              ? `Still needed: ${missingDetails.join(', ')}. Edit these on the contractor record.`
              : `Still needed: ${missingDetails.join(', ')}. Your coordinator maintains these — send them the details and they will fill them in.`}
          </p>
        )}
      </Step>

      {/* --- step 2 ------------------------------------------------------- */}
      <Step
        n={2}
        title="Licence"
        state={licenceState}
        blurb={
          managed
            ? 'You are on the managed-licence line, so our qualifying agent is the contractor of record and their licence goes on the permit. You do not need one of your own.'
            : 'Your DBPR certification or county competency card. The number on the permit application has to be this one.'
        }
      >
        {managed ? (
          <p className="text-sm text-ink-soft leading-relaxed max-w-2xl">
            Because our licence is on the work, supervision is a legal obligation rather than a service extra — expect a
            project manager on site, and expect those visits to be recorded.
          </p>
        ) : (
          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-3">
            <div>
              <dt className="label">Licence number</dt>
              <dd className={`mt-0.5 text-sm ${client.licenseNumber ? 'font-mono' : 'text-danger'}`}>
                {client.licenseNumber ?? 'Missing'}
              </dd>
            </div>
            <div>
              <dt className="label">Licence type</dt>
              <dd className={`mt-0.5 text-sm ${client.licenseType ? '' : 'text-danger'}`}>
                {client.licenseType ?? 'Missing'}
              </dd>
            </div>
            <div>
              <dt className="label">Expires</dt>
              <dd className="mt-0.5 text-sm">{fmtDate(client.licenseExpiresAt)}</dd>
            </div>
          </dl>
        )}
      </Step>

      {/* --- step 3 ------------------------------------------------------- */}
      <Step
        n={3}
        title="Insurance and registrations"
        state={insuranceState}
        blurb="One card per document we need. An expired certificate is not a reminder, it is a stop: the permit gate refuses new filings behind a lapsed policy."
      >
        {complianceQ.isLoading && <LoadingPanel label="Loading what we hold…" rows={3} />}
        {complianceQ.isError && (
          <ErrorState error={complianceQ.error} onRetry={() => void complianceQ.refetch()} compact title="Could not load your documents" />
        )}
        {complianceQ.data && (
          <InsuranceCards client={client} items={complianceQ.data.items} />
        )}
      </Step>

      {/* --- step 4 ------------------------------------------------------- */}
      <Step
        n={4}
        title="Sign the agreements"
        state={agreementsState}
        blurb="Signed electronically. Every signature is stored with a hash of the exact words you agreed to, so neither side can quietly change them afterwards."
      >
        {!client.contactEmail && (
          <div className="rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-[13px] text-danger leading-snug">
            There is no contact email on this account, so there is nowhere to send an agreement. Finish step 1 first.
          </div>
        )}
        {signingQ.isLoading && <LoadingPanel label="Loading agreements…" rows={3} />}
        {signingQ.isError && (
          <ErrorState error={signingQ.error} onRetry={() => void signingQ.refetch()} compact title="Could not load agreements" />
        )}
        {signingVerdict && (
          <AgreementList
            client={client}
            missing={signingVerdict.missing}
            pending={signingVerdict.pending}
            compromised={signingVerdict.compromised}
            requests={signaturesQ.data?.requests ?? []}
            canSend={isStaff && canEditClient}
            canSign={!isStaff && !!user && can(user.role, 'portal:sign_documents')}
            required={signingQ.data?.required ?? REQUIRED_SIGNABLES[client.serviceLine]}
          />
        )}
      </Step>

      {/* --- step 5 ------------------------------------------------------- */}
      <Step
        n={5}
        title="Payment method on file"
        state={paymentState}
        blurb="A card or bank account on file so agency fees we advance on your behalf can be settled without a phone call each time."
      >
        <PaymentStep client={client} />
      </Step>
    </div>
  );
}

function Step({
  n,
  title,
  state,
  blurb,
  children,
}: {
  n: number;
  title: string;
  state: StepState;
  blurb: string;
  children: ReactNode;
}) {
  const accent =
    state === 'blocked' ? 'border-l-4 border-danger' : state === 'done' ? 'border-l-4 border-good' : '';
  return (
    <section className={`card ${accent}`}>
      <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="label">Step {n}</span>
            <span className={STEP_BADGE[state].cls}>{STEP_BADGE[state].label}</span>
          </div>
          <h2 className="mt-1 text-base font-semibold">{title}</h2>
          <p className="mt-1 text-[13px] text-ink-soft leading-relaxed max-w-3xl">{blurb}</p>
        </div>
      </div>
      <div className="border-t border-line px-5 py-4">{children}</div>
    </section>
  );
}

// --------------------------------------------------------------------------
// Step 3 — insurance cards
// --------------------------------------------------------------------------

function InsuranceCards({ client, items }: { client: Client; items: ComplianceRow[] }) {
  const required = DEFAULT_COMPLIANCE_POLICY.filter((p) => p.required || p.kind === 'WORKERS_COMP_EXEMPTION');

  const latestByKind = useMemo(() => {
    const map = new Map<ComplianceKind, ComplianceRow>();
    for (const it of items) {
      const cur = map.get(it.kind);
      if (!cur || (Date.parse(it.expiresAt ?? '') || 0) > (Date.parse(cur.expiresAt ?? '') || 0)) map.set(it.kind, it);
    }
    return map;
  }, [items]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      {required.map((spec) => (
        <InsuranceCard
          key={spec.kind}
          client={client}
          kind={spec.kind}
          why={spec.note}
          minLimitCents={spec.minLimitPerOccurrenceCents}
          blocksFiling={spec.blocksFiling}
          item={latestByKind.get(spec.kind) ?? null}
        />
      ))}
    </div>
  );
}

function InsuranceCard({
  client,
  kind,
  why,
  minLimitCents,
  blocksFiling,
  item,
}: {
  client: Client;
  kind: ComplianceKind;
  why: string | null;
  minLimitCents: number | null;
  blocksFiling: boolean;
  item: ComplianceRow | null;
}) {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [expiresAt, setExpiresAt] = useState('');
  const [carrier, setCarrier] = useState('');

  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('Choose a file first');
      const payload = await readFileAsUpload(file);
      const uploaded = await post<DocumentUploadResponse>('/documents', {
        ...payload,
        clientId: client.id,
        permitId: null,
        category: 'COMPLIANCE',
        requirementKey: `compliance:${kind.toLowerCase()}`,
      });
      await post('/compliance', {
        clientId: client.id,
        kind,
        carrier: carrier.trim() || null,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        documentId: uploaded.document.id,
      });
    },
    onSuccess: () => {
      setFile(null);
      setCarrier('');
      setExpiresAt('');
      void qc.invalidateQueries({ queryKey: ['compliance'] });
    },
  });

  const status = item?.effectiveStatus ?? 'MISSING';
  const bad = status === 'MISSING' || status === 'EXPIRED' || status === 'REJECTED';

  return (
    <div className={`rounded-card border p-4 ${bad && blocksFiling ? 'border-danger/40 bg-danger-soft/30' : 'border-line bg-white'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold leading-snug">{COMPLIANCE_LABELS[kind]}</div>
          <div className="text-[11px] text-ink-mute">
            {blocksFiling ? 'Blocks filing while missing or expired' : 'Required on file — warns rather than blocks'}
          </div>
        </div>
        <ComplianceBadge status={status} />
      </div>

      {why && <p className="mt-2 text-[12px] text-ink-soft leading-snug">{why}</p>}
      {minLimitCents != null && (
        <p className="mt-1 text-[12px] text-ink-soft">
          Minimum per-occurrence limit we accept: <span className="font-medium">{formatCents(minLimitCents)}</span>
        </p>
      )}

      {item && (
        <dl className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1 text-[12px]">
          <div>
            <dt className="label inline">Carrier </dt>
            <dd className="inline text-ink-soft">{item.carrier ?? '—'}</dd>
          </div>
          <div>
            <dt className="label inline">Expiry </dt>
            <dd className="inline text-ink-soft">
              {fmtDate(item.expiresAt)} · {expiryPhrase(item.daysUntilExpiry)}
            </dd>
          </div>
        </dl>
      )}
      {item?.reviewNote && status === 'REJECTED' && (
        <p className="mt-2 rounded bg-danger-soft px-2 py-1.5 text-[12px] text-danger leading-snug">
          Sent back: {item.reviewNote}
        </p>
      )}

      {upload.isError && (
        <p className="mt-2 text-[12px] text-danger leading-snug">{errorMessage(upload.error)}</p>
      )}

      <div className="mt-3 space-y-2 border-t border-line pt-3">
        <label className="block">
          <span className="label">{item ? 'Upload a replacement' : 'Upload the certificate'}</span>
          <input
            type="file"
            className="input mt-1 text-[12px] file:mr-2 file:rounded file:border-0 file:bg-page file:px-2 file:py-1 file:text-[12px]"
            accept=".pdf,.png,.jpg,.jpeg,.webp,.heic"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        {file && (
          <>
            <div className="text-[11px] text-ink-mute">
              {file.name} · {fmtBytes(file.size)}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="label">Carrier</span>
                <input className="input mt-1 py-1.5 text-[13px]" value={carrier} onChange={(e) => setCarrier(e.target.value)} />
              </label>
              <label className="block">
                <span className="label">Expiry date</span>
                <input
                  type="date"
                  className="input mt-1 py-1.5 text-[13px]"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                />
              </label>
            </div>
            <button type="button" className="btn-primary w-full" disabled={upload.isPending} onClick={() => upload.mutate()}>
              {upload.isPending ? 'Uploading…' : 'Send for review'}
            </button>
            <p className="text-[11px] text-ink-mute leading-snug">
              It lands as awaiting review. A coordinator checks the certificate before it counts — self-attested
              insurance is the exact failure this step exists to prevent.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Step 4 — agreements
// --------------------------------------------------------------------------

function AgreementList({
  client,
  missing,
  pending,
  compromised,
  requests,
  canSend,
  canSign,
  required,
}: {
  client: Client;
  missing: SignableKind[];
  pending: SignableKind[];
  compromised: SignableKind[];
  requests: SignatureListResponse['requests'];
  canSend: boolean;
  canSign: boolean;
  required: SignableKind[];
}) {
  const qc = useQueryClient();
  const [signing, setSigning] = useState<string | null>(null);

  /*
   * The send response says what actually reached the contractor, and it is
   * kept and shown.
   *
   * "Sent" used to mean an INSERT succeeded. A contractor with no portal user
   * yet -- normal early in onboarding -- was told nothing at all, and the
   * screen said Sent over the top of it.
   */
  const [delivery, setDelivery] = useState<SendDelivery | null>(null);

  const send = useMutation({
    mutationFn: (kind: SignableKind) =>
      post<{ delivery: SendDelivery }>('/signing/requests', { clientId: client.id, kind }),
    onSuccess: (data) => {
      setDelivery(data.delivery ?? null);
      void qc.invalidateQueries({ queryKey: ['signing'] });
    },
  });

  const latestFor = (kind: SignableKind) => requests.find((r) => r.kind === kind) ?? null;

  return (
    <div className="space-y-2">
      {compromised.length > 0 && (
        <div className="rounded-md border-2 border-danger bg-danger-soft px-3 py-2 text-[13px] text-danger leading-snug">
          A signed agreement no longer matches the text that was signed. Do not treat it as executed — void and reissue
          it, and find out what changed the document.
        </div>
      )}
      {send.isError && <ErrorState error={send.error} compact title="Could not send that agreement" />}

      {delivery?.note && (
        <div className="rounded-md border border-warn/25 bg-warn-soft px-3 py-2 text-[13px] text-warn leading-snug">
          {delivery.note}
        </div>
      )}

      <ul className="divide-y divide-line">
        {required.map((kind) => {
          const req = latestFor(kind);
          const state: StepState = compromised.includes(kind)
            ? 'blocked'
            : missing.includes(kind)
              ? 'pending'
              : pending.includes(kind)
                ? 'pending'
                : 'done';
          return (
            <li key={kind} className="py-2.5 flex items-start justify-between gap-4 flex-wrap">
              <div className="min-w-0">
                <div className="text-[13px] font-medium">{SIGNABLE_LABELS[kind]}</div>
                <div className="text-[12px] text-ink-soft">
                  {req
                    ? `${req.status === 'SIGNED' ? 'Signed' : req.status === 'VIEWED' ? 'Opened' : req.status === 'SENT' ? 'Sent' : req.status.toLowerCase()} ${
                        req.signedAt ? fmtDate(req.signedAt) : req.viewedAt ? fmtDate(req.viewedAt) : req.sentAt ? fmtDate(req.sentAt) : ''
                      }`
                    : 'Not sent yet'}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className={STEP_BADGE[state].cls}>{STEP_BADGE[state].label}</span>
                {/*
                  * The half that was missing. The portal told contractors an
                  * agreement was waiting for their signature and then offered
                  * them nowhere to sign it.
                  */}
                {canSign && req && req.status !== 'SIGNED' && req.status !== 'VOIDED'
                  && req.status !== 'DECLINED' && req.status !== 'EXPIRED' && (
                  <button
                    type="button"
                    className="btn-primary px-2 py-1 text-[12px]"
                    onClick={() => setSigning(req.id)}
                  >
                    Review and sign
                  </button>
                )}
                {!canSign && req && req.status !== 'SIGNED' && (
                  <span className="text-[12px] text-ink-mute">Sent to {req.signerEmail}</span>
                )}
                {canSign && req && req.status === 'SIGNED' && (
                  <button
                    type="button"
                    className="btn-ghost px-2 py-1 text-[12px]"
                    onClick={() => setSigning(req.id)}
                  >
                    View
                  </button>
                )}
                {canSend && !req && (
                  <button
                    type="button"
                    className="btn-ghost px-2 py-1 text-[12px]"
                    disabled={send.isPending || !client.contactEmail}
                    onClick={() => send.mutate(kind)}
                  >
                    {send.isPending ? 'Sending…' : 'Send'}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <SignDocument
        requestId={signing}
        open={signing !== null}
        onClose={() => setSigning(null)}
      />
    </div>
  );
}

// --------------------------------------------------------------------------
// Step 5 — payment
// --------------------------------------------------------------------------

function PaymentStep({ client }: { client: Client }) {
  const { user } = useAuth();
  const canPay = !!user && (can(user.role, 'portal:pay') || can(user.role, 'billing:manage'));
  const [notConfigured, setNotConfigured] = useState(false);

  const setup = useMutation({
    mutationFn: () => post<SetupIntentResponse>('/billing/setup-intent', { clientId: client.id }),
    onSuccess: (data) => {
      // A deployment with no Stripe key answers 200 with `configured: false`
      // rather than an error, because "not set up yet" is not a fault. Same
      // honest panel either way.
      if (!data.configured) setNotConfigured(true);
    },
    onError: (err) => {
      // A 404 here is the honest signal that the endpoint has not been built,
      // and `not_configured` is what the Stripe connector throws when the
      // secret key is absent. Either way there is no hosted element to mount,
      // and pretending otherwise would put a dead form in front of a customer.
      if (err instanceof ApiError && (err.status === 404 || err.code === 'not_configured')) setNotConfigured(true);
    },
  });

  const unavailable = notConfigured || (setup.isError && setup.error instanceof ApiError && setup.error.status === 404);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div>
        {client.stripeCustomerId ? (
          <div className="rounded-md border border-good/30 bg-good-soft px-3 py-2.5">
            <div className="text-[13px] font-semibold text-good">A payment method is on file</div>
            <p className="mt-1 text-[12px] text-ink-soft leading-snug">
              Held by Stripe against customer <span className="font-mono">{client.stripeCustomerId}</span>. We never see
              or store the card number — only Stripe's reference to it.
            </p>
          </div>
        ) : unavailable ? (
          <div className="rounded-md border border-line bg-page px-3 py-2.5">
            <div className="text-[13px] font-semibold">Card payments are not configured yet</div>
            <p className="mt-1 text-[12px] text-ink-soft leading-snug">
              This deployment has no Stripe key set, so there is no hosted card form to show you. Nothing is broken and
              nothing is missing on your side — invoices will arrive by email and can be paid by cheque or transfer in
              the meantime. An administrator sets <span className="font-mono">STRIPE_SECRET_KEY</span> to switch this on.
            </p>
          </div>
        ) : (
          <>
            {/*
              Stripe Elements mounts here. This container stays empty until the
              setup intent comes back with a client secret; there is no card
              input of our own to fall back to, deliberately.
            */}
            <div
              id="stripe-card-element"
              className="min-h-[92px] rounded-md border border-dashed border-line bg-page grid place-items-center px-4 text-center"
            >
              <span className="text-[12px] text-ink-mute leading-snug">
                {setup.isPending
                  ? 'Opening a secure session with Stripe…'
                  : setup.isSuccess
                    ? "Stripe's hosted card form loads here. Your card details go straight to Stripe and never reach our servers."
                    : 'Your card is entered into Stripe’s own hosted form, not ours.'}
              </span>
            </div>

            {setup.isError && !unavailable && (
              <div className="mt-2">
                <ErrorState error={setup.error} compact title="Could not start a card session" />
              </div>
            )}

            {canPay ? (
              <button
                type="button"
                className="btn-primary mt-3"
                disabled={setup.isPending}
                onClick={() => setup.mutate()}
              >
                {setup.isPending ? 'Starting…' : 'Add card'}
              </button>
            ) : (
              <p className="mt-3 text-[12px] text-ink-mute leading-snug">
                Your role cannot add a payment method to this account.
              </p>
            )}
          </>
        )}
      </div>

      <div className="rounded-md bg-page px-3 py-2.5">
        <div className="label">Why it works this way</div>
        <p className="mt-1.5 text-[12px] text-ink-soft leading-relaxed">
          Card numbers are entered into Stripe's hosted element and go from your browser to Stripe directly. This
          application never receives, logs or stores a card number, which is what keeps it out of the heaviest PCI DSS
          scope — and there is no partial version of that rule, so you will not find a card field anywhere else in this
          product.
        </p>
      </div>
    </div>
  );
}

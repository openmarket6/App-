import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { can } from '@flph/shared';
import { get, post, ApiError } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { fmtDateTime } from '../lib/format.ts';
import EmptyState from '../components/EmptyState.tsx';
import ErrorState, { errorMessage } from '../components/ErrorState.tsx';
import { LoadingPanel } from '../components/Spinner.tsx';

/**
 * Producing an instrument: Notice of Commencement, Notice to Owner, hold
 * harmless, contractor services agreement.
 *
 * THE FORM IS NOT WRITTEN HERE. It is built from the field list the API serves
 * at /generated-documents/kinds, which is the same list the validator reads. A
 * form typed out separately drifts — it offers a box the server ignores, or
 * omits one the server requires — and the person who discovers that is a permit
 * tech looking at a refusal for a field that was never on their screen.
 *
 * The other rule this screen follows: it never guesses on the customer's
 * behalf. Blocking problems appear beside the field that caused them and stop
 * the produce button. Warnings do not stop it — they are shown, and going ahead
 * anyway is an explicit tick, because a Notice to Owner served late may still
 * be worth serving and that is not this screen's decision to make.
 */

interface FieldSpec {
  name: string;
  label: string;
  type: 'text' | 'textarea' | 'date' | 'money' | 'number' | 'select';
  required: boolean;
  help?: string;
  placeholder?: string;
  group: string;
}

interface KindSpec {
  kind: string;
  label: string;
  fields: FieldSpec[];
}

interface PlanSpec {
  key: string;
  name: string;
  tradeCount: number;
  monthlyPriceCents: number;
  onboardingFeeCents: number;
  complianceRetainerCents: number;
}

interface KindsResponse {
  kinds: KindSpec[];
  plans: PlanSpec[];
}

interface Problem {
  field: string;
  severity: 'blocking' | 'warning';
  detail: string;
  consequence?: string;
}

interface GeneratedRow {
  id: string;
  kind: string;
  kindLabel: string;
  status: string;
  title: string;
  sha256: string;
  generatedAt: string;
  completedAt: string | null;
  completionReference: string | null;
  isCurrent: boolean;
}

interface ClientRow {
  id: string;
  name: string;
}

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Money is typed in dollars and sent in cents.
 *
 * Parsed here rather than trusted: `parseFloat('1,000.50')` is 1, and a
 * silently wrong bond amount on a recorded notice is not a rounding error.
 */
function dollarsToCents(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, '');
  if (!cleaned) return null;
  if (!/^-?\d+(\.\d{0,2})?$/.test(cleaned)) return NaN;
  return Math.round(Number(cleaned) * 100);
}

export default function DocumentsGenerate() {
  const { user } = useAuth();
  const qc = useQueryClient();

  const [kind, setKind] = useState<string>('NOC');
  const [clientId, setClientId] = useState<string>('');
  const [planKey, setPlanKey] = useState<string>('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [problems, setProblems] = useState<Problem[]>([]);
  const [acceptWarnings, setAcceptWarnings] = useState(false);
  const [made, setMade] = useState<GeneratedRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mayGenerate = !!user && can(user.role, 'document:generate');

  const kindsQ = useQuery({
    queryKey: ['generatedDocumentKinds'],
    queryFn: () => get<KindsResponse>('/generated-documents/kinds'),
    staleTime: 60 * 60_000,
  });

  const clientsQ = useQuery({
    queryKey: ['clients'],
    queryFn: () => get<{ clients: ClientRow[] }>('/clients'),
    staleTime: 5 * 60_000,
  });

  const listQ = useQuery({
    queryKey: ['generatedDocuments', clientId],
    queryFn: () => {
      // Query string built outside the path so the path itself stays a plain
      // literal — the route-coverage check reads these call sites, and a
      // conditional inside the template hides the route from it.
      const qs = clientId ? `?clientId=${clientId}` : '';
      return get<{ documents: GeneratedRow[] }>(`/generated-documents` + qs);
    },
    enabled: !!user,
  });

  const spec = useMemo(
    () => kindsQ.data?.kinds.find((k) => k.kind === kind) ?? null,
    [kindsQ.data, kind],
  );

  const groups = useMemo(() => {
    const out: Array<{ heading: string; fields: FieldSpec[] }> = [];
    for (const f of spec?.fields ?? []) {
      const last = out[out.length - 1];
      if (last && last.heading === f.group) last.fields.push(f);
      else out.push({ heading: f.group, fields: [f] });
    }
    return out;
  }, [spec]);

  // Switching kind starts a fresh form. Carrying values across would silently
  // put an owner's address into a claimant field.
  useEffect(() => {
    setValues({});
    setProblems([]);
    setMade(null);
    setError(null);
    setAcceptWarnings(false);
  }, [kind]);

  const buildInput = (): Record<string, unknown> => {
    const input: Record<string, unknown> = {};
    for (const f of spec?.fields ?? []) {
      const raw = (values[f.name] ?? '').trim();
      if (!raw) continue;
      if (f.type === 'money') {
        const cents = dollarsToCents(raw);
        if (cents === null) continue;
        input[f.name] = cents;
      } else if (f.type === 'number') {
        input[f.name] = Number(raw);
      } else if (f.type === 'date') {
        input[f.name] = raw;
      } else {
        input[f.name] = raw;
      }
    }
    // Prices are never sent from here — only the plan key. The server takes the
    // snapshot, so what the customer signs cannot be edited in a browser.
    if (kind === 'CONTRACTOR_AGREEMENT' && planKey) input['planKey'] = planKey;
    return input;
  };

  const check = useMutation({
    mutationFn: () => post<{ ok: boolean; problems: Problem[] }>(
      '/generated-documents/validate', { kind, input: buildInput() },
    ),
    onSuccess: (r) => {
      setProblems(r.problems);
      setError(null);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const produce = useMutation({
    mutationFn: () =>
      post<GeneratedRow & { warnings: Problem[] }>('/generated-documents', {
        clientId: clientId || undefined,
        kind,
        input: buildInput(),
        acceptWarnings,
      }),
    onSuccess: async (row) => {
      setMade(row);
      setError(null);
      setProblems([]);
      await qc.invalidateQueries({ queryKey: ['generatedDocuments'] });
    },
    onError: (e) => {
      if (e instanceof ApiError) {
        const details = e.details as { problems?: Problem[]; warnings?: Problem[] } | undefined;
        if (details?.problems) setProblems(details.problems);
        else if (details?.warnings) setProblems(details.warnings);
      }
      setError(errorMessage(e));
    },
  });

  const problemFor = (name: string) => problems.find((p) => p.field === name);
  const blocking = problems.filter((p) => p.severity === 'blocking');
  const warnings = problems.filter((p) => p.severity === 'warning');

  if (!user) return null;

  if (!mayGenerate) {
    return (
      <EmptyState
        title="Not your area"
        body="Producing a recordable instrument needs the document:generate capability. An administrator can grant it."
      />
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-4">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">Generate a document</h1>
        <p className="mt-1 text-sm text-ink-mute">
          Notices, indemnities and agreements, produced from the record and stored with
          exactly what they were made from.
        </p>
      </header>

      {/*
        * Said once, at the top, and not hidden behind a tooltip. Somebody about
        * to record an instrument with a county clerk is entitled to know the
        * template has not been through counsel.
        */}
      <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        These templates have not been reviewed by a Florida construction attorney. Have
        counsel read the output once before anything is recorded or served.
      </div>

      {kindsQ.isLoading && <LoadingPanel label="Loading the forms" />}
      {kindsQ.isError && <ErrorState error={kindsQ.error} onRetry={() => void kindsQ.refetch()} />}

      {kindsQ.data && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div>
            <div className="mb-4 grid gap-3 sm:grid-cols-2">
              <label className="text-sm">
                <span className="mb-1 block text-ink-mute">Document</span>
                <select
                  className="w-full rounded border border-line bg-white px-2 py-2"
                  value={kind}
                  onChange={(e) => setKind(e.target.value)}
                >
                  {kindsQ.data.kinds.map((k) => (
                    <option key={k.kind} value={k.kind}>{k.label}</option>
                  ))}
                </select>
              </label>

              <label className="text-sm">
                <span className="mb-1 block text-ink-mute">Contractor</span>
                <select
                  className="w-full rounded border border-line bg-white px-2 py-2"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                >
                  <option value="">Choose…</option>
                  {(clientsQ.data?.clients ?? []).map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </label>
            </div>

            {kind === 'CONTRACTOR_AGREEMENT' && (
              <label className="mb-4 block text-sm">
                <span className="mb-1 block text-ink-mute">Plan</span>
                <select
                  className="w-full rounded border border-line bg-white px-2 py-2"
                  value={planKey}
                  onChange={(e) => setPlanKey(e.target.value)}
                >
                  <option value="">Choose a plan…</option>
                  {kindsQ.data.plans.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.name} — {money(p.monthlyPriceCents)}/mo, {money(p.onboardingFeeCents)} onboarding,{' '}
                      {money(p.complianceRetainerCents)} retainer
                    </option>
                  ))}
                </select>
                <span className="mt-1 block text-xs text-ink-mute">
                  The prices are snapshotted by the server at the moment you produce this,
                  so the signed copy keeps the prices that were agreed.
                </span>
              </label>
            )}

            {groups.map((g) => (
              <section key={g.heading} className="mb-5">
                <h2 className="mb-2 border-b border-line pb-1 text-sm font-semibold uppercase tracking-wide text-ink-mute">
                  {g.heading}
                </h2>
                <div className="grid gap-3 sm:grid-cols-2">
                  {g.fields.map((f) => {
                    const p = problemFor(f.name);
                    const wide = f.type === 'textarea';
                    return (
                      <label
                        key={f.name}
                        className={`text-sm ${wide ? 'sm:col-span-2' : ''}`}
                      >
                        <span className="mb-1 block">
                          {f.label}
                          {f.required && <span className="text-rose-600"> *</span>}
                        </span>
                        {f.type === 'textarea' ? (
                          <textarea
                            rows={3}
                            className={`w-full rounded border px-2 py-2 ${
                              p?.severity === 'blocking' ? 'border-rose-400' : 'border-line'
                            }`}
                            value={values[f.name] ?? ''}
                            placeholder={f.placeholder}
                            onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                          />
                        ) : (
                          <input
                            type={f.type === 'date' ? 'date' : 'text'}
                            inputMode={f.type === 'money' || f.type === 'number' ? 'decimal' : undefined}
                            className={`w-full rounded border px-2 py-2 ${
                              p?.severity === 'blocking' ? 'border-rose-400' : 'border-line'
                            }`}
                            value={values[f.name] ?? ''}
                            placeholder={f.type === 'money' ? '0.00' : f.placeholder}
                            onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                          />
                        )}
                        {p && (
                          <span
                            className={`mt-1 block text-xs ${
                              p.severity === 'blocking' ? 'text-rose-700' : 'text-amber-700'
                            }`}
                          >
                            {p.detail}
                            {p.consequence ? ` ${p.consequence}` : ''}
                          </span>
                        )}
                        {!p && f.help && (
                          <span className="mt-1 block text-xs text-ink-mute">{f.help}</span>
                        )}
                      </label>
                    );
                  })}
                </div>
              </section>
            ))}

            {error && (
              <div className="mb-3 rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900">
                {error}
              </div>
            )}

            {warnings.length > 0 && (
              <div className="mb-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <div className="font-semibold">Worth checking before you produce this</div>
                <ul className="mt-1 list-disc pl-5">
                  {warnings.map((w) => (
                    <li key={`${w.field}-${w.detail}`}>
                      {w.detail}
                      {w.consequence ? ` ${w.consequence}` : ''}
                    </li>
                  ))}
                </ul>
                {/*
                  * An explicit tick, not a silent default. Going ahead despite a
                  * warning is a decision, and it is stored with the document as
                  * one.
                  */}
                <label className="mt-2 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={acceptWarnings}
                    onChange={(e) => setAcceptWarnings(e.target.checked)}
                  />
                  <span>I have read these and want to produce it anyway.</span>
                </label>
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              <button
                className="rounded border border-ink px-4 py-2 text-sm font-semibold disabled:opacity-50"
                onClick={() => check.mutate()}
                disabled={check.isPending}
              >
                {check.isPending ? 'Checking…' : 'Check it'}
              </button>
              <button
                className="rounded bg-ink px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                onClick={() => produce.mutate()}
                disabled={produce.isPending || blocking.length > 0 || !clientId}
              >
                {produce.isPending ? 'Producing…' : 'Produce'}
              </button>
              {!clientId && (
                <span className="self-center text-xs text-ink-mute">
                  Choose a contractor first.
                </span>
              )}
            </div>

            {made && (
              <div className="mt-4 rounded border border-emerald-300 bg-emerald-50 px-3 py-3 text-sm text-emerald-900">
                <div className="font-semibold">{made.kindLabel} produced.</div>
                <div className="mt-1 text-xs">
                  Stored with a SHA-256 of {made.sha256.slice(0, 12)}… so a printed copy can
                  be checked against this record.
                </div>
                <a
                  className="mt-2 inline-block underline"
                  href={`/api/generated-documents/${made.id}/html`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open it
                </a>
              </div>
            )}
          </div>

          <aside>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-mute">
              Produced already
            </h2>
            {listQ.isLoading && <LoadingPanel label="Loading" />}
            {listQ.data && listQ.data.documents.length === 0 && (
              <p className="text-sm text-ink-mute">Nothing yet.</p>
            )}
            <ul className="space-y-2">
              {(listQ.data?.documents ?? []).map((d) => (
                <li key={d.id} className="rounded border border-line bg-surface p-2 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium">{d.kindLabel}</span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                        d.status === 'void'
                          ? 'bg-rose-100 text-rose-800'
                          : d.status === 'draft'
                            ? 'bg-slate-100 text-slate-700'
                            : 'bg-emerald-100 text-emerald-800'
                      }`}
                    >
                      {d.status}
                    </span>
                  </div>
                  <div className="text-xs text-ink-mute">{fmtDateTime(d.generatedAt)}</div>
                  {d.completionReference && (
                    <div className="text-xs text-ink-mute">Ref {d.completionReference}</div>
                  )}
                  {!d.isCurrent && (
                    <div className="text-xs text-amber-700">Superseded or void</div>
                  )}
                  <a
                    className="text-xs underline"
                    href={`/api/generated-documents/${d.id}/html`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open
                  </a>
                </li>
              ))}
            </ul>
          </aside>
        </div>
      )}
    </div>
  );
}

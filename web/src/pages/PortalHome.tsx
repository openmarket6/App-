import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { TERMINAL_STAGES, formatCents, type ActionUrgency, type PortalAction } from '@flph/shared';
import { get } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { daysAgo, firstName, fmtDate, fmtDateTime, greeting, humanEnum } from '../lib/format.ts';
import type { ClientListResponse, InvoiceListResponse } from '../lib/api-shapes.ts';
import type { InspectionListResponse, PermitListResponse, PermitRow } from '../lib/types.ts';
import type { PortalActionsResponse, PortalTreeResponse } from '../lib/portal-shapes.ts';
import { stageNarrative } from '../lib/portal-copy.ts';
import EmptyState from '../components/EmptyState.tsx';
import ErrorState from '../components/ErrorState.tsx';
import { LoadingPanel } from '../components/Spinner.tsx';
import StageBadge, { stageLabel } from '../components/StageBadge.tsx';

/**
 * The contractor's landing page.
 *
 * One idea runs the whole screen: the first thing you see is what is waiting
 * on *you*, ordered by what actually stops work rather than by what was
 * easiest to compute. Expired insurance sits above an unsigned form, which
 * sits above an unpaid invoice, because only the first one stops us filing
 * anything at all — and that ordering is decided once, in
 * `buildActionQueue`, so this page and any other reading of the queue cannot
 * disagree about what is urgent.
 *
 * Everything below the queue is reassurance rather than instruction: where
 * each job is, what is booked, and a way into the files.
 */

const URGENCY: Record<
  ActionUrgency,
  { heading: string; blurb: string; badge: string; border: string; badgeLabel: string }
> = {
  blocking: {
    heading: 'Stopping work',
    blurb: 'Nothing moves on these until they are dealt with.',
    badge: 'badge-red',
    border: 'border-danger',
    badgeLabel: 'Blocking',
  },
  soon: {
    heading: 'Soon',
    blurb: 'Not urgent today. Cheaper to do now than to do in a hurry later.',
    badge: 'badge-amber',
    border: 'border-warn',
    badgeLabel: 'Soon',
  },
  informational: {
    heading: 'For your information',
    blurb: 'Nothing is blocked by these.',
    badge: 'badge-blue',
    border: 'border-brand',
    badgeLabel: 'FYI',
  },
};

export default function PortalHome() {
  const { user } = useAuth();

  const clientsQ = useQuery({
    queryKey: ['clients', 'self'],
    queryFn: () => get<ClientListResponse>('/clients'),
  });
  const actionsQ = useQuery({
    queryKey: ['portal', 'actions'],
    queryFn: () => get<PortalActionsResponse>('/portal/actions'),
  });
  const permitsQ = useQuery({ queryKey: ['permits'], queryFn: () => get<PermitListResponse>('/permits') });
  const inspectionsQ = useQuery({
    queryKey: ['inspections', 'upcoming'],
    queryFn: () => get<InspectionListResponse>('/inspections?upcoming=true'),
  });
  const invoicesQ = useQuery({ queryKey: ['invoices'], queryFn: () => get<InvoiceListResponse>('/billing/invoices') });
  const treeQ = useQuery({ queryKey: ['portal', 'tree'], queryFn: () => get<PortalTreeResponse>('/portal/folders') });

  const client = clientsQ.data?.clients[0] ?? null;
  const permits = permitsQ.data?.permits ?? [];
  const active = useMemo(() => permits.filter((p) => !TERMINAL_STAGES.includes(p.stage)), [permits]);
  const inspections = inspectionsQ.data?.inspections ?? [];
  const actions = actionsQ.data?.actions ?? [];

  const grouped = useMemo(() => {
    const by: Record<ActionUrgency, PortalAction[]> = { blocking: [], soon: [], informational: [] };
    for (const a of actions) by[a.urgency]?.push(a);
    return by;
  }, [actions]);

  const outstanding = invoicesQ.data?.outstandingCents ?? 0;
  const tree = treeQ.data?.tree ?? null;
  const attentionFolders = useMemo(
    () => (tree ? tree.children.filter((c) => c.needsAttention).map((c) => c.name) : []),
    [tree],
  );

  if (permitsQ.isLoading && clientsQ.isLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Home</h1>
        <LoadingPanel label="Pulling your jobs together…" rows={5} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* --- greeting ------------------------------------------------------ */}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">
            {greeting()}, {firstName(user?.name)}.
          </h1>
          <p className="mt-1 text-sm text-ink-soft">
            {client?.name ?? 'Your company'} ·{' '}
            {active.length === 0
              ? 'nothing open right now'
              : `${active.length} permit${active.length === 1 ? '' : 's'} in flight`}
            {outstanding > 0 && ` · ${formatCents(outstanding)} outstanding`}
          </p>
        </div>
        <div className="flex gap-2">
          <Link to="/files" className="btn-ghost">
            Your files
          </Link>
          <Link to="/request-permit" className="btn-primary">
            Request a permit
          </Link>
        </div>
      </div>

      {client?.filingHold && (
        <div className="rounded-md border-2 border-danger bg-danger-soft px-4 py-3">
          <div className="text-sm font-semibold text-danger">We cannot file anything new for you right now</div>
          <p className="mt-1 text-sm text-ink-soft leading-relaxed">
            {client.filingHoldReason ?? 'A hold has been placed on this account.'} Permits already in are carrying on
            as normal.{' '}
            <Link to="/support" className="link">
              Message your coordinator
            </Link>{' '}
            and we will tell you exactly what lifts it.
          </p>
        </div>
      )}

      {/* --- needs you ----------------------------------------------------- */}
      <section>
        <div className="flex items-baseline justify-between gap-3 mb-3">
          <h2 className="text-sm font-semibold">Needs you</h2>
          {actions.length > 0 && (
            <span className="text-[12px] text-ink-mute">
              {actions.length} item{actions.length === 1 ? '' : 's'} · most urgent first
            </span>
          )}
        </div>

        {actionsQ.isLoading && <LoadingPanel label="Checking what needs you…" rows={2} />}

        {actionsQ.isError && (
          <ErrorState
            error={actionsQ.error}
            onRetry={() => void actionsQ.refetch()}
            title="Could not check what needs you"
          />
        )}

        {!actionsQ.isLoading && !actionsQ.isError && actions.length === 0 && (
          <div className="card border-l-4 border-good">
            <EmptyState
              title="Nothing needs you today — we'll tell you the moment it does"
              hint="Your paperwork is current, nothing is waiting on a signature and there is nothing unpaid. Anything that comes up lands here first, before it becomes a problem."
              compact
            />
          </div>
        )}

        {(['blocking', 'soon', 'informational'] as ActionUrgency[]).map((urgency) => {
          const items = grouped[urgency];
          if (items.length === 0) return null;
          const style = URGENCY[urgency];
          const bordered = urgency === 'blocking';

          return (
            <div
              key={urgency}
              className={
                bordered ? 'mb-4 rounded-card border-2 border-danger bg-danger-soft/30 p-3 sm:p-4' : 'mb-4'
              }
            >
              <div className="flex items-baseline gap-2 mb-2 flex-wrap">
                <h3 className={`text-[13px] font-semibold ${bordered ? 'text-danger' : 'text-ink'}`}>
                  {style.heading}
                </h3>
                <span className="text-[12px] text-ink-soft">{style.blurb}</span>
              </div>
              <ul className="space-y-2">
                {items.map((a) => (
                  <li key={a.id} className={`card border-l-4 ${style.border}`}>
                    <div className="flex items-start justify-between gap-3 px-4 py-3 flex-wrap">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={style.badge}>{style.badgeLabel}</span>
                          <span className="text-[14px] font-medium leading-snug">{a.title}</span>
                        </div>
                        <p className="mt-1 text-[13px] text-ink-soft leading-relaxed">{a.detail}</p>
                      </div>
                      <Link to={a.href} className="btn-ghost shrink-0 whitespace-nowrap">
                        {a.cta}
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </section>

      {/* --- permits in flight --------------------------------------------- */}
      <section>
        <div className="flex items-baseline justify-between gap-3 mb-3">
          <h2 className="text-sm font-semibold">Your jobs in flight</h2>
          <Link to="/pipeline" className="link text-[12px]">
            See every permit
          </Link>
        </div>

        {permitsQ.isError ? (
          <ErrorState error={permitsQ.error} onRetry={() => void permitsQ.refetch()} title="Could not load your permits" />
        ) : active.length === 0 ? (
          <div className="card">
            <EmptyState
              title="No permits in flight"
              hint="Send us the job and a coordinator works out the jurisdiction and the permit type. Once it is accepted it appears here with exactly where it sits."
              action={
                <Link to="/request-permit" className="btn-primary">
                  Request a permit
                </Link>
              }
            />
          </div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {active.map((p) => (
              <PermitCard key={p.id} permit={p} />
            ))}
          </ul>
        )}
      </section>

      {/* --- inspections and files ----------------------------------------- */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] items-start">
        <section>
          <h2 className="text-sm font-semibold mb-3">Inspections coming up</h2>
          {inspectionsQ.isError ? (
            <ErrorState error={inspectionsQ.error} compact title="Could not load inspections" />
          ) : inspections.length === 0 ? (
            <div className="card">
              <EmptyState
                title="Nothing booked"
                hint="We book inspections as each permit reaches that stage and tell you the day before. Have the job ready — a failed inspection costs a re-inspection fee and about a week."
                compact
              />
            </div>
          ) : (
            <ul className="card divide-y divide-line overflow-hidden">
              {inspections.map((ins) => {
                const permit = permits.find((p) => p.id === ins.permitId) ?? null;
                const days = ins.scheduledFor ? -(daysAgo(ins.scheduledFor) ?? 0) : null;
                return (
                  <li key={ins.id} className="px-4 py-3 flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium">{ins.inspectionType}</div>
                      <div className="text-[12px] text-ink-soft">
                        {permit ? (
                          <Link to={`/permits/${permit.id}`} className="link">
                            {permit.agencyRecordId ?? 'Permit'}
                          </Link>
                        ) : (
                          'Permit'
                        )}
                        {permit?.projectAddress ? ` · ${permit.projectAddress}` : ''}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-[13px] tabular-nums">{fmtDateTime(ins.scheduledFor)}</div>
                      <div className="text-[11px] text-ink-mute">
                        {days == null ? '' : days <= 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section>
          <h2 className="text-sm font-semibold mb-3">Your files</h2>
          <Link to="/files" className="card card-pad block hover:border-brand/40 transition-colors">
            <div className="label">Everything we hold for you</div>
            <div className="mt-1.5 text-2xl font-semibold tabular-nums leading-none">
              {tree ? tree.totalDocuments : '—'}
            </div>
            <p className="mt-2 text-[12px] text-ink-soft leading-relaxed">
              {attentionFolders.length > 0
                ? `${attentionFolders.join(' and ')} needs something from you.`
                : 'Your company paperwork, then a folder per job with a folder inside for each permit on it.'}
            </p>
            <span className="link mt-3 inline-block text-[13px]">Open your folders →</span>
          </Link>
        </section>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function PermitCard({ permit: p }: { permit: PermitRow }) {
  const overBaseline = p.risk.baselineDays != null && p.risk.daysInStage > p.risk.baselineDays;

  return (
    <li className={`card card-pad ${overBaseline ? 'border-l-4 border-warn' : ''}`}>
      <Link to={`/permits/${p.id}`} className="block">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <span className="font-mono text-[13px] text-brand break-all">
            {p.agencyRecordId ?? 'Not yet numbered'}
          </span>
          <StageBadge stage={p.stage} />
        </div>
        <div className="mt-1.5 text-[14px] font-medium leading-snug">{p.projectName ?? 'Job'}</div>
        <div className="text-[12px] text-ink-mute truncate">{p.projectAddress ?? '—'}</div>
        <div className="mt-1 text-[12px] text-ink-soft">
          {humanEnum(p.permitType)} · {p.jurisdictionName ?? p.jurisdictionId}
        </div>
      </Link>
      <p className="mt-2 text-[12px] text-ink-soft leading-relaxed">{stageNarrative(p.stage)}</p>
      <div className="mt-2 flex items-baseline justify-between gap-2 text-[12px]">
        <span className="text-ink-mute">{stageLabel(p.stage)} for</span>
        <span
          className={`tabular-nums font-medium ${overBaseline ? 'text-warn' : 'text-ink'}`}
          title={
            p.risk.baselineDays != null
              ? `Typical at ${p.jurisdictionName ?? 'this department'} is ${p.risk.baselineDays} days`
              : 'We have not measured a typical time here yet'
          }
        >
          {p.risk.daysInStage} day{p.risk.daysInStage === 1 ? '' : 's'}
          {p.risk.baselineDays != null && (
            <span className="text-ink-mute font-normal"> · usually {p.risk.baselineDays}</span>
          )}
        </span>
      </div>
      {p.expiresAt && (
        <div className="mt-1 text-[11px] text-ink-mute">Permit expires {fmtDate(p.expiresAt)}</div>
      )}
    </li>
  );
}

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Blocker, IntegrationGate, Jurisdiction, Pathway, Platform } from '@flph/shared';
import { get } from '../lib/api.ts';
import { fmtShare, humanEnum } from '../lib/format.ts';
import type { IntegrationSummary, JurisdictionListResponse, RoadmapItem, RoadmapResponse } from '../lib/types.ts';
import KpiCard from '../components/KpiCard.tsx';
import DataTable, { type Column } from '../components/DataTable.tsx';
import EmptyState from '../components/EmptyState.tsx';
import ErrorState from '../components/ErrorState.tsx';
import { LoadingPanel } from '../components/Spinner.tsx';

/**
 * Portal connectors.
 *
 * The note at the top is the whole strategy in five sentences, and it is here
 * rather than in a slide deck because every table below only makes sense if you
 * already believe it: there is no multi-jurisdiction self-serve access in this
 * market, so build order comes from our own filing volume, not from statewide
 * platform share.
 */

const PATHWAY_LABEL: Record<Pathway, string> = {
  api: 'API',
  rpa: 'Browser automation',
  manual: 'Manual',
};

const OWNER_CLASS: Record<Blocker['owner'], string> = {
  agency: 'badge-red',
  vendor: 'badge-amber',
  us: 'badge-blue',
};

const OWNER_LABEL: Record<Blocker['owner'], string> = {
  agency: 'Agency',
  vendor: 'Vendor',
  us: 'Us',
};

/** Gate flags aggregated across every jurisdiction on a platform. A platform
 *  "has" a capability when any of its deployments does — the gate data is
 *  per-agency, and this is the honest roll-up. */
interface AdapterRow {
  platform: Platform;
  jurisdictions: number;
  ourJurisdictions: number;
  capabilities: Array<{ label: string; kind: 'good' | 'cost' }>;
  turnOn: string;
  docsUrl: string | null;
}

function buildAdapters(jurisdictions: Jurisdiction[], roadmap: RoadmapItem[]): AdapterRow[] {
  const byPlatform = new Map<Platform, Jurisdiction[]>();
  for (const j of jurisdictions) {
    const list = byPlatform.get(j.platform);
    if (list) list.push(j);
    else byPlatform.set(j.platform, [j]);
  }

  // "What it takes to turn on" is not new copy — it is the readiness engine's
  // own next action, taken as the most common one across that platform's
  // jurisdictions, so the table cannot drift from the roadmap below it.
  const actionsByPlatform = new Map<Platform, Map<string, number>>();
  const volumeByPlatform = new Map<Platform, number>();
  for (const item of roadmap) {
    const p = item.jurisdiction?.platform;
    if (!p) continue;
    const counts = actionsByPlatform.get(p) ?? new Map<string, number>();
    counts.set(item.nextAction, (counts.get(item.nextAction) ?? 0) + 1);
    actionsByPlatform.set(p, counts);
    if (item.ourVolume > 0) volumeByPlatform.set(p, (volumeByPlatform.get(p) ?? 0) + 1);
  }

  const rows: AdapterRow[] = [];
  for (const [platform, list] of byPlatform) {
    const anyGate = (key: keyof IntegrationGate) => list.some((j) => Boolean(j.gate[key]));
    const capabilities: AdapterRow['capabilities'] = [];
    if (anyGate('publicApi')) capabilities.push({ label: 'Public API', kind: 'good' });
    if (anyGate('sandboxAvailable')) capabilities.push({ label: 'Sandbox', kind: 'good' });
    if (anyGate('webhooks')) capabilities.push({ label: 'Webhooks', kind: 'good' });
    else capabilities.push({ label: 'Poll only', kind: 'cost' });
    if (anyGate('bulkExport')) capabilities.push({ label: 'Bulk export', kind: 'good' });
    if (anyGate('agencyApprovalRequired')) capabilities.push({ label: 'Agency approval', kind: 'cost' });
    if (anyGate('agencyPurchaseRequired')) capabilities.push({ label: 'Agency pays', kind: 'cost' });
    if (anyGate('vendorPartnerRequired')) capabilities.push({ label: 'Partner programme', kind: 'cost' });

    const counts = actionsByPlatform.get(platform);
    const turnOn =
      counts && counts.size > 0
        ? [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0]
        : 'No route recorded — treat as manual until a jurisdiction on this platform enters the book.';

    rows.push({
      platform,
      jurisdictions: list.length,
      ourJurisdictions: volumeByPlatform.get(platform) ?? 0,
      capabilities,
      turnOn,
      docsUrl: list.find((j) => j.gate.docsUrl)?.gate.docsUrl ?? null,
    });
  }

  return rows.sort((a, b) => b.jurisdictions - a.jurisdictions || a.platform.localeCompare(b.platform));
}

export default function Connectors() {
  const [showAll, setShowAll] = useState(false);

  const summaryQ = useQuery({
    queryKey: ['integrations', 'summary'],
    queryFn: () => get<IntegrationSummary>('/integrations/summary'),
  });
  const roadmapQ = useQuery({
    queryKey: ['integrations', 'roadmap'],
    queryFn: () => get<RoadmapResponse>('/integrations/roadmap'),
  });
  const jurisdictionsQ = useQuery({
    queryKey: ['jurisdictions', 'all'],
    queryFn: () => get<JurisdictionListResponse>('/jurisdictions'),
    staleTime: 5 * 60_000,
  });

  const summary = summaryQ.data;
  const roadmap = roadmapQ.data;

  const adapters = useMemo(
    () => buildAdapters(jurisdictionsQ.data?.jurisdictions ?? [], roadmap?.items ?? []),
    [jurisdictionsQ.data, roadmap],
  );

  const roadmapRows = useMemo(() => {
    const items = roadmap?.items ?? [];
    return showAll ? items : items.filter((i) => i.ourVolume > 0);
  }, [roadmap, showAll]);

  const roadmapColumns: Array<Column<RoadmapItem>> = useMemo(
    () => [
      {
        key: 'jurisdiction',
        header: 'Jurisdiction',
        sortValue: (r) => r.jurisdiction?.name ?? r.jurisdictionId,
        render: (r) => (
          <div className="min-w-[150px]">
            <div className="font-medium">{r.jurisdiction?.name ?? r.jurisdictionId}</div>
            <div className="text-[11px] text-ink-mute">{humanEnum(r.jurisdiction?.platform ?? 'unknown')}</div>
          </div>
        ),
      },
      {
        key: 'priority',
        header: 'Priority',
        align: 'right',
        sortValue: (r) => r.priorityScore,
        render: (r) => (
          <div className="min-w-[64px]">
            <div className="tabular-nums font-semibold">{r.priorityScore}</div>
            <div className="h-1 rounded bg-page mt-0.5 overflow-hidden">
              <div className="h-full bg-brand" style={{ width: `${r.priorityScore}%` }} />
            </div>
          </div>
        ),
      },
      {
        key: 'volume',
        header: 'Our volume',
        align: 'right',
        sortValue: (r) => r.volumeShare,
        render: (r) => (
          <span className="tabular-nums whitespace-nowrap">
            {r.ourVolume} <span className="text-ink-mute text-[11px]">{fmtShare(r.volumeShare)}</span>
          </span>
        ),
      },
      {
        key: 'pathway',
        header: 'Current → target',
        sortValue: (r) => r.currentPathway,
        render: (r) => (
          <span className="whitespace-nowrap text-[13px]">
            <span className="badge-gray">{PATHWAY_LABEL[r.currentPathway]}</span>
            <span className="mx-1 text-ink-mute">→</span>
            <span className={r.targetPathway === r.currentPathway ? 'badge-gray' : 'badge-blue'}>
              {PATHWAY_LABEL[r.targetPathway]}
            </span>
          </span>
        ),
      },
      {
        key: 'weeks',
        header: 'Est. weeks',
        align: 'right',
        sortValue: (r) => r.estimatedWeeks,
        render: (r) => <span className="tabular-nums">{r.estimatedWeeks === 0 ? '—' : r.estimatedWeeks}</span>,
      },
      {
        key: 'blockers',
        header: 'Blockers',
        sortValue: (r) => r.blockers.length,
        render: (r) =>
          r.blockers.length === 0 ? (
            <span className="text-[12px] text-ink-mute">None</span>
          ) : (
            <ul className="space-y-1 min-w-[240px]">
              {r.blockers.map((b, i) => (
                <li key={i} className="text-[12px] leading-snug">
                  <span className={OWNER_CLASS[b.owner]}>{OWNER_LABEL[b.owner]}</span>{' '}
                  {b.cost === 'agency_budget' && <span className="badge-red">Agency budget</span>}{' '}
                  <span className="text-ink">{b.label}</span>
                  <div className="text-ink-soft">{b.detail}</div>
                </li>
              ))}
            </ul>
          ),
      },
      {
        key: 'next',
        header: 'Next action',
        render: (r) => <p className="text-[12px] text-ink-soft leading-snug min-w-[240px]">{r.nextAction}</p>,
      },
    ],
    [],
  );

  const anyLoading = summaryQ.isLoading || roadmapQ.isLoading || jurisdictionsQ.isLoading;
  const firstError = summaryQ.error ?? roadmapQ.error ?? jurisdictionsQ.error;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Portal connectors</h1>
        <p className="mt-1 text-sm text-ink-soft">
          What we can transact through today, what stands in the way, and the order to attack it in.
        </p>
      </div>

      {/* --- the honest position ------------------------------------------- */}
      <div className="card card-pad border-l-4 border-brand">
        <h2 className="text-sm font-semibold">The honest position on portal APIs</h2>
        <ul className="mt-2 space-y-1.5 text-[13px] text-ink-soft leading-relaxed list-disc pl-4">
          <li>
            <span className="text-ink font-medium">No platform lets a third-party expediter self-serve
            multi-jurisdiction access.</span> There is no "Florida permits API" to sign up for.
          </li>
          <li>
            <span className="text-ink font-medium">Every API is gated at the individual agency level.</span> The
            approval you need is a building department administrator's, not the vendor's — so the unit of work is one
            city at a time.
          </li>
          <li>
            <span className="text-ink font-medium">Accela is the only mature public one.</span> Self-register at the
            developer portal, build against the shared sandbox, then get each agency to install the app.
          </li>
          <li>
            <span className="text-ink font-medium">Tyler EnerGov's API is a paid add-on the agency must buy.</span>{' '}
            Your integration request carries a budget ask for the jurisdiction, so you need a champion willing to fund
            it — lead with staff workload reduction, never with data access.
          </li>
          <li>
            <span className="text-ink font-medium">Sequence effort by our own permit volume per jurisdiction, not by
            statewide platform share.</span> Tyler has the largest Florida footprint and the hardest commercial ask;
            that combination is a trap if you build by market share.
          </li>
        </ul>
        {roadmap && (
          <p className="mt-3 text-[12px] text-ink-mute">
            {roadmap.jurisdictionsFor80Pct} jurisdiction{roadmap.jurisdictionsFor80Pct === 1 ? '' : 's'} produce 80% of
            our {roadmap.totalVolume} filings. That is the real build list.
          </p>
        )}
      </div>

      {anyLoading && <LoadingPanel label="Loading connector position…" rows={5} />}
      {firstError && (
        <ErrorState
          error={firstError}
          onRetry={() => {
            void summaryQ.refetch();
            void roadmapQ.refetch();
            void jurisdictionsQ.refetch();
          }}
          title="Could not load the connector position"
        />
      )}

      {/* --- counts -------------------------------------------------------- */}
      {summary && (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <KpiCard
            label="API candidate"
            value={summary.byTier.api_candidate ?? 0}
            accent="brand"
            hint="Public developer portal exists — we can build before anyone says yes, then ask each agency to install."
          />
          <KpiCard
            label="API partner"
            value={summary.byTier.api_partner ?? 0}
            hint="API exists behind a commercial gate: a vendor partner programme, or a licence the agency has to purchase."
          />
          <KpiCard
            label="Browser automation"
            value={summary.byTier.rpa ?? 0}
            accent="warn"
            hint="Portal only. Disclosed, rate-limited automation once a human has read that portal's terms."
          />
          <KpiCard
            label="Manual"
            value={summary.byTier.manual ?? 0}
            hint="A coordinator reads the portal or the counter. For paper-only agencies this is the permanent, correct answer."
          />
        </div>
      )}

      {summary && (
        <div className="card card-pad">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-[13px]">
            <div>
              <div className="label">Jurisdictions</div>
              <div className="mt-1 text-lg font-semibold tabular-nums">{summary.totalJurisdictions}</div>
            </div>
            <div>
              <div className="label">Portal URL verified</div>
              <div className="mt-1 text-lg font-semibold tabular-nums">{summary.portalUrlKnown}</div>
            </div>
            <div>
              <div className="label">Automation approved</div>
              <div className="mt-1 text-lg font-semibold tabular-nums">{summary.automationApproved}</div>
            </div>
            <div>
              <div className="label">Credentials held</div>
              <div className="mt-1 text-lg font-semibold tabular-nums">{summary.withCredentials}</div>
            </div>
            <div>
              <div className="label">Paper only</div>
              <div className="mt-1 text-lg font-semibold tabular-nums">{summary.paperOnly}</div>
            </div>
          </div>
        </div>
      )}

      {/* --- quick wins ----------------------------------------------------- */}
      {roadmap && (
        <div className="card card-pad border-l-4 border-good">
          <h2 className="text-sm font-semibold">Quick wins</h2>
          <p className="mt-1 text-[13px] text-ink-soft leading-relaxed">
            Jurisdictions we already file in whose every remaining blocker is ours to clear — no agency approval, no
            vendor programme, no budget ask. These need calendar time, not a campaign.
          </p>
          {roadmap.quickWins.length === 0 ? (
            <p className="mt-3 text-[13px] text-ink-mute">
              Nothing is blocked purely on us right now. Every remaining gate needs an agency or a vendor to say yes.
            </p>
          ) : (
            <ul className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2">
              {roadmap.quickWins.map((w) => (
                <li key={w.jurisdictionId} className="rounded border border-line bg-page p-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[13px] font-medium">{w.jurisdiction?.name ?? w.jurisdictionId}</span>
                    <span className="text-[11px] text-ink-mute tabular-nums">
                      {w.ourVolume} filings · {fmtShare(w.volumeShare)}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {w.blockers.map((b, i) => (
                      <span key={i} className="badge-blue">
                        {b.label}
                      </span>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[12px] text-ink-soft leading-snug">{w.nextAction}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* --- adapters ------------------------------------------------------- */}
      {adapters.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold mb-2">Adapters</h2>
          <DataTable<AdapterRow>
            columns={[
              {
                key: 'platform',
                header: 'Adapter',
                sortValue: (a) => a.platform,
                render: (a) => (
                  <div className="min-w-[130px]">
                    <div className="font-medium">{humanEnum(a.platform)}</div>
                    <div className="text-[11px] text-ink-mute">
                      {a.jurisdictions} jurisdiction{a.jurisdictions === 1 ? '' : 's'}
                      {a.ourJurisdictions > 0 ? ` · ${a.ourJurisdictions} we file in` : ''}
                    </div>
                  </div>
                ),
              },
              {
                key: 'capabilities',
                header: 'Capabilities',
                render: (a) => (
                  <div className="flex flex-wrap gap-1 min-w-[180px]">
                    {a.capabilities.map((c) => (
                      <span key={c.label} className={c.kind === 'good' ? 'badge-green' : 'badge-amber'}>
                        {c.label}
                      </span>
                    ))}
                  </div>
                ),
              },
              {
                key: 'turnOn',
                header: 'What it takes to turn on',
                render: (a) => (
                  <div className="min-w-[320px]">
                    <p className="text-[12px] text-ink-soft leading-snug">{a.turnOn}</p>
                    {a.docsUrl && (
                      <a
                        href={a.docsUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="link text-[12px] mt-1 inline-block"
                      >
                        Documentation
                      </a>
                    )}
                  </div>
                ),
              },
            ]}
            rows={adapters}
            rowKey={(a) => a.platform}
            dense
            initialSort={{ key: 'platform', dir: 'asc' }}
            footer="Capability flags roll up the per-agency integration gate — a platform shows a capability when any of its Florida deployments has it."
          />
        </div>
      )}

      {/* --- roadmap -------------------------------------------------------- */}
      {roadmap && (
        <div>
          <div className="flex items-end justify-between gap-3 mb-2 flex-wrap">
            <div>
              <h2 className="text-sm font-semibold">Roadmap</h2>
              <p className="text-[12px] text-ink-soft">
                Sorted by priority — volume share × how much the pathway improves, damped by how long the gate takes to
                clear.
              </p>
            </div>
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              Show jurisdictions we do not file in
            </label>
          </div>
          <DataTable<RoadmapItem>
            columns={roadmapColumns}
            rows={roadmapRows}
            rowKey={(r) => r.jurisdictionId}
            dense
            empty={
              <EmptyState
                title="No jurisdictions in the ranking"
                hint={
                  showAll
                    ? 'The roadmap is empty, which means the jurisdiction dataset failed to load.'
                    : 'We have not filed anywhere yet, so there is no volume to rank by. Tick the box above to see the whole state.'
                }
              />
            }
            footer={`${roadmapRows.length} of ${roadmap.items.length} jurisdictions shown.`}
          />
        </div>
      )}
    </div>
  );
}

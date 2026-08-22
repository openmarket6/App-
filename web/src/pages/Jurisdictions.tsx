import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  INTEGRATION_TIERS,
  PLATFORMS,
  can,
  type IntegrationGate,
  type Jurisdiction,
} from '@flph/shared';
import { get, patch } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { fmtDateTime, humanEnum } from '../lib/format.ts';
import type { JurisdictionListResponse } from '../lib/types.ts';
import DataTable, { type Column } from '../components/DataTable.tsx';
import Drawer from '../components/Drawer.tsx';
import EmptyState from '../components/EmptyState.tsx';
import ErrorState, { errorMessage } from '../components/ErrorState.tsx';
import { LoadingPanel } from '../components/Spinner.tsx';

/**
 * All 119 Florida jurisdictions.
 *
 * The commercially useful column here is the honest one: a null portal URL is
 * rendered as "not verified — confirm by phone" rather than left blank or
 * filled with a plausible guess, because quoting a client a timeline against a
 * URL nobody has opened is how a filing goes missing for a week.
 */

interface Filters {
  platform: string;
  tier: string;
  hvhz: boolean;
  paperOnly: boolean;
  search: string;
}

const EMPTY: Filters = { platform: '', tier: '', hvhz: false, paperOnly: false, search: '' };

function matches(j: Jurisdiction, f: Filters): boolean {
  if (f.platform && j.platform !== f.platform) return false;
  if (f.tier && j.integrationTier !== f.tier) return false;
  if (f.hvhz && !j.hvhz) return false;
  if (f.paperOnly && !j.paperOnly) return false;
  if (f.search) {
    const s = f.search.toLowerCase();
    if (
      !j.name.toLowerCase().includes(s) &&
      !j.county.toLowerCase().includes(s) &&
      !j.slug.toLowerCase().includes(s)
    ) {
      return false;
    }
  }
  return true;
}

const TIER_CLASS: Record<string, string> = {
  api_live: 'badge-green',
  api_candidate: 'badge-blue',
  api_partner: 'badge-blue',
  rpa: 'badge-amber',
  manual: 'badge-gray',
};

export default function Jurisdictions() {
  const { user } = useAuth();
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [selected, setSelected] = useState<Jurisdiction | null>(null);

  const canEdit = !!user && can(user.role, 'jurisdiction:edit');

  const q = useQuery({
    queryKey: ['jurisdictions', 'all'],
    queryFn: () => get<JurisdictionListResponse>('/jurisdictions'),
    staleTime: 5 * 60_000,
  });

  const all = useMemo(() => q.data?.jurisdictions ?? [], [q.data]);
  const rows = useMemo(() => all.filter((j) => matches(j, filters)), [all, filters]);

  // Keep the drawer showing the freshly-patched row rather than the snapshot it
  // was opened with.
  const current = useMemo(
    () => (selected ? (all.find((j) => j.id === selected.id) ?? selected) : null),
    [all, selected],
  );

  const platformsInUse = useMemo(
    () => PLATFORMS.filter((p) => all.some((j) => j.platform === p)),
    [all],
  );

  const columns: Array<Column<Jurisdiction>> = useMemo(
    () => [
      {
        key: 'name',
        header: 'Jurisdiction',
        sortValue: (j) => j.name,
        render: (j) => (
          <div className="min-w-[160px]">
            <div className="font-medium">{j.name}</div>
            <div className="text-[11px] text-ink-mute">{j.county} County</div>
          </div>
        ),
      },
      {
        key: 'kind',
        header: 'Kind',
        sortValue: (j) => j.kind,
        render: (j) => <span className="text-[13px]">{humanEnum(j.kind)}</span>,
      },
      {
        key: 'platform',
        header: 'Platform',
        sortValue: (j) => j.platform,
        render: (j) => <span className="text-[13px] whitespace-nowrap">{humanEnum(j.platform)}</span>,
      },
      {
        key: 'tier',
        header: 'Tier',
        sortValue: (j) => j.integrationTier,
        render: (j) => (
          <span className={TIER_CLASS[j.integrationTier] ?? 'badge-gray'}>{humanEnum(j.integrationTier)}</span>
        ),
      },
      {
        key: 'hvhz',
        header: 'HVHZ',
        sortValue: (j) => (j.hvhz ? 1 : 0),
        render: (j) => (j.hvhz ? <span className="badge-amber">HVHZ</span> : <span className="text-ink-mute">—</span>),
      },
      {
        key: 'wbd',
        header: 'WBD',
        sortValue: (j) => (j.windBorneDebris ? 1 : 0),
        render: (j) =>
          j.windBorneDebris ? (
            <span className="badge-gray" title="Wind-borne debris region">Yes</span>
          ) : (
            <span className="text-ink-mute">—</span>
          ),
      },
      {
        key: 'wind',
        header: 'Wind mph',
        align: 'right',
        sortValue: (j) => j.designWindSpeedMph,
        render: (j) => (
          <span className="tabular-nums">{j.designWindSpeedMph == null ? '—' : j.designWindSpeedMph}</span>
        ),
      },
      {
        key: 'portal',
        header: 'Portal',
        sortValue: (j) => (j.portalUrl ? 0 : 1),
        render: (j) =>
          j.portalUrl ? (
            <a
              href={j.portalUrl}
              target="_blank"
              rel="noreferrer"
              className="link text-[13px]"
              onClick={(e) => e.stopPropagation()}
            >
              Open
            </a>
          ) : j.paperOnly ? (
            <span className="text-[12px] text-ink-mute">Paper only</span>
          ) : (
            <span className="text-[12px] text-warn">Not verified — confirm by phone</span>
          ),
      },
      {
        key: 'automation',
        header: 'Automation',
        sortValue: (j) => (j.automationApproved ? 0 : 1),
        render: (j) =>
          j.automationApproved ? (
            <span className="badge-green">Approved</span>
          ) : (
            <span className="badge-gray">ToS unreviewed</span>
          ),
      },
      {
        key: 'median',
        header: 'Median review',
        align: 'right',
        sortValue: (j) => j.medianReviewDays,
        render: (j) => (
          <span className="tabular-nums whitespace-nowrap">
            {j.medianReviewDays == null ? (
              <span className="text-ink-mute">unmeasured</span>
            ) : (
              <>
                {j.medianReviewDays}d <span className="text-ink-mute text-[11px]">n={j.reviewSampleSize}</span>
              </>
            )}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold">Jurisdictions</h1>
          <p className="mt-1 text-sm text-ink-soft">
            {rows.length} of {all.length} Florida building departments
            {q.data ? ` · ${q.data.of} in the dataset` : ''}
          </p>
        </div>
      </div>

      <div className="card card-pad">
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3 items-end">
          <div>
            <label className="label" htmlFor="j-platform">Platform</label>
            <select
              id="j-platform"
              className="input mt-1"
              value={filters.platform}
              onChange={(e) => setFilters((f) => ({ ...f, platform: e.target.value }))}
            >
              <option value="">All platforms</option>
              {platformsInUse.map((p) => (
                <option key={p} value={p}>
                  {humanEnum(p)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="j-tier">Integration tier</label>
            <select
              id="j-tier"
              className="input mt-1"
              value={filters.tier}
              onChange={(e) => setFilters((f) => ({ ...f, tier: e.target.value }))}
            >
              <option value="">All tiers</option>
              {INTEGRATION_TIERS.map((t) => (
                <option key={t} value={t}>
                  {humanEnum(t)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="j-search">Search</label>
            <input
              id="j-search"
              className="input mt-1"
              placeholder="Name, county or slug"
              value={filters.search}
              onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
            />
          </div>
          <label className="flex items-center gap-2 text-[13px] pb-2">
            <input
              type="checkbox"
              checked={filters.hvhz}
              onChange={(e) => setFilters((f) => ({ ...f, hvhz: e.target.checked }))}
            />
            HVHZ only
          </label>
          <label className="flex items-center gap-2 text-[13px] pb-2">
            <input
              type="checkbox"
              checked={filters.paperOnly}
              onChange={(e) => setFilters((f) => ({ ...f, paperOnly: e.target.checked }))}
            />
            Paper only
          </label>
        </div>
        {(filters.platform || filters.tier || filters.hvhz || filters.paperOnly || filters.search) && (
          <button type="button" className="link mt-3 text-[13px]" onClick={() => setFilters(EMPTY)}>
            Clear filters
          </button>
        )}
      </div>

      {q.isLoading && <LoadingPanel label="Loading jurisdictions…" rows={6} />}
      {q.isError && (
        <ErrorState error={q.error} onRetry={() => q.refetch()} title="Could not load jurisdictions" />
      )}

      {!q.isLoading && !q.isError && (
        <DataTable<Jurisdiction>
          columns={columns}
          rows={rows}
          rowKey={(j) => j.id}
          dense
          initialSort={{ key: 'name', dir: 'asc' }}
          onRowClick={(j) => setSelected(j)}
          empty={
            <EmptyState
              title="No jurisdictions match these filters"
              hint="Clear a filter or widen the search — the dataset covers every county and the municipalities we file in."
              action={
                <button type="button" className="btn-ghost" onClick={() => setFilters(EMPTY)}>
                  Clear filters
                </button>
              }
            />
          }
          footer="Click a row for the full integration gate, our notes, and the terms-of-service record."
        />
      )}

      <Drawer
        open={!!current}
        onClose={() => setSelected(null)}
        title={current?.name ?? ''}
        subtitle={
          current
            ? `${humanEnum(current.kind)} · ${current.county} County · ${humanEnum(current.platform)}`
            : undefined
        }
      >
        {current && <JurisdictionDetail jurisdiction={current} canEdit={canEdit} />}
      </Drawer>
    </div>
  );
}

// ---------------------------------------------------------------------------

const GATE_ROWS: Array<{ key: keyof IntegrationGate; label: string; good: boolean }> = [
  { key: 'publicApi', label: 'Public developer portal', good: true },
  { key: 'sandboxAvailable', label: 'Sandbox to build against', good: true },
  { key: 'webhooks', label: 'Webhooks (otherwise we poll)', good: true },
  { key: 'bulkExport', label: 'Bulk export', good: true },
  { key: 'agencyApprovalRequired', label: 'Agency admin must approve the app', good: false },
  { key: 'agencyPurchaseRequired', label: 'Agency must buy an API licence', good: false },
  { key: 'vendorPartnerRequired', label: 'Vendor partner programme required', good: false },
];

function JurisdictionDetail({ jurisdiction: j, canEdit }: { jurisdiction: Jurisdiction; canEdit: boolean }) {
  return (
    <div className="space-y-5">
      <section>
        <h3 className="label">Building code</h3>
        <div className="mt-2 grid grid-cols-2 gap-2 text-[13px]">
          <div className="rounded border border-line p-2">
            <div className="text-[11px] text-ink-mute">HVHZ</div>
            <div className="mt-0.5 font-medium">{j.hvhz ? 'Yes — NOA / product approval rules' : 'No'}</div>
          </div>
          <div className="rounded border border-line p-2">
            <div className="text-[11px] text-ink-mute">Wind-borne debris</div>
            <div className="mt-0.5 font-medium">{j.windBorneDebris ? 'Yes' : 'No'}</div>
          </div>
          <div className="rounded border border-line p-2">
            <div className="text-[11px] text-ink-mute">Design wind speed</div>
            <div className="mt-0.5 font-medium">
              {j.designWindSpeedMph == null ? 'Unverified' : `${j.designWindSpeedMph} mph (ASCE 7 ult.)`}
            </div>
          </div>
          <div className="rounded border border-line p-2">
            <div className="text-[11px] text-ink-mute">Our median review</div>
            <div className="mt-0.5 font-medium">
              {j.medianReviewDays == null ? 'Unmeasured' : `${j.medianReviewDays}d · n=${j.reviewSampleSize}`}
            </div>
          </div>
        </div>
      </section>

      <section>
        <h3 className="label">Integration gate</h3>
        <p className="mt-1 text-[12px] text-ink-soft leading-snug">
          What stands between us and API access here. Almost every gate is controlled by the agency, not the platform
          vendor.
        </p>
        <ul className="mt-2 divide-y divide-line">
          {GATE_ROWS.map((row) => {
            const value = j.gate[row.key] as boolean;
            const helpful = row.good ? value : !value;
            return (
              <li key={row.key} className="flex items-center justify-between gap-3 py-1.5">
                <span className="text-[13px]">{row.label}</span>
                <span className={helpful ? 'badge-green' : row.good ? 'badge-gray' : 'badge-amber'}>
                  {value ? 'Yes' : 'No'}
                </span>
              </li>
            );
          })}
        </ul>
        {j.gate.docsUrl && (
          <a href={j.gate.docsUrl} target="_blank" rel="noreferrer" className="link mt-2 inline-block text-[13px]">
            Platform API documentation
          </a>
        )}
        {j.gate.notes && (
          <p className="mt-2 rounded bg-page border border-line p-2 text-[12px] text-ink-soft leading-relaxed">
            {j.gate.notes}
          </p>
        )}
      </section>

      <section>
        <h3 className="label">Contact and access</h3>
        <ul className="mt-2 divide-y divide-line text-[13px]">
          <li className="flex items-start justify-between gap-3 py-1.5">
            <span className="text-ink-mute text-[12px]">Portal</span>
            <span className="text-right min-w-0">
              {j.portalUrl ? (
                <a href={j.portalUrl} target="_blank" rel="noreferrer" className="link break-all">
                  {j.portalUrl}
                </a>
              ) : (
                <span className="text-warn">Not verified — confirm by phone</span>
              )}
              <div className="text-[11px] text-ink-mute">confidence: {j.portalUrlConfidence}</div>
            </span>
          </li>
          <li className="flex items-center justify-between gap-3 py-1.5">
            <span className="text-ink-mute text-[12px]">Phone</span>
            <span>{j.contactPhone ?? '—'}</span>
          </li>
          <li className="flex items-center justify-between gap-3 py-1.5">
            <span className="text-ink-mute text-[12px]">Paper only</span>
            <span>{j.paperOnly ? 'Yes' : 'No'}</span>
          </li>
          <li className="flex items-start justify-between gap-3 py-1.5">
            <span className="text-ink-mute text-[12px]">Automation</span>
            <span className="text-right">
              {j.automationApproved ? (
                <>
                  <span className="badge-green">Approved</span>
                  <div className="text-[11px] text-ink-mute mt-0.5">
                    {j.automationApprovedAt ? fmtDateTime(j.automationApprovedAt) : ''}
                    {j.automationApprovedBy ? ` by ${j.automationApprovedBy}` : ''}
                  </div>
                </>
              ) : (
                <span className="badge-gray">Terms of service not reviewed</span>
              )}
            </span>
          </li>
          <li className="flex items-center justify-between gap-3 py-1.5">
            <span className="text-ink-mute text-[12px]">Record updated</span>
            <span className="text-[12px]">{fmtDateTime(j.updatedAt)}</span>
          </li>
        </ul>
      </section>

      {j.notes && (
        <section>
          <h3 className="label">Notes</h3>
          <p className="mt-1.5 text-[13px] text-ink-soft leading-relaxed whitespace-pre-wrap">{j.notes}</p>
        </section>
      )}

      {canEdit ? (
        <EditForm jurisdiction={j} />
      ) : (
        <p className="text-[12px] text-ink-mute">
          Editing a jurisdiction record needs <span className="font-mono">jurisdiction:edit</span>.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function EditForm({ jurisdiction: j }: { jurisdiction: Jurisdiction }) {
  const qc = useQueryClient();
  const [portalUrl, setPortalUrl] = useState(j.portalUrl ?? '');
  const [contactPhone, setContactPhone] = useState(j.contactPhone ?? '');
  const [approve, setApprove] = useState(j.automationApproved);
  const [tosNote, setTosNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const needsNote = approve && !j.automationApproved;

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => patch(`/jurisdictions/${j.id}`, body),
    onSuccess: () => {
      setError(null);
      setSaved(true);
      setTosNote('');
      void qc.invalidateQueries({ queryKey: ['jurisdictions'] });
    },
    onError: (err) => {
      setSaved(false);
      setError(errorMessage(err));
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setSaved(false);

    const trimmedUrl = portalUrl.trim();
    if (trimmedUrl && !/^https?:\/\//i.test(trimmedUrl)) {
      setError('The portal URL has to be a full address starting with http:// or https://');
      return;
    }
    if (needsNote && !tosNote.trim()) {
      setError(
        'Approving automation requires a note — record who read this portal’s terms of service and what they concluded.',
      );
      return;
    }

    const body: Record<string, unknown> = {
      portalUrl: trimmedUrl || null,
      contactPhone: contactPhone.trim() || null,
    };
    // Confidence is a claim about who verified it. Typing a URL by hand is a
    // human verification, so it moves to high; clearing it drops back to low.
    if (trimmedUrl !== (j.portalUrl ?? '')) body.portalUrlConfidence = trimmedUrl ? 'high' : 'low';
    if (approve !== j.automationApproved) body.automationApproved = approve;
    if (tosNote.trim()) body.tosReviewNote = tosNote.trim();

    save.mutate(body);
  }

  return (
    <form onSubmit={submit} className="rounded-md border border-line bg-page p-3">
      <h3 className="label">Record a correction</h3>
      <p className="mt-1 text-[12px] text-ink-soft leading-snug">
        Anything a coordinator learns on the phone belongs here. The generated dataset is never edited, so regenerating
        it will not discard this.
      </p>

      <div className="mt-3 space-y-3">
        <div>
          <label className="label" htmlFor={`url-${j.id}`}>Portal URL</label>
          <input
            id={`url-${j.id}`}
            className="input mt-1"
            placeholder="https://…  (leave blank if there is no portal)"
            value={portalUrl}
            onChange={(e) => setPortalUrl(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor={`phone-${j.id}`}>Building department phone</label>
          <input
            id={`phone-${j.id}`}
            className="input mt-1"
            placeholder="The number that actually gets answered"
            value={contactPhone}
            onChange={(e) => setContactPhone(e.target.value)}
          />
        </div>

        <div className="rounded border border-line bg-white p-2.5">
          <label className="flex items-start gap-2 text-[13px]">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={approve}
              onChange={(e) => setApprove(e.target.checked)}
            />
            <span>
              <span className="font-medium">Automation approved for this portal</span>
              <span className="block text-[12px] text-ink-soft leading-snug">
                Turning this on is a legal judgement about the portal&rsquo;s terms, so the API refuses to record it
                without a note naming who read them.
              </span>
            </span>
          </label>
          {needsNote && (
            <div className="mt-2">
              <label className="label" htmlFor={`tos-${j.id}`}>Terms-of-service review note (required)</label>
              <textarea
                id={`tos-${j.id}`}
                className="input mt-1 min-h-[72px]"
                placeholder="Who read the terms, on what date, and what they concluded about disclosed rate-limited automation."
                value={tosNote}
                onChange={(e) => setTosNote(e.target.value)}
              />
            </div>
          )}
        </div>
      </div>

      {error && <div className="mt-3 rounded bg-danger-soft px-2 py-1.5 text-[12px] text-danger">{error}</div>}
      {saved && <div className="mt-3 rounded bg-good-soft px-2 py-1.5 text-[12px] text-good">Saved.</div>}

      <button type="submit" className="btn-primary mt-3" disabled={save.isPending}>
        {save.isPending ? 'Saving…' : 'Save changes'}
      </button>
    </form>
  );
}

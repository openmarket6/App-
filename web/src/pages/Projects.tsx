import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  can,
  dollarsToCents,
  formatCents,
  type Jurisdiction,
  type Project,
} from '@flph/shared';
import { get, post } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { fmtDate, humanEnum } from '../lib/format.ts';
import type { ClientListResponse, ProjectListResponse, ProjectRow } from '../lib/api-shapes.ts';
import type { JurisdictionListResponse, PermitListResponse, PermitRow } from '../lib/types.ts';
import DataTable, { type Column } from '../components/DataTable.tsx';
import Drawer from '../components/Drawer.tsx';
import EmptyState from '../components/EmptyState.tsx';
import ErrorState from '../components/ErrorState.tsx';
import KpiCard from '../components/KpiCard.tsx';
import StageBadge from '../components/StageBadge.tsx';
import RiskBadge from '../components/RiskBadge.tsx';
import { LoadingPanel } from '../components/Spinner.tsx';

/**
 * Projects — the job sites.
 *
 * A project is where the jurisdiction actually lives: the address decides the
 * building department, and every trade permit on that address inherits it. So
 * the two badges on this table are not decoration. HVHZ means Miami-Dade NOAs
 * rather than statewide product approval, and a flood zone means an elevation
 * certificate — both of which change the document list before anybody has
 * chosen a permit type.
 */

/** Zone X is the "no special flood hazard" answer, and does not add requirements. */
function inFloodZone(zone: string | null): boolean {
  return !!zone && !/^x$/i.test(zone.trim());
}

interface Row extends ProjectRow {
  permits: PermitRow[];
  jurisdiction: Jurisdiction | null;
}

export default function Projects() {
  const { user } = useAuth();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');

  const canCreate = !!user && can(user.role, 'permit:create');

  const projectsQ = useQuery({
    queryKey: ['projects'],
    queryFn: () => get<ProjectListResponse>('/projects'),
  });

  const permitsQ = useQuery({
    queryKey: ['permits'],
    queryFn: () => get<PermitListResponse>('/permits'),
  });

  const jurisdictionsQ = useQuery({
    queryKey: ['jurisdictions', 'all'],
    queryFn: () => get<JurisdictionListResponse>('/jurisdictions'),
    staleTime: 10 * 60_000,
  });

  const rows = useMemo<Row[]>(() => {
    const permitsByProject = new Map<string, PermitRow[]>();
    for (const p of permitsQ.data?.permits ?? []) {
      const list = permitsByProject.get(p.projectId) ?? [];
      list.push(p);
      permitsByProject.set(p.projectId, list);
    }
    const jurisdictionById = new Map((jurisdictionsQ.data?.jurisdictions ?? []).map((j) => [j.id, j]));

    return (projectsQ.data?.projects ?? []).map((p) => ({
      ...p,
      permits: permitsByProject.get(p.id) ?? [],
      jurisdiction: jurisdictionById.get(p.jurisdictionId) ?? null,
    }));
  }, [projectsQ.data, permitsQ.data, jurisdictionsQ.data]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return rows;
    return rows.filter((r) =>
      [r.name, r.addressLine1, r.city, r.county, r.zip, r.parcelId, r.clientName, r.jurisdictionName]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(s),
    );
  }, [rows, q]);

  const current = useMemo(() => rows.find((r) => r.id === selected) ?? null, [rows, selected]);

  const totalValuation = rows.reduce((sum, r) => sum + r.valuationCents, 0);
  const hvhzCount = rows.filter((r) => r.jurisdiction?.hvhz).length;
  const floodCount = rows.filter((r) => inFloodZone(r.floodZone)).length;

  const columns: Array<Column<Row>> = useMemo(
    () => [
      {
        key: 'client',
        header: 'Contractor',
        sortValue: (r) => r.clientName ?? '',
        render: (r) => (
          <div className="min-w-[150px]">
            <div className="font-medium">{r.clientName ?? '—'}</div>
            <div className="text-[12px] text-ink-mute truncate">{r.name}</div>
          </div>
        ),
      },
      {
        key: 'address',
        header: 'Address',
        sortValue: (r) => r.addressLine1,
        render: (r) => (
          <div className="min-w-[190px]">
            <div>{r.addressLine1}</div>
            <div className="text-[12px] text-ink-mute">
              {r.city}, {r.county} County {r.zip}
            </div>
          </div>
        ),
      },
      {
        key: 'jurisdiction',
        header: 'Jurisdiction',
        sortValue: (r) => r.jurisdictionName ?? '',
        render: (r) => (
          <div className="min-w-[170px]">
            <div className="whitespace-nowrap">{r.jurisdictionName ?? r.jurisdictionId}</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {r.jurisdiction?.hvhz && (
                <span className="badge-amber" title="High-Velocity Hurricane Zone — Miami-Dade NOAs required, not statewide product approval">
                  HVHZ
                </span>
              )}
              {r.jurisdiction?.paperOnly && <span className="badge-red">Paper only</span>}
              {inFloodZone(r.floodZone) && (
                <span className="badge-blue" title="FEMA special flood hazard area — elevation certificate required">
                  Flood {r.floodZone}
                </span>
              )}
              {r.coastalConstructionControlLine && <span className="badge-amber">CCCL</span>}
              {r.ownerBuilder && <span className="badge-gray">Owner-builder</span>}
            </div>
          </div>
        ),
      },
      {
        key: 'valuation',
        header: 'Valuation',
        align: 'right',
        sortValue: (r) => r.valuationCents,
        render: (r) => (
          <span className={`tabular-nums ${r.valuationCents === 0 ? 'text-ink-mute' : ''}`}>
            {r.valuationCents === 0 ? 'Not recorded' : formatCents(r.valuationCents)}
          </span>
        ),
      },
      {
        key: 'permits',
        header: 'Permits',
        align: 'right',
        sortValue: (r) => r.permits.length,
        render: (r) => <span className="tabular-nums">{r.permits.length || '—'}</span>,
      },
      {
        key: 'created',
        header: 'Created',
        sortValue: (r) => Date.parse(r.createdAt),
        render: (r) => <span className="whitespace-nowrap text-[13px] text-ink-soft">{fmtDate(r.createdAt)}</span>,
      },
    ],
    [],
  );

  const loading = projectsQ.isLoading || permitsQ.isLoading;
  const error = projectsQ.error ?? permitsQ.error;

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold">Projects</h1>
          <p className="mt-1 text-sm text-ink-soft">
            {filtered.length} of {rows.length} job site{rows.length === 1 ? '' : 's'} · one project carries every trade
            permit on that address.
          </p>
        </div>
        {canCreate && (
          <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
            New project
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <KpiCard label="Projects" value={rows.length} hint="Every job site on the book, across both service lines." />
        <KpiCard
          label="In HVHZ"
          value={hvhzCount}
          accent={hvhzCount > 0 ? 'warn' : 'none'}
          hint="Miami-Dade NOAs for every product in the assembly. Statewide approval will not be accepted."
        />
        <KpiCard
          label="In a flood zone"
          value={floodCount}
          hint="Elevation certificate, and a 50% rule determination on substantial improvement."
        />
        <KpiCard
          label="Declared value"
          value={formatCents(totalValuation)}
          hint="Sum of recorded valuations. Anything over $250,000 carries a Notice of Commencement."
        />
      </div>

      <div className="card card-pad">
        <label className="block max-w-md">
          <span className="label">Search</span>
          <input
            className="input mt-1"
            placeholder="Address, city, parcel, contractor…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
      </div>

      {error && <ErrorState error={error} onRetry={() => void projectsQ.refetch()} title="Could not load projects" />}
      {loading && !error && <LoadingPanel label="Loading projects…" rows={5} />}

      {!loading && !error && (
        <DataTable<Row>
          columns={columns}
          rows={filtered}
          rowKey={(r) => r.id}
          onRowClick={(r) => setSelected(r.id)}
          initialSort={{ key: 'created', dir: 'desc' }}
          empty={
            rows.length === 0 ? (
              <EmptyState
                title="No projects yet"
                hint="A project is the address a permit is filed against — it decides the building department, and the HVHZ and flood-zone facts that decide the document list. Create the first one and permits hang off it."
                action={
                  canCreate ? (
                    <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
                      New project
                    </button>
                  ) : undefined
                }
              />
            ) : (
              <EmptyState
                title="No projects match that search"
                hint="Try the street name, the parcel number, or the contractor."
                action={
                  <button type="button" className="btn-ghost" onClick={() => setQ('')}>
                    Clear search
                  </button>
                }
              />
            )
          }
          footer={
            jurisdictionsQ.isError
              ? 'Jurisdictions could not be loaded, so the HVHZ badges are missing on this render.'
              : `${filtered.length} project${filtered.length === 1 ? '' : 's'}`
          }
        />
      )}

      <ProjectDrawer project={current} canCreate={canCreate} onClose={() => setSelected(null)} />

      {canCreate && creating && <CreateProjectDrawer onClose={() => setCreating(false)} onCreated={() => setCreating(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

function ProjectDrawer({
  project,
  canCreate,
  onClose,
}: {
  project: Row | null;
  canCreate: boolean;
  onClose: () => void;
}) {
  if (!project) return null;
  const j = project.jurisdiction;

  return (
    <Drawer
      open
      onClose={onClose}
      title={project.name}
      subtitle={`${project.addressLine1}, ${project.city} ${project.zip}`}
      footer={
        canCreate ? (
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12px] text-ink-soft">Every trade on this address is a separate permit.</span>
            <Link to={`/permits/new?clientId=${project.clientId}&projectId=${project.id}`} className="btn-primary">
              File a permit here
            </Link>
          </div>
        ) : undefined
      }
    >
      <div className="space-y-5">
        <section>
          <div className="label">Project</div>
          <dl className="mt-1.5 rounded-md bg-page px-3 py-2">
            <Fact label="Contractor">
              <Link to={`/clients/${project.clientId}`} className="link">
                {project.clientName ?? project.clientId}
              </Link>
            </Fact>
            <Fact label="County">{project.county}</Fact>
            <Fact label="Parcel ID">{project.parcelId ?? 'Not recorded'}</Fact>
            <Fact label="Valuation">
              {project.valuationCents === 0 ? 'Not recorded' : formatCents(project.valuationCents)}
            </Fact>
            <Fact label="Owner-builder">{project.ownerBuilder ? 'Yes' : 'No'}</Fact>
            <Fact label="Flood zone">
              {project.floodZone ? (
                inFloodZone(project.floodZone) ? (
                  <span className="text-warn">
                    {project.floodZone} — elevation certificate required
                  </span>
                ) : (
                  `${project.floodZone} — no special flood hazard`
                )
              ) : (
                'Not recorded'
              )}
            </Fact>
            <Fact label="Seaward of the CCCL">
              {project.coastalConstructionControlLine ? 'Yes — state DEP authorization first' : 'No'}
            </Fact>
            <Fact label="Created">{fmtDate(project.createdAt)}</Fact>
          </dl>
        </section>

        <section>
          <div className="label">Jurisdiction</div>
          {j ? (
            <dl className="mt-1.5 rounded-md bg-page px-3 py-2">
              <Fact label="Building department">{j.name}</Fact>
              <Fact label="Platform">{humanEnum(j.platform)}</Fact>
              <Fact label="Integration tier">{humanEnum(j.integrationTier)}</Fact>
              <Fact label="HVHZ">{j.hvhz ? 'Yes — Miami-Dade NOAs required' : 'No'}</Fact>
              <Fact label="Design wind speed">
                {j.designWindSpeedMph != null ? `${j.designWindSpeedMph} mph ultimate` : 'Not verified'}
              </Fact>
              <Fact label="Paper only">{j.paperOnly ? 'Yes — no electronic submittal' : 'No'}</Fact>
              <Fact label="Portal">
                {j.portalUrl ? (
                  <a href={j.portalUrl} target="_blank" rel="noreferrer noopener" className="link break-all">
                    {j.portalUrl}
                  </a>
                ) : (
                  <span className="text-warn">
                    Not verified — confirm by phone{j.contactPhone ? ` (${j.contactPhone})` : ''}
                  </span>
                )}
              </Fact>
              <Fact label="Median review">
                {j.medianReviewDays != null
                  ? `${j.medianReviewDays}d over ${j.reviewSampleSize} measured filings`
                  : 'No measured sample yet'}
              </Fact>
            </dl>
          ) : (
            <p className="mt-1.5 text-[13px] text-ink-soft">
              This project points at jurisdiction <span className="font-mono">{project.jurisdictionId}</span>, which is
              not in the loaded set. That is a data problem worth chasing — permits here cannot be routed.
            </p>
          )}
        </section>

        <section>
          <div className="flex items-baseline justify-between gap-3">
            <div className="label">Permits on this project</div>
            <span className="badge-gray tabular-nums">{project.permits.length}</span>
          </div>
          {project.permits.length === 0 ? (
            <EmptyState
              title="No permits filed here yet"
              hint="The project exists; nothing has been filed against it. Every trade — building, roofing, electrical — is its own permit."
              compact
            />
          ) : (
            <ul className="mt-1.5 divide-y divide-line border-t border-line">
              {project.permits.map((p) => (
                <li key={p.id} className="py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link to={`/permits/${p.id}`} className="font-mono text-[13px] text-brand hover:underline">
                        {p.agencyRecordId ?? 'No number'}
                      </Link>
                      <div className="mt-0.5 text-[12px] text-ink-soft">{humanEnum(p.permitType)}</div>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-1 shrink-0">
                      <StageBadge stage={p.stage} />
                      <RiskBadge level={p.risk.level} score={p.risk.score} reasons={p.risk.reasons} />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

interface Form {
  clientId: string;
  name: string;
  addressLine1: string;
  city: string;
  county: string;
  zip: string;
  jurisdictionId: string;
  parcelId: string;
  /** Dollars in the field, integer cents on the wire. */
  valuationDollars: string;
  ownerBuilder: boolean;
  floodZone: string;
  coastalConstructionControlLine: boolean;
}

const EMPTY: Form = {
  clientId: '',
  name: '',
  addressLine1: '',
  city: '',
  county: '',
  zip: '',
  jurisdictionId: '',
  parcelId: '',
  valuationDollars: '',
  ownerBuilder: false,
  floodZone: '',
  coastalConstructionControlLine: false,
};

function CreateProjectDrawer({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [form, setForm] = useState<Form>({
    ...EMPTY,
    clientId: user?.role === 'CLIENT' ? (user.clientId ?? '') : '',
  });

  const clientsQ = useQuery({
    queryKey: ['clients'],
    queryFn: () => get<ClientListResponse>('/clients'),
  });

  const jurisdictionsQ = useQuery({
    queryKey: ['jurisdictions', 'all'],
    queryFn: () => get<JurisdictionListResponse>('/jurisdictions'),
    staleTime: 10 * 60_000,
  });

  const jurisdiction = useMemo(
    () => (jurisdictionsQ.data?.jurisdictions ?? []).find((j) => j.id === form.jurisdictionId) ?? null,
    [jurisdictionsQ.data, form.jurisdictionId],
  );

  // The jurisdiction already knows its county; prefilling keeps the two from
  // disagreeing on the same row.
  useEffect(() => {
    if (!jurisdiction) return;
    setForm((f) => (f.county.trim() ? f : { ...f, county: jurisdiction.county }));
  }, [jurisdiction]);

  const create = useMutation({
    mutationFn: () =>
      post<Project>('/projects', {
        clientId: form.clientId,
        name: form.name.trim(),
        addressLine1: form.addressLine1.trim(),
        city: form.city.trim(),
        county: form.county.trim(),
        zip: form.zip.trim(),
        jurisdictionId: form.jurisdictionId,
        parcelId: form.parcelId.trim() || null,
        valuationCents: dollarsToCents(Number(form.valuationDollars) || 0),
        ownerBuilder: form.ownerBuilder,
        floodZone: form.floodZone.trim() || null,
        coastalConstructionControlLine: form.coastalConstructionControlLine,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['projects'] });
      onCreated();
    },
  });

  const valid =
    !!form.clientId &&
    !!form.name.trim() &&
    !!form.addressLine1.trim() &&
    !!form.city.trim() &&
    !!form.county.trim() &&
    !!form.zip.trim() &&
    !!form.jurisdictionId;

  return (
    <Drawer
      open
      onClose={onClose}
      title="New project"
      subtitle="The job site. Its address decides the building department for every permit filed on it."
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12px] text-ink-soft">Nothing is filed yet — this only creates the site.</span>
          <div className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={!valid || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending ? 'Creating…' : 'Create project'}
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {create.isError && <ErrorState error={create.error} title="Could not create the project" compact />}

        {user?.role !== 'CLIENT' && (
          <FormField label="Contractor" required>
            {clientsQ.isLoading ? (
              <div className="text-[12px] text-ink-mute">Loading contractors…</div>
            ) : clientsQ.isError ? (
              <ErrorState error={clientsQ.error} compact title="Could not load contractors" />
            ) : (
              <select
                className="input"
                value={form.clientId}
                onChange={(e) => setForm((f) => ({ ...f, clientId: e.target.value }))}
              >
                <option value="">Choose a contractor…</option>
                {(clientsQ.data?.clients ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </FormField>
        )}

        <FormField label="Project name" required hint="What a coordinator will recognise on the board.">
          <input
            className="input"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Whitfield residence — re-roof"
          />
        </FormField>

        <FormField label="Street address" required>
          <input
            className="input"
            value={form.addressLine1}
            onChange={(e) => setForm((f) => ({ ...f, addressLine1: e.target.value }))}
          />
        </FormField>

        <div className="grid grid-cols-3 gap-3">
          <FormField label="City" required>
            <input className="input" value={form.city} onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))} />
          </FormField>
          <FormField label="County" required>
            <input
              className="input"
              value={form.county}
              onChange={(e) => setForm((f) => ({ ...f, county: e.target.value }))}
            />
          </FormField>
          <FormField label="ZIP" required>
            <input className="input" value={form.zip} onChange={(e) => setForm((f) => ({ ...f, zip: e.target.value }))} />
          </FormField>
        </div>

        <FormField
          label="Jurisdiction"
          required
          hint="One of the 119 Florida records. A free-text authority is how a filing goes missing."
        >
          {jurisdictionsQ.isLoading ? (
            <div className="text-[12px] text-ink-mute">Loading jurisdictions…</div>
          ) : jurisdictionsQ.isError ? (
            <ErrorState error={jurisdictionsQ.error} compact title="Could not load jurisdictions" />
          ) : (
            <select
              className="input"
              value={form.jurisdictionId}
              onChange={(e) => setForm((f) => ({ ...f, jurisdictionId: e.target.value }))}
            >
              <option value="">Choose a jurisdiction…</option>
              {(jurisdictionsQ.data?.jurisdictions ?? []).map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name} ({j.county})
                </option>
              ))}
            </select>
          )}
        </FormField>

        {jurisdiction && (
          <div className="rounded-md bg-page px-3 py-2 text-[12px] text-ink-soft leading-snug">
            {jurisdiction.hvhz
              ? 'High-Velocity Hurricane Zone. Every product in the envelope needs a Miami-Dade NOA — statewide Florida Product Approval will not be accepted.'
              : jurisdiction.windBorneDebris
                ? 'Wind-borne debris region. Every glazed opening needs impact-rated protection or code-compliant shutters.'
                : 'Outside the HVHZ and the wind-borne debris region.'}
            {jurisdiction.paperOnly && ' This jurisdiction accepts paper submittal only — plan for a courier or a counter visit.'}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Parcel ID" hint="Folio number from the property appraiser.">
            <input
              className="input"
              value={form.parcelId}
              onChange={(e) => setForm((f) => ({ ...f, parcelId: e.target.value }))}
            />
          </FormField>
          <FormField label="Valuation (US$)" hint="Over $250,000 adds a recorded Notice of Commencement.">
            <input
              className="input tabular-nums"
              inputMode="decimal"
              value={form.valuationDollars}
              onChange={(e) => setForm((f) => ({ ...f, valuationDollars: e.target.value }))}
              placeholder="48000"
            />
          </FormField>
        </div>

        <FormField label="FEMA flood zone" hint="Leave blank if unknown; “X” means no special flood hazard.">
          <input
            className="input"
            value={form.floodZone}
            onChange={(e) => setForm((f) => ({ ...f, floodZone: e.target.value }))}
            placeholder="AE"
          />
        </FormField>

        <div className="space-y-2">
          <Check
            checked={form.ownerBuilder}
            onChange={(v) => setForm((f) => ({ ...f, ownerBuilder: v }))}
            label="Owner-builder"
            hint="Adds the F.S. 489.103(7) disclosure affidavit, usually signed in person before the building official."
          />
          <Check
            checked={form.coastalConstructionControlLine}
            onChange={(v) => setForm((f) => ({ ...f, coastalConstructionControlLine: v }))}
            label="Seaward of the Coastal Construction Control Line"
            hint="A state DEP authorization has to be in hand before the local permit issues."
          />
        </div>
      </div>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-[12px] text-ink-mute shrink-0">{label}</dt>
      <dd className="text-[13px] text-right min-w-0">{children}</dd>
    </div>
  );
}

function FormField({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="label">
        {label}
        {required && <span className="text-danger"> *</span>}
      </span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-[12px] text-ink-mute leading-snug">{hint}</span>}
    </label>
  );
}

function Check({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 rounded border-line text-brand focus:ring-brand/30"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="leading-snug">
        {label}
        {hint && <span className="block text-[12px] text-ink-mute">{hint}</span>}
      </span>
    </label>
  );
}

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  PERMIT_TYPES,
  SERVICE_LINES,
  SERVICE_LINE_LABELS,
  assessCompliance,
  buildRequirements,
  can,
  dollarsToCents,
  formatCents,
  type Client,
  type ComplianceGap,
  type ComplianceVerdict,
  type Jurisdiction,
  type Permit,
  type PermitType,
  type Project,
  type RequirementItem,
  type ServiceLine,
  type SupervisionGap,
} from '@flph/shared';
import { ApiError, get, post } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { humanEnum } from '../lib/format.ts';
import type {
  ClientListResponse,
  ComplianceListResponse,
  ProjectListResponse,
  QualifierListResponse,
  UserListResponse,
} from '../lib/api-shapes.ts';
import type { JurisdictionListResponse } from '../lib/types.ts';
import ComplianceBadge from '../components/ComplianceBadge.tsx';
import EmptyState from '../components/EmptyState.tsx';
import ErrorState, { errorCode, errorMessage } from '../components/ErrorState.tsx';
import Meter from '../components/Meter.tsx';
import Spinner, { LoadingPanel } from '../components/Spinner.tsx';

/**
 * File a new permit.
 *
 * One scrolling form, not a wizard. A coordinator filing twenty of these wants
 * to see the compliance verdict, the jurisdiction's facts and the full
 * document checklist at the same time — hiding any of it behind a "next"
 * button turns one screen of judgement into four screens of clicking.
 *
 * Two things here are deliberate rather than decorative:
 *
 *   1. The compliance verdict is computed in the browser with the same
 *      `assessCompliance` the API's filing gate runs. Reading a stored flag
 *      would let this screen and the gate disagree, and the entire value of
 *      showing the verdict up front is that it predicts what happens when you
 *      press the button.
 *
 *   2. A blocked contractor still gets the whole form, greyed at the submit
 *      step. Showing a coordinator exactly what they cannot yet file — and the
 *      three sentences they can read down the phone to fix it — is more useful
 *      than an empty screen that says "not allowed".
 */

const NEW_PROJECT = '__new__';

interface ProjectForm {
  name: string;
  addressLine1: string;
  city: string;
  county: string;
  zip: string;
  jurisdictionId: string;
  parcelId: string;
  /** Dollars in the input. Converted to integer cents on the wire, never before. */
  valuationDollars: string;
  ownerBuilder: boolean;
  floodZone: string;
  coastalConstructionControlLine: boolean;
}

const EMPTY_PROJECT: ProjectForm = {
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

/**
 * How a filing actually reaches this jurisdiction.
 *
 * Mirrors `getAdapterFor` in the API's connector registry deliberately, so the
 * sentence on this screen and the adapter the server will pick cannot drift.
 * Note what does not promote a jurisdiction here either: holding credentials,
 * or the platform merely being one we have a client for.
 */
function filingRoute(j: Jurisdiction): { label: string; tone: 'good' | 'warn' | 'gray'; detail: string } {
  if (j.paperOnly) {
    return {
      label: 'By hand',
      tone: 'warn',
      detail:
        'This jurisdiction does not accept electronic submittal. Plan for a wet-signed, sealed paper set and a courier or counter visit — and price the extra half day in.',
    };
  }
  if (j.integrationTier === 'api_live' && (j.platform === 'accela' || j.platform === 'opengov')) {
    return {
      label: 'Live API',
      tone: 'good',
      detail: `We transact with ${j.name} through their ${humanEnum(j.platform)} API. Status comes back on its own, usually within the hour.`,
    };
  }
  if (j.integrationTier === 'rpa' && j.automationApproved) {
    return {
      label: 'Portal automation',
      tone: 'good',
      detail:
        'A disclosed, rate-limited read of their portal keeps status current. Submittal itself is still done by a coordinator.',
    };
  }
  return {
    label: 'By hand',
    tone: 'gray',
    detail:
      'A coordinator files on the portal or at the counter and records what the agency says. Manual is a permanent, first-class tier here — it is not a gap waiting to be closed.',
  };
}

export default function PermitNew() {
  const { user, isStaff } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const canCreate = !!user && can(user.role, 'permit:create');
  const canReadUsers = !!user && can(user.role, 'user:read');
  const canReadSettings = !!user && can(user.role, 'settings:read');

  // A portal account is pinned to its own contractor and never sees the picker.
  const pinnedClientId = user?.role === 'CLIENT' ? (user.clientId ?? '') : '';

  const [clientId, setClientId] = useState<string>(pinnedClientId || (params.get('clientId') ?? ''));
  const [projectId, setProjectId] = useState<string>(params.get('projectId') ?? '');
  const [projectForm, setProjectForm] = useState<ProjectForm>(EMPTY_PROJECT);
  const [permitType, setPermitType] = useState<PermitType>('RESIDENTIAL_ALTERATION');
  const [serviceLine, setServiceLine] = useState<ServiceLine | ''>('');
  const [qualifyingAgentId, setQualifyingAgentId] = useState('');
  const [supervisorUserId, setSupervisorUserId] = useState('');
  const [agencyRecordId, setAgencyRecordId] = useState('');

  const [blockingGaps, setBlockingGaps] = useState<ComplianceGap[] | null>(null);
  const [supervisionGaps, setSupervisionGaps] = useState<SupervisionGap[] | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // --- data ---------------------------------------------------------------

  const clientsQ = useQuery({
    queryKey: ['clients'],
    queryFn: () => get<ClientListResponse>('/clients'),
  });

  const jurisdictionsQ = useQuery({
    queryKey: ['jurisdictions', 'all'],
    queryFn: () => get<JurisdictionListResponse>('/jurisdictions'),
    staleTime: 10 * 60_000,
  });

  const projectsQ = useQuery({
    queryKey: ['projects', clientId],
    queryFn: () => get<ProjectListResponse>(`/projects?clientId=${encodeURIComponent(clientId)}`),
    enabled: !!clientId,
  });

  const complianceQ = useQuery({
    queryKey: ['compliance', clientId],
    queryFn: () => get<ComplianceListResponse>(`/compliance?clientId=${encodeURIComponent(clientId)}`),
    enabled: !!clientId,
  });

  const qualifiersQ = useQuery({
    queryKey: ['supervision', 'qualifiers'],
    queryFn: () => get<QualifierListResponse>('/supervision/qualifiers'),
    enabled: isStaff && canReadSettings,
    staleTime: 5 * 60_000,
  });

  const usersQ = useQuery({
    queryKey: ['users'],
    queryFn: () => get<UserListResponse>('/users'),
    enabled: isStaff && canReadUsers,
    staleTime: 5 * 60_000,
  });

  const clients = useMemo(() => clientsQ.data?.clients ?? [], [clientsQ.data]);
  const client = useMemo<Client | null>(() => clients.find((c) => c.id === clientId) ?? null, [clients, clientId]);

  const jurisdictions = useMemo(() => jurisdictionsQ.data?.jurisdictions ?? [], [jurisdictionsQ.data]);
  const projects = useMemo(() => projectsQ.data?.projects ?? [], [projectsQ.data]);

  /**
   * The same function the API's filing gate calls, over the certificates we
   * actually hold. Not a stored flag — see the header comment.
   *
   * Null until the items are actually in hand. `assessCompliance([])` is a
   * perfectly valid verdict meaning "nothing on file, blocked", and rendering
   * that while the request is still in flight would accuse a contractor of a
   * lapse they do not have.
   */
  const verdict = useMemo<ComplianceVerdict | null>(
    () => (clientId && complianceQ.data ? assessCompliance(complianceQ.data.items) : null),
    [clientId, complianceQ.data],
  );

  const creatingProject = projectId === NEW_PROJECT;
  const existingProject = useMemo<Project | null>(
    () => (creatingProject ? null : (projects.find((p) => p.id === projectId) ?? null)),
    [creatingProject, projects, projectId],
  );

  const jurisdictionId = creatingProject ? projectForm.jurisdictionId : (existingProject?.jurisdictionId ?? '');
  const jurisdiction = useMemo<Jurisdiction | null>(
    () => jurisdictions.find((j) => j.id === jurisdictionId) ?? null,
    [jurisdictions, jurisdictionId],
  );

  // Service line defaults to whatever the contractor is on, but stays
  // overridable — a managed-licence client can still have a one-off expedited
  // filing, and vice versa.
  useEffect(() => {
    if (client && !serviceLine) setServiceLine(client.serviceLine);
  }, [client, serviceLine]);

  // Choosing a jurisdiction is also choosing a county; prefilling it saves a
  // field and keeps the two consistent.
  useEffect(() => {
    if (!creatingProject || !jurisdiction) return;
    setProjectForm((f) => (f.county.trim() ? f : { ...f, county: jurisdiction.county }));
  }, [creatingProject, jurisdiction]);

  const effectiveServiceLine: ServiceLine = serviceLine || client?.serviceLine || 'EXPEDITING';
  const managed = effectiveServiceLine === 'MANAGED_LICENSE';

  // --- requirements preview ------------------------------------------------

  const valuationCents = creatingProject
    ? dollarsToCents(Number(projectForm.valuationDollars) || 0)
    : (existingProject?.valuationCents ?? 0);

  const requirements = useMemo<RequirementItem[]>(() => {
    if (!jurisdiction) return [];
    const project = creatingProject
      ? {
          valuationCents,
          ownerBuilder: projectForm.ownerBuilder,
          floodZone: projectForm.floodZone.trim() || null,
          coastalConstructionControlLine: projectForm.coastalConstructionControlLine,
        }
      : existingProject
        ? {
            valuationCents: existingProject.valuationCents,
            ownerBuilder: existingProject.ownerBuilder,
            floodZone: existingProject.floodZone,
            coastalConstructionControlLine: existingProject.coastalConstructionControlLine,
          }
        : null;
    if (!project) return [];
    // The firm override layer lives server-side and is applied at filing time,
    // so this preview is base + permit type + conditional. Said plainly below
    // rather than presented as the whole list.
    return buildRequirements({ permitType, jurisdiction, project });
  }, [jurisdiction, creatingProject, existingProject, permitType, valuationCents, projectForm]);

  // --- validity ------------------------------------------------------------

  const filingHold = !!client?.filingHold;
  const clearedToFile = !!verdict?.clearedToFile;
  const complianceKnown = !!verdict;
  const complianceBlocked = !!client && complianceKnown && (!clearedToFile || filingHold);

  const projectReady = creatingProject
    ? !!projectForm.name.trim() &&
      !!projectForm.addressLine1.trim() &&
      !!projectForm.city.trim() &&
      !!projectForm.county.trim() &&
      !!projectForm.zip.trim() &&
      !!projectForm.jurisdictionId
    : !!existingProject;

  const blockers: string[] = [];
  if (!canCreate) blockers.push('Your role does not allow: permit:create.');
  if (!client) blockers.push('Choose the contractor this permit is filed under.');
  if (client && complianceQ.isError) {
    blockers.push(`Could not read ${client.name}'s compliance, so nothing here can be cleared to file. Retry above.`);
  } else if (client && !complianceKnown) {
    blockers.push(`Checking ${client.name}'s licence and insurance…`);
  } else if (client && filingHold) {
    blockers.push(`${client.name} is on a filing hold: ${client.filingHoldReason ?? 'no reason recorded'}.`);
  } else if (client && !clearedToFile) {
    blockers.push(`${client.name} is not cleared to file — see the blocking gaps above.`);
  }
  if (!projectReady) blockers.push('Pick an existing project or fill in the new one, including its jurisdiction.');
  if (managed && !qualifyingAgentId) blockers.push('A managed-licence permit needs a qualifying agent.');
  if (managed && !supervisorUserId) blockers.push('A managed-licence permit needs a supervising project manager.');

  const canSubmit = blockers.length === 0;

  // --- submit --------------------------------------------------------------

  const submit = useMutation({
    mutationFn: async (): Promise<Permit> => {
      let targetProjectId = projectId;

      if (creatingProject) {
        const created = await post<Project>('/projects', {
          clientId,
          name: projectForm.name.trim(),
          addressLine1: projectForm.addressLine1.trim(),
          city: projectForm.city.trim(),
          county: projectForm.county.trim(),
          zip: projectForm.zip.trim(),
          jurisdictionId: projectForm.jurisdictionId,
          parcelId: projectForm.parcelId.trim() || null,
          // Integer cents. The dollars in the input are converted here, at the
          // edge, and nowhere else.
          valuationCents,
          ownerBuilder: projectForm.ownerBuilder,
          floodZone: projectForm.floodZone.trim() || null,
          coastalConstructionControlLine: projectForm.coastalConstructionControlLine,
        });
        targetProjectId = created.id;
      }

      const result = await post<{ permit: Permit }>('/permits', {
        projectId: targetProjectId,
        permitType,
        serviceLine: effectiveServiceLine,
        agencyRecordId: agencyRecordId.trim() || null,
        qualifyingAgentId: managed ? qualifyingAgentId : null,
        supervisorUserId: supervisorUserId || null,
      });
      return result.permit;
    },
    onMutate: () => {
      setBlockingGaps(null);
      setSupervisionGaps(null);
      setSubmitError(null);
    },
    onSuccess: (permit) => navigate(`/permits/${permit.id}`),
    onError: (err) => {
      // The two 409s carry the exact thing to chase. A generic toast here would
      // throw away the only part of the response worth reading.
      const code = errorCode(err);
      const details = err instanceof ApiError ? (err.details as Record<string, unknown> | undefined) : undefined;
      if (code === 'not_cleared_to_file') {
        setBlockingGaps((details?.blockingGaps as ComplianceGap[] | undefined) ?? []);
      } else if (code === 'supervision_not_defensible') {
        setSupervisionGaps((details?.gaps as SupervisionGap[] | undefined) ?? []);
      }
      setSubmitError(errorMessage(err));
    },
  });

  // --- render --------------------------------------------------------------

  if (clientsQ.isLoading) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">New permit</h1>
        <LoadingPanel label="Loading contractors…" rows={4} />
      </div>
    );
  }

  if (clientsQ.isError) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">New permit</h1>
        <ErrorState
          error={clientsQ.error}
          onRetry={() => void clientsQ.refetch()}
          title="Could not load the contractor book"
        />
      </div>
    );
  }

  if (clients.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">New permit</h1>
        <div className="card">
          <EmptyState
            title="No contractors on the book yet"
            hint="A permit is filed under a contractor, so there has to be one first. Create the contractor, get their licence and insurance on file, then come back here."
            action={
              user && can(user.role, 'client:create') ? (
                <Link to="/clients" className="btn-primary">
                  Go to contractors
                </Link>
              ) : undefined
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-5">
      <div>
        <h1 className="text-xl font-semibold">New permit</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Everything on one page. The compliance gate below is the same check the API runs when you press file, so what
          you see here is what will happen.
        </p>
      </div>

      {!canCreate && (
        <div className="rounded-md border border-line bg-page px-4 py-3 text-[13px] text-ink-soft leading-relaxed">
          Your role is read-only for filings. You can work through this form to see what a permit would require, but the
          file button stays disabled.
        </div>
      )}

      {/* --- 1. Contractor ------------------------------------------------- */}
      <Section
        n={1}
        title="Contractor"
        hint="Who the permit is filed under. Their compliance decides whether it can be filed at all."
      >
        {pinnedClientId ? (
          <div className="rounded-md bg-page px-3 py-2.5 text-[13px]">
            <span className="text-ink-mute">Filing under </span>
            <span className="font-medium">{client?.name ?? 'your company'}</span>
          </div>
        ) : (
          <Field label="Contractor" required>
            <select
              className="input"
              value={clientId}
              onChange={(e) => {
                setClientId(e.target.value);
                setProjectId('');
                setServiceLine('');
                setBlockingGaps(null);
              }}
            >
              <option value="">Choose a contractor…</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.filingHold ? ' — on filing hold' : ''}
                </option>
              ))}
            </select>
          </Field>
        )}

        {clientId && complianceQ.isLoading && <Spinner label="Checking compliance…" className="mt-3" />}
        {clientId && complianceQ.isError && (
          <div className="mt-3">
            <ErrorState
              error={complianceQ.error}
              onRetry={() => void complianceQ.refetch()}
              title="Could not read this contractor's compliance"
              compact
            />
          </div>
        )}

        {client && verdict && !complianceQ.isLoading && (
          <ComplianceVerdictPanel client={client} verdict={verdict} />
        )}
      </Section>

      {/* --- 2. Project ---------------------------------------------------- */}
      <Section n={2} title="Project" hint="The job site. Its address decides the building department, and every permit on it inherits that.">
        {!clientId ? (
          <p className="text-[13px] text-ink-mute">Choose a contractor first — projects belong to one.</p>
        ) : (
          <>
            {projectsQ.isLoading && <Spinner label="Loading projects…" />}
            {projectsQ.isError && (
              <ErrorState error={projectsQ.error} onRetry={() => void projectsQ.refetch()} compact title="Could not load projects" />
            )}
            {!projectsQ.isLoading && (
              <Field label="Project" required>
                <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  <option value="">Choose a project…</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {p.addressLine1}, {p.city}
                    </option>
                  ))}
                  <option value={NEW_PROJECT}>+ New project</option>
                </select>
                {projects.length === 0 && !projectsQ.isLoading && (
                  <span className="mt-1 block text-[12px] text-ink-mute leading-snug">
                    {client?.name ?? 'This contractor'} has no projects yet — choose “New project” to create the first one
                    inline.
                  </span>
                )}
              </Field>
            )}

            {existingProject && (
              <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 rounded-md bg-page px-3 py-2.5 text-[13px]">
                <Fact label="Address">
                  {existingProject.addressLine1}, {existingProject.city} {existingProject.zip}
                </Fact>
                <Fact label="County">{existingProject.county}</Fact>
                <Fact label="Valuation">{formatCents(existingProject.valuationCents)}</Fact>
                <Fact label="Parcel">{existingProject.parcelId ?? '—'}</Fact>
                <Fact label="Flood zone">{existingProject.floodZone ?? 'Not recorded'}</Fact>
                <Fact label="Owner-builder">{existingProject.ownerBuilder ? 'Yes' : 'No'}</Fact>
                <Fact label="Seaward of the CCCL">
                  {existingProject.coastalConstructionControlLine ? 'Yes' : 'No'}
                </Fact>
              </dl>
            )}

            {creatingProject && (
              <div className="mt-4 space-y-3 border-t border-line pt-4">
                <Field label="Project name" required hint="What a coordinator will recognise on the board — usually the address or the client's job name.">
                  <input
                    className="input"
                    value={projectForm.name}
                    onChange={(e) => setProjectForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder="Whitfield residence — re-roof"
                  />
                </Field>

                <Field label="Street address" required>
                  <input
                    className="input"
                    value={projectForm.addressLine1}
                    onChange={(e) => setProjectForm((f) => ({ ...f, addressLine1: e.target.value }))}
                    placeholder="1420 Bayshore Blvd"
                  />
                </Field>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <Field label="City" required>
                    <input
                      className="input"
                      value={projectForm.city}
                      onChange={(e) => setProjectForm((f) => ({ ...f, city: e.target.value }))}
                    />
                  </Field>
                  <Field label="County" required>
                    <input
                      className="input"
                      value={projectForm.county}
                      onChange={(e) => setProjectForm((f) => ({ ...f, county: e.target.value }))}
                    />
                  </Field>
                  <Field label="ZIP" required>
                    <input
                      className="input"
                      value={projectForm.zip}
                      onChange={(e) => setProjectForm((f) => ({ ...f, zip: e.target.value }))}
                    />
                  </Field>
                </div>

                <Field
                  label="Jurisdiction"
                  required
                  hint="The building department that will actually review this. Pick it from the 119 Florida records — a free-text authority is how a filing goes missing."
                >
                  {jurisdictionsQ.isLoading ? (
                    <Spinner label="Loading jurisdictions…" />
                  ) : jurisdictionsQ.isError ? (
                    <ErrorState error={jurisdictionsQ.error} compact title="Could not load jurisdictions" />
                  ) : (
                    <select
                      className="input"
                      value={projectForm.jurisdictionId}
                      onChange={(e) => setProjectForm((f) => ({ ...f, jurisdictionId: e.target.value }))}
                    >
                      <option value="">Choose a jurisdiction…</option>
                      {jurisdictions.map((j) => (
                        <option key={j.id} value={j.id}>
                          {j.name} ({j.county})
                        </option>
                      ))}
                    </select>
                  )}
                </Field>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field label="Parcel ID" hint="Folio or parcel number from the property appraiser.">
                    <input
                      className="input"
                      value={projectForm.parcelId}
                      onChange={(e) => setProjectForm((f) => ({ ...f, parcelId: e.target.value }))}
                    />
                  </Field>
                  <Field
                    label="Valuation (US$)"
                    hint={
                      valuationCents >= 250_000_00
                        ? 'Over $250,000 — this adds a Notice of Commencement and a threshold inspection line to the checklist.'
                        : 'Job value in dollars. Stored as integer cents.'
                    }
                  >
                    <input
                      className="input tabular-nums"
                      inputMode="decimal"
                      value={projectForm.valuationDollars}
                      onChange={(e) => setProjectForm((f) => ({ ...f, valuationDollars: e.target.value }))}
                      placeholder="48000"
                    />
                  </Field>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field label="FEMA flood zone" hint="Leave blank if unknown; “X” means no special flood hazard.">
                    <input
                      className="input"
                      value={projectForm.floodZone}
                      onChange={(e) => setProjectForm((f) => ({ ...f, floodZone: e.target.value }))}
                      placeholder="AE"
                    />
                  </Field>
                  <div className="space-y-2 pt-5">
                    <Check
                      checked={projectForm.ownerBuilder}
                      onChange={(v) => setProjectForm((f) => ({ ...f, ownerBuilder: v }))}
                      label="Owner-builder permit"
                      hint="Adds the F.S. 489.103(7) disclosure affidavit, usually signed in person."
                    />
                    <Check
                      checked={projectForm.coastalConstructionControlLine}
                      onChange={(v) => setProjectForm((f) => ({ ...f, coastalConstructionControlLine: v }))}
                      label="Seaward of the Coastal Construction Control Line"
                      hint="Requires a state DEP authorization before the local permit can issue."
                    />
                  </div>
                </div>
              </div>
            )}

            {jurisdiction && <JurisdictionFacts jurisdiction={jurisdiction} />}
          </>
        )}
      </Section>

      {/* --- 3. Permit ----------------------------------------------------- */}
      <Section n={3} title="Permit" hint="What is being filed, and under which service line.">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Permit type" required>
            <select className="input" value={permitType} onChange={(e) => setPermitType(e.target.value as PermitType)}>
              {PERMIT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {humanEnum(t)}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Service line"
            required
            hint={
              client
                ? `${client.name} is on ${SERVICE_LINE_LABELS[client.serviceLine]}. Override only for a genuine one-off.`
                : undefined
            }
          >
            <select
              className="input"
              value={effectiveServiceLine}
              onChange={(e) => setServiceLine(e.target.value as ServiceLine)}
            >
              {SERVICE_LINES.map((s) => (
                <option key={s} value={s}>
                  {SERVICE_LINE_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="mt-3">
          <Field
            label="Agency permit number"
            hint="Only if the agency has already issued one — otherwise leave it blank and the connector or a coordinator will fill it in."
          >
            <input
              className="input font-mono"
              value={agencyRecordId}
              onChange={(e) => setAgencyRecordId(e.target.value)}
              placeholder="BLD-2026-014882"
            />
          </Field>
        </div>

        {managed && (
          <div className="mt-4 rounded-md border border-brand/25 bg-brand-soft/40 px-3 py-3">
            <div className="text-[13px] font-semibold text-brand">Managed licence — both of these are mandatory</div>
            <p className="mt-1 text-[12px] text-ink-soft leading-relaxed">
              On this line our qualifier's licence goes on the permit, which makes us the contractor of record and makes
              supervision a legal obligation — so the permit has to name whose licence it is and which project manager is
              actually walking the job.
            </p>

            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Qualifying agent" required>
                {!isStaff || !canReadSettings ? (
                  <p className="text-[12px] text-ink-mute leading-snug">
                    Only staff can assign a qualifying agent. Ask a coordinator to file this one.
                  </p>
                ) : qualifiersQ.isLoading ? (
                  <Spinner label="Loading qualifiers…" />
                ) : qualifiersQ.isError ? (
                  <ErrorState error={qualifiersQ.error} compact title="Could not load qualifying agents" />
                ) : (
                  <select
                    className="input"
                    value={qualifyingAgentId}
                    onChange={(e) => setQualifyingAgentId(e.target.value)}
                  >
                    <option value="">Choose a qualifying agent…</option>
                    {(qualifiersQ.data?.qualifiers ?? [])
                      .filter((q) => q.active)
                      .map((q) => (
                        <option key={q.id} value={q.id}>
                          {q.name} — {q.licenseType} {q.licenseNumber}
                          {q.overCapacity ? ` (over capacity: ${q.activePermits})` : ''}
                        </option>
                      ))}
                  </select>
                )}
              </Field>

              <Field label="Supervising project manager" required>
                {!isStaff || !canReadUsers ? (
                  <p className="text-[12px] text-ink-mute leading-snug">
                    Only staff can name a supervising PM. Ask a coordinator to file this one.
                  </p>
                ) : usersQ.isLoading ? (
                  <Spinner label="Loading staff…" />
                ) : usersQ.isError ? (
                  <ErrorState error={usersQ.error} compact title="Could not load staff" />
                ) : (
                  <select className="input" value={supervisorUserId} onChange={(e) => setSupervisorUserId(e.target.value)}>
                    <option value="">Choose a project manager…</option>
                    {(usersQ.data?.users ?? [])
                      .filter((u) => u.active && (u.role === 'ADMIN' || u.role === 'PERMIT_TECH'))
                      .map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name} — {u.email}
                        </option>
                      ))}
                  </select>
                )}
              </Field>
            </div>

            {(qualifiersQ.data?.qualifiers ?? []).some((q) => q.id === qualifyingAgentId && q.overCapacity) && (
              <p className="mt-2 text-[12px] text-warn leading-snug">
                This qualifier is already past their own concurrent-permit cap. Capacity nobody can physically supervise
                is the exact pattern regulators look for.
              </p>
            )}
          </div>
        )}
      </Section>

      {/* --- 4. Requirements ------------------------------------------------ */}
      <Section
        n={4}
        title="Document checklist"
        hint="Composed from what you have selected so far, before anything is committed."
      >
        <RequirementsPreview requirements={requirements} hasJurisdiction={!!jurisdiction} />
      </Section>

      {/* --- 5. File -------------------------------------------------------- */}
      <div className="card card-pad space-y-3">
        {complianceBlocked && client && (
          <div className="rounded-md border border-danger/25 bg-danger-soft px-3 py-2.5">
            <div className="text-[13px] font-semibold text-danger">
              {filingHold
                ? `${client.name} is on a filing hold — nothing can be filed under them`
                : `${client.name} is not cleared to file`}
            </div>
            <p className="mt-1 text-[12px] text-ink-soft leading-relaxed">
              {filingHold
                ? (client.filingHoldReason ?? 'No reason was recorded when the hold was placed.')
                : 'The API refuses this filing for the same reason. Clear the blocking items above and the button switches on by itself.'}
            </p>
          </div>
        )}

        {blockingGaps && blockingGaps.length > 0 && (
          <div className="rounded-md border border-danger/25 bg-danger-soft px-3 py-2.5">
            <div className="text-[13px] font-semibold text-danger">The filing gate refused this permit</div>
            <ul className="mt-1.5 space-y-1">
              {blockingGaps.map((g) => (
                <li key={g.kind} className="text-[12px] leading-snug">
                  <span className="font-semibold">{g.label}</span> — {g.detail}
                </li>
              ))}
            </ul>
          </div>
        )}

        {supervisionGaps && supervisionGaps.length > 0 && (
          <div className="rounded-md border border-danger/25 bg-danger-soft px-3 py-2.5">
            <div className="text-[13px] font-semibold text-danger">The supervision record does not support this filing</div>
            <ul className="mt-1.5 space-y-1">
              {supervisionGaps.map((g, i) => (
                <li key={i} className="text-[12px] leading-snug">
                  <span className={g.severity === 'blocking' ? 'font-semibold text-danger' : 'text-warn'}>
                    {g.severity === 'blocking' ? 'Blocking' : 'Warning'}
                  </span>{' '}
                  — {g.detail}
                </li>
              ))}
            </ul>
          </div>
        )}

        {submitError && !blockingGaps && !supervisionGaps && (
          <ErrorState error={submitError} title="Could not file this permit" compact />
        )}

        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            {blockers.length > 0 ? (
              <ul className="space-y-0.5">
                {blockers.map((b, i) => (
                  <li key={i} className="text-[12px] text-ink-soft leading-snug">
                    {b}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12px] text-ink-soft leading-snug">
                The permit starts in Draft. Nothing is sent to {jurisdiction?.name ?? 'the agency'} until you advance it.
              </p>
            )}
          </div>
          <div className="flex gap-2 shrink-0">
            <Link to="/pipeline" className="btn-ghost">
              Cancel
            </Link>
            <button
              type="button"
              className="btn-primary"
              disabled={!canSubmit || submit.isPending}
              onClick={() => submit.mutate()}
            >
              {submit.isPending ? 'Filing…' : 'Create permit'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compliance verdict
// ---------------------------------------------------------------------------

function ComplianceVerdictPanel({
  client,
  verdict,
}: {
  client: Client;
  verdict: ComplianceVerdict;
}) {
  const blocking = verdict.gaps.filter((g) => g.blocksFiling);
  const warnings = verdict.gaps.filter((g) => !g.blocksFiling);
  const cleared = verdict.clearedToFile && !client.filingHold;

  return (
    <div className={`mt-4 rounded-md border px-3 py-3 ${cleared ? 'border-good/25 bg-good-soft/40' : 'border-danger/25 bg-danger-soft'}`}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className={`text-[13px] font-semibold ${cleared ? 'text-good' : 'text-danger'}`}>
            {client.filingHold
              ? 'On filing hold — nothing can be filed'
              : verdict.clearedToFile
                ? 'Cleared to file'
                : 'Not cleared to file'}
          </div>
          <p className="mt-0.5 text-[12px] text-ink-soft leading-snug">
            {client.filingHold
              ? (client.filingHoldReason ?? 'No reason recorded. A coordinator has to lift the hold.')
              : verdict.clearedToFile
                ? 'Licence and insurance on file are current. This filing will pass the gate.'
                : `${blocking.length} blocking item${blocking.length === 1 ? '' : 's'} between this contractor and a filing.`}
          </p>
        </div>
        <Meter
          value={verdict.completeness}
          label="Paperwork complete"
          tone={cleared ? undefined : 'danger'}
          className="w-56"
        />
      </div>

      {blocking.length > 0 && (
        <div className="mt-3">
          <div className="label text-danger">Blocking — file cannot proceed</div>
          <ul className="mt-1.5 space-y-1.5">
            {blocking.map((g) => (
              <GapLine key={g.kind} gap={g} />
            ))}
          </ul>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="mt-3">
          <div className="label">Worth chasing — does not block this filing</div>
          <ul className="mt-1.5 space-y-1.5">
            {warnings.map((g) => (
              <GapLine key={g.kind} gap={g} />
            ))}
          </ul>
        </div>
      )}

      {verdict.nextExpiry && (
        <p className="mt-3 text-[12px] text-ink-soft leading-snug">
          Next thing to expire: {verdict.nextExpiry.kind.toLowerCase().replace(/_/g, ' ')} in{' '}
          {verdict.nextExpiry.days} day{verdict.nextExpiry.days === 1 ? '' : 's'}.
        </p>
      )}

      <Link to={`/clients/${client.id}`} className="link mt-3 inline-block text-[12px]">
        Open {client.name}'s compliance file
      </Link>
    </div>
  );
}

/** One gap, phrased so a coordinator can read it straight down the phone. */
function GapLine({ gap }: { gap: ComplianceGap }) {
  return (
    <li className="flex items-start gap-2">
      <ComplianceBadge status={gap.status} className="mt-0.5 shrink-0" />
      <span className="text-[12px] leading-snug">
        <span className="font-semibold">{gap.label}</span> — {gap.detail}
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Jurisdiction facts
// ---------------------------------------------------------------------------

function JurisdictionFacts({ jurisdiction: j }: { jurisdiction: Jurisdiction }) {
  const route = filingRoute(j);
  const routeClass = route.tone === 'good' ? 'badge-green' : route.tone === 'warn' ? 'badge-amber' : 'badge-gray';

  return (
    <div className="mt-4 rounded-md border border-line bg-page px-3 py-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-[13px] font-semibold">{j.name}</div>
        <div className="flex flex-wrap gap-1">
          {j.hvhz && <span className="badge-amber">HVHZ</span>}
          {j.windBorneDebris && !j.hvhz && <span className="badge-amber">Wind-borne debris</span>}
          {j.paperOnly && <span className="badge-red">Paper only</span>}
          <span className={routeClass}>{route.label}</span>
        </div>
      </div>

      <dl className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-6 text-[13px]">
        <Fact label="Platform">{humanEnum(j.platform)}</Fact>
        <Fact label="Integration tier">{humanEnum(j.integrationTier)}</Fact>
        <Fact label="Design wind speed">
          {j.designWindSpeedMph != null ? `${j.designWindSpeedMph} mph ultimate` : 'Not verified'}
        </Fact>
        <Fact label="Median review">
          {j.medianReviewDays != null ? `${j.medianReviewDays}d over ${j.reviewSampleSize} filings` : 'No measured sample yet'}
        </Fact>
        <Fact label="Portal">
          {j.portalUrl ? (
            <a href={j.portalUrl} target="_blank" rel="noreferrer noopener" className="link break-all">
              {j.portalUrl}
            </a>
          ) : (
            // We do not invent URLs. An unverified portal is said out loud,
            // because quoting a timeline against a URL nobody has opened is how
            // a filing goes missing for a week.
            <span className="text-warn">Not verified — confirm by phone{j.contactPhone ? ` (${j.contactPhone})` : ''}</span>
          )}
        </Fact>
        <Fact label="Portal URL confidence">{humanEnum(j.portalUrlConfidence)}</Fact>
      </dl>

      <p className="mt-2 text-[12px] text-ink-soft leading-relaxed">
        <span className="font-semibold text-ink">How we file here:</span> {route.detail}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Requirements preview
// ---------------------------------------------------------------------------

const SOURCE_LABEL: Record<RequirementItem['source'], string> = {
  base: 'Every permit',
  permit_type: 'This permit type',
  conditional: 'Conditional',
  override: 'Learned from a correction',
};

const SOURCE_CLASS: Record<RequirementItem['source'], string> = {
  base: 'badge-gray',
  permit_type: 'badge-blue',
  conditional: 'badge-amber',
  override: 'badge-green',
};

function RequirementsPreview({
  requirements,
  hasJurisdiction,
}: {
  requirements: RequirementItem[];
  hasJurisdiction: boolean;
}) {
  const required = requirements.filter((r) => r.required);
  const optional = requirements.filter((r) => !r.required);

  if (!hasJurisdiction) {
    return (
      <EmptyState
        title="Nothing to compose yet"
        hint="Pick a project — or a jurisdiction on the new one — and the full checklist appears here before you commit to anything."
        compact
      />
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-[12px] text-ink-soft leading-relaxed">
        {required.length} required and {optional.length} optional item{optional.length === 1 ? '' : 's'} from the base
        layer, this permit type, and the conditions on this project. Anything the firm has learned from a correction in
        this jurisdiction is added server-side when the permit is created, so the real checklist can only grow from here.
      </p>

      <RequirementGroup title={`Required (${required.length})`} items={required} />
      {optional.length > 0 && <RequirementGroup title={`Optional (${optional.length})`} items={optional} />}
    </div>
  );
}

function RequirementGroup({ title, items }: { title: string; items: RequirementItem[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="label">{title}</div>
      <ul className="mt-1.5 divide-y divide-line border-t border-line">
        {items.map((r) => (
          <li key={r.key} className="py-2.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[13px] font-medium">{r.label}</span>
              <span className={SOURCE_CLASS[r.source]}>{SOURCE_LABEL[r.source]}</span>
              <span className="font-mono text-[11px] text-ink-mute">{r.key}</span>
            </div>
            {r.detail && <div className="mt-0.5 text-[12px] text-ink-soft leading-snug">{r.detail}</div>}
            {r.because && (
              <div className="mt-1 text-[12px] text-ink-soft leading-snug">
                <span className="font-semibold text-ink">Why:</span> {r.because}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

function Section({
  n,
  title,
  hint,
  children,
}: {
  n: number;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="card card-pad">
      <div className="flex items-baseline gap-2">
        <span className="label tabular-nums">{n}</span>
        <h2 className="text-base font-semibold">{title}</h2>
      </div>
      {hint && <p className="mt-0.5 text-[12px] text-ink-soft leading-snug">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Field({
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

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-[12px] text-ink-mute shrink-0">{label}</dt>
      <dd className="text-[13px] text-right min-w-0">{children}</dd>
    </div>
  );
}

import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  SERVICE_LINES,
  SERVICE_LINE_LABELS,
  TERMINAL_STAGES,
  assessCompliance,
  can,
  formatCents,
  type Client,
  type ComplianceVerdict,
  type ServiceLine,
} from '@flph/shared';
import { get, post } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import type { ClientListResponse, ComplianceListResponse, InvoiceListResponse } from '../lib/api-shapes.ts';
import type { PermitListResponse } from '../lib/types.ts';
import DataTable, { type Column } from '../components/DataTable.tsx';
import Drawer from '../components/Drawer.tsx';
import EmptyState from '../components/EmptyState.tsx';
import ErrorState, { errorMessage } from '../components/ErrorState.tsx';
import KpiCard from '../components/KpiCard.tsx';
import Meter from '../components/Meter.tsx';
import { LoadingPanel } from '../components/Spinner.tsx';

/**
 * The contractor book.
 *
 * The column that decides whether a row needs attention is "cleared to file",
 * and it is not stored anywhere — it is `assessCompliance` run over the
 * documents we actually hold, the same function the permit-creation gate uses.
 * Computing it here rather than reading a flag means this screen and the gate
 * can never disagree, which matters because the whole value of the column is
 * that it predicts what happens when somebody tries to file tomorrow.
 */

const ONBOARDING_STATUSES = ['INVITED', 'IN_PROGRESS', 'PENDING_REVIEW', 'ACTIVE', 'SUSPENDED'] as const;
type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

const ONBOARDING_LABELS: Record<OnboardingStatus, string> = {
  INVITED: 'Invited',
  IN_PROGRESS: 'Onboarding',
  PENDING_REVIEW: 'Pending review',
  ACTIVE: 'Active',
  SUSPENDED: 'Suspended',
};

const ONBOARDING_CLASS: Record<OnboardingStatus, string> = {
  INVITED: 'badge-gray',
  IN_PROGRESS: 'badge-blue',
  PENDING_REVIEW: 'badge-amber',
  ACTIVE: 'badge-green',
  SUSPENDED: 'badge-red',
};

interface Row {
  client: Client;
  verdict: ComplianceVerdict;
  openPermits: number;
  outstandingCents: number;
}

interface Filters {
  serviceLine: string;
  onboardingStatus: string;
  notCleared: boolean;
  q: string;
}

const EMPTY: Filters = { serviceLine: '', onboardingStatus: '', notCleared: false, q: '' };

export default function Contractors() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [inviteOpen, setInviteOpen] = useState(false);

  const canCreate = !!user && can(user.role, 'client:create');

  const clientsQ = useQuery({
    queryKey: ['clients'],
    queryFn: () => get<ClientListResponse>('/clients'),
  });

  // Whole-book compliance in one call. The verdict is derived per contractor
  // below rather than requested per row — 60 contractors is 60 requests.
  const complianceQ = useQuery({
    queryKey: ['compliance', 'all'],
    queryFn: () => get<ComplianceListResponse>('/compliance'),
  });

  const permitsQ = useQuery({
    queryKey: ['permits'],
    queryFn: () => get<PermitListResponse>('/permits'),
  });

  const invoicesQ = useQuery({
    queryKey: ['invoices'],
    queryFn: () => get<InvoiceListResponse>('/billing/invoices'),
  });

  const rows = useMemo<Row[]>(() => {
    const clients = clientsQ.data?.clients ?? [];
    const items = complianceQ.data?.items ?? [];
    const permits = permitsQ.data?.permits ?? [];
    const invoices = invoicesQ.data?.invoices ?? [];

    const openByClient = new Map<string, number>();
    for (const p of permits) {
      if (TERMINAL_STAGES.includes(p.stage)) continue;
      openByClient.set(p.clientId, (openByClient.get(p.clientId) ?? 0) + 1);
    }

    const owedByClient = new Map<string, number>();
    for (const inv of invoices) {
      if (inv.status !== 'SENT' && inv.status !== 'PARTIAL' && inv.status !== 'OVERDUE') continue;
      const bal = Math.max(0, inv.totalCents - inv.amountPaidCents);
      owedByClient.set(inv.clientId, (owedByClient.get(inv.clientId) ?? 0) + bal);
    }

    return clients.map((client) => ({
      client,
      verdict: assessCompliance(items.filter((i) => i.clientId === client.id)),
      openPermits: openByClient.get(client.id) ?? 0,
      outstandingCents: owedByClient.get(client.id) ?? 0,
    }));
  }, [clientsQ.data, complianceQ.data, permitsQ.data, invoicesQ.data]);

  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        if (filters.serviceLine && r.client.serviceLine !== filters.serviceLine) return false;
        if (filters.onboardingStatus && r.client.onboardingStatus !== filters.onboardingStatus) return false;
        if (filters.notCleared && r.verdict.clearedToFile && !r.client.filingHold) return false;
        if (filters.q) {
          const q = filters.q.toLowerCase();
          const hay = [r.client.name, r.client.legalName, r.client.contactEmail, r.client.licenseNumber]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      }),
    [rows, filters],
  );

  const blocked = rows.filter((r) => !r.verdict.clearedToFile || r.client.filingHold).length;
  const managed = rows.filter((r) => r.client.serviceLine === 'MANAGED_LICENSE').length;
  const totalOwed = rows.reduce((s, r) => s + r.outstandingCents, 0);

  const columns: Array<Column<Row>> = useMemo(
    () => [
      {
        key: 'name',
        header: 'Contractor',
        sortValue: (r) => r.client.name,
        render: (r) => (
          <div className="min-w-[190px]">
            <Link to={`/clients/${r.client.id}`} className="font-medium text-brand hover:underline">
              {r.client.name}
            </Link>
            <div className="text-[12px] text-ink-mute truncate">
              {r.client.licenseNumber ? `${r.client.licenseType ?? 'Licence'} ${r.client.licenseNumber}` : 'No licence on file'}
            </div>
          </div>
        ),
      },
      {
        key: 'line',
        header: 'Service line',
        sortValue: (r) => r.client.serviceLine,
        render: (r) => (
          <span className={r.client.serviceLine === 'MANAGED_LICENSE' ? 'badge-blue' : 'badge-gray'}>
            {r.client.serviceLine === 'MANAGED_LICENSE' ? 'Managed licence' : 'Expediting'}
          </span>
        ),
      },
      {
        key: 'onboarding',
        header: 'Onboarding',
        sortValue: (r) => r.client.onboardingStatus,
        render: (r) => (
          <span className={ONBOARDING_CLASS[r.client.onboardingStatus]}>
            {ONBOARDING_LABELS[r.client.onboardingStatus]}
          </span>
        ),
      },
      {
        key: 'completeness',
        header: 'Compliance',
        sortValue: (r) => r.verdict.completeness,
        render: (r) => (
          <div className="min-w-[130px]">
            <Meter
              value={r.verdict.completeness}
              size="sm"
              tone={r.verdict.clearedToFile ? undefined : 'danger'}
            />
            <div className="mt-1 text-[11px] text-ink-mute leading-snug">
              {r.verdict.gaps.length === 0
                ? 'Everything current'
                : `${r.verdict.gaps.length} gap${r.verdict.gaps.length === 1 ? '' : 's'}`}
            </div>
          </div>
        ),
      },
      {
        key: 'cleared',
        header: 'Cleared to file',
        sortValue: (r) => (r.client.filingHold ? 0 : r.verdict.clearedToFile ? 2 : 1),
        render: (r) => {
          if (r.client.filingHold) return <span className="badge-red">On filing hold</span>;
          return r.verdict.clearedToFile ? (
            <span className="badge-green">Yes</span>
          ) : (
            <span
              className="badge-red"
              title={r.verdict.gaps.filter((g) => g.blocksFiling).map((g) => `${g.label}: ${g.detail}`).join('\n')}
            >
              No
            </span>
          );
        },
      },
      {
        key: 'permits',
        header: 'Open permits',
        align: 'right',
        sortValue: (r) => r.openPermits,
        render: (r) => <span className="tabular-nums">{r.openPermits || '—'}</span>,
      },
      {
        key: 'balance',
        header: 'Outstanding',
        align: 'right',
        sortValue: (r) => r.outstandingCents,
        render: (r) => (
          <span className={`tabular-nums ${r.outstandingCents > 0 ? 'font-medium' : 'text-ink-mute'}`}>
            {r.outstandingCents > 0 ? formatCents(r.outstandingCents) : '—'}
          </span>
        ),
      },
      {
        key: 'hold',
        header: 'Filing hold',
        sortValue: (r) => (r.client.filingHold ? 1 : 0),
        render: (r) =>
          r.client.filingHold ? (
            <span className="text-[12px] text-danger leading-snug block max-w-[220px]">
              {r.client.filingHoldReason ?? 'Held — no reason recorded'}
            </span>
          ) : (
            <span className="text-ink-mute">—</span>
          ),
      },
    ],
    [],
  );

  const loading = clientsQ.isLoading || complianceQ.isLoading;
  const error = clientsQ.error ?? complianceQ.error;

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold">Contractors</h1>
          <p className="mt-1 text-sm text-ink-soft">
            {filtered.length} of {rows.length} account{rows.length === 1 ? '' : 's'} · cleared-to-file is computed live
            from the certificates on file, not a stored flag.
          </p>
        </div>
        {canCreate && (
          <button type="button" className="btn-primary" onClick={() => setInviteOpen(true)}>
            Invite contractor
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <KpiCard label="Contractors" value={rows.length} hint="Every account on the book, both service lines." />
        <KpiCard
          label="Not cleared to file"
          value={blocked}
          accent={blocked > 0 ? 'danger' : 'none'}
          hint="Blocking compliance gap or an active filing hold. New permits will be refused."
        />
        <KpiCard
          label="Managed licence"
          value={managed}
          hint="Our qualifier is contractor of record — supervision evidence is mandatory on these."
        />
        <KpiCard
          label="Outstanding"
          value={formatCents(totalOwed)}
          hint="Billed and uncollected across sent, partial and overdue invoices."
          to="/invoices"
        />
      </div>

      <div className="card card-pad">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
          <div>
            <label className="label" htmlFor="c-line">Service line</label>
            <select
              id="c-line"
              className="input mt-1"
              value={filters.serviceLine}
              onChange={(e) => setFilters((f) => ({ ...f, serviceLine: e.target.value }))}
            >
              <option value="">Both lines</option>
              {SERVICE_LINES.map((s) => (
                <option key={s} value={s}>
                  {SERVICE_LINE_LABELS[s as ServiceLine]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="c-status">Onboarding status</label>
            <select
              id="c-status"
              className="input mt-1"
              value={filters.onboardingStatus}
              onChange={(e) => setFilters((f) => ({ ...f, onboardingStatus: e.target.value }))}
            >
              <option value="">Any status</option>
              {ONBOARDING_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {ONBOARDING_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="c-q">Search</label>
            <input
              id="c-q"
              className="input mt-1"
              placeholder="Name, email, licence…"
              value={filters.q}
              onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
            />
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-sm pb-2">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-line text-brand focus:ring-brand/30"
                checked={filters.notCleared}
                onChange={(e) => setFilters((f) => ({ ...f, notCleared: e.target.checked }))}
              />
              Not cleared to file
            </label>
          </div>
        </div>
        {(filters.serviceLine || filters.onboardingStatus || filters.q || filters.notCleared) && (
          <button type="button" className="link mt-3 text-[13px]" onClick={() => setFilters(EMPTY)}>
            Clear filters
          </button>
        )}
      </div>

      {error && <ErrorState error={error} onRetry={() => void clientsQ.refetch()} title="Could not load the contractor book" />}
      {loading && !error && <LoadingPanel label="Loading contractors…" rows={5} />}

      {!loading && !error && (
        <DataTable<Row>
          columns={columns}
          rows={filtered}
          rowKey={(r) => r.client.id}
          initialSort={{ key: 'name', dir: 'asc' }}
          onRowClick={(r) => navigate(`/clients/${r.client.id}`)}
          rowClassName={(r) => (r.client.filingHold || !r.verdict.clearedToFile ? 'bg-danger-soft/30' : '')}
          empty={
            rows.length === 0 ? (
              <EmptyState
                title="No contractors yet"
                hint="A contractor record is what permits, compliance documents, invoices and portal accounts hang off. Create the first one and the onboarding checklist opens from their detail page."
                action={
                  canCreate ? (
                    <button type="button" className="btn-primary" onClick={() => setInviteOpen(true)}>
                      Invite contractor
                    </button>
                  ) : undefined
                }
              />
            ) : (
              <EmptyState
                title="No contractors match these filters"
                hint="Widen the service line or onboarding status, or clear the search box."
                action={
                  <button type="button" className="btn-ghost" onClick={() => setFilters(EMPTY)}>
                    Clear filters
                  </button>
                }
              />
            )
          }
          footer={
            complianceQ.isError
              ? 'Compliance could not be loaded, so the cleared-to-file column is not trustworthy on this render.'
              : `${filtered.length} contractor${filtered.length === 1 ? '' : 's'}`
          }
        />
      )}

      {canCreate && <InviteDrawer open={inviteOpen} onClose={() => setInviteOpen(false)} />}
    </div>
  );
}

// --------------------------------------------------------------------------
// Invite
// --------------------------------------------------------------------------

function InviteDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const canInviteUser = !!user && can(user.role, 'user:invite');

  const [form, setForm] = useState({
    name: '',
    legalName: '',
    contactName: '',
    contactEmail: '',
    contactPhone: '',
    serviceLine: 'EXPEDITING' as ServiceLine,
    licenseNumber: '',
    licenseType: '',
    createPortalLogin: true,
  });
  const [portalNote, setPortalNote] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: async (): Promise<{ client: Client; portalError: string | null }> => {
      const client = await post<Client>('/clients', {
        name: form.name.trim(),
        legalName: form.legalName.trim() || null,
        contactName: form.contactName.trim() || null,
        contactEmail: form.contactEmail.trim() || null,
        contactPhone: form.contactPhone.trim() || null,
        serviceLine: form.serviceLine,
        licenseNumber: form.licenseNumber.trim() || null,
        licenseType: form.licenseType.trim() || null,
        onboardingStatus: 'INVITED',
      });

      // The portal login is a separate act with its own capability. A failure
      // here must not lose the contractor record that already succeeded, so it
      // is reported rather than thrown.
      let portalError: string | null = null;
      if (form.createPortalLogin && canInviteUser && form.contactEmail.trim()) {
        try {
          await post('/users/invite', {
            email: form.contactEmail.trim(),
            name: form.contactName.trim() || form.name.trim(),
            role: 'CLIENT',
            clientId: client.id,
          });
        } catch (e) {
          portalError = `${form.name.trim()} was created, but the portal invite failed: ${errorMessage(e)}. Send it again from Settings \u2192 Users.`;
        }
      }
      return { client, portalError };
    },
    onSuccess: ({ client, portalError }) => {
      void qc.invalidateQueries({ queryKey: ['clients'] });
      void qc.invalidateQueries({ queryKey: ['users'] });
      setPortalNote(portalError);
      if (!portalError) {
        onClose();
        navigate(`/onboarding/${client.id}`);
      }
    },
  });

  const valid = form.name.trim().length > 0;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Invite a contractor"
      subtitle="Creates the contractor record and, if you have an email for them, a portal login."
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12px] text-ink-soft">They land on the onboarding checklist next.</span>
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
              {create.isPending ? 'Creating…' : 'Create contractor'}
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {create.isError && <ErrorState error={create.error} title="Could not create the contractor" compact />}
        {portalNote && (
          <div className="rounded-md border border-warn/25 bg-warn-soft px-3 py-2 text-[13px] text-warn leading-snug">
            {portalNote}
          </div>
        )}

        <Field label="Trading name" required>
          <input
            className="input"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Gulfstream Roofing"
          />
        </Field>
        <Field label="Legal entity name" hint="Only if it differs from the trading name — this is what goes on agreements.">
          <input
            className="input"
            value={form.legalName}
            onChange={(e) => setForm((f) => ({ ...f, legalName: e.target.value }))}
            placeholder="Gulfstream Roofing LLC"
          />
        </Field>

        <Field label="Service line" required hint="Managed licence puts our qualifier on the permit and makes supervision records mandatory.">
          <select
            className="input"
            value={form.serviceLine}
            onChange={(e) => setForm((f) => ({ ...f, serviceLine: e.target.value as ServiceLine }))}
          >
            {SERVICE_LINES.map((s) => (
              <option key={s} value={s}>
                {SERVICE_LINE_LABELS[s as ServiceLine]}
              </option>
            ))}
          </select>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Contact name">
            <input
              className="input"
              value={form.contactName}
              onChange={(e) => setForm((f) => ({ ...f, contactName: e.target.value }))}
            />
          </Field>
          <Field label="Contact phone">
            <input
              className="input"
              value={form.contactPhone}
              onChange={(e) => setForm((f) => ({ ...f, contactPhone: e.target.value }))}
            />
          </Field>
        </div>

        <Field label="Contact email" hint="Signature requests and the portal invite both go here.">
          <input
            type="email"
            className="input"
            value={form.contactEmail}
            onChange={(e) => setForm((f) => ({ ...f, contactEmail: e.target.value }))}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Licence number" hint={form.serviceLine === 'MANAGED_LICENSE' ? 'Optional — we are the contractor of record.' : undefined}>
            <input
              className="input"
              value={form.licenseNumber}
              onChange={(e) => setForm((f) => ({ ...f, licenseNumber: e.target.value }))}
              placeholder="CCC1234567"
            />
          </Field>
          <Field label="Licence type">
            <input
              className="input"
              value={form.licenseType}
              onChange={(e) => setForm((f) => ({ ...f, licenseType: e.target.value }))}
              placeholder="Certified roofing"
            />
          </Field>
        </div>

        {canInviteUser && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-line text-brand focus:ring-brand/30"
              checked={form.createPortalLogin}
              onChange={(e) => setForm((f) => ({ ...f, createPortalLogin: e.target.checked }))}
              disabled={!form.contactEmail.trim()}
            />
            <span className="leading-snug">
              Also send a portal login to that email.
              <span className="block text-[12px] text-ink-mute">
                A portal account sees only this contractor's own permits, documents and invoices.
              </span>
            </span>
          </label>
        )}
      </div>
    </Drawer>
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

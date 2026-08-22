import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS, can, type Role } from '@flph/shared';
import { get, patch, post } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { fmtDate, fmtDateTime } from '../lib/format.ts';
import type { ClientListResponse, UserListResponse, UserRow } from '../lib/api-shapes.ts';
import DataTable, { type Column } from '../components/DataTable.tsx';
import Drawer from '../components/Drawer.tsx';
import EmptyState from '../components/EmptyState.tsx';
import ErrorState from '../components/ErrorState.tsx';
import KpiCard from '../components/KpiCard.tsx';
import { LoadingPanel } from '../components/Spinner.tsx';

/**
 * Authorization.
 *
 * Every account — staff included — is created PENDING with zero capabilities,
 * so assigning a role is the act that turns a signup into an employee. That
 * makes the pending list the owner's action queue rather than a filter, which
 * is why it sits at the top of the page in its own block instead of being
 * sorted into the table.
 *
 * Two rules are enforced by the API and mirrored here so the UI never offers a
 * control that will be refused: nobody changes their own role, and the last
 * active administrator cannot be demoted or deactivated.
 */

/*
 * Every role except PENDING can be assigned. Deriving this from the shared
 * ROLES tuple rather than restating it means a role added to the enum (and to
 * the API's own /users/roles list, which is built from the same tuple) appears
 * in the dropdown and the legend without a second edit here — the drift that
 * previously hid SITE_SUPERVISOR and ENGINEER from the UI.
 */
const ASSIGNABLE: Role[] = ROLES.filter((r) => r !== 'PENDING');

/*
 * The invite endpoints return `acceptPath` -- a root-relative path. What an
 * administrator needs to paste into an email is an absolute URL, and the page
 * they are on is by definition the right origin, so it is built here rather
 * than asking the API to know its own public address.
 */
function inviteLink(acceptPath: string | null | undefined): string | null {
  return acceptPath ? `${window.location.origin}${acceptPath}` : null;
}

const ROLE_CLASS: Record<Role, string> = {
  ADMIN: 'badge-blue',
  PERMIT_TECH: 'badge-blue',
  SITE_SUPERVISOR: 'badge-blue',
  ENGINEER: 'badge-blue',
  VIEWER: 'badge-gray',
  CLIENT: 'badge-green',
  PENDING: 'badge-amber',
};

export default function Users() {
  const { user } = useAuth();
  const [inviting, setInviting] = useState(false);
  const [search, setSearch] = useState('');

  const canAssign = !!user && can(user.role, 'user:assign_role');
  const canInvite = !!user && can(user.role, 'user:invite');

  const q = useQuery({
    queryKey: ['users'],
    queryFn: () => get<UserListResponse>('/users'),
  });

  const users = q.data?.users ?? [];
  const pending = users.filter((u) => u.role === 'PENDING');
  const authorized = users.filter((u) => u.role !== 'PENDING');
  const activeAdmins = users.filter((u) => u.role === 'ADMIN' && u.active).length;

  const filtered = authorized.filter((u) => {
    if (!search.trim()) return true;
    const s = search.toLowerCase();
    return u.name.toLowerCase().includes(s) || u.email.toLowerCase().includes(s) || (u.clientName ?? '').toLowerCase().includes(s);
  });

  const columns: Array<Column<UserRow>> = useMemo(
    () => [
      {
        key: 'name',
        header: 'Account',
        sortValue: (u) => u.name,
        render: (u) => (
          <div className="min-w-[200px]">
            <div className="font-medium">
              {u.name}
              {u.id === user?.id && <span className="badge-gray ml-2">You</span>}
              {!u.active && <span className="badge-red ml-2">Deactivated</span>}
            </div>
            <div className="text-[12px] text-ink-mute truncate">{u.email}</div>
            {u.clientId && (
              <div className="text-[12px]">
                <Link to={`/clients/${u.clientId}`} className="link">
                  {u.clientName ?? 'Linked contractor'}
                </Link>
              </div>
            )}
          </div>
        ),
      },
      {
        key: 'role',
        header: 'Current role',
        sortValue: (u) => u.role,
        render: (u) => (
          <div className="min-w-[160px]">
            <span className={ROLE_CLASS[u.role]}>{ROLE_LABELS[u.role]}</span>
            <div className="mt-1 text-[11px] text-ink-soft leading-snug">{ROLE_DESCRIPTIONS[u.role]}</div>
          </div>
        ),
      },
      {
        key: 'lastLogin',
        header: 'Last login',
        sortValue: (u) => u.lastLoginAt ?? '',
        render: (u) => (
          <div className="whitespace-nowrap">
            <div className="text-[13px]">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : <span className="text-ink-mute">Never</span>}</div>
            <div className="text-[11px] text-ink-mute">Created {fmtDate(u.createdAt)}</div>
          </div>
        ),
      },
      {
        key: 'invite',
        header: 'Invite',
        sortValue: (u) => (u.invitePending ? 0 : 1),
        render: (u) =>
          u.invitePending ? (
            <div className="min-w-[130px]">
              <span className="badge-amber">Not accepted</span>
              <div className="mt-0.5 text-[11px] text-ink-mute">Expires {fmtDate(u.inviteExpiresAt)}</div>
            </div>
          ) : (
            <span className="text-[12px] text-ink-mute">Password set</span>
          ),
      },
      {
        key: 'assign',
        header: 'Change role',
        render: (u) => (
          <RoleControl user={u} canAssign={canAssign} canInvite={canInvite} selfId={user?.id ?? ''} activeAdmins={activeAdmins} />
        ),
      },
    ],
    [canAssign, canInvite, user?.id, activeAdmins],
  );

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold">Users and authorization</h1>
          <p className="mt-1 text-sm text-ink-soft max-w-3xl leading-relaxed">
            Every account starts with no access at all and stays that way until somebody here gives it a role. That is
            deliberate: “no role yet” is an explicit state, so no permission check can mistake an unauthorized account
            for a staff one.
          </p>
        </div>
        {canInvite && (
          <button type="button" className="btn-primary" onClick={() => setInviting(true)}>
            Invite someone
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <KpiCard
          label="Awaiting authorization"
          value={pending.length}
          accent={pending.length > 0 ? 'warn' : 'none'}
          hint="Signed up and can see nothing. This is your queue."
        />
        <KpiCard label="Active accounts" value={users.filter((u) => u.active).length} hint="Staff and portal accounts combined." />
        <KpiCard
          label="Administrators"
          value={activeAdmins}
          accent={activeAdmins <= 1 ? 'warn' : 'none'}
          hint={
            activeAdmins <= 1
              ? 'Only one administrator. The last one cannot be demoted, so a second is worth having before you need it.'
              : 'Full access, including users, billing, credentials and connectors.'
          }
        />
        <KpiCard
          label="Portal accounts"
          value={users.filter((u) => u.role === 'CLIENT').length}
          hint="Contractor logins. Each sees only its own company."
        />
      </div>

      {q.isLoading && <LoadingPanel label="Loading accounts…" rows={5} />}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load accounts" />}

      {/* --- the action queue ---------------------------------------------- */}
      {!q.isLoading && pending.length > 0 && (
        <section className="card border-l-4 border-warn">
          <div className="px-5 pt-4 pb-3">
            <h2 className="text-sm font-semibold">
              {pending.length} account{pending.length === 1 ? '' : 's'} waiting for you
            </h2>
            <p className="mt-1 text-[13px] text-ink-soft leading-relaxed max-w-3xl">
              These people can sign in and see a waiting screen. Until you pick a role they can do nothing — which is
              the correct default, but it is not a resting state.
            </p>
          </div>
          <ul className="divide-y divide-line border-t border-line">
            {pending.map((u) => (
              <li key={u.id} className="px-5 py-3.5 flex items-start justify-between gap-4 flex-wrap bg-warn-soft/30">
                <div className="min-w-0">
                  <div className="text-[14px] font-medium">{u.name}</div>
                  <div className="text-[12px] text-ink-soft">{u.email}</div>
                  <div className="text-[12px] text-ink-mute">
                    Signed up {fmtDate(u.createdAt)}
                    {u.lastLoginAt && ` · last seen ${fmtDateTime(u.lastLoginAt)}`}
                    {u.invitePending && ' · invite not yet accepted'}
                  </div>
                </div>
                <div className="shrink-0 w-[280px]">
                  <RoleControl
                    user={u}
                    canAssign={canAssign}
                    canInvite={canInvite}
                    selfId={user?.id ?? ''}
                    activeAdmins={activeAdmins}
                  />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* --- role reference ------------------------------------------------- */}
      <div className="card card-pad">
        <h2 className="text-sm font-semibold">What each role can do</h2>
        <dl className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
          {ASSIGNABLE.map((r) => (
            <div key={r}>
              <dt className="flex items-center gap-2">
                <span className={ROLE_CLASS[r]}>{ROLE_LABELS[r]}</span>
              </dt>
              <dd className="mt-1 text-[13px] text-ink-soft leading-snug">{ROLE_DESCRIPTIONS[r]}</dd>
            </div>
          ))}
        </dl>
      </div>

      {/* --- everyone else -------------------------------------------------- */}
      {!q.isLoading && !q.isError && (
        <section className="space-y-3">
          <div className="flex items-end justify-between gap-4 flex-wrap">
            <h2 className="text-sm font-semibold">Authorized accounts</h2>
            <input
              className="input max-w-xs"
              placeholder="Search name, email, contractor…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <DataTable<UserRow>
            columns={columns}
            rows={filtered}
            rowKey={(u) => u.id}
            initialSort={{ key: 'name', dir: 'asc' }}
            rowClassName={(u) => (u.active ? '' : 'opacity-60')}
            empty={
              <EmptyState
                title={authorized.length === 0 ? 'No authorized accounts yet' : 'Nobody matches that search'}
                hint={
                  authorized.length === 0
                    ? 'Invite a colleague or authorize one of the pending accounts above.'
                    : 'Try a different name or email.'
                }
              />
            }
            footer="You cannot change your own role here, and the API refuses it too — ask another administrator."
          />
        </section>
      )}

      {inviting && canInvite && <InviteDrawer canAssignRole={canAssign} onClose={() => setInviting(false)} />}
    </div>
  );
}

// --------------------------------------------------------------------------

function RoleControl({
  user: row,
  canAssign,
  canInvite,
  selfId,
  activeAdmins,
}: {
  user: UserRow;
  canAssign: boolean;
  canInvite: boolean;
  selfId: string;
  activeAdmins: number;
}) {
  const qc = useQueryClient();
  const [pendingRole, setPendingRole] = useState<Role | ''>('');
  const [clientId, setClientId] = useState(row.clientId ?? '');

  const isSelf = row.id === selfId;
  const lastAdmin = row.role === 'ADMIN' && row.active && activeAdmins <= 1;

  const clientsQ = useQuery({
    queryKey: ['clients'],
    queryFn: () => get<ClientListResponse>('/clients'),
    enabled: pendingRole === 'CLIENT',
    staleTime: 5 * 60_000,
  });

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['users'] });

  const assign = useMutation({
    mutationFn: (role: Role) =>
      patch(`/users/${row.id}/role`, { role, ...(role === 'CLIENT' ? { clientId } : {}) }),
    onSuccess: () => {
      setPendingRole('');
      invalidate();
    },
  });

  const setActive = useMutation({
    mutationFn: (active: boolean) => patch(`/users/${row.id}`, { active }),
    onSuccess: invalidate,
  });

  /*
   * The reissued link is the entire point of the request -- there is no
   * outbound mail, so a response that is thrown away leaves the invitee with
   * nothing and the administrator with no way to know that.
   */
  const [resentUrl, setResentUrl] = useState<string | null>(null);
  const [resentEmailed, setResentEmailed] = useState(false);
  const [resentCopied, setResentCopied] = useState(false);

  const resend = useMutation({
    mutationFn: () =>
      post<{ acceptPath?: string | null; emailed?: boolean }>(`/users/${row.id}/resend-invite`, {}),
    onSuccess: (data) => {
      setResentCopied(false);
      setResentEmailed(Boolean(data?.emailed));
      setResentUrl(inviteLink(data?.acceptPath));
      invalidate();
    },
  });

  if (isSelf) {
    return (
      <div className="min-w-[220px] text-[12px] text-ink-mute leading-snug">
        This is your own account. Changing your own role is refused here and in the API — self-promotion is the whole
        point of a privilege-escalation attempt, and there is no legitimate workflow where the fix is to edit your own
        row.
      </div>
    );
  }

  if (!canAssign) {
    return <span className="text-[12px] text-ink-mute">Your role cannot assign roles.</span>;
  }

  return (
    <div className="min-w-[220px] space-y-1.5">
      {(assign.isError || setActive.isError || resend.isError) && (
        <ErrorState
          error={assign.error ?? setActive.error ?? resend.error}
          compact
          title="Could not apply that change"
        />
      )}

      <label className="block">
        <span className="sr-only">Role for {row.name}</span>
        <select
          className="input py-1.5 text-[13px]"
          value={pendingRole || row.role}
          disabled={assign.isPending}
          onChange={(e) => {
            const next = e.target.value as Role;
            if (next === 'CLIENT') setPendingRole('CLIENT');
            else {
              setPendingRole('');
              if (next !== row.role) assign.mutate(next);
            }
          }}
        >
          {row.role === 'PENDING' && <option value="PENDING">Choose a role…</option>}
          {ASSIGNABLE.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
      </label>

      {pendingRole === 'CLIENT' && (
        <div className="space-y-1.5 rounded-md border border-line bg-page px-2.5 py-2">
          <p className="text-[11px] text-ink-soft leading-snug">
            A portal account must be attached to one contractor. That link is what scopes every query they make.
          </p>
          <select
            className="input py-1.5 text-[13px]"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          >
            <option value="">Choose a contractor</option>
            {(clientsQ.data?.clients ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <div className="flex gap-1.5">
            <button type="button" className="btn-ghost px-2 py-1 text-[12px]" onClick={() => setPendingRole('')}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary px-2 py-1 text-[12px]"
              disabled={!clientId || assign.isPending}
              onClick={() => assign.mutate('CLIENT')}
            >
              {assign.isPending ? 'Saving…' : 'Set as contractor'}
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {row.invitePending && canInvite && (
          <button
            type="button"
            className="btn-ghost px-2 py-1 text-[12px]"
            disabled={resend.isPending}
            onClick={() => resend.mutate()}
          >
            {resend.isPending ? 'Reissuing…' : 'Reissue invite'}
          </button>
        )}
        {canInvite && (
          <button
            type="button"
            className={row.active ? 'btn-ghost px-2 py-1 text-[12px]' : 'btn-primary px-2 py-1 text-[12px]'}
            disabled={setActive.isPending || (row.active && lastAdmin)}
            title={row.active && lastAdmin ? 'This is the last active administrator' : undefined}
            onClick={() => setActive.mutate(!row.active)}
          >
            {setActive.isPending ? 'Saving…' : row.active ? 'Deactivate' : 'Reactivate'}
          </button>
        )}
      </div>

      {resentUrl && (
        <div className="space-y-1 rounded-md border border-good/20 bg-good-soft px-2.5 py-2">
          <p className="text-[11px] text-good leading-snug">
            {resentEmailed
              ? `Emailed to ${row.email}. The link is here too, in case it does not arrive.`
              : `Could not email it — send this link to ${row.name} yourself.`}
          </p>
          <div className="flex gap-1.5">
            <input
              readOnly
              className="input py-1 font-mono text-[11px]"
              value={resentUrl}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              type="button"
              className="btn-ghost shrink-0 px-2 py-1 text-[12px]"
              onClick={() => {
                void navigator.clipboard?.writeText(resentUrl);
                setResentCopied(true);
              }}
            >
              {resentCopied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      {lastAdmin && (
        <p className="text-[11px] text-warn leading-snug">
          Last active administrator — cannot be demoted or deactivated until somebody else is promoted.
        </p>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------

function InviteDrawer({ canAssignRole, onClose }: { canAssignRole: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('PENDING');
  const [clientId, setClientId] = useState('');

  const clientsQ = useQuery({
    queryKey: ['clients'],
    queryFn: () => get<ClientListResponse>('/clients'),
    enabled: role === 'CLIENT',
  });

  // There is no outbound mail yet, so the invite link comes back once and the
  // admin sends it. Closing the drawer on success would throw the only copy
  // away, so it stays open until the link has been taken.
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [emailed, setEmailed] = useState(false);
  const [copied, setCopied] = useState(false);

  const invite = useMutation({
    mutationFn: () =>
      post<{ acceptPath?: string | null; emailed?: boolean }>('/users/invite', {
        email: email.trim(),
        name: name.trim(),
        role,
        ...(role === 'CLIENT' ? { clientId } : {}),
      }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['users'] });
      const url = inviteLink(data?.acceptPath);
      setEmailed(Boolean(data?.emailed));
      setInviteUrl(url);
      if (!url) onClose();
    },
  });

  const options: Role[] = canAssignRole ? ['PENDING', ...ASSIGNABLE] : ['PENDING', 'CLIENT'];
  const valid = email.trim().includes('@') && name.trim().length > 0 && (role !== 'CLIENT' || !!clientId);

  return (
    <Drawer
      open
      onClose={onClose}
      title="Invite someone"
      subtitle="They set their own password from the invite link. No password is ever chosen for them here."
      width="520px"
      footer={
        inviteUrl ? (
          <div className="flex justify-end">
            <button type="button" className="btn-primary" onClick={onClose}>
              Done
            </button>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn-primary" disabled={!valid || invite.isPending} onClick={() => invite.mutate()}>
              {invite.isPending ? 'Creating…' : 'Create the invitation'}
            </button>
          </div>
        )
      }
    >
      {inviteUrl ? (
        <div className="space-y-4">
          <div className="rounded-md bg-good-soft border border-good/20 px-3 py-2 text-sm text-good">
            Account created for {email.trim()}.{' '}
            {emailed
              ? 'The invitation has been emailed to them.'
              : 'Email is not configured, so send them the link below yourself.'}
          </div>
          <div>
            <span className="label">Invitation link</span>
            <div className="mt-1 flex gap-2">
              <input readOnly className="input font-mono text-[12px]" value={inviteUrl} onFocus={(e) => e.currentTarget.select()} />
              <button
                type="button"
                className="btn-ghost shrink-0"
                onClick={() => {
                  void navigator.clipboard?.writeText(inviteUrl);
                  setCopied(true);
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="mt-2 text-[12px] text-ink-soft leading-relaxed">
              Send this to them yourself — email, text, however you like. It is shown once and expires in 14 days. They
              choose their own password from it, so nobody here ever knows it. If it goes astray, reissue the invite
              from the user list; that invalidates this one.
            </p>
          </div>
        </div>
      ) : (
      <div className="space-y-4">
        {invite.isError && <ErrorState error={invite.error} compact title="Could not create the invitation" />}

        <label className="block">
          <span className="label">Full name</span>
          <input className="input mt-1" value={name} onChange={(e) => setName(e.target.value)} />
        </label>

        <label className="block">
          <span className="label">Email</span>
          <input type="email" className="input mt-1" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>

        <label className="block">
          <span className="label">Role</span>
          <select className="input mt-1" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {options.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-[12px] text-ink-soft leading-snug">{ROLE_DESCRIPTIONS[role]}</span>
          {!canAssignRole && (
            <span className="mt-1 block text-[12px] text-ink-mute leading-snug">
              Inviting somebody straight into a staff role needs the role-assignment capability. Invite them as awaiting
              authorization and an administrator can promote them.
            </span>
          )}
        </label>

        {role === 'CLIENT' && (
          <label className="block">
            <span className="label">Contractor</span>
            <select className="input mt-1" value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">Choose a contractor</option>
              {(clientsQ.data?.clients ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[12px] text-ink-mute leading-snug">
              This link is what scopes every query the account makes. A portal login without one can see nothing.
            </span>
          </label>
        )}
      </div>
      )}
    </Drawer>
  );
}

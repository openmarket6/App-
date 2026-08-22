import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { can } from '@flph/shared';
import { get, patch, post } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { fmtDate, fmtDateTime } from '../lib/format.ts';
import type {
  PortalTeamInviteResponse,
  PortalTeamMember,
  PortalTeamPatchResponse,
  PortalTeamResponse,
} from '../lib/portal-shapes.ts';
import EmptyState from '../components/EmptyState.tsx';
import ErrorState from '../components/ErrorState.tsx';
import { LoadingPanel } from '../components/Spinner.tsx';

/**
 * Your company's logins.
 *
 * Being able to log in is not the same as being able to hand out logins. The
 * capability sits on one nominated person per company — `clientAdmin` — rather
 * than on the CLIENT role, so a foreman with an account cannot quietly create
 * more accounts. Everyone else sees the list read-only and is told who to ask,
 * because "you do not have permission" with no name attached just becomes a
 * phone call to us.
 *
 * The invite link is shown exactly once. There is no outbound mail yet, so the
 * administrator sends it themselves, and a token that could be re-read from a
 * list is a token that could be scraped.
 */

export default function PortalTeam() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [inviting, setInviting] = useState(false);

  const q = useQuery({
    queryKey: ['portal', 'team'],
    queryFn: () => get<PortalTeamResponse>('/portal/team'),
  });

  const members = useMemo(() => q.data?.members ?? [], [q.data]);
  const me = useMemo(() => members.find((m) => m.id === user?.id) ?? null, [members, user?.id]);

  // Same rule the API applies: hold the capability by role, or be an active
  // company administrator. Mirrored here only so the UI never offers a control
  // that would be refused.
  const canManage = !!user && (can(user.role, 'portal:manage_team') || (!!me?.active && me.clientAdmin));

  const admins = members.filter((m) => m.active && m.clientAdmin);
  const activeAdminCount = admins.length;

  const setActive = useMutation({
    mutationFn: (v: { userId: string; active: boolean }) =>
      patch<PortalTeamPatchResponse>(`/portal/team/${v.userId}`, { active: v.active }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['portal', 'team'] }),
  });

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">Your team</h1>
          <p className="mt-1 text-sm text-ink-soft leading-relaxed max-w-2xl">
            Everyone from your company who can log in here. Give your office manager and your foremen their own login
            rather than sharing one — every upload and every message is recorded against the person who made it, and
            that is worth something the day somebody asks who sent which revision.
          </p>
        </div>
        {canManage && (
          <button type="button" className="btn-primary" onClick={() => setInviting(true)}>
            Invite a teammate
          </button>
        )}
      </div>

      {!canManage && (
        <div className="rounded-md border border-line bg-page px-4 py-3">
          <div className="text-[13px] font-semibold">You can see this list but not change it</div>
          <p className="mt-1 text-[13px] text-ink-soft leading-relaxed">
            {admins.length > 0 ? (
              <>
                Adding or removing logins is limited to your company administrator —{' '}
                {admins.map((a, i) => (
                  <span key={a.id}>
                    {i > 0 && (i === admins.length - 1 ? ' or ' : ', ')}
                    <span className="font-medium text-ink">{a.name}</span> ({a.email})
                  </span>
                ))}
                . Ask them.
              </>
            ) : (
              <>
                Nobody at your company is nominated as an administrator yet, so only we can add logins for you.{' '}
                <Link to="/support" className="link">
                  Message your coordinator
                </Link>{' '}
                and we will nominate someone.
              </>
            )}
          </p>
        </div>
      )}

      {q.isLoading && <LoadingPanel label="Loading your team…" rows={3} />}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load your team" />}

      {setActive.isError && <ErrorState error={setActive.error} compact title="Could not change that login" />}

      {!q.isLoading && !q.isError && members.length === 0 && (
        <div className="card">
          <EmptyState
            title="No logins on this company yet"
            hint="That is unusual — you are signed in, so at least your own account should be here. Try reloading, and tell us if it stays empty."
            compact
          />
        </div>
      )}

      {members.length > 0 && (
        <ul className="card divide-y divide-line overflow-hidden">
          {members.map((m) => (
            <MemberRow
              key={m.id}
              member={m}
              isSelf={m.id === user?.id}
              canManage={canManage}
              lastAdmin={m.active && m.clientAdmin && activeAdminCount <= 1}
              pending={setActive.isPending}
              onSetActive={(active) => setActive.mutate({ userId: m.id, active })}
            />
          ))}
        </ul>
      )}

      {q.data && (
        <p className="text-[12px] text-ink-mute">
          {q.data.activeCount} active of {q.data.total} · {q.data.adminCount} administrator
          {q.data.adminCount === 1 ? '' : 's'}. Only we can nominate an administrator — ask your coordinator if that
          needs to change.
        </p>
      )}

      {inviting && canManage && <InviteDrawer onClose={() => setInviting(false)} />}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function MemberRow({
  member: m,
  isSelf,
  canManage,
  lastAdmin,
  pending,
  onSetActive,
}: {
  member: PortalTeamMember;
  isSelf: boolean;
  canManage: boolean;
  lastAdmin: boolean;
  pending: boolean;
  onSetActive: (active: boolean) => void;
}) {
  // Both rules the API enforces, mirrored so the button is never a trap.
  const blockedReason = isSelf
    ? 'You cannot deactivate your own login — ask another administrator.'
    : lastAdmin
      ? "This is your company's last active administrator. Ask us to nominate another one first."
      : null;

  return (
    <li className="px-4 py-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[14px] font-medium">{m.name}</span>
            {isSelf && <span className="badge-gray">You</span>}
            {m.clientAdmin && <span className="badge-blue">Company administrator</span>}
            {!m.active && <span className="badge-red">Deactivated</span>}
            {m.invitePending && <span className="badge-amber">Invite not accepted</span>}
          </div>
          <div className="mt-0.5 text-[12px] text-ink-soft break-all">{m.email}</div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[12px] text-ink-mute">
            <span>
              Last login{' '}
              {m.lastLoginAt ? (
                <span className="text-ink-soft">{fmtDateTime(m.lastLoginAt)}</span>
              ) : (
                <span className="text-ink-soft">never</span>
              )}
            </span>
            <span>Added {fmtDate(m.createdAt)}</span>
            {m.invitePending && m.inviteExpiresAt && <span>Invite expires {fmtDate(m.inviteExpiresAt)}</span>}
          </div>
        </div>

        {canManage && (
          <div className="shrink-0 text-right">
            <button
              type="button"
              className={m.active ? 'btn-ghost whitespace-nowrap' : 'btn-primary whitespace-nowrap'}
              disabled={pending || !!blockedReason}
              title={blockedReason ?? undefined}
              onClick={() => onSetActive(!m.active)}
            >
              {m.active ? 'Deactivate' : 'Reactivate'}
            </button>
            {blockedReason && (
              <div className="mt-1 max-w-[220px] text-[11px] text-ink-mute leading-snug">{blockedReason}</div>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/* -------------------------------------------------------------------------- */

function InviteDrawer({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const invite = useMutation({
    mutationFn: () =>
      post<PortalTeamInviteResponse>('/portal/team/invite', { email: email.trim(), name: name.trim() }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['portal', 'team'] });
      setInviteUrl(data?.inviteUrl ?? null);
      // Closing on success would throw away the only copy of the link.
      if (!data?.inviteUrl) onClose();
    },
  });

  const valid = email.trim().includes('@') && name.trim().length > 0;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (valid && !invite.isPending) invite.mutate();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-navy/30" onClick={onClose} aria-hidden />
      <div className="relative w-full sm:max-w-lg max-h-[90vh] overflow-y-auto rounded-t-card sm:rounded-card bg-white border border-line shadow-xl">
        <div className="border-b border-line px-5 py-4">
          <div className="text-base font-semibold">Invite a teammate</div>
          <p className="mt-0.5 text-[13px] text-ink-soft leading-relaxed">
            They get their own login inside your company and set their own password. No password is ever chosen for
            them here.
          </p>
        </div>

        <div className="px-5 py-4">
          {inviteUrl ? (
            <div className="space-y-4">
              <div className="rounded-md border border-good/20 bg-good-soft px-3 py-2 text-sm text-good">
                Account created for {email.trim()}.
              </div>
              <div>
                <span className="label">Invitation link</span>
                <div className="mt-1 flex gap-2">
                  <input
                    readOnly
                    className="input font-mono text-[12px]"
                    value={inviteUrl}
                    onFocus={(e) => e.currentTarget.select()}
                  />
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
                  Send this to them yourself — email, text, however you like. It is shown once and expires in 14 days.
                  They choose their own password from it, so nobody here ever knows it. If it goes astray, ask us to
                  reissue the invite; that invalidates this one.
                </p>
              </div>
              <div className="flex justify-end">
                <button type="button" className="btn-primary" onClick={onClose}>
                  Done
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4">
              {invite.isError && <ErrorState error={invite.error} compact title="Could not create that login" />}

              <label className="block">
                <span className="label">Full name</span>
                <input className="input mt-1" value={name} onChange={(e) => setName(e.target.value)} />
              </label>

              <label className="block">
                <span className="label">Email</span>
                <input
                  type="email"
                  className="input mt-1"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="off"
                />
              </label>

              <p className="text-[12px] text-ink-soft leading-relaxed">
                Everyone you invite here gets a normal login inside your company — they can see your jobs, your files
                and your invoices, and upload. They cannot invite anyone else. Ask us if somebody needs that.
              </p>

              <div className="flex justify-end gap-2">
                <button type="button" className="btn-ghost" onClick={onClose}>
                  Cancel
                </button>
                <button type="submit" className="btn-primary" disabled={!valid || invite.isPending}>
                  {invite.isPending ? 'Creating…' : 'Create the invitation'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

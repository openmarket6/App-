import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { can } from '@flph/shared';
import { get, patch, post } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { daysAgo, fmtDateTime, humanEnum } from '../lib/format.ts';
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type ClientListResponse,
  type SupportTicket,
  type TicketListResponse,
  type TicketPriority,
  type TicketStatus,
  type UserListResponse,
} from '../lib/api-shapes.ts';
import type { PermitListResponse } from '../lib/types.ts';
import Drawer from '../components/Drawer.tsx';
import EmptyState from '../components/EmptyState.tsx';
import ErrorState from '../components/ErrorState.tsx';
import KpiCard from '../components/KpiCard.tsx';
import { LoadingPanel } from '../components/Spinner.tsx';

/**
 * The support desk.
 *
 * The sharp edge is internal notes. One ticket carries two audiences, and the
 * difference between them is a single boolean — exactly the shape of bug that
 * ships unnoticed because it works perfectly for the staff user testing it.
 * The API strips internal messages for a CLIENT before they leave the server,
 * so this page never has them to leak; what it adds is making them
 * unmistakable on screen, so nobody writes one thinking it is a reply.
 */

const STATUS_CLASS: Record<TicketStatus, string> = {
  OPEN: 'badge-red',
  IN_PROGRESS: 'badge-blue',
  WAITING_CLIENT: 'badge-amber',
  RESOLVED: 'badge-green',
};

const PRIORITY_CLASS: Record<TicketPriority, string> = {
  LOW: 'badge-gray',
  NORMAL: 'badge-gray',
  HIGH: 'badge-amber',
  URGENT: 'badge-red',
};

const STATUS_LABELS: Record<TicketStatus, string> = {
  OPEN: 'Open',
  IN_PROGRESS: 'In progress',
  WAITING_CLIENT: 'Waiting on contractor',
  RESOLVED: 'Resolved',
};

export default function Support() {
  const { user, isStaff } = useAuth();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [composing, setComposing] = useState(false);

  const q = useQuery({
    queryKey: ['tickets'],
    queryFn: () => get<TicketListResponse>('/support'),
  });

  const clientsQ = useQuery({
    queryKey: ['clients'],
    queryFn: () => get<ClientListResponse>('/clients'),
    staleTime: 5 * 60_000,
  });

  const clientName = useMemo(
    () => new Map((clientsQ.data?.clients ?? []).map((c) => [c.id, c.name])),
    [clientsQ.data],
  );

  const tickets = q.data?.tickets ?? [];
  const rows = tickets.filter((t) => !statusFilter || t.status === statusFilter);
  const selected = tickets.find((t) => t.id === selectedId) ?? null;

  const open = tickets.filter((t) => t.status !== 'RESOLVED');
  const urgent = tickets.filter((t) => t.priority === 'URGENT' && t.status !== 'RESOLVED').length;
  const waiting = tickets.filter((t) => t.status === 'WAITING_CLIENT').length;
  const oldest = open.reduce<number | null>((max, t) => {
    const d = daysAgo(t.createdAt);
    return d != null && (max == null || d > max) ? d : max;
  }, null);

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold">Support desk</h1>
          <p className="mt-1 text-sm text-ink-soft max-w-3xl leading-relaxed">
            {isStaff
              ? 'Every ticket across the book. Internal notes are staff-only and are stripped by the API before a contractor ever sees the thread — but they are still worth writing carefully.'
              : 'Questions, chasers and anything that needs a person. Replies land here and in your email.'}
          </p>
        </div>
        <button type="button" className="btn-primary" onClick={() => setComposing(true)}>
          {isStaff ? 'Open a ticket' : 'Ask a question'}
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <KpiCard label="Open tickets" value={open.length} hint="Anything not resolved." />
        <KpiCard
          label="Urgent"
          value={urgent}
          accent={urgent > 0 ? 'danger' : 'none'}
          hint="Marked urgent and still open. Triage is the desk's call, not the contractor's."
        />
        <KpiCard
          label="Waiting on contractor"
          value={waiting}
          accent={waiting > 0 ? 'warn' : 'none'}
          hint="We have replied; the ball is on their side."
        />
        <KpiCard
          label="Oldest open"
          value={oldest == null ? '—' : `${oldest}d`}
          hint={oldest == null ? 'Nothing open.' : 'Days since the oldest open ticket was raised.'}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-5 space-y-3">
          <div className="card card-pad">
            <label className="label" htmlFor="t-status">Status</label>
            <select id="t-status" className="input mt-1" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">Any status</option>
              {TICKET_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>

          {q.isLoading && <LoadingPanel label="Loading tickets…" rows={4} />}
          {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Could not load tickets" />}

          {!q.isLoading && !q.isError && rows.length === 0 && (
            <div className="card">
              <EmptyState
                title={tickets.length === 0 ? 'No tickets' : 'No tickets match this filter'}
                hint={
                  tickets.length === 0
                    ? 'Nothing has been raised yet. A ticket is the right place for anything that needs a person rather than a form.'
                    : 'Try a different status.'
                }
                compact
              />
            </div>
          )}

          {!q.isLoading && rows.length > 0 && (
            <div className="card overflow-hidden">
              <ul className="divide-y divide-line">
                {rows.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(t.id)}
                      className={`w-full text-left px-4 py-3 transition-colors ${
                        t.id === selectedId ? 'bg-brand-soft' : 'hover:bg-page'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-[12px] text-ink-mute">{t.reference}</span>
                            <span className={STATUS_CLASS[t.status]}>{STATUS_LABELS[t.status]}</span>
                            {t.priority !== 'NORMAL' && (
                              <span className={PRIORITY_CLASS[t.priority]}>{humanEnum(t.priority)}</span>
                            )}
                          </div>
                          <div className="mt-1 text-[13px] font-medium leading-snug truncate">{t.subject}</div>
                          <div className="text-[12px] text-ink-mute truncate">
                            {isStaff && `${clientName.get(t.clientId) ?? 'Unknown contractor'} · `}
                            {t.messages.length} message{t.messages.length === 1 ? '' : 's'}
                            {isStaff && (t.internalMessageCount ?? 0) > 0 && ` · ${t.internalMessageCount} internal`}
                          </div>
                        </div>
                        <span className="text-[11px] text-ink-mute tabular-nums shrink-0">
                          {daysAgo(t.updatedAt) ?? 0}d
                        </span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="lg:col-span-7">
          {selected ? (
            <Thread
              ticket={selected}
              clientName={clientName.get(selected.clientId) ?? null}
              isStaff={isStaff}
              canTriage={!!user && can(user.role, 'permit:edit')}
              currentUserId={user?.id ?? ''}
            />
          ) : (
            <div className="card h-full">
              <EmptyState
                title="Pick a ticket"
                hint="The thread, its history and the reply box open here. Nothing is lost by clicking around — replies are only sent when you send them."
              />
            </div>
          )}
        </div>
      </div>

      {composing && <ComposeDrawer isStaff={isStaff} onClose={() => setComposing(false)} onOpened={setSelectedId} />}
    </div>
  );
}

// --------------------------------------------------------------------------

function Thread({
  ticket,
  clientName,
  isStaff,
  canTriage,
  currentUserId,
}: {
  ticket: SupportTicket;
  clientName: string | null;
  isStaff: boolean;
  canTriage: boolean;
  currentUserId: string;
}) {
  const qc = useQueryClient();
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);

  const usersQ = useQuery({
    queryKey: ['users'],
    queryFn: () => get<UserListResponse>('/users'),
    enabled: isStaff,
    staleTime: 10 * 60_000,
    retry: false,
  });

  const userName = useMemo(
    () => new Map((usersQ.data?.users ?? []).map((u) => [u.id, u.name])),
    [usersQ.data],
  );

  const reply = useMutation({
    mutationFn: () => post(`/support/${ticket.id}/messages`, { body: body.trim(), internal }),
    onSuccess: () => {
      setBody('');
      setInternal(false);
      void qc.invalidateQueries({ queryKey: ['tickets'] });
    },
  });

  const triage = useMutation({
    mutationFn: (b: Record<string, unknown>) => patch(`/support/${ticket.id}`, b),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tickets'] }),
  });

  const staff = (usersQ.data?.users ?? []).filter((u) => u.role !== 'CLIENT' && u.role !== 'PENDING' && u.active);

  return (
    <div className="card flex flex-col">
      <div className="border-b border-line px-5 py-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-[12px] text-ink-mute">{ticket.reference}</span>
              <span className={STATUS_CLASS[ticket.status]}>{STATUS_LABELS[ticket.status]}</span>
              <span className={PRIORITY_CLASS[ticket.priority]}>{humanEnum(ticket.priority)}</span>
            </div>
            <h2 className="mt-1 text-base font-semibold leading-snug">{ticket.subject}</h2>
            <div className="mt-0.5 text-[12px] text-ink-soft">
              {isStaff && clientName && (
                <>
                  <Link to={`/clients/${ticket.clientId}`} className="link">
                    {clientName}
                  </Link>
                  {' · '}
                </>
              )}
              Raised {fmtDateTime(ticket.createdAt)}
              {ticket.permitId && (
                <>
                  {' · '}
                  <Link to={`/permits/${ticket.permitId}`} className="link">
                    attached permit
                  </Link>
                </>
              )}
            </div>
          </div>
        </div>

        {canTriage && (
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
            <label className="block">
              <span className="label">Status</span>
              <select
                className="input mt-1 py-1.5 text-[13px]"
                value={ticket.status}
                disabled={triage.isPending}
                onChange={(e) => triage.mutate({ status: e.target.value })}
              >
                {TICKET_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="label">Priority</span>
              <select
                className="input mt-1 py-1.5 text-[13px]"
                value={ticket.priority}
                disabled={triage.isPending}
                onChange={(e) => triage.mutate({ priority: e.target.value })}
              >
                {TICKET_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {humanEnum(p)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="label">Assigned to</span>
              <select
                className="input mt-1 py-1.5 text-[13px]"
                value={ticket.assignedToUserId ?? ''}
                disabled={triage.isPending || staff.length === 0}
                onChange={(e) => triage.mutate({ assignedToUserId: e.target.value || null })}
              >
                <option value="">Unassigned</option>
                {staff.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        {triage.isError && (
          <div className="mt-2">
            <ErrorState error={triage.error} compact title="Could not update the ticket" />
          </div>
        )}
      </div>

      <div className="px-5 py-4 space-y-3 max-h-[520px] overflow-y-auto">
        <article className="rounded-md border border-line px-3.5 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[12px] font-semibold">
              {userName.get(ticket.openedByUserId) ?? (isStaff ? 'Contractor' : 'You')}
            </span>
            <span className="text-[11px] text-ink-mute tabular-nums">{fmtDateTime(ticket.createdAt)}</span>
          </div>
          <p className="mt-1.5 text-[13px] leading-relaxed whitespace-pre-wrap">{ticket.body}</p>
        </article>

        {ticket.messages.map((m) => (
          <article
            key={m.id}
            className={`rounded-md px-3.5 py-3 ${
              m.internal
                ? 'border-2 border-dashed border-warn/50 bg-warn-soft'
                : m.authorUserId === currentUserId
                  ? 'border border-brand/30 bg-brand-soft'
                  : 'border border-line'
            }`}
          >
            <div className="flex items-baseline justify-between gap-3 flex-wrap">
              <span className="text-[12px] font-semibold">
                {userName.get(m.authorUserId) ?? (m.authorUserId === currentUserId ? 'You' : 'Support')}
                {m.internal && <span className="badge-amber ml-2">Internal note — not visible to the contractor</span>}
              </span>
              <span className="text-[11px] text-ink-mute tabular-nums">{fmtDateTime(m.at)}</span>
            </div>
            <p className="mt-1.5 text-[13px] leading-relaxed whitespace-pre-wrap">{m.body}</p>
          </article>
        ))}

        {ticket.messages.length === 0 && (
          <p className="text-[13px] text-ink-mute">No replies yet.</p>
        )}
      </div>

      <div className="border-t border-line px-5 py-4 space-y-2">
        {reply.isError && <ErrorState error={reply.error} compact title="Could not post that message" />}
        <textarea
          className={`input min-h-[96px] ${internal ? 'border-warn focus:border-warn focus:ring-warn/20' : ''}`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={internal ? 'Internal note — the contractor will never see this.' : 'Write a reply…'}
        />
        <div className="flex items-center justify-between gap-3 flex-wrap">
          {isStaff ? (
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-line text-warn focus:ring-warn/30"
                checked={internal}
                onChange={(e) => setInternal(e.target.checked)}
              />
              <span className={internal ? 'font-medium text-warn' : ''}>
                Internal note — staff only, never shown to the contractor
              </span>
            </label>
          ) : (
            <span className="text-[12px] text-ink-mute">Your reply moves this ticket back to us.</span>
          )}
          <button
            type="button"
            className={internal ? 'btn-ghost border-warn text-warn' : 'btn-primary'}
            disabled={!body.trim() || reply.isPending}
            onClick={() => reply.mutate()}
          >
            {reply.isPending ? 'Posting…' : internal ? 'Add internal note' : 'Send reply'}
          </button>
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------

function ComposeDrawer({
  isStaff,
  onClose,
  onOpened,
}: {
  isStaff: boolean;
  onClose: () => void;
  onOpened: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [clientId, setClientId] = useState('');
  const [permitId, setPermitId] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState<TicketPriority>('NORMAL');

  const clientsQ = useQuery({
    queryKey: ['clients'],
    queryFn: () => get<ClientListResponse>('/clients'),
    enabled: isStaff,
  });

  const permitsQ = useQuery({
    queryKey: ['permits'],
    queryFn: () => get<PermitListResponse>('/permits'),
  });

  const permits = (permitsQ.data?.permits ?? []).filter((p) => !isStaff || !clientId || p.clientId === clientId);

  const create = useMutation({
    mutationFn: () =>
      post<SupportTicket>('/support', {
        ...(isStaff && clientId ? { clientId } : {}),
        permitId: permitId || null,
        subject: subject.trim(),
        body: body.trim(),
        ...(isStaff ? { priority } : {}),
      }),
    onSuccess: (ticket) => {
      void qc.invalidateQueries({ queryKey: ['tickets'] });
      onOpened(ticket.id);
      onClose();
    },
  });

  const valid = subject.trim().length > 0 && body.trim().length > 0 && (!isStaff || !!clientId);

  return (
    <Drawer
      open
      onClose={onClose}
      title={isStaff ? 'Open a ticket' : 'Ask us something'}
      subtitle={isStaff ? 'Raised on behalf of a contractor.' : 'A real person reads this.'}
      width="560px"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" disabled={!valid || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? 'Opening…' : 'Open the ticket'}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        {create.isError && <ErrorState error={create.error} compact title="Could not open the ticket" />}

        {isStaff && (
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
          </label>
        )}

        <label className="block">
          <span className="label">Related permit</span>
          <select className="input mt-1" value={permitId} onChange={(e) => setPermitId(e.target.value)}>
            <option value="">Not about a specific permit</option>
            {permits.map((p) => (
              <option key={p.id} value={p.id}>
                {p.agencyRecordId ?? 'No number'} — {p.projectAddress ?? p.projectName ?? 'Unnamed'}
              </option>
            ))}
          </select>
        </label>

        {isStaff && (
          <label className="block">
            <span className="label">Priority</span>
            <select className="input mt-1" value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)}>
              {TICKET_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {humanEnum(p)}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="block">
          <span className="label">Subject</span>
          <input className="input mt-1" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </label>

        <label className="block">
          <span className="label">What is going on</span>
          <textarea className="input mt-1 min-h-[140px]" value={body} onChange={(e) => setBody(e.target.value)} />
        </label>

        {!isStaff && (
          <p className="text-[12px] text-ink-soft leading-snug">
            Priority is set by the desk once someone has read it — a field you set yourself would not mean anything.
          </p>
        )}
      </div>
    </Drawer>
  );
}

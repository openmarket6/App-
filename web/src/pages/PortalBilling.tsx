import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { formatCents } from '@flph/shared';
import { get } from '../lib/api.ts';
import { fmtDate } from '../lib/format.ts';
import type { InvoiceListResponse, SubscriptionResponse } from '../lib/api-shapes.ts';
import ErrorState from '../components/ErrorState.tsx';
import KpiCard from '../components/KpiCard.tsx';
import { LoadingPanel } from '../components/Spinner.tsx';

/**
 * What a contractor is paying, and what is outstanding.
 *
 * The portal sidebar has linked here since it was written, and there was no
 * such route: every contractor who clicked Billing got a blank screen. It
 * reads the two endpoints that already existed rather than adding any -- the
 * plan and retainer from the subscription, the balance from the invoice list.
 *
 * It deliberately does not offer to change the plan. Prices live in code and
 * are published to the public pricing page from the same constants, so a
 * self-service plan change here would be a second source of truth for what a
 * job costs.
 */
export default function PortalBilling() {
  const subQ = useQuery({
    queryKey: ['portal', 'subscription'],
    queryFn: () => get<SubscriptionResponse>('/billing/subscription'),
  });
  const invQ = useQuery({
    queryKey: ['portal', 'invoices'],
    queryFn: () => get<InvoiceListResponse>('/billing/invoices'),
  });

  if (subQ.isLoading || invQ.isLoading) return <LoadingPanel />;
  if (subQ.isError) return <ErrorState error={subQ.error} title="Could not load your billing" />;

  const sub = subQ.data?.subscription ?? null;
  const retainer = subQ.data?.retainer ?? null;
  const outstanding = invQ.data?.outstandingCents ?? 0;
  const recent = (invQ.data?.invoices ?? []).slice(0, 8);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Billing</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Your plan, what is held on account, and what is currently owed.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <KpiCard label="Current plan" value={sub?.plan?.name ?? 'No active plan'} />
        <KpiCard label="Outstanding" value={formatCents(outstanding)} />
        <KpiCard
          label="Compliance retainer"
          value={retainer ? formatCents(retainer.heldCents) : '—'}
        />
      </div>

      {retainer && retainer.shortfallCents > 0 && (
        <div className="rounded-md border border-warn/25 bg-warn-soft px-3 py-2 text-sm text-warn">
          Your retainer is {formatCents(retainer.shortfallCents)} short of the{' '}
          {formatCents(retainer.requiredCents)} this plan requires. The retainer is held against
          licensing risk — it is not a service fee, and it is returned when the engagement ends.
        </div>
      )}

      <div className="card">
        <div className="card-pad border-b border-line">
          <h2 className="text-sm font-semibold">Recent invoices</h2>
        </div>
        {recent.length === 0 ? (
          <div className="card-pad text-sm text-ink-soft">Nothing invoiced yet.</div>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {recent.map((inv) => (
                <tr key={inv.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-2.5">{fmtDate(inv.issuedAt)}</td>
                  <td className="px-4 py-2.5 text-ink-soft">{inv.number ?? inv.id.slice(0, 8)}</td>
                  <td className="px-4 py-2.5 text-right font-medium">{formatCents(inv.totalCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="card-pad border-t border-line">
          <Link to="/invoices" className="link text-[13px]">
            See every invoice, including agency fees
          </Link>
        </div>
      </div>

      <p className="text-[12px] text-ink-mute leading-relaxed">
        To change plans or update a payment method, message your coordinator — plans are set with
        you rather than switched silently, so the price you were quoted stays the price you pay.
      </p>
    </div>
  );
}

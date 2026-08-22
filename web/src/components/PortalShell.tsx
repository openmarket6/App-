import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../lib/auth.tsx';
import type { ClientListResponse } from '../lib/api-shapes.ts';
import type { PortalActionsResponse } from '../lib/portal-shapes.ts';
import { get } from '../lib/api.ts';

/**
 * The contractor's own navigation.
 *
 * The staff sidebar is an operations console — fourteen destinations organised
 * around what a coordinator does all day. A contractor has a different job and
 * a different device, so this is a different shell rather than the same one
 * with rows hidden: their company name is the masthead, the sections are named
 * for their work rather than ours, and the whole thing collapses to a single
 * bar on a phone because that is where a roofer actually opens it.
 *
 * The one number carried in the navigation is the blocking-action count. It is
 * on Home and nowhere else: a badge on every section trains people to ignore
 * badges, and only one of these counts stops work.
 */

interface NavItem {
  to: string;
  label: string;
  hint: string;
  /** Only Home carries one, and only when something is actually blocked. */
  badge?: number;
  /** Match the section as a prefix rather than exactly — /files/<path> is still Files. */
  prefix?: boolean;
}

interface NavSection {
  heading: string | null;
  items: NavItem[];
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

export default function PortalShell({ children }: { children: ReactNode }) {
  const { user, signOut } = useAuth();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  // Close the mobile menu on navigation. Leaving it open over the page someone
  // just asked for is the classic phone-nav bug.
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  const clientsQ = useQuery({
    queryKey: ['clients', 'self'],
    queryFn: () => get<ClientListResponse>('/clients'),
    enabled: !!user,
  });

  const actionsQ = useQuery({
    queryKey: ['portal', 'actions'],
    queryFn: () => get<PortalActionsResponse>('/portal/actions'),
    enabled: !!user,
    refetchOnWindowFocus: true,
  });

  if (!user) return null;

  const companyName = clientsQ.data?.clients[0]?.name ?? 'Your company';
  const blocking = actionsQ.data?.blockingCount ?? 0;

  const sections: NavSection[] = [
    {
      heading: null,
      items: [
        { to: '/dashboard', label: 'Home', hint: 'What needs you today', badge: blocking || undefined },
        { to: '/pipeline', label: 'My jobs', hint: 'Every permit and where it sits', prefix: true },
        { to: '/files', label: 'Files', hint: 'Your folders', prefix: true },
        { to: '/request-permit', label: 'Request a permit', hint: 'Send us a new job' },
        { to: '/drafting', label: 'Drafting', hint: 'Plans and engineering' },
        { to: '/invoices', label: 'Invoices', hint: 'Our fees and agency fees' },
        { to: '/support', label: 'Messages', hint: 'Talk to your coordinator' },
      ],
    },
    {
      heading: 'Account',
      items: [
        { to: '/onboarding', label: 'Company & compliance', hint: 'Insurance, licence, agreements', prefix: true },
        { to: '/account/team', label: 'Team', hint: 'Who from your company can log in' },
        { to: '/account/billing', label: 'Billing', hint: 'Payment method and plan' },
      ],
    },
  ];

  const nav = (
    <nav className="flex-1 overflow-y-auto py-3" aria-label="Portal">
      {sections.map((section, si) => (
        <div key={section.heading ?? `section-${si}`} className="mb-4">
          {section.heading && (
            <div className="px-4 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-white/40">
              {section.heading}
            </div>
          )}
          {section.items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={!item.prefix}
              title={item.hint}
              className={({ isActive }) =>
                `flex items-center justify-between gap-2 px-4 py-2.5 md:py-2 text-[14px] md:text-[13px] transition-colors ${
                  isActive ? 'bg-brand text-white font-medium' : 'text-white/75 hover:bg-white/5 hover:text-white'
                }`
              }
            >
              <span className="truncate">{item.label}</span>
              {item.badge ? (
                <span
                  className="shrink-0 rounded bg-danger px-1.5 py-0.5 text-[11px] font-bold leading-4 text-white tabular-nums"
                  title={`${item.badge} thing${item.badge === 1 ? '' : 's'} are stopping work`}
                >
                  {item.badge}
                </span>
              ) : null}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );

  const account = (
    <div className="border-t border-white/10 px-4 py-3 flex items-center gap-3">
      <div className="h-7 w-7 shrink-0 rounded-full bg-white/10 grid place-items-center text-[11px] font-semibold">
        {initials(user.name)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium leading-tight truncate">{user.name}</div>
        <div className="text-[11px] text-white/50 truncate">{user.email}</div>
      </div>
      <button onClick={signOut} className="text-white/50 hover:text-white text-xs shrink-0">
        Sign out
      </button>
    </div>
  );

  const masthead = (
    <div className="px-4 py-4 flex items-center gap-3 border-b border-white/10">
      <div className="h-9 w-9 shrink-0 rounded bg-white/10 grid place-items-center text-[11px] font-bold tracking-wide">
        {initials(companyName) || '1CS'}
      </div>
      <div className="min-w-0">
        <div className="text-sm font-semibold leading-tight truncate" title={companyName}>
          {companyName}
        </div>
        <div className="text-[11px] text-white/50 leading-tight truncate">
          Your permit desk at 1 Contractor Solutions
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-full flex flex-col md:flex-row">
      {/* --- phone bar ---------------------------------------------------- */}
      <header className="md:hidden sticky top-0 z-40 flex items-center gap-3 bg-navy px-4 py-3 text-white">
        <div className="h-8 w-8 shrink-0 rounded bg-white/10 grid place-items-center text-[10px] font-bold">
          {initials(companyName) || '1CS'}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold leading-tight truncate">{companyName}</div>
          <div className="text-[11px] text-white/50 leading-tight">1 Contractor Solutions</div>
        </div>
        {blocking > 0 && !menuOpen && (
          <span className="rounded bg-danger px-1.5 py-0.5 text-[11px] font-bold tabular-nums">{blocking}</span>
        )}
        <button
          type="button"
          className="rounded border border-white/20 px-2.5 py-1.5 text-[12px] font-medium"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          {menuOpen ? 'Close' : 'Menu'}
        </button>
      </header>

      {menuOpen && (
        <div className="md:hidden fixed inset-0 z-30 flex flex-col pt-[60px] bg-navy text-white">
          {nav}
          {account}
        </div>
      )}

      {/* --- desktop sidebar ---------------------------------------------- */}
      <aside className="hidden md:flex w-[212px] shrink-0 bg-navy text-white flex-col">
        {masthead}
        {nav}
        {account}
      </aside>

      <main className="flex-1 min-w-0 p-4 md:p-6 overflow-x-hidden">{children}</main>
    </div>
  );
}

import { NavLink, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { ROLE_LABELS } from '@flph/shared';
import { useAuth } from '../lib/auth.tsx';
import PortalShell from './PortalShell.tsx';

interface NavItem {
  to: string;
  label: string;
  staffOnly?: boolean;
  badgeKey?: string;
}

interface NavSection {
  heading: string;
  items: NavItem[];
}

const SECTIONS: NavSection[] = [
  {
    heading: 'Operations',
    items: [
      { to: '/dashboard', label: 'Dashboard' },
      { to: '/pipeline', label: 'Permit Pipeline', badgeKey: 'openPermits' },
      { to: '/inspections', label: 'Inspections', badgeKey: 'inspectionsThisWeek' },
      { to: '/documents', label: 'Documents & Compliance' },
      { to: '/documents/generate', label: 'Generate a document', staffOnly: true },
      { to: '/field', label: 'My site visits', staffOnly: true },
      { to: '/supervision', label: 'Supervision', staffOnly: true },
      { to: '/notary', label: 'Notary', staffOnly: true },
    ],
  },
  {
    heading: 'Book of business',
    items: [
      { to: '/clients', label: 'Contractors', staffOnly: true, badgeKey: 'clients' },
      { to: '/projects', label: 'Projects' },
      { to: '/drafting', label: 'Drafting & Engineering', badgeKey: 'openDrafting' },
      { to: '/invoices', label: 'Fees & Invoices' },
    ],
  },
  {
    heading: 'Knowledge',
    items: [
      { to: '/jurisdictions', label: 'Jurisdictions', badgeKey: 'jurisdictions' },
      { to: '/support', label: 'Support Desk', badgeKey: 'openTickets' },
    ],
  },
  {
    heading: 'Insight',
    items: [
      { to: '/reports', label: 'Reports', staffOnly: true },
      { to: '/settings/users', label: 'Users & access', staffOnly: true },
      { to: '/settings/google', label: 'Google Drive', staffOnly: true },
      { to: '/connectors', label: 'Portal Connectors', staffOnly: true },
      { to: '/settings', label: 'Settings', staffOnly: true },
    ],
  },
];

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

/** An authorized-but-roleless account gets a wall, not a dashboard. */
function PendingWall({ name, onSignOut }: { name: string; onSignOut: () => void }) {
  return (
    <div className="min-h-full grid place-items-center p-6">
      <div className="card card-pad max-w-md text-center">
        <div className="mx-auto h-11 w-11 rounded-full bg-warn-soft grid place-items-center text-warn font-semibold">
          {initials(name)}
        </div>
        <h1 className="mt-4 text-lg font-semibold">Your account is waiting for authorization</h1>
        <p className="mt-2 text-sm text-ink-soft leading-relaxed">
          An administrator has to assign your access level before you can see anything here. You will not need to sign
          up again — just sign back in once you have been told it is done.
        </p>
        <button onClick={onSignOut} className="btn-ghost mt-6">
          Sign out
        </button>
      </div>
    </div>
  );
}

export default function Shell({ children }: { children: ReactNode }) {
  const { user, signOut, isStaff } = useAuth();
  const location = useLocation();

  if (!user) return null;
  if (user.role === 'PENDING') return <PendingWall name={user.name} onSignOut={signOut} />;

  // A contractor gets their own application, not this one with rows hidden.
  // Same session, same API, different place — the navigation, the language and
  // the information architecture are all theirs.
  if (user.role === 'CLIENT') return <PortalShell>{children}</PortalShell>;

  const sections = SECTIONS.map((s) => ({
    ...s,
    items: s.items.filter((i) => (i.staffOnly ? isStaff : true)),
  })).filter((s) => s.items.length > 0);

  const crumb =
    SECTIONS.flatMap((s) => s.items).find((i) => location.pathname.startsWith(i.to))?.label ?? 'Dashboard';

  return (
    <div className="min-h-full flex">
      <aside className="w-[212px] shrink-0 bg-navy text-white flex flex-col">
        {/* The full lockup, sized to the rail. It already contains the
            wordmark, so setting the name in text beside it says it twice --
            and at 212px wide the text had nowhere to go but an ellipsis. */}
        <div className="px-4 py-5 border-b border-white/10">
          <img
            src="/brand/1cs-logo-onnavy.png"
            alt="1CS Contractor Solutions"
            className="w-full max-w-[168px] h-auto"
          />
        </div>

        <nav className="flex-1 overflow-y-auto py-3">
          {sections.map((section) => (
            <div key={section.heading} className="mb-4">
              <div className="px-4 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-white/40">
                {section.heading}
              </div>
              {section.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    `flex items-center justify-between px-4 py-2 text-[13px] transition-colors ${
                      isActive ? 'bg-brand text-white font-medium' : 'text-white/75 hover:bg-white/5 hover:text-white'
                    }`
                  }
                >
                  <span className="truncate">{item.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="border-t border-white/10 px-4 py-3 flex items-center gap-3">
          <div className="h-7 w-7 rounded-full bg-white/10 grid place-items-center text-[11px] font-semibold">
            {initials(user.name)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium leading-tight truncate">{user.name}</div>
            <div className="text-[11px] text-white/50 truncate">{ROLE_LABELS[user.role]}</div>
          </div>
          <button onClick={signOut} title="Sign out" className="text-white/50 hover:text-white text-xs">
            Exit
          </button>
        </div>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col">
        <header className="h-12 border-b border-line bg-white flex items-center px-6 gap-3">
          <span className="text-sm text-ink-mute">1 Contractor Solutions</span>
          <span className="text-ink-mute">›</span>
          <span className="text-sm font-medium">{crumb}</span>
          <div className="ml-auto flex items-center gap-2">
            {!isStaff && (
              <span className="badge-blue">Client portal — {user.name}</span>
            )}
            {user.role === 'VIEWER' && <span className="badge-gray">Read only</span>}
          </div>
        </header>
        <main className="flex-1 p-6 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

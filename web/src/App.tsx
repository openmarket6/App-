import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth.tsx';
import Login from './pages/Login.tsx';
import AcceptInvite from './pages/AcceptInvite.tsx';
import ResetPassword from './pages/ResetPassword.tsx';
import FirstRun from './pages/FirstRun.tsx';
import Shell from './components/Shell.tsx';

import Dashboard from './pages/Dashboard.tsx';
import PortalHome from './pages/PortalHome.tsx';
import PortalFiles from './pages/PortalFiles.tsx';
import PortalBilling from './pages/PortalBilling.tsx';
import ErrorBoundary from './components/ErrorBoundary.tsx';
import PortalRequestPermit from './pages/PortalRequestPermit.tsx';
import PortalTeam from './pages/PortalTeam.tsx';
import PortalPermit from './pages/PortalPermit.tsx';
import Pipeline from './pages/Pipeline.tsx';
import PermitNew from './pages/PermitNew.tsx';
import Inspections from './pages/Inspections.tsx';
import Projects from './pages/Projects.tsx';
import PermitDetail from './pages/PermitDetail.tsx';
import JobPhotos from './pages/JobPhotos.tsx';
import Jurisdictions from './pages/Jurisdictions.tsx';
import Connectors from './pages/Connectors.tsx';
import Reports from './pages/Reports.tsx';
import Contractors from './pages/Contractors.tsx';
import ContractorDetail from './pages/ContractorDetail.tsx';
import Onboarding from './pages/Onboarding.tsx';
import Compliance from './pages/Compliance.tsx';
import Drafting from './pages/Drafting.tsx';
import Supervision from './pages/Supervision.tsx';
import FieldVisits from './pages/FieldVisits.tsx';
import DocumentsGenerate from './pages/DocumentsGenerate.tsx';
import Invoices from './pages/Invoices.tsx';
import Support from './pages/Support.tsx';
import Notary from './pages/Notary.tsx';
import Users from './pages/Users.tsx';
import Settings from './pages/Settings.tsx';

export default function App() {
  const { user, loading, isStaff, needsSetup, refresh } = useAuth();

  if (loading) {
    return (
      <div className="min-h-full grid place-items-center">
        <div className="text-sm text-ink-mute">Loading…</div>
      </div>
    );
  }

  // Accepting an invitation is the single route that has to work without a
  // session — it is how someone gets one. Everything else falls through to the
  // sign-in screen whatever path was typed, which is what makes this
  // deployment private without depending on a hosting-plan feature.
  if (!user) {
    if (needsSetup) return <FirstRun onDone={() => void refresh()} />;
    return (
      <Routes>
        <Route path="/accept-invite" element={<AcceptInvite />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }

  const staffOnly = (el: JSX.Element) => (isStaff ? el : <Navigate to="/dashboard" replace />);

  /*
   * A site supervisor lands on the field screen, not the dashboard.
   *
   * Their account exists to do one thing on a phone, and the operations
   * dashboard is a page of numbers they cannot act on while standing on a roof.
   * Sending them there first would make every visit start with a wrong turn.
   */
  const home = user.role === 'SITE_SUPERVISOR' ? '/field' : '/dashboard';

  return (
    <Shell>
      {/*
        * Inside the shell on purpose: when a page fails, the navigation stays
        * usable and the person can go somewhere else, instead of being left on
        * a blank document with no way out but the back button.
        */}
      <ErrorBoundary label="page">
      <Routes>
        <Route path="/" element={<Navigate to={home} replace />} />
        <Route path="/dashboard" element={isStaff ? <Dashboard /> : <PortalHome />} />
        <Route path="/field" element={<FieldVisits />} />

        <Route path="/pipeline" element={<Pipeline />} />
        <Route path="/permits/new" element={<PermitNew />} />
        <Route path="/permits/:id" element={isStaff ? <PermitDetail /> : <PortalPermit />} />
        <Route path="/permits/:id/photos" element={<JobPhotos />} />
        <Route path="/inspections" element={<Inspections />} />

        <Route path="/documents" element={<Compliance />} />
        <Route path="/documents/generate" element={staffOnly(<DocumentsGenerate />)} />
        <Route path="/drafting" element={<Drafting />} />
        <Route path="/invoices" element={<Invoices />} />
        <Route path="/support" element={<Support />} />
        <Route path="/jurisdictions" element={<Jurisdictions />} />
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/files" element={<PortalFiles />} />
        <Route path="/files/*" element={<PortalFiles />} />
        <Route path="/request-permit" element={<PortalRequestPermit />} />
        <Route path="/account/team" element={<PortalTeam />} />
        <Route path="/account/billing" element={<PortalBilling />} />
        <Route path="/onboarding/:clientId" element={<Onboarding />} />
        <Route path="/projects" element={<Projects />} />

        <Route path="/clients" element={staffOnly(<Contractors />)} />
        <Route path="/clients/:id" element={staffOnly(<ContractorDetail />)} />
        <Route path="/supervision" element={staffOnly(<Supervision />)} />
        <Route path="/notary" element={staffOnly(<Notary />)} />
        <Route path="/reports" element={staffOnly(<Reports />)} />
        <Route path="/connectors" element={staffOnly(<Connectors />)} />
        <Route path="/settings" element={staffOnly(<Settings />)} />
        <Route path="/settings/users" element={user.role === 'ADMIN' ? <Users /> : <Navigate to="/dashboard" replace />} />

        <Route path="*" element={<Navigate to={home} replace />} />
      </Routes>
      </ErrorBoundary>
    </Shell>
  );
}

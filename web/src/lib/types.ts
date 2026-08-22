/**
 * Response shapes for the endpoints the firm-side pages read.
 *
 * These mirror what the routers actually send, joined fields included. They
 * live here rather than in each page so the portal pages read the same permit
 * row shape the pipeline does — one definition, one place to fix when a
 * handler grows a field.
 */
import type {
  Client,
  Correction,
  Inspection,
  IntegrationTier,
  Jurisdiction,
  Pathway,
  Permit,
  PermitDocument,
  PermitStage,
  Platform,
  Project,
  Readiness,
  RequirementItem,
  RiskAssessment,
  RiskLevel,
  StatusEvent,
} from '@flph/shared';

// --- GET /permits ----------------------------------------------------------

export interface PermitRow extends Permit {
  projectName: string | null;
  projectAddress: string | null;
  clientName: string | null;
  jurisdictionName: string | null;
  risk: RiskAssessment;
}

export interface PermitListResponse {
  permits: PermitRow[];
  total: number;
}

// --- GET /permits/:id ------------------------------------------------------

export interface PermitDetailResponse {
  permit: Permit;
  project: Project | null;
  client: Client | null;
  jurisdiction: Jurisdiction | null;
  risk: RiskAssessment;
  requirements: RequirementItem[];
  statusEvents: StatusEvent[];
  documents: PermitDocument[];
  inspections: Inspection[];
  corrections: Correction[];
}

// --- POST /permits/:id/sync ------------------------------------------------

/**
 * The manual "sync now". `synced: false` is a normal answer, not an error:
 * paper-only and coordinator-served jurisdictions have no machine to ask, and
 * `reason` says which of those it is.
 */
export interface PermitSyncAdapter {
  key: string;
  label: string;
  channel: string;
  configured: boolean;
  blockedReason: string | null;
  canFetchStatus: boolean;
  manualEntry: boolean;
}

export interface PermitSyncResponse {
  synced: boolean;
  permitId: string;
  jurisdictionId: string;
  jurisdictionName: string;
  adapter: PermitSyncAdapter;
  reason: string | null;
  permit: Permit;
  outcome?: {
    ok: boolean;
    changed: boolean;
    stage: PermitStage | null;
    unmappedStatus: string | null;
    error: string | null;
  };
}

// --- GET /dashboard --------------------------------------------------------

export interface DashboardJurisdiction {
  jurisdictionId: string;
  name: string;
  platform: string;
  integrationTier: string;
  paperOnly: boolean;
  permitCount: number;
  activeCount: number;
  medianReviewDays: number | null;
  reviewSampleSize: number;
  firstPassApprovalRate: number | null;
}

export interface NeedsAttentionRow {
  permitId: string;
  agencyRecordId: string | null;
  permitType: string;
  stage: PermitStage;
  serviceLine: string;
  projectName: string | null;
  projectAddress: string | null;
  clientId: string;
  clientName: string | null;
  jurisdictionId: string;
  jurisdictionName: string | null;
  risk: RiskLevel;
  score: number;
  daysInStage: number;
  baselineDays: number | null;
  reasons: string[];
}

export interface DashboardResponse {
  scope: 'firm' | 'client';
  clientId: string | null;
  generatedAt: string;
  kpis: {
    activePermits: number;
    atRisk: number;
    openCorrections: number;
    readyToSubmit: number;
    medianReviewDays: number | null;
    reviewSampleSize: number;
    firstPassApprovalRate: number | null;
    firstPassDecidedCount: number;
    inspectionsThisWeek: number;
    /** Staff only. */
    outstandingInvoiceCents?: number | null;
    overdueInvoices?: number | null;
    /** Client view only. */
    openTickets?: number | null;
  } & Record<string, number | null | undefined>;
  pipelineByStage: Record<PermitStage, number>;
  busiestJurisdictions: DashboardJurisdiction[];
  needsAttention: NeedsAttentionRow[];
}

// --- GET /jurisdictions ----------------------------------------------------

export interface JurisdictionListResponse {
  jurisdictions: Jurisdiction[];
  total: number;
  of: number;
}

// --- GET /corrections ------------------------------------------------------

export interface CorrectionRow extends Correction {
  jurisdictionId: string | null;
  permitType: string | null;
}

export interface CorrectionListResponse {
  corrections: CorrectionRow[];
  total: number;
}

// --- GET /inspections ------------------------------------------------------

export interface InspectionRow extends Inspection {
  clientId: string | null;
  jurisdictionId: string | null;
}

export interface InspectionListResponse {
  inspections: InspectionRow[];
  total: number;
}

// --- GET /integrations/summary --------------------------------------------

export interface IntegrationSummary {
  totalJurisdictions: number;
  byPlatform: Partial<Record<Platform, number>>;
  byTier: Partial<Record<IntegrationTier, number>>;
  byPathway: Record<Pathway, number>;
  automationApproved: number;
  withCredentials: number;
  paperOnly: number;
  portalUrlKnown: number;
}

// --- GET /integrations/roadmap --------------------------------------------

export interface RoadmapItem extends Readiness {
  ourVolume: number;
  jurisdiction: {
    name: string;
    platform: Platform;
    integrationTier: IntegrationTier;
    portalUrl: string | null;
  } | null;
}

export interface RoadmapResponse {
  items: RoadmapItem[];
  quickWins: RoadmapItem[];
  totalVolume: number;
  coverageToday: Record<Pathway, number>;
  coverageAtTarget: Record<Pathway, number>;
  jurisdictionsFor80Pct: number;
}

import type {
  DocumentStatus,
  InspectionResult,
  IntegrationTier,
  PermitStage,
  PermitType,
  Platform,
  RiskLevel,
  Role,
  SourceChannel,
} from './enums.ts';

export type ID = string;
/** Money is integer cents. Everywhere. No floats touch currency. */
export type Cents = number;

export type Confidence = 'high' | 'medium' | 'low';

/** What stands between us and API access for a jurisdiction. */
export interface IntegrationGate {
  /** Does a public developer portal exist at all? */
  publicApi: boolean;
  /** Must an agency administrator approve/install our app? */
  agencyApprovalRequired: boolean;
  /** Must the agency BUY something (e.g. Tyler EnerGov API license)? */
  agencyPurchaseRequired: boolean;
  /** Vendor partner program membership required before we can even ask. */
  vendorPartnerRequired: boolean;
  /** Sandbox we can build against before any agency says yes. */
  sandboxAvailable: boolean;
  /** Platform emits webhooks, or we have to poll. */
  webhooks: boolean;
  /** Bulk export available, or record-by-record paging. */
  bulkExport: boolean;
  docsUrl: string | null;
  notes: string | null;
}

export interface Jurisdiction {
  id: ID;
  /** Stable slug, e.g. "fl-miami-dade-county". */
  slug: string;
  name: string;
  kind: 'county' | 'municipality';
  /** County this sits in. For counties, equals `name`. */
  county: string;
  fipsCounty: string | null;
  platform: Platform;
  platformVersionNote: string | null;
  integrationTier: IntegrationTier;
  gate: IntegrationGate;
  /** null when we have not verified a URL. We do not invent URLs. */
  portalUrl: string | null;
  portalUrlConfidence: Confidence;
  /** High-velocity hurricane zone (FBC). Drives product approval requirements. */
  hvhz: boolean;
  /** Wind-borne debris region. */
  windBorneDebris: boolean;
  /** Design wind speed, ASCE 7 ultimate, mph. Null when unverified. */
  designWindSpeedMph: number | null;
  /** Jurisdiction refuses electronic submittal entirely. */
  paperOnly: boolean;
  /** Set true only after a human has read this portal's terms of service. */
  automationApproved: boolean;
  automationApprovedAt: string | null;
  automationApprovedBy: string | null;
  /** Measured, not guessed. Recomputed from our own submittal history. */
  medianReviewDays: number | null;
  /** Our observed sample size behind medianReviewDays. */
  reviewSampleSize: number;
  contactPhone: string | null;
  notes: string | null;
  updatedAt: string;
}

export interface Client {
  id: ID;
  name: string;
  /** Legal entity name, when it differs from the trading name. */
  legalName: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  /** Which service line this contractor is on. Drives pricing, required
   *  paperwork and whether supervision records are mandatory. */
  serviceLine: import('./billing.ts').ServiceLine;
  /** Their own licence, when they hold one. Null on managed-licence accounts
   *  where our qualifier is the contractor of record. */
  licenseNumber: string | null;
  licenseType: string | null;
  licenseExpiresAt: string | null;
  federalEin: string | null;
  /** Where they are in onboarding. */
  onboardingStatus: 'INVITED' | 'IN_PROGRESS' | 'PENDING_REVIEW' | 'ACTIVE' | 'SUSPENDED';
  onboardingCompletedAt: string | null;
  /** Set by a coordinator when paperwork or insurance forces a hold. Blocks new filings. */
  filingHold: boolean;
  filingHoldReason: string | null;
  stripeCustomerId: string | null;
  quickbooksCustomerId: string | null;
  active: boolean;
  createdAt: string;
}

export interface Project {
  id: ID;
  clientId: ID;
  name: string;
  addressLine1: string;
  city: string;
  county: string;
  zip: string;
  jurisdictionId: ID;
  parcelId: string | null;
  valuationCents: Cents;
  ownerBuilder: boolean;
  floodZone: string | null;
  coastalConstructionControlLine: boolean;
  createdAt: string;
}

export interface Permit {
  id: ID;
  projectId: ID;
  clientId: ID;
  jurisdictionId: ID;
  permitType: PermitType;
  /** The jurisdiction's own number. Null until they issue one. */
  agencyRecordId: string | null;
  /** The raw status string the agency gave us, before normalization. */
  rawStatus: string | null;
  stage: PermitStage;
  /** Set when rawStatus could not be mapped. Visible, never silently guessed. */
  unmappedStatus: string | null;
  submittedAt: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  closedAt: string | null;
  correctionCycles: number;
  feesDueCents: Cents;
  feesPaidCents: Cents;
  /** Which service line this permit is billed and supervised under. */
  serviceLine: import('./billing.ts').ServiceLine;
  /** On MANAGED_LICENSE, the qualifying agent whose licence is on the permit. */
  qualifyingAgentId: ID | null;
  /** The PM responsible for supervising this job. Required on MANAGED_LICENSE. */
  supervisorUserId: ID | null;
  /** Which channel last wrote this row. Informational only — never branch domain logic on it. */
  sourceChannel: SourceChannel;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StatusEvent {
  id: ID;
  permitId: ID;
  at: string;
  rawStatus: string | null;
  stage: PermitStage | null;
  note: string | null;
  sourceChannel: SourceChannel;
}

export const DOCUMENT_CATEGORIES = [
  'SUBMITTAL',
  'PLAN_SET',
  'PRODUCT_APPROVAL',
  'CORRECTION_RESPONSE',
  'AGENCY_ISSUED',
  'JOB_PHOTO',
  'SUPERVISION_PHOTO',
  'COMPLIANCE',
  'SIGNED_AGREEMENT',
  'OTHER',
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

export interface PermitDocument {
  id: ID;
  /** Null for contractor-level documents — insurance, licences, signed agreements.
   *  Those live in the contractor's folder rather than under a permit. */
  permitId: ID | null;
  /** Always set, so every artifact belongs to exactly one contractor folder. */
  clientId: ID;
  category: DocumentCategory;
  contentType: string;
  /** For photos: when the camera captured it, not when it was uploaded. */
  capturedAt: string | null;
  /** Photo geotag, when the browser or EXIF supplied one. */
  geo: { lat: number; lng: number } | null;
  /** SHA-256 of the bytes. Detects a silent replacement. */
  sha256: string | null;
  requirementKey: string;
  fileName: string;
  /** Documents version rather than overwrite — agencies ask which revision went on which cycle. */
  version: number;
  supersedesId: ID | null;
  submittedOnCycle: number | null;
  status: DocumentStatus;
  sizeBytes: number;
  storageKey: string;
  uploadedAt: string;
  uploadedBy: ID;
}

export interface Inspection {
  id: ID;
  permitId: ID;
  inspectionType: string;
  scheduledFor: string | null;
  result: InspectionResult;
  inspectorNote: string | null;
  reinspectionOfId: ID | null;
  sourceChannel: SourceChannel;
}

export interface Correction {
  id: ID;
  permitId: ID;
  cycle: number;
  issuedAt: string;
  discipline: string | null;
  text: string;
  resolvedAt: string | null;
  /** Every correction we receive feeds the requirements database. This is the asset. */
  promotedToRequirement: boolean;
}

export interface RequirementOverride {
  id: ID;
  jurisdictionId: ID;
  permitType: PermitType | null;
  requirementKey: string;
  /** 'add' introduces a requirement; 'remove' suppresses a base one; 'amend' edits copy. */
  op: 'add' | 'remove' | 'amend';
  label: string | null;
  detail: string | null;
  learnedFromCorrectionId: ID | null;
  createdAt: string;
  createdBy: ID;
}

export interface User {
  id: ID;
  email: string;
  name: string;
  role: Role;
  /** Non-null for CLIENT role: scopes every query to that client. */
  clientId: ID | null;
  /**
   * A contractor's own administrator. Grants `portal:manage_team` so they can
   * invite their foreman and office manager themselves, without a coordinator
   * doing account admin for them. Meaningless on staff roles.
   */
  clientAdmin?: boolean;
  passwordHash: string;
  active: boolean;
  createdAt: string;
}

export interface CredentialRecord {
  id: ID;
  jurisdictionId: ID;
  /** Firm-owned account label. Never a client's login. */
  label: string;
  kind: 'oauth2' | 'portal_login' | 'api_key';
  /** AES-256-GCM ciphertext, base64. */
  ciphertext: string;
  iv: string;
  authTag: string;
  createdAt: string;
  rotatedAt: string | null;
}

export interface RiskAssessment {
  level: RiskLevel;
  score: number;
  reasons: string[];
  daysInStage: number;
  /** Jurisdiction's own measured median, the baseline this was scored against. */
  baselineDays: number | null;
}

export interface RequirementItem {
  key: string;
  label: string;
  detail: string | null;
  required: boolean;
  /** Which layer put it there — useful for explaining to a client why they need it. */
  source: 'base' | 'permit_type' | 'conditional' | 'override';
  /** For conditional items, the condition that fired. */
  because: string | null;
}

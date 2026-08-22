/**
 * Response shapes for the contractor-book, compliance, signing, drafting,
 * supervision, billing, support, notary and user endpoints.
 *
 * `types.ts` covers the permit/dashboard/jurisdiction surface. This file is
 * its sibling for everything the contractor lifecycle touches, and it exists
 * for the same reason: a handler that grows a joined field should be fixed in
 * one place rather than in six pages that each guessed at the shape.
 *
 * A few interfaces here (tickets, notarization requests) have no equivalent in
 * `@flph/shared` because they are defined inside their own routers. They are
 * mirrored rather than invented — keep them in step with those files.
 */
import type {
  Client,
  ComplianceItem,
  ComplianceStatus,
  ComplianceVerdict,
  DraftingRate,
  DraftingRequest,
  ID,
  Invoice,
  PermitDocument,
  Project,
  QualifyingAgent,
  Role,
  ServiceLine,
  SignableKind,
  SignatureAuditEntry,
  SignatureRequest,
  SigningVerdict,
  SiteVisit,
  Subscription,
  SubscriptionPlan,
  SupervisionVerdict,
  TradeRate,
} from '@flph/shared';

// --- GET /clients ----------------------------------------------------------

export interface ClientListResponse {
  clients: Client[];
  total: number;
}

// --- GET /compliance -------------------------------------------------------

/** A stored item plus the date math the API applies on top of it. */
export interface ComplianceRow extends ComplianceItem {
  label: string;
  /** `status` is the human decision; this is that decision aged against today. */
  effectiveStatus: ComplianceStatus;
  daysUntilExpiry: number | null;
}

export interface ComplianceListResponse {
  clientId: string | null;
  items: ComplianceRow[];
  total: number;
  /** Null when staff are browsing the whole book — a verdict is per contractor. */
  verdict: ComplianceVerdict | null;
}

export interface ComplianceMutationResponse {
  item: ComplianceRow | null;
  verdict: ComplianceVerdict;
}

// --- GET /compliance/expiring ---------------------------------------------

export interface ExpiringComplianceRow extends ComplianceRow {
  clientName: string | null;
  clientOnFilingHold: boolean;
}

export interface ComplianceExpiringResponse {
  windowDays: number;
  items: ExpiringComplianceRow[];
  total: number;
  expiredCount: number;
}

// --- GET /documents --------------------------------------------------------

export interface DocumentListResponse {
  documents: PermitDocument[];
  total: number;
}

export interface DocumentUploadResponse {
  document: PermitDocument;
  superseded: PermitDocument | null;
}

// --- GET /signing/requests -------------------------------------------------

/**
 * The list handler drops `renderedBody` and adds `intact`, which is
 * `signatureIntact()` evaluated server-side: signed, but the document text no
 * longer hashes the same. Null for anything not signed.
 */
export interface SignatureRequestRow extends Omit<SignatureRequest, 'renderedBody'> {
  renderedBody?: string;
  label: string;
  intact: boolean | null;
  auditTrail?: SignatureAuditEntry[];
}

export interface SignatureListResponse {
  requests: SignatureRequestRow[];
  total: number;
}

export interface SigningStatusResponse {
  clientId: string;
  serviceLine: ServiceLine;
  verdict: SigningVerdict;
  labels: Record<SignableKind, string>;
  /**
   * Which documents this contractor's service line requires.
   *
   * Sent rather than derived on the page from `client.serviceLine`, which
   * arrives from a different endpoint. If the two ever disagreed the screen
   * would offer a list of agreements the verdict is not judging, and the step
   * would sit at pending against documents nobody is counting.
   */
  required: SignableKind[];
}

// --- GET /drafting ---------------------------------------------------------

export interface DraftingRow extends DraftingRequest {
  nextStep: string;
  requiresSeal: boolean;
  satisfiesRequirementKeys: string[];
}

export interface DraftingListResponse {
  requests: DraftingRow[];
  total: number;
  rates: DraftingRate[];
}

// --- GET /supervision ------------------------------------------------------

export interface SiteVisitListResponse {
  visits: SiteVisit[];
  total: number;
}

/** `GET /supervision/qualifiers` — the stored agent plus its live load. */
export interface QualifierRow extends QualifyingAgent {
  activePermits: number;
  /** Past the self-imposed cap. A qualifier who cannot supervise the work should not be on the permit. */
  overCapacity: boolean;
}

export interface QualifierListResponse {
  qualifiers: QualifierRow[];
  total: number;
}

export interface SupervisionVerdictResponse {
  permitId: string;
  serviceLine: ServiceLine;
  qualifier: QualifyingAgent | null;
  verdict: SupervisionVerdict;
}

// --- GET /billing ----------------------------------------------------------

export interface InvoiceListResponse {
  invoices: Invoice[];
  total: number;
  outstandingCents: number;
}

export interface RateBookResponse {
  rates: TradeRate[];
  updatedAt: string;
  updatedBy: string | null;
}

export interface PlanListResponse {
  plans: SubscriptionPlan[];
  total: number;
}

export interface SubscriptionRow extends Subscription {
  plan: SubscriptionPlan | null;
}

export interface SubscriptionListResponse {
  subscriptions: SubscriptionRow[];
  total: number;
}

/**
 * `GET /billing/subscription` — one contractor's live subscription.
 *
 * Singular because at most one can be live at a time, and the retainer comes
 * with it: a plan running on less cover than it requires is the thing you need
 * to see, and separating them would let a screen show the plan without it.
 */
export interface SubscriptionResponse {
  subscription: SubscriptionRow | null;
  retainer: {
    heldCents: number;
    requiredCents: number;
    shortfallCents: number;
  } | null;
}

// --- GET /projects ---------------------------------------------------------

export interface ProjectRow extends Project {
  clientName: string | null;
  jurisdictionName: string | null;
}

export interface ProjectListResponse {
  projects: ProjectRow[];
  total: number;
}

// --- GET /users ------------------------------------------------------------

export interface UserRow {
  id: ID;
  email: string;
  name: string;
  role: Role;
  clientId: ID | null;
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  hasPassword: boolean;
  clientName: string | null;
  /** Invited, never signed in. The token itself never leaves the API. */
  invitePending: boolean;
  inviteExpiresAt: string | null;
}

export interface UserListResponse {
  users: UserRow[];
  total: number;
  roles: Array<{ role: Role; label: string; description: string }>;
  pendingAuthorization: number;
}

// --- Support ---------------------------------------------------------------
// Mirrors packages/api/src/routes/support.ts, which owns these types.

export const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING_CLIENT', 'RESOLVED'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export interface TicketMessage {
  id: ID;
  authorUserId: ID;
  body: string;
  at: string;
  /** Staff-only. The API strips these before a CLIENT ever sees the ticket. */
  internal: boolean;
}

export interface SupportTicket {
  id: ID;
  reference: string;
  clientId: ID;
  permitId: ID | null;
  subject: string;
  body: string;
  status: TicketStatus;
  priority: TicketPriority;
  messages: TicketMessage[];
  openedByUserId: ID;
  assignedToUserId: ID | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Staff-only field; absent on a portal response. */
  internalMessageCount?: number;
}

export interface TicketListResponse {
  tickets: SupportTicket[];
  total: number;
  openCount: number;
}

// --- Notary ----------------------------------------------------------------
// Mirrors packages/api/src/routes/notary.ts.

export const NOTARY_TYPES = ['RON', 'IN_PERSON'] as const;
export type NotaryType = (typeof NOTARY_TYPES)[number];

export const NOTARY_STATUSES = ['REQUESTED', 'SCHEDULED', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
export type NotaryStatus = (typeof NOTARY_STATUSES)[number];

export const NOTARY_PROVIDERS = ['DOCUSIGN_NOTARY', 'PROOF', 'BLUENOTARY', 'IN_HOUSE'] as const;
export type NotaryProvider = (typeof NOTARY_PROVIDERS)[number];

export const NOTARY_PROVIDER_LABELS: Record<NotaryProvider, string> = {
  DOCUSIGN_NOTARY: 'DocuSign Notary',
  PROOF: 'Proof (formerly Notarize)',
  BLUENOTARY: 'BlueNotary',
  IN_HOUSE: 'In-house commissioned notary',
};

export interface NotaryRequest {
  id: ID;
  clientId: ID;
  documentId: ID;
  signatureRequestId: ID | null;
  type: NotaryType;
  status: NotaryStatus;
  provider: NotaryProvider | null;
  scheduledFor: string | null;
  completedAt: string | null;
  notaryName: string | null;
  notaryCommissionNumber: string | null;
  notaryCommissionExpiresAt: string | null;
  /** Where the audio-video recording lives at the provider. §117.245, F.S. */
  sessionRecordingRef: string | null;
  journalEntryRef: string | null;
  /** completedAt + 10 years. Nothing may be destroyed before this date. */
  retentionUntil: string | null;
  externalId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NotaryListResponse {
  requests: NotaryRequest[];
  total: number;
  openCount: number;
}

// --- Onboarding / billing setup -------------------------------------------

/**
 * What `POST /billing/setup-intent` returns.
 *
 * A deployment with no `STRIPE_SECRET_KEY` is not an error — it is a
 * deployment somebody has not finished setting up — so the endpoint answers
 * 200 with `configured: false` and the UI renders that honestly instead of an
 * error toast or, worse, a dead card form. The two shapes are discriminated on
 * `configured` so nothing can read a `clientSecret` that was never sent.
 */
export interface SetupIntentUnconfigured {
  configured: false;
  reason: string;
}

export interface SetupIntentReady {
  configured: true;
  /** Single-use, scoped to one customer. This is the value Elements needs. */
  clientSecret: string;
  publishableKey: string | null;
  customerId: string;
}

export type SetupIntentResponse = SetupIntentUnconfigured | SetupIntentReady;

/** `GET /billing/payment-methods`. Brand and last four; never a full number. */
export interface PaymentMethodRow {
  id: ID;
  brand: string | null;
  last4: string | null;
}

export interface PaymentMethodListResponse {
  configured: boolean;
  reason?: string;
  customerId: string | null;
  paymentMethods: PaymentMethodRow[];
}

// --- GET /engineering/* ----------------------------------------------------

/**
 * An engineer of record. The licence fields are not decoration: an expired
 * licence cannot seal, so `licenseExpired` decides whether this person can
 * finish a job, not merely whether their details are tidy.
 */
export interface Engineer {
  id: ID;
  userId: ID | null;
  displayName: string;
  licenseType: string;
  licenseNumber: string;
  licenseState: string;
  licenseExpiresOn: string | null;
  licenseExpired: boolean;
  disciplines: string[] | null;
  maxActiveOrders: number | null;
  isActive: boolean;
  /** Open orders on this engineer's desk right now. */
  activeOrders: number;
}

export interface EngineerListResponse {
  engineers: Engineer[];
  total: number;
}

/** A row of `GET /engineering/queue` — a drafting order seen from the desk. */
export interface EngineeringOrder {
  id: ID;
  clientId: ID;
  /** A sequence, not a label -- the column is an integer. */
  orderNumber: number | null;
  projectId: ID | null;
  permitId: ID | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  engineerId: ID | null;
  engineerName: string | null;
  dueDate: string | null;
  quoteStatus: string;
  quotedCents: number | null;
  currentRevision: number | null;
  createdAt: string;
  overdue: boolean;
}

export interface EngineeringQueueResponse {
  orders: EngineeringOrder[];
  total: number;
  overdueCount: number;
  /** Resolved server-side: the caller's own engineer row when none was asked for. */
  engineerId: ID | null;
}

/** A seal is a professional act, so the record keeps the licence as it stood. */
export interface DocumentSeal {
  id: ID;
  documentId: ID;
  documentName: string | null;
  documentVersionId: ID | null;
  sealedByName: string;
  licenseType: string;
  licenseNumber: string;
  licenseState: string;
  sealedAt: string;
  sealReference: string | null;
  note: string | null;
}

export interface SealListResponse {
  seals: DocumentSeal[];
  total: number;
}

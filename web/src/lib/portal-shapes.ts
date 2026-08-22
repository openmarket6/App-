/**
 * Response shapes for `/portal/*` — the contractor-facing API.
 *
 * `types.ts` covers the firm-side permit surface and `api-shapes.ts` the
 * contractor lifecycle. This is the third sibling, and it exists for the same
 * reason as both: the portal router joins and reshapes rows before sending
 * them, and six pages each guessing at that shape is six places to fix when a
 * handler grows a field.
 *
 * Everything here mirrors `packages/api/src/routes/portal.ts`. Keep it in step
 * with that file — the domain types it reuses come from `@flph/shared`, which
 * is the definition, not a copy.
 */
import type {
  DocumentCategory,
  DocumentStatus,
  ID,
  PermitDocument,
  PermitRequest,
  PortalAction,
  PortalFolder,
  Role,
} from '@flph/shared';
import type { SupportTicket, TicketMessage } from './api-shapes.ts';

// --- GET /portal/folders ---------------------------------------------------

export interface PortalTreeResponse {
  clientId: string;
  tree: PortalFolder;
  generatedAt: string;
}

// --- GET /portal/folders/:path --------------------------------------------

/** A breadcrumb step. The API sends only these three fields on the trail. */
export interface PortalTrailStep {
  path: string;
  name: string;
  kind: PortalFolder['kind'];
}

/**
 * A document as the folder listing sends it — the stored row with the display
 * fields joined on and the two facts the UI needs to collapse revisions.
 */
export interface PortalFolderDocument {
  id: ID;
  fileName: string;
  category: DocumentCategory;
  version: number;
  status: DocumentStatus;
  sizeBytes: number;
  contentType: string;
  uploadedAt: string;
  uploadedByName: string | null;
  supersedesId: ID | null;
  capturedAt: string | null;
  /** A newer revision of this file exists. The UI folds it under that one. */
  superseded: boolean;
  supersededById: ID | null;
}

export interface PortalFolderResponse {
  clientId: string;
  folder: PortalFolder;
  trail: PortalTrailStep[];
  documents: PortalFolderDocument[];
  currentCount: number;
  supersededCount: number;
}

// --- POST /portal/folders/:path/upload ------------------------------------

export interface PortalUploadResponse {
  folder: { path: string; name: string };
  document: PermitDocument;
  superseded: PermitDocument | null;
}

// --- GET /portal/actions ---------------------------------------------------

export interface PortalActionsResponse {
  clientId: string;
  actions: PortalAction[];
  total: number;
  blockingCount: number;
  generatedAt: string;
}

// --- Permit requests -------------------------------------------------------

/** The stored request plus `permitRequestNextStep` evaluated server-side. */
export interface PermitRequestRow extends PermitRequest {
  nextStep: string;
}

export interface PermitRequestListResponse {
  clientId: string | null;
  requests: PermitRequestRow[];
  total: number;
  openCount: number;
}

// --- GET /portal/team ------------------------------------------------------

export interface PortalTeamMember {
  id: ID;
  email: string;
  name: string;
  role: Role;
  clientId: ID | null;
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  hasPassword: boolean;
  /** The one person per company who may invite and deactivate logins. */
  clientAdmin: boolean;
  invitePending: boolean;
  inviteExpiresAt: string | null;
}

export interface PortalTeamResponse {
  clientId: string;
  members: PortalTeamMember[];
  total: number;
  activeCount: number;
  adminCount: number;
}

export interface PortalTeamInviteResponse {
  user: PortalTeamMember;
  invitePending: boolean;
  inviteExpiresAt: string | null;
  /** Returned once, on creation only. There is no outbound mail yet. */
  inviteUrl: string | null;
}

export interface PortalTeamPatchResponse {
  user: PortalTeamMember | null;
}

// --- GET/POST /portal/permits/:id/messages --------------------------------

/**
 * Internal staff notes are stripped server-side before this leaves the API, so
 * a contractor's client never holds one. Nothing here renders `internal`.
 */
export interface PortalMessagesResponse {
  permitId: string;
  ticket: SupportTicket | null;
  messages: TicketMessage[];
}

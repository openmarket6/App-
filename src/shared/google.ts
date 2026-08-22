import type { ID } from './types.js';

/**
 * Google Drive and Calendar mirroring.
 *
 * ## Why a service account and a Shared Drive, and not OAuth
 *
 * The obvious approach — connect Ryan's Google account with OAuth and create
 * folders as him — fails in three specific ways that all surface months later:
 *
 *   1. **Ownership.** Every folder and file belongs to that person. When they
 *      leave, change password, or revoke the grant, the company's permit
 *      records go with them. For records that evidence contractor licensing
 *      and insurance, that is not an inconvenience, it is a liability.
 *   2. **Token decay.** A refresh token that expires at 3am produces a silent
 *      sync failure and a Drive that quietly stops matching reality.
 *   3. **The wrong Drive.** Personal My Drive already holds unrelated company
 *      files. Permit records belong somewhere with their own access policy.
 *
 * So: a **service account** writing into a **Shared Drive** that the company
 * owns. The service account is a member, not an owner; people are added and
 * removed from the Shared Drive without touching the integration; and nothing
 * breaks when staff change.
 *
 * One hard constraint worth knowing: **service accounts have no storage quota
 * of their own.** A service account cannot create files in "its" My Drive —
 * the API rejects it. A Shared Drive is not a preference here, it is the only
 * configuration that works.
 *
 * ## Direction of truth
 *
 * The application is the source of truth; Drive is a mirror people can browse,
 * search and share with an inspector or an adjuster. Folders are created from
 * the same derived tree the portal renders, so the two cannot disagree about
 * what folders exist.
 *
 * Files added on the Drive side are detected by the reconcile pass and either
 * reported or imported, depending on configuration — never silently ignored,
 * because a coordinator dropping a correction letter into a Drive folder and
 * finding it absent from the permit is exactly how people stop trusting a
 * system.
 */

export const DRIVE_MIME_FOLDER = 'application/vnd.google-apps.folder';

/** Where a mirrored node lives, and whether it is current. */
export interface DriveLink {
  /** Google Drive file/folder id. */
  driveId: string;
  /** Cached so a rename can be detected without a round trip. */
  name: string;
  webViewLink: string | null;
  /** Last time we successfully wrote or verified this node. */
  syncedAt: string;
  /** Set when the last attempt failed; cleared on success. */
  lastError: string | null;
}

export type DriveNodeKind = 'client' | 'client_section' | 'project' | 'permit' | 'permit_section';

/**
 * The blueprint.
 *
 * Deliberately mirrors `buildFolderTree` in portal.ts — a contractor browsing
 * the portal and a coordinator browsing Drive should see the same shelves with
 * the same names. If you change one, change the other.
 */
export const CLIENT_SECTIONS = [
  {
    key: 'compliance',
    name: '01 Insurance & Licensing',
    description: 'Certificates of insurance, state licence, workers comp or exemption, W-9.',
  },
  {
    key: 'agreements',
    name: '02 Agreements',
    description: 'Service agreement, hold harmless, card authorization, permit agent authorization.',
  },
  {
    key: 'projects',
    name: '03 Jobs',
    description: 'One folder per job site. Permits live inside their job.',
  },
  {
    key: 'correspondence',
    name: '04 Correspondence',
    description: 'Anything that is about the contractor rather than one job.',
  },
] as const;
export type ClientSectionKey = (typeof CLIENT_SECTIONS)[number]['key'];

export const PERMIT_SECTIONS_DRIVE = [
  { key: 'plans', name: '01 Plans & Drawings' },
  { key: 'submittal', name: '02 Submittal Package' },
  { key: 'product-approval', name: '03 Product Approvals & NOAs' },
  { key: 'corrections', name: '04 Correction Responses' },
  { key: 'photos', name: '05 Job Photos' },
  { key: 'from-agency', name: '06 From the Agency' },
  { key: 'inspections', name: '07 Inspections' },
] as const;
export type PermitSectionKey = (typeof PERMIT_SECTIONS_DRIVE)[number]['key'];

/* ------------------------------------------------------------------ */
/* Naming                                                              */
/* ------------------------------------------------------------------ */

/**
 * Drive tolerates almost anything in a name, including duplicates, which is
 * precisely the problem: two folders called "Smith Residence" are
 * indistinguishable to a human and identical to a search. So names are
 * normalised, and every node also carries its record id in Drive's
 * `appProperties` — that, not the name, is how we find a folder again.
 */
export function sanitizeDriveName(input: string): string {
  return input
    .replace(/[\/\\]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export function clientFolderName(client: { name: string; licenseNumber?: string | null }): string {
  const base = sanitizeDriveName(client.name);
  // The licence number disambiguates two contractors trading under similar
  // names, which happens more than you would like in this industry.
  return client.licenseNumber ? `${base} (${client.licenseNumber})` : base;
}

export function projectFolderName(project: { name: string; addressLine1: string; city: string }): string {
  return sanitizeDriveName(`${project.name} — ${project.addressLine1}, ${project.city}`);
}

export function permitFolderName(permit: {
  agencyRecordId: string | null;
  permitType: string;
  createdAt: string;
}): string {
  const type = permit.permitType
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  const ref = permit.agencyRecordId ?? `Unnumbered ${permit.createdAt.slice(0, 10)}`;
  return sanitizeDriveName(`${ref} — ${type}`);
}

/** Written into Drive `appProperties` so a folder can be found by record, not by name. */
export function driveAppProperties(kind: DriveNodeKind, recordId: ID, extra?: Record<string, string>) {
  return { flphKind: kind, flphId: recordId, ...extra };
}

/* ------------------------------------------------------------------ */
/* Calendar                                                            */
/* ------------------------------------------------------------------ */

export const CALENDAR_EVENT_KINDS = [
  'INSPECTION',
  'PERMIT_EXPIRY',
  'PERMIT_EXPIRY_WARNING',
  'DRAFTING_DUE',
  'SITE_VISIT',
  'COMPLIANCE_EXPIRY',
] as const;
export type CalendarEventKind = (typeof CALENDAR_EVENT_KINDS)[number];

export interface CalendarLink {
  eventId: string;
  calendarId: string;
  kind: CalendarEventKind;
  syncedAt: string;
  lastError: string | null;
}

export interface CalendarEventDraft {
  kind: CalendarEventKind;
  /** Stable per source record, so an update patches rather than duplicates. */
  sourceId: ID;
  summary: string;
  description: string;
  location: string | null;
  /** All-day events pass a date; timed events pass an RFC3339 dateTime. */
  start: { date?: string; dateTime?: string };
  end: { date?: string; dateTime?: string };
  /** Minutes before start. Empty means use the calendar default. */
  reminderMinutes: number[];
}

/**
 * Calendar entries earn their place only if they are actionable. An event that
 * fires with no one able to do anything about it teaches people to ignore the
 * calendar, which costs more than the event was worth.
 */
export const CALENDAR_DEFAULTS: Record<CalendarEventKind, { reminderMinutes: number[]; allDay: boolean }> = {
  INSPECTION: { reminderMinutes: [60 * 24, 60], allDay: false },
  PERMIT_EXPIRY: { reminderMinutes: [60 * 24 * 7], allDay: true },
  PERMIT_EXPIRY_WARNING: { reminderMinutes: [60 * 24], allDay: true },
  DRAFTING_DUE: { reminderMinutes: [60 * 24], allDay: true },
  SITE_VISIT: { reminderMinutes: [60], allDay: false },
  COMPLIANCE_EXPIRY: { reminderMinutes: [60 * 24 * 14], allDay: true },
};

/* ------------------------------------------------------------------ */
/* Sync state                                                          */
/* ------------------------------------------------------------------ */

export interface GoogleSyncState {
  id: ID;
  /** 'client' | 'project' | 'permit' | 'document' | 'inspection' | ... */
  entityKind: string;
  entityId: ID;
  drive: DriveLink | null;
  calendar: CalendarLink | null;
  /** Section folders keyed by section key, for client and permit nodes. */
  sections: Record<string, DriveLink> | null;
  updatedAt: string;
}

export interface GoogleConnectionStatus {
  configured: boolean;
  /** Reasons it is not usable, in the order a human should fix them. */
  blockers: string[];
  serviceAccountEmail: string | null;
  sharedDriveId: string | null;
  sharedDriveName: string | null;
  calendarId: string | null;
  lastReconcileAt: string | null;
  lastReconcileSummary: {
    clients: number;
    projects: number;
    permits: number;
    documents: number;
    events: number;
    failures: number;
  } | null;
}

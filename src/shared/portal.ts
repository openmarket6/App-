import type { DocumentCategory, ID, PermitDocument } from './types.js';
import { COMPLIANCE_LABELS, type ComplianceKind } from './compliance.js';

/**
 * The contractor portal's information architecture.
 *
 * A contractor does not think in database categories. They think: "the Sunset
 * Harbour job", "my insurance", "the thing you asked me to sign". So the
 * portal presents a folder tree shaped like that, computed from the same rows
 * the staff side reads — there is no second copy of anything, and no folder
 * that can drift out of sync with reality, because folders are derived rather
 * than stored.
 *
 * Two rules hold the whole thing together:
 *
 *   1. Every folder is derived from data, never created by hand. A contractor
 *      cannot make an empty folder, mis-file a certificate into the wrong job,
 *      or leave a stale folder behind after a project closes.
 *   2. A folder path is not an access control. Scoping is enforced at the
 *      route layer by clientId, exactly as everywhere else. The tree is a
 *      presentation of what someone may already see, never the reason they
 *      may see it.
 */

export type FolderKind =
  | 'root'
  | 'company'
  | 'compliance'
  | 'agreements'
  | 'tax'
  | 'project'
  | 'permit'
  | 'permit_section';

export interface PortalFolder {
  /** Stable path, e.g. "company/compliance" or "projects/<projectId>/permits/<permitId>/plans". */
  path: string;
  name: string;
  kind: FolderKind;
  /** One line telling the contractor what belongs here. Empty folders are useless without it. */
  hint: string | null;
  children: PortalFolder[];
  /** Document ids filed directly in this folder. */
  documentIds: ID[];
  /** Rolled up including children — what the folder badge shows. */
  totalDocuments: number;
  /** Something in here needs the contractor's attention. */
  needsAttention: boolean;
  /** Can the contractor upload directly into this folder? */
  acceptsUpload: boolean;
  /** Categories an upload here should be filed as. */
  uploadCategories: DocumentCategory[];
}

/** Which permit sub-folder a document category belongs in. */
const PERMIT_SECTIONS: Array<{
  key: string;
  name: string;
  hint: string;
  categories: DocumentCategory[];
  acceptsUpload: boolean;
}> = [
  {
    key: 'plans',
    name: 'Plans & drawings',
    hint: 'Signed and sealed plan sets, site plans, truss layouts.',
    categories: ['PLAN_SET'],
    acceptsUpload: true,
  },
  {
    key: 'submittal',
    name: 'Submittal package',
    hint: 'Everything that went to the building department with this application.',
    categories: ['SUBMITTAL'],
    acceptsUpload: true,
  },
  {
    key: 'product-approval',
    name: 'Product approvals',
    hint: 'Florida Product Approval or Miami-Dade NOA sheets for every product in the assembly.',
    categories: ['PRODUCT_APPROVAL'],
    acceptsUpload: true,
  },
  {
    key: 'corrections',
    name: 'Correction responses',
    hint: 'What we sent back to answer the plans examiner.',
    categories: ['CORRECTION_RESPONSE'],
    acceptsUpload: true,
  },
  {
    key: 'photos',
    name: 'Job photos',
    hint: 'Site photos for the application or the inspector. Taken on your phone is fine.',
    categories: ['JOB_PHOTO', 'SUPERVISION_PHOTO'],
    acceptsUpload: true,
  },
  {
    key: 'from-agency',
    name: 'From the agency',
    hint: 'The issued permit card, correction notices, inspection results.',
    categories: ['AGENCY_ISSUED'],
    acceptsUpload: false,
  },
];

export interface FolderTreeInput {
  documents: PermitDocument[];
  projects: Array<{ id: ID; name: string; addressLine1: string; city: string }>;
  permits: Array<{ id: ID; projectId: ID; permitType: string; agencyRecordId: string | null; stage: string }>;
  /** Compliance kinds still missing or expired, so the folder can flag itself. */
  complianceGapKinds?: ComplianceKind[];
  /** Signable kinds still awaiting signature. */
  pendingSignatureCount?: number;
}

function folder(partial: Partial<PortalFolder> & Pick<PortalFolder, 'path' | 'name' | 'kind'>): PortalFolder {
  return {
    hint: null,
    children: [],
    documentIds: [],
    totalDocuments: 0,
    needsAttention: false,
    acceptsUpload: false,
    uploadCategories: [],
    ...partial,
  };
}

function rollUp(f: PortalFolder): number {
  f.totalDocuments = f.documentIds.length + f.children.reduce((sum, c) => sum + rollUp(c), 0);
  f.needsAttention = f.needsAttention || f.children.some((c) => c.needsAttention);
  return f.totalDocuments;
}

/**
 * Builds the contractor's whole tree in one pass.
 *
 * Deliberately pure and synchronous: given the same rows it always produces
 * the same tree, which means the portal and any staff-side preview of "what
 * does this contractor see" cannot disagree.
 */
export function buildFolderTree(input: FolderTreeInput): PortalFolder {
  const byPermit = new Map<ID, PermitDocument[]>();
  const companyDocs: PermitDocument[] = [];

  for (const d of input.documents) {
    if (d.permitId) {
      const list = byPermit.get(d.permitId) ?? [];
      list.push(d);
      byPermit.set(d.permitId, list);
    } else {
      companyDocs.push(d);
    }
  }

  const pick = (docs: PermitDocument[], cats: DocumentCategory[]) =>
    docs.filter((d) => cats.includes(d.category)).map((d) => d.id);

  // --- company folder ---
  const compliance = folder({
    path: 'company/compliance',
    name: 'Insurance & licensing',
    kind: 'compliance',
    hint: 'Certificates of insurance, your state licence, workers comp or your exemption. Keep these current — an expired policy stops us filing.',
    documentIds: pick(companyDocs, ['COMPLIANCE']),
    acceptsUpload: true,
    uploadCategories: ['COMPLIANCE'],
    needsAttention: (input.complianceGapKinds?.length ?? 0) > 0,
  });

  const agreements = folder({
    path: 'company/agreements',
    name: 'Agreements',
    kind: 'agreements',
    hint: 'Your service agreement, hold harmless, card authorization and permit agent authorization.',
    documentIds: pick(companyDocs, ['SIGNED_AGREEMENT']),
    acceptsUpload: false,
    needsAttention: (input.pendingSignatureCount ?? 0) > 0,
  });

  const tax = folder({
    path: 'company/tax',
    name: 'Tax & business',
    kind: 'tax',
    hint: 'W-9, business tax receipt, anything your accountant needs from us.',
    documentIds: pick(companyDocs, ['OTHER']),
    acceptsUpload: true,
    uploadCategories: ['OTHER'],
  });

  const company = folder({
    path: 'company',
    name: 'My company',
    kind: 'company',
    hint: 'Paperwork that belongs to your business rather than to one job.',
    children: [compliance, agreements, tax],
  });

  // --- project folders ---
  const permitsByProject = new Map<ID, FolderTreeInput['permits']>();
  for (const p of input.permits) {
    const list = permitsByProject.get(p.projectId) ?? [];
    list.push(p);
    permitsByProject.set(p.projectId, list);
  }

  const projectFolders = input.projects.map((project) => {
    const permitFolders = (permitsByProject.get(project.id) ?? []).map((permit) => {
      const docs = byPermit.get(permit.id) ?? [];
      const sections = PERMIT_SECTIONS.map((s) =>
        folder({
          path: `projects/${project.id}/permits/${permit.id}/${s.key}`,
          name: s.name,
          kind: 'permit_section',
          hint: s.hint,
          documentIds: pick(docs, s.categories),
          acceptsUpload: s.acceptsUpload,
          uploadCategories: s.categories,
        }),
      );

      return folder({
        path: `projects/${project.id}/permits/${permit.id}`,
        name: permit.agencyRecordId
          ? `${permit.agencyRecordId} — ${humanType(permit.permitType)}`
          : `${humanType(permit.permitType)} (not yet numbered)`,
        kind: 'permit',
        hint: `Currently ${humanStage(permit.stage)}.`,
        children: sections,
      });
    });

    return folder({
      path: `projects/${project.id}`,
      name: project.name,
      kind: 'project',
      hint: `${project.addressLine1}, ${project.city}`,
      children: permitFolders,
    });
  });

  const projects = folder({
    path: 'projects',
    name: 'Jobs',
    kind: 'root',
    hint: 'One folder per job, with a folder inside for each permit on it.',
    children: projectFolders,
  });

  const root = folder({
    path: '',
    name: 'All files',
    kind: 'root',
    children: [company, projects],
  });

  rollUp(root);
  return root;
}

export function findFolder(root: PortalFolder, path: string): PortalFolder | null {
  if (root.path === path) return root;
  for (const c of root.children) {
    const hit = findFolder(c, path);
    if (hit) return hit;
  }
  return null;
}

/** Breadcrumb trail from the root down to `path`, inclusive. */
export function folderTrail(root: PortalFolder, path: string): PortalFolder[] {
  if (root.path === path) return [root];
  for (const c of root.children) {
    const trail = folderTrail(c, path);
    if (trail.length) return [root, ...trail];
  }
  return [];
}

/* ------------------------------------------------------------------ */
/* "Needs you" queue                                                   */
/* ------------------------------------------------------------------ */

export type ActionUrgency = 'blocking' | 'soon' | 'informational';

export interface PortalAction {
  id: string;
  urgency: ActionUrgency;
  title: string;
  detail: string;
  /** Where clicking it should go. */
  href: string;
  cta: string;
  /** Sort weight — lower is more urgent. */
  weight: number;
}

export interface PortalActionInput {
  complianceGaps: Array<{ kind: ComplianceKind; status: string; daysUntilExpiry: number | null; blocksFiling: boolean }>;
  pendingSignatures: Array<{ id: ID; kind: string; label: string }>;
  correctionsAwaitingResponse: Array<{ id: ID; permitId: ID; permitLabel: string; cycle: number }>;
  unpaidInvoices: Array<{ id: ID; number: string; balanceCents: number; overdue: boolean }>;
  draftingAwaitingApproval: Array<{ id: ID; quotedCents: number | null }>;
  missingPaymentMethod: boolean;
}

/**
 * The single list a contractor should read every morning.
 *
 * Ordered by what actually stops work, not by what is easiest to compute.
 * Expired insurance outranks an unsigned form, which outranks an unpaid
 * invoice, because only the first one prevents us filing anything at all.
 */
export function buildActionQueue(input: PortalActionInput): PortalAction[] {
  const actions: PortalAction[] = [];

  for (const gap of input.complianceGaps) {
    const label = COMPLIANCE_LABELS[gap.kind] ?? gap.kind;
    if (gap.status === 'EXPIRED' || gap.status === 'MISSING' || gap.status === 'REJECTED') {
      actions.push({
        id: `compliance-${gap.kind}`,
        urgency: gap.blocksFiling ? 'blocking' : 'soon',
        title: gap.blocksFiling ? `${label} is stopping new filings` : `${label} needs updating`,
        detail:
          gap.status === 'MISSING'
            ? 'We do not have this on file yet.'
            : gap.status === 'EXPIRED'
              ? `Expired ${Math.abs(gap.daysUntilExpiry ?? 0)} days ago.`
              : 'The copy on file was not accepted — check the note and send a replacement.',
        href: '/files/company/compliance',
        cta: 'Upload it',
        weight: gap.blocksFiling ? 0 : 20,
      });
    } else if (gap.status === 'EXPIRING_SOON') {
      actions.push({
        id: `compliance-${gap.kind}`,
        urgency: 'soon',
        title: `${label} expires in ${gap.daysUntilExpiry} days`,
        detail: 'Ask your agent for the renewal certificate now and we will never have to stop a filing.',
        href: '/files/company/compliance',
        cta: 'Upload renewal',
        weight: 10,
      });
    }
  }

  for (const c of input.correctionsAwaitingResponse) {
    actions.push({
      id: `correction-${c.id}`,
      urgency: 'blocking',
      title: `${c.permitLabel} has corrections to answer`,
      detail: `Cycle ${c.cycle}. The agency is waiting on us — nothing moves until this is answered.`,
      href: `/permits/${c.permitId}`,
      cta: 'See what they asked for',
      weight: 5,
    });
  }

  for (const s of input.pendingSignatures) {
    actions.push({
      id: `sign-${s.id}`,
      urgency: 'blocking',
      title: `${s.label} is waiting for your signature`,
      detail: 'Takes about a minute. You can read the whole document first.',
      href: `/sign/${s.id}`,
      cta: 'Read and sign',
      weight: 15,
    });
  }

  for (const d of input.draftingAwaitingApproval) {
    actions.push({
      id: `drafting-${d.id}`,
      urgency: 'soon',
      title: 'A drafting quote is waiting for your approval',
      detail: d.quotedCents != null ? 'Approve it and our team starts on the plans.' : 'We have scoped it and sent a price.',
      href: '/drafting',
      cta: 'Review the quote',
      weight: 30,
    });
  }

  if (input.missingPaymentMethod) {
    actions.push({
      id: 'payment-method',
      urgency: 'soon',
      title: 'No payment method on file',
      detail: 'Add a card so permit fees can be advanced without waiting on a transfer.',
      href: '/account/billing',
      cta: 'Add a card',
      weight: 40,
    });
  }

  for (const inv of input.unpaidInvoices) {
    actions.push({
      id: `invoice-${inv.id}`,
      urgency: inv.overdue ? 'soon' : 'informational',
      title: inv.overdue ? `Invoice ${inv.number} is overdue` : `Invoice ${inv.number} is due`,
      detail: 'Agency fees we advanced are itemised separately from our own fee.',
      href: '/invoices',
      cta: 'View invoice',
      weight: inv.overdue ? 45 : 60,
    });
  }

  return actions.sort((a, b) => a.weight - b.weight);
}

function humanType(t: string): string {
  return t
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function humanStage(s: string): string {
  return humanType(s).toLowerCase();
}

/* ------------------------------------------------------------------ */
/* Permit requests                                                     */
/* ------------------------------------------------------------------ */

/**
 * What a contractor submits when they want a permit pulled.
 *
 * Deliberately NOT a permit. A contractor filling in a permit row directly
 * would be filing under their own name with no compliance check, no
 * jurisdiction mapping, and no coordinator eyes on it. A request is an intake
 * form: it captures what they know, and a coordinator turns it into a real
 * permit once the address is resolved to a jurisdiction and the paperwork
 * checks out. That triage step is the service.
 */
export const PERMIT_REQUEST_STATUSES = [
  'SUBMITTED',
  'IN_TRIAGE',
  'NEEDS_INFO',
  'ACCEPTED',
  'DECLINED',
  'WITHDRAWN',
] as const;
export type PermitRequestStatus = (typeof PERMIT_REQUEST_STATUSES)[number];

export interface PermitRequest {
  id: ID;
  clientId: ID;
  /** Set once triage links it to a real project. */
  projectId: ID | null;
  /** Set once accepted and a permit exists. */
  permitId: ID | null;
  status: PermitRequestStatus;
  /** What the contractor told us, in their words. */
  scopeOfWork: string;
  addressLine1: string;
  city: string;
  zip: string;
  county: string | null;
  /** Their best guess. Triage confirms it. */
  suggestedPermitType: string | null;
  estimatedValueCents: number | null;
  desiredStartDate: string | null;
  /** Anything they uploaded with the request — sketches, a survey, photos. */
  attachmentIds: ID[];
  /** Coordinator's note back to them when status is NEEDS_INFO or DECLINED. */
  triageNote: string | null;
  triagedByUserId: ID | null;
  triagedAt: string | null;
  submittedByUserId: ID;
  createdAt: string;
  updatedAt: string;
}

export function permitRequestNextStep(r: Pick<PermitRequest, 'status' | 'triageNote'>): string {
  switch (r.status) {
    case 'SUBMITTED':
      return 'With our team. We will confirm the jurisdiction and come back to you.';
    case 'IN_TRIAGE':
      return 'A coordinator is working out which jurisdiction and permit type this needs.';
    case 'NEEDS_INFO':
      return r.triageNote ?? 'We need something more from you before we can file.';
    case 'ACCEPTED':
      return 'Accepted. Track it on the permit itself from here on.';
    case 'DECLINED':
      return r.triageNote ?? 'We could not take this one on.';
    case 'WITHDRAWN':
      return 'Withdrawn.';
    default:
      return '';
  }
}

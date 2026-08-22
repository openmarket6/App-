import type { ID } from './types.js';

/**
 * In-app signing.
 *
 * The federal E-SIGN Act and Florida's UETA make an electronic signature as
 * enforceable as ink, but only if you can show three things later: that the
 * signer intended to sign, that they saw the document they were signing, and
 * that neither has changed since. So the record below stores a hash of the
 * exact rendered document alongside the signature, not just a name and a date.
 * If the template is edited afterwards, the hash stops matching and the
 * mismatch is visible rather than silently papered over.
 *
 * Have counsel review the templates themselves. This module is the mechanism,
 * not the legal opinion.
 */

export const SIGNABLE_KINDS = [
  'MASTER_SERVICE_AGREEMENT',
  'HOLD_HARMLESS',
  'CREDIT_CARD_AUTHORIZATION',
  'MANAGED_LICENSE_ADDENDUM',
  'W9_ACKNOWLEDGEMENT',
  'PERMIT_AGENT_AUTHORIZATION',
] as const;
export type SignableKind = (typeof SIGNABLE_KINDS)[number];

export const SIGNABLE_LABELS: Record<SignableKind, string> = {
  MASTER_SERVICE_AGREEMENT: 'Master service agreement',
  HOLD_HARMLESS: 'Hold harmless and indemnification agreement',
  CREDIT_CARD_AUTHORIZATION: 'Credit card / ACH authorization',
  MANAGED_LICENSE_ADDENDUM: 'Managed licence and supervision addendum',
  W9_ACKNOWLEDGEMENT: 'W-9 acknowledgement',
  PERMIT_AGENT_AUTHORIZATION: 'Permit agent authorization',
};

/** Which documents each service line requires before the contractor is live. */
export const REQUIRED_SIGNABLES: Record<'EXPEDITING' | 'MANAGED_LICENSE', SignableKind[]> = {
  EXPEDITING: ['MASTER_SERVICE_AGREEMENT', 'HOLD_HARMLESS', 'CREDIT_CARD_AUTHORIZATION', 'PERMIT_AGENT_AUTHORIZATION'],
  MANAGED_LICENSE: [
    'MASTER_SERVICE_AGREEMENT',
    'HOLD_HARMLESS',
    'CREDIT_CARD_AUTHORIZATION',
    'MANAGED_LICENSE_ADDENDUM',
    'PERMIT_AGENT_AUTHORIZATION',
  ],
};

export interface SignableTemplate {
  id: ID;
  kind: SignableKind;
  version: number;
  title: string;
  /** Markdown with {{placeholders}}. Rendered per contractor at send time. */
  body: string;
  /** Set once a template version has been signed by anyone — edits then fork a new version. */
  locked: boolean;
  createdAt: string;
  createdBy: ID;
}

export type SignatureRequestStatus = 'DRAFT' | 'SENT' | 'VIEWED' | 'SIGNED' | 'DECLINED' | 'VOIDED' | 'EXPIRED';

export interface SignatureRequest {
  id: ID;
  clientId: ID;
  templateId: ID;
  kind: SignableKind;
  templateVersion: number;
  status: SignatureRequestStatus;
  /** The exact text presented to the signer, placeholders already resolved. */
  renderedBody: string;
  /** SHA-256 of renderedBody. The tamper check. */
  renderedHash: string;
  /** Who we asked. */
  signerName: string;
  signerEmail: string;
  signerTitle: string | null;
  sentAt: string | null;
  viewedAt: string | null;
  signedAt: string | null;
  declinedAt: string | null;
  declineReason: string | null;
  expiresAt: string | null;
  signature: SignatureEvidence | null;
  createdAt: string;
}

export interface SignatureEvidence {
  /** Typed full name, as entered by the signer. */
  typedName: string;
  /** Data URL of a drawn signature, when the signer drew one. */
  drawnSignaturePng: string | null;
  /** Explicit affirmative consent to sign electronically — E-SIGN requires it be affirmative. */
  consentToElectronicSignature: boolean;
  ipAddress: string;
  userAgent: string;
  signedAt: string;
  /** Recomputed at signing time. Must equal SignatureRequest.renderedHash. */
  documentHashAtSigning: string;
  /** Monotonic audit entries: sent, opened, scrolled to end, signed. */
  auditTrail: SignatureAuditEntry[];
}

export interface SignatureAuditEntry {
  at: string;
  event: 'created' | 'sent' | 'opened' | 'read_to_end' | 'signed' | 'declined' | 'voided' | 'reminder_sent';
  ipAddress: string | null;
  detail: string | null;
}

export function isSigned(r: Pick<SignatureRequest, 'status'>): boolean {
  return r.status === 'SIGNED';
}

/** Does the signature still attest to the document as it exists now? */
export function signatureIntact(r: SignatureRequest): boolean {
  if (!r.signature) return false;
  return r.signature.documentHashAtSigning === r.renderedHash;
}

export interface SigningVerdict {
  complete: boolean;
  missing: SignableKind[];
  pending: SignableKind[];
  /** Signed, but the underlying document no longer hashes the same. Investigate. */
  compromised: SignableKind[];
}

export function assessSigning(
  requests: SignatureRequest[],
  serviceLine: 'EXPEDITING' | 'MANAGED_LICENSE',
): SigningVerdict {
  const required = REQUIRED_SIGNABLES[serviceLine];
  const byKind = new Map<SignableKind, SignatureRequest>();
  for (const r of requests) {
    const cur = byKind.get(r.kind);
    // Prefer a signed request over any other state for the same kind.
    if (!cur || (r.status === 'SIGNED' && cur.status !== 'SIGNED')) byKind.set(r.kind, r);
  }

  const missing: SignableKind[] = [];
  const pending: SignableKind[] = [];
  const compromised: SignableKind[] = [];

  for (const kind of required) {
    const r = byKind.get(kind);
    if (!r) {
      missing.push(kind);
      continue;
    }
    if (r.status === 'SIGNED') {
      if (!signatureIntact(r)) compromised.push(kind);
      continue;
    }
    if (r.status === 'DECLINED' || r.status === 'VOIDED' || r.status === 'EXPIRED') missing.push(kind);
    else pending.push(kind);
  }

  return { complete: missing.length === 0 && pending.length === 0 && compromised.length === 0, missing, pending, compromised };
}

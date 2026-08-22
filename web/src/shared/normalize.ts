import type { PermitStage } from './enums.ts';

/**
 * Status normalization.
 *
 * Design rule: when we cannot map an agency's status string we surface it as
 * unmapped rather than guessing a stage. A wrong stage silently removes a permit
 * from a follow-up queue; a missing stage is visible in the console and someone
 * fixes it. Guessing is the expensive failure, not admitting ignorance.
 */

export interface NormalizationResult {
  stage: PermitStage | null;
  matchedRule: string | null;
  canonical: string;
}

/** Lowercase, collapse punctuation and whitespace so "Corrections Required!" == "corrections required". */
export function canonicalize(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[_\-/\\.,:;!?()[\]{}"']+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface Rule {
  name: string;
  test: RegExp;
  stage: PermitStage;
}

/**
 * Order matters: the first match wins, so more specific rules go first.
 *
 * Note the deliberate absence of a trailing \b on stem patterns. An earlier
 * version wrote /\bcorrection\b/ which matched "correction" but not
 * "corrections" — the plural is what most agencies actually emit.
 */
const RULES: Rule[] = [
  { name: 'denied', test: /\b(denied|denial|rejected application|disapproved)/, stage: 'DENIED' },
  { name: 'withdrawn', test: /\b(withdrawn|cancell?ed by applicant|voided)/, stage: 'WITHDRAWN' },
  { name: 'expired', test: /\b(expired|lapsed|abandoned)/, stage: 'EXPIRED' },
  { name: 'closed', test: /\b(closed|finaled|final(ed)? out|certificate of occupancy issued|co issued|completed)/, stage: 'CLOSED' },
  { name: 'inspections', test: /\b(inspection|inspections|ready for inspection|in inspection|active permit)/, stage: 'INSPECTIONS' },
  { name: 'issued', test: /\b(issued|permit issued|active|picked up|released)/, stage: 'ISSUED' },
  { name: 'approved', test: /\b(approved|ready to issue|ready for issuance|pending payment|awaiting payment|approved pending fees)/, stage: 'APPROVED' },
  { name: 'resubmitted', test: /\b(resubmit|re submit|revision received|revised plans received|second review|resubmittal received)/, stage: 'RESUBMITTED' },
  { name: 'corrections', test: /\b(correction|comments issued|revisions? required|deficien|rejected plan|plan review comments|needs revision|disapproved plan)/, stage: 'CORRECTIONS_REQUIRED' },
  { name: 'in_review', test: /\b(in review|plan review|under review|routing|reviewing|distributed|in plan check|plan check)/, stage: 'IN_REVIEW' },
  { name: 'intake', test: /\b(intake|screening|accepted for processing|application accepted|pre screen|prescreen|logged in)/, stage: 'INTAKE_REVIEW' },
  { name: 'submitted', test: /\b(submitted|received|filed|application received|new application|pending)/, stage: 'SUBMITTED' },
  { name: 'ready_to_submit', test: /\b(ready to submit|ready for submittal|package complete)/, stage: 'READY_TO_SUBMIT' },
  { name: 'draft', test: /\b(draft|incomplete|not submitted|started|saved)/, stage: 'DRAFT' },
];

export function normalizeStatus(raw: string | null | undefined): NormalizationResult {
  const canonical = canonicalize(raw ?? '');
  if (!canonical) return { stage: null, matchedRule: null, canonical };
  for (const rule of RULES) {
    if (rule.test.test(canonical)) {
      return { stage: rule.stage, matchedRule: rule.name, canonical };
    }
  }
  return { stage: null, matchedRule: null, canonical };
}

export function ruleCount(): number {
  return RULES.length;
}

export function ruleNames(): string[] {
  return RULES.map((r) => r.name);
}

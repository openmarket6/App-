/**
 * Accela status mapping.
 *
 * This is the layer where a wrong answer reaches a contractor as a fact. Every
 * agency writes its own status names, so these tests use the phrasings that
 * actually appear across Florida agencies rather than a tidy invented set.
 *
 * The rule the whole file exists to protect: an unrecognised status becomes
 * 'unknown' and a person looks at it. It is never rounded to the nearest
 * familiar value.
 */
import { describe, it, expect } from 'vitest';
import {
  toDetectedStatus, toInspectionOutcome, looksLikeCorrection,
} from '../src/services/municipalities/accela/mapping.js';

describe('permit status mapping', () => {
  it('reads the ordinary progression', () => {
    expect(toDetectedStatus('Application Submitted')).toBe('submitted');
    expect(toDetectedStatus('Plan Review')).toBe('under_review');
    expect(toDetectedStatus('Approved')).toBe('approved');
    expect(toDetectedStatus('Issued')).toBe('issued');
    expect(toDetectedStatus('Finaled')).toBe('closed');
  });

  it('copes with each agency spelling it differently', () => {
    for (const variant of ['In Plan Review', 'PLANS ROUTED', 'in_process', 'Under Review', 'Processing']) {
      expect(toDetectedStatus(variant), variant).toBe('under_review');
    }
  });

  it('finds the correction inside a review status', () => {
    // The ordering rule. "Plan Review - Corrections Required" contains both
    // words; matching "review" first would file it as an ordinary review and
    // the contractor would never be told there is work to do.
    expect(toDetectedStatus('Plan Review - Corrections Required')).toBe('corrections_required');
    // Not a refused application: a live one whose drawings need fixing. A
    // contractor told "rejected" believes the job is dead and stops working it.
    expect(toDetectedStatus('Rejected Plans / Resubmit')).toBe('corrections_required');
    expect(toDetectedStatus('Denied - Corrections Required')).toBe('corrections_required');
    // A refusal with no route back still reads as a refusal.
    expect(toDetectedStatus('Denied')).toBe('rejected');
    expect(toDetectedStatus('Incomplete - Additional Information Needed')).toBe('corrections_required');
    expect(toDetectedStatus('On Hold')).toBe('corrections_required');
  });

  it('does not understate an issued permit as merely approved', () => {
    // An issued permit means work may lawfully begin; approved does not.
    expect(toDetectedStatus('Permit Issued')).toBe('issued');
    expect(toDetectedStatus('Ready to Issue')).toBe('approved');
  });

  it('separates a refusal from a closure', () => {
    expect(toDetectedStatus('Denied')).toBe('rejected');
    expect(toDetectedStatus('Revoked')).toBe('rejected');
    expect(toDetectedStatus('Withdrawn')).toBe('closed');
    expect(toDetectedStatus('Expired')).toBe('expired');
  });

  it('says unknown rather than guessing', () => {
    // The most important test here. A guess that reads "issued" sends a crew to
    // a site they may not lawfully work; 'unknown' makes a person look.
    for (const odd of ['Tier 3', 'AHJ Referral', 'Ordinance 22-14', 'XYZ']) {
      expect(toDetectedStatus(odd), odd).toBe('unknown');
    }
    expect(toDetectedStatus(null)).toBe('unknown');
    expect(toDetectedStatus('')).toBe('unknown');
    expect(toDetectedStatus('   ')).toBe('unknown');
  });
});

describe('inspection outcome mapping', () => {
  it('reads the common results', () => {
    expect(toInspectionOutcome('Passed')).toBe('passed');
    expect(toInspectionOutcome('Approved')).toBe('passed');
    expect(toInspectionOutcome('Failed')).toBe('failed');
    expect(toInspectionOutcome('Scheduled')).toBe('scheduled');
  });

  it('does not round a partial pass up to a pass', () => {
    // "Passed with conditions" means work remains. Recording it as a clean pass
    // is how a condition is forgotten until the final inspection fails over it.
    expect(toInspectionOutcome('Passed with Conditions')).toBe('partial');
    expect(toInspectionOutcome('Partial Approval')).toBe('partial');
    expect(toInspectionOutcome('Approved - Corrections Noted')).toBe('partial');
  });

  it('tells a no-show apart from a failure', () => {
    // Both leave the work uninspected, but only one is the contractor's fault
    // and only one is chargeable. Conflating them starts arguments.
    expect(toInspectionOutcome('No Show')).toBe('no_show');
    expect(toInspectionOutcome('Not Ready')).toBe('no_show');
    expect(toInspectionOutcome('Failed - Not Ready')).toBe('no_show');
  });

  it('says unknown rather than guessing', () => {
    expect(toInspectionOutcome('Tier 2 Referral')).toBe('unknown');
    expect(toInspectionOutcome(null)).toBe('unknown');
  });
});

describe('spotting a correction in a plan-review comment', () => {
  it('recognises the usual phrasings', () => {
    expect(looksLikeCorrection('Provide signed and sealed truss layout')).toBe(true);
    expect(looksLikeCorrection('Wind load calculations are missing')).toBe(true);
    expect(looksLikeCorrection('Please revise sheet A-3 and resubmit')).toBe(true);
  });

  it('ignores an ordinary note', () => {
    expect(looksLikeCorrection('Routed to structural on 4 March')).toBe(false);
    expect(looksLikeCorrection('Fee paid in full')).toBe(false);
    expect(looksLikeCorrection(null)).toBe(false);
  });
});

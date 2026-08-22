/**
 * The Notice of Commencement threshold.
 *
 * A missing or defective NOC is not paperwork. It stops the building
 * department performing the first inspection, and it bears on lien rights.
 *
 * The rule lived in two places with two different numbers. The filing gate
 * enforced $2,500. The contractor's checklist only asked for an NOC once a job
 * passed $250,000 -- while the label on that very line claimed $5,000. So a
 * $50,000 re-roof showed no NOC on the checklist and was then refused at
 * filing; and if the checklist is what people trust, the NOC gets missed on a
 * job that legally needs one.
 *
 * The number is $7,500: Fla. Stat. 713.02(5) exempts direct contracts of
 * $7,500 or less, so the trigger is strictly greater than the threshold.
 *
 * These tests exist so the two cannot drift apart again, and so the figure
 * itself cannot be changed silently.
 */
import { describe, it, expect } from 'vitest';
import { buildRequirements } from '../src/shared/requirements.js';
import { NOC_THRESHOLD_CENTS } from '../src/shared/requirements.js';
import { NOC_THRESHOLD_CENTS as GATE_THRESHOLD } from '../src/domain/permitIntake.js';

const project = (valuationCents: number) => ({
  valuationCents,
  ownerBuilder: false,
  floodZone: null,
  coastalConstructionControlLine: false,
  county: 'Miami-Dade',
});

const jurisdiction = { paperOnly: false, hvhz: false, county: 'Miami-Dade' };

const hasNoc = (valuationCents: number): boolean => {
  const reqs = buildRequirements({
    permitType: 'roofing',
    project: project(valuationCents),
    jurisdiction,
  } as never);
  return reqs.some((r: { key: string }) => r.key === 'notice_of_commencement');
};

describe('the NOC threshold', () => {
  it('is one number, shared by the checklist and the filing gate', () => {
    // The whole bug in one assertion. These were 250_000 and 250_000_00.
    expect(GATE_THRESHOLD).toBe(NOC_THRESHOLD_CENTS);
  });

  it('is $7,500', () => {
    // Pinned deliberately. This is a legal threshold, not a tuning knob --
    // changing it should require changing this line and saying why.
    expect(NOC_THRESHOLD_CENTS).toBe(750_000);
  });

  it('exempts a contract of exactly $7,500', () => {
    // 713.02(5) exempts contracts of $7,500 "or less", so the boundary case
    // is exempt. Greater-or-equal here would demand an NOC the statute does
    // not require, on every job that lands exactly on the number.
    expect(hasNoc(7_500_00)).toBe(false);
  });

  it('asks for one at $7,500.01', () => {
    expect(hasNoc(7_500_00 + 1)).toBe(true);
  });

  it('does not ask on a small service call', () => {
    // $1,200 water heater swap. Asking for a recorded NOC here sends the
    // contractor to the county clerk for nothing.
    expect(hasNoc(1_200_00)).toBe(false);
  });

  it('asks for an NOC on an ordinary re-roof', () => {
    // $50,000. Previously showed nothing, because the rule was nested inside
    // a $250,000 branch.
    expect(hasNoc(50_000_00)).toBe(true);
  });

  it('asks for one just above the threshold', () => {
    expect(hasNoc(NOC_THRESHOLD_CENTS + 1)).toBe(true);
  });

  it('does not ask for one on a small job below it', () => {
    expect(hasNoc(NOC_THRESHOLD_CENTS - 1)).toBe(false);
  });

  it('still asks on a large job', () => {
    // The old behaviour was not wrong here, only wrong everywhere below it.
    expect(hasNoc(500_000_00)).toBe(true);
  });

  it('states the threshold it actually used', () => {
    // The old label said $5,000 while the code used $250,000. A reason a
    // contractor cannot verify is a reason they cannot act on.
    const reqs = buildRequirements({
      permitType: 'roofing',
      project: project(50_000_00),
      jurisdiction,
    } as never);
    const noc = reqs.find((r: { key: string }) => r.key === 'notice_of_commencement') as
      | { because: string }
      | undefined;
    expect(noc?.because).toContain((NOC_THRESHOLD_CENTS / 100).toLocaleString('en-US'));
  });
});

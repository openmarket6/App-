/**
 * Matching a database municipality to its reference entry.
 *
 * The connector roadmap screen was dead for want of this. Its endpoints
 * answered 501, and even once they existed the screen reads j.gate[key]
 * directly — so a row with no gate would have failed it a second time.
 *
 * The two sides disagree in three boring ways, and each one alone was enough:
 *
 *   dataset "Alachua County"     database "Alachua"
 *   dataset "City of Miami"      database "Miami"
 *   dataset kind "municipality"  database kind "city"
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeJurisdictionName, normalizeJurisdictionKind, matchJurisdiction, UNKNOWN_GATE,
} from '../src/shared/jurisdictionMatch.js';
import { JURISDICTIONS } from '../src/shared/data/jurisdictions.data.js';
import { pathwayForTier } from '../src/shared/integration.js';

describe('normalising a jurisdiction name', () => {
  it('drops the County suffix the dataset carries', () => {
    expect(normalizeJurisdictionName('Alachua County'))
      .toBe(normalizeJurisdictionName('Alachua'));
  });

  it('drops the City of / Town of / Village of prefixes', () => {
    for (const prefix of ['City of', 'Town of', 'Village of']) {
      expect(normalizeJurisdictionName(`${prefix} Miami`))
        .toBe(normalizeJurisdictionName('Miami'));
    }
  });

  it('strips the prefix before punctuation, not after', () => {
    /*
     * Order matters. Removing punctuation first turns "City of St. Petersburg"
     * into "cityofstpetersburg", and the prefix rule then never fires.
     */
    expect(normalizeJurisdictionName('City of St. Petersburg'))
      .toBe(normalizeJurisdictionName('St. Petersburg'));
  });

  it('ignores case, spacing and hyphens', () => {
    expect(normalizeJurisdictionName('MIAMI-DADE'))
      .toBe(normalizeJurisdictionName('Miami Dade'));
  });

  it('handles null without throwing', () => {
    expect(normalizeJurisdictionName(null)).toBe('');
    expect(normalizeJurisdictionName(undefined)).toBe('');
  });
});

describe('matching against the reference dataset', () => {
  it('matches a county written either way', () => {
    expect(matchJurisdiction('Alachua', 'Alachua', 'county')?.slug).toBe('fl-alachua-county');
    expect(matchJurisdiction('Alachua County', 'Alachua', 'county')?.slug)
      .toBe('fl-alachua-county');
  });

  it('matches a city the dataset prefixes', () => {
    const m = matchJurisdiction('Miami', 'Miami-Dade', 'city');
    expect(m).toBeTruthy();
    expect(m!.name).toMatch(/Miami/);
  });

  it('returns null rather than guessing', () => {
    /*
     * Five of the 103 jurisdictions in the database genuinely have no entry.
     * A near-miss match would give them somebody else's integration gate, which
     * is worse than none: the screen would promise an API pathway nobody has
     * checked exists.
     */
    expect(matchJurisdiction('Nowhere', 'Nowhere', 'county')).toBeNull();
  });

  it('gives an unmatched jurisdiction a gate that reads as manual', () => {
    // Everything false lands the readiness engine on `manual`, which is the
    // honest answer for a place we know nothing about.
    expect(UNKNOWN_GATE.publicApi).toBe(false);
    expect(UNKNOWN_GATE.sandboxAvailable).toBe(false);
  });

  it('covers the counties the dataset claims to', () => {
    // Every county must be findable by its bare name and kind, or the
    // normaliser has regressed for a whole class of row.
    const counties = JURISDICTIONS.filter((j) => j.kind === 'county');
    expect(counties.length).toBeGreaterThan(60);
    for (const c of counties) {
      const bare = c.name.replace(/\s+County$/, '');
      expect(matchJurisdiction(bare, c.county, 'county')?.slug, c.name).toBe(c.slug);
    }
  });

  it('does not hand a county the city of the same name', () => {
    /*
     * The collision this nearly shipped with. "Sarasota County" and "City of
     * Sarasota" normalise to the same name and county, and a single index let
     * the second overwrite the first — so Sarasota County would have carried
     * the city's integration gate and its entire readiness assessment.
     */
    const county = matchJurisdiction('Sarasota', 'Sarasota', 'county');
    const city = matchJurisdiction('Sarasota', 'Sarasota', 'city');
    expect(county?.slug).toBe('fl-sarasota-county');
    expect(city?.slug).toBe('fl-city-of-sarasota');
    expect(county?.slug).not.toBe(city?.slug);
  });

  it('refuses to guess when the name is ambiguous and no kind is given', () => {
    // A confidently wrong gate is worse than a missing one: it promises an API
    // pathway nobody has checked exists.
    expect(matchJurisdiction('Sarasota', 'Sarasota')).toBeNull();
  });

  it('treats the database vocabulary and the dataset vocabulary as one', () => {
    // The database says `city`; the dataset says `municipality`.
    expect(normalizeJurisdictionKind('city')).toBe('municipality');
    expect(normalizeJurisdictionKind('municipality')).toBe('municipality');
    expect(normalizeJurisdictionKind('county')).toBe('county');
    expect(matchJurisdiction('Miami', 'Miami-Dade', 'city')?.slug)
      .toBe(matchJurisdiction('Miami', 'Miami-Dade', 'municipality')?.slug);
  });

  it('reaches a real integration gate, not an empty one', () => {
    // The point of the whole exercise: a matched jurisdiction carries the gate
    // that decides whether an API pathway is possible at all.
    const m = matchJurisdiction('Alachua', 'Alachua', 'county');
    expect(m?.gate).toBeTruthy();
    expect(typeof m!.gate.publicApi).toBe('boolean');
    expect(['api', 'rpa', 'manual']).toContain(pathwayForTier(m!.integrationTier));
  });
});

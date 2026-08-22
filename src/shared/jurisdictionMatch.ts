/**
 * Matching a database municipality to its entry in the reference dataset.
 *
 * The two disagree in three specific, boring ways, and every one of them was
 * enough to stop the connector roadmap working:
 *
 *   the dataset says   "Alachua County"      the database says  "Alachua"
 *   the dataset says   "City of Miami"       the database says  "Miami"
 *   the dataset says   kind "municipality"   the database says  kind "city"
 *
 * Matching in code rather than seeding a slug column is deliberate. A seeded
 * column is a copy that goes stale the next time either side gains a row, and
 * the staleness is invisible — a jurisdiction quietly loses its gate and drops
 * to "manual" with nothing to say why. The rule below is one function, applied
 * at read time, and it is tested.
 *
 * 98 of the 103 jurisdictions in the database match. The five that do not are
 * genuinely absent from the dataset, and they are reported as unmatched rather
 * than guessed at.
 */
import type { Jurisdiction } from './types.js';
import { JURISDICTIONS } from './data/jurisdictions.data.js';

/**
 * Reduce a name to the part both sides agree on.
 *
 * Order matters: the "City of" prefix comes off before punctuation, or
 * "City of St. Petersburg" and "St. Petersburg" normalise differently.
 */
export function normalizeJurisdictionName(value: string | null | undefined): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/^(city|town|village|borough) of\s+/, '')
    .replace(/\s+county$/, '')
    .replace(/[^a-z]/g, '');
}

/**
 * The two vocabularies for what a jurisdiction IS.
 *
 * The database says `city`; the dataset says `municipality`. Everything that is
 * not a county is treated as one thing, because the distinction between a city,
 * a town and a village does not change how we file with them.
 */
export function normalizeJurisdictionKind(value: string | null | undefined): 'county' | 'municipality' {
  return String(value ?? '').toLowerCase().trim() === 'county' ? 'county' : 'municipality';
}

const key = (
  name: string | null | undefined,
  county: string | null | undefined,
  kind?: string | null,
) =>
  `${normalizeJurisdictionName(name)}|${normalizeJurisdictionName(county)}` +
  (kind === undefined || kind === null ? '' : `|${normalizeJurisdictionKind(kind)}`);

const BY_KIND = new Map<string, Jurisdiction>();
/*
 * Name and county alone are NOT unique. "Sarasota County" and "City of
 * Sarasota" normalise to the same pair, and with a single index the second
 * entry silently overwrote the first — so Sarasota County would have been given
 * the city's integration gate and its whole readiness assessment with it.
 *
 * So the loose index holds only pairs that appear exactly once. An ambiguous
 * name with no kind returns null rather than a coin flip, because a confidently
 * wrong gate is worse than a missing one: it promises an API pathway nobody has
 * checked exists.
 */
const LOOSE = new Map<string, Jurisdiction | null>();

for (const j of JURISDICTIONS) {
  BY_KIND.set(key(j.name, j.county, j.kind), j);
  const loose = key(j.name, j.county);
  LOOSE.set(loose, LOOSE.has(loose) ? null : j);
}

/**
 * The dataset entry for a database row, or null when there is genuinely none.
 *
 * Pass `kind` wherever it is known — ocs.municipalities always has it — and the
 * match is exact. Without it, an ambiguous name resolves to null.
 */
export function matchJurisdiction(
  name: string | null | undefined,
  county: string | null | undefined,
  kind?: string | null,
): Jurisdiction | null {
  if (kind !== undefined && kind !== null) {
    return BY_KIND.get(key(name, county, kind)) ?? null;
  }
  return LOOSE.get(key(name, county)) ?? null;
}

/**
 * The gate for a jurisdiction we have no dataset entry for.
 *
 * Everything false, which reads as "no API pathway is available here" and lands
 * the readiness engine on `manual`. That is the honest answer for a place we
 * know nothing about: the alternative is a screen that quietly promises an
 * integration nobody has checked is possible.
 */
export const UNKNOWN_GATE = {
  publicApi: false,
  agencyApprovalRequired: false,
  agencyPurchaseRequired: false,
  vendorPartnerRequired: false,
  sandboxAvailable: false,
  webhooks: false,
  bulkExport: false,
  docsUrl: null,
  notes: 'No reference data for this jurisdiction.',
} as const;

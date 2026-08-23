/**
 * The trades an as-built record can be issued for.
 *
 * In shared rather than beside either thing that uses it, because two now do
 * and they are on opposite sides of the system:
 *
 *   src/domain/documents/asBuiltLetter.ts renders the letter, and the trade
 *   decides its operative sentence.
 *
 *   src/shared/drafting.ts derives one orderable service per trade, so a
 *   contractor can ask for a roofing letter without having to describe what
 *   they want in a free-text brief.
 *
 * One list, so a trade added here appears in both. Two copies would drift the
 * first time somebody added a trade to the ordering side and not the rendering
 * side — and the failure is a contractor ordering something the generator has
 * no template for.
 */

export const AS_BUILT_TRADES = [
  'ROOFING',
  'ELECTRICAL',
  'PLUMBING',
  'MECHANICAL',
  'STRUCTURAL',
  'BUILDING',
  'WINDOWS_AND_DOORS',
] as const;

export type AsBuiltTrade = (typeof AS_BUILT_TRADES)[number];

export const AS_BUILT_TRADE_LABELS: Record<AsBuiltTrade, string> = {
  ROOFING: 'Roofing',
  ELECTRICAL: 'Electrical',
  PLUMBING: 'Plumbing',
  MECHANICAL: 'Mechanical (HVAC)',
  STRUCTURAL: 'Structural',
  BUILDING: 'Building (general)',
  WINDOWS_AND_DOORS: 'Windows & doors',
};

export function isAsBuiltTrade(v: unknown): v is AsBuiltTrade {
  return typeof v === 'string' && (AS_BUILT_TRADES as readonly string[]).includes(v);
}

/**
 * The drafting service key for a trade's as-built letter.
 *
 * Derived rather than written out, so the catalogue cannot list a letter for a
 * trade the generator does not know how to render.
 */
export const asBuiltLetterService = <T extends AsBuiltTrade>(trade: T) =>
  `AS_BUILT_LETTER_${trade}` as const;

export type AsBuiltLetterService = `AS_BUILT_LETTER_${AsBuiltTrade}`;

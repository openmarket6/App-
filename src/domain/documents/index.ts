/**
 * The one door into document generation.
 *
 * Validation and rendering are deliberately separate modules and deliberately
 * joined here, so that no caller can render without validating. A route that
 * imported the renderer directly could produce a defective instrument; there is
 * one function that produces documents and it refuses when there is a blocking
 * problem.
 */
import {
  type DocumentKind, type FieldProblem, DOCUMENT_KIND_LABELS,
  validateNoc, validateNto, canGenerate,
} from './noc.js';
import { validateHoldHarmless, validateContractorAgreement } from './agreements.js';
import { renderDocument, type RenderMeta } from './render.js';

export * from './noc.js';
export * from './agreements.js';
export { renderDocument, esc, type RenderMeta } from './render.js';

export const DOCUMENT_KINDS: readonly DocumentKind[] = [
  'NOC', 'NTO', 'HOLD_HARMLESS', 'CONTRACTOR_AGREEMENT',
];

export function isDocumentKind(v: unknown): v is DocumentKind {
  return typeof v === 'string' && (DOCUMENT_KINDS as readonly string[]).includes(v);
}

/** Validate any kind. `now` is injected so the deadline checks are testable. */
export function validateDocument(
  kind: DocumentKind,
  input: Record<string, unknown>,
  now: Date = new Date(),
): FieldProblem[] {
  switch (kind) {
    case 'NOC': return validateNoc(input);
    case 'NTO': return validateNto(input, now);
    case 'HOLD_HARMLESS': return validateHoldHarmless(input, now);
    case 'CONTRACTOR_AGREEMENT': return validateContractorAgreement(input);
  }
}

export interface GenerationRefused {
  ok: false;
  problems: FieldProblem[];
}

export interface GenerationProduced {
  ok: true;
  kind: DocumentKind;
  label: string;
  html: string;
  /** Problems that did not block. Carried forward, never swallowed. */
  warnings: FieldProblem[];
}

export type GenerationResult = GenerationRefused | GenerationProduced;

/**
 * Produce a document, or refuse and say why.
 *
 * Warnings travel with a produced document rather than being dropped. Somebody
 * decided to generate an NTO that is past its window, or an agreement with a
 * short retainer, and the record of that decision belongs with the document —
 * not in a log line nobody reads.
 */
export function generateDocument(
  kind: DocumentKind,
  input: Record<string, unknown>,
  meta: RenderMeta,
  now: Date = new Date(),
): GenerationResult {
  const problems = validateDocument(kind, input, now);
  if (!canGenerate(problems)) return { ok: false, problems };

  return {
    ok: true,
    kind,
    label: DOCUMENT_KIND_LABELS[kind],
    html: renderDocument(kind, input, meta),
    warnings: problems.filter((p) => p.severity === 'warning'),
  };
}

/**
 * Fields an endpoint accepts and then never reads.
 *
 * The mirror of the unknown-key problem. Zod discarding a field the schema does
 * not declare is logged now; this is the other half — a field the schema DOES
 * declare, validates, and then nobody looks at. The caller is told the value
 * was accepted, because it was: the request returns 200 and the field is
 * simply not used for anything.
 *
 * Two were live when this was written. The photo upload took a `category` of
 * JOB_PHOTO or SUPERVISION_PHOTO and inserted the literal 'photo' regardless.
 * The invoice list took a `status` and never filtered on it, so a caller
 * asking for overdue invoices got every invoice and no indication otherwise.
 *
 * TWO KINDS OF FALSE POSITIVE had to be handled before this was worth keeping,
 * and both are worth naming because they are the reason a check like this gets
 * deleted rather than fixed:
 *
 *   A handler can be two hundred lines long, and the use can be on the last
 *   one — /api/dashboard reads q.clientId as the final argument of the call it
 *   is wrapped in. Scanning a fixed window found three of these.
 *
 *   `z.literal(...)` fields are used BY being validated. The supervision terms
 *   acknowledgement and the e-signature consent box are both literals matched
 *   exactly; the whole point is that the caller must send that value, and
 *   reading it afterwards would add nothing.
 */
import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Known and accepted. Each entry is a field that is genuinely not read, with
 * the reason that is correct — not a list of things to get around to.
 */
const ACCEPTED: Record<string, string> = {};

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(?<!:)\/\/[^\n]*/g, ' ');
}

/** Index of the bracket closing the one that opens at `start`. */
function matching(s: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i < s.length; i += 1) {
    if (s[i] === open) depth += 1;
    else if (s[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Top-level keys of a `z.object({ ... })` shape, and whether each is a literal. */
function shapeFields(shape: string): Array<{ name: string; literal: boolean }> {
  const out: Array<{ name: string; literal: boolean }> = [];
  let depth = 0;
  let key = '';
  let i = 0;
  while (i < shape.length) {
    const ch = shape[i]!;
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;

    if (depth === 0 && ch === ':' && key.trim()) {
      const name = key.trim().replace(/['"]/g, '');
      // the value runs to the next top-level comma
      let j = i + 1;
      let d = 0;
      while (j < shape.length) {
        const c = shape[j]!;
        if ('([{'.includes(c)) d += 1;
        else if (')]}'.includes(c)) d -= 1;
        else if (c === ',' && d === 0) break;
        j += 1;
      }
      const value = shape.slice(i + 1, j);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        out.push({ name, literal: /z\.literal\s*\(/.test(value) });
      }
      key = '';
      i = j;
      continue;
    }
    if (depth === 0 && ch === ',') key = '';
    else if (depth === 0) key += ch;
    i += 1;
  }
  return out;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else if (e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('request fields', () => {
  it('are read by the handler that accepts them', async () => {
    const problems: string[] = [];

    for (const file of await walk(join(ROOT, 'src', 'routes'))) {
      const raw = await readFile(file, 'utf8');
      // Only what the application can reach. /v1 authenticates Supabase tokens
      // this frontend never issues, so a dead field there is dead code.
      if (!raw.includes('/api/')) continue;
      const src = stripComments(raw);

      for (const m of src.matchAll(/\bparse\s*\(/g)) {
        const callEnd = matching(src, m.index! + m[0].length - 1, '(', ')');
        if (callEnd < 0) continue;
        const call = src.slice(m.index! + m[0].length, callEnd);

        const zm = /z\.object\s*\(\s*\{/.exec(call);
        if (!zm) continue;
        const braceStart = call.indexOf('{', zm.index);
        const braceEnd = matching(call, braceStart, '{', '}');
        if (braceEnd < 0) continue;

        const fields = shapeFields(call.slice(braceStart + 1, braceEnd));
        if (fields.length === 0) continue;

        // What is the parsed value called? A destructured target names every
        // field it takes, so there is nothing to check.
        const lineStart = src.lastIndexOf('\n', m.index!) + 1;
        const decl = src.slice(lineStart, m.index!);
        const vm = /(?:const|let)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*$/.exec(decl);
        if (!vm) continue;
        const target = vm[1]!;

        /*
         * Scan to the end of the enclosing handler, not a fixed window.
         * Walking out to the closing brace of the arrow function this parse
         * sits in is what removed three false positives, one of them a use on
         * the handler's very last line.
         */
        const bodyStart = src.lastIndexOf('async (', m.index!);
        const braceAfter = bodyStart >= 0 ? src.indexOf('{', bodyStart) : -1;
        const handlerEnd = braceAfter >= 0 ? matching(src, braceAfter, '{', '}') : -1;
        const scope = src.slice(callEnd, handlerEnd > callEnd ? handlerEnd : callEnd + 20000);

        for (const f of fields) {
          if (f.literal) continue;
          const t = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const n = f.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const used =
            new RegExp(`\\b${t}\\s*\\.\\s*${n}\\b`).test(scope) ||
            new RegExp(`\\b${t}\\s*\\[\\s*['"]${n}['"]`).test(scope) ||
            new RegExp(`\\{[^}]*\\b${n}\\b[^}]*\\}\\s*=\\s*${t}\\b`).test(scope) ||
            new RegExp(`\\.\\.\\.${t}\\b`).test(scope);
          if (used) continue;

          const key = `${file.replace(`${ROOT}/`, '')}:${target}.${f.name}`;
          if (ACCEPTED[key]) continue;
          const line = raw.slice(0, m.index!).split('\n').length;
          problems.push(`${file.replace(`${ROOT}/`, '')}:${line}  ${target}.${f.name}`);
        }
      }
    }

    expect(
      problems,
      problems.length
        ? 'These fields are validated and then never read. The caller is told ' +
          'the value was accepted, and it goes nowhere:\n  ' +
          `${problems.join('\n  ')}\n` +
          'Use it, drop it from the schema, or add it to ACCEPTED above with ' +
          'the reason it is correct.'
        : '',
    ).toEqual([]);
  });
});

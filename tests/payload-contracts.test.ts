/**
 * What the screens send, and what the endpoints accept.
 *
 * Four production faults in one session came from the same place: the frontend
 * posts a field, the server's schema does not declare it, Zod strips it, and
 * the response says 200. Nothing anywhere reports the loss, and the damage
 * turns up somewhere else entirely.
 *
 *   - compliance review took `decision: 'accept'`, the drawer sends 'APPROVE'
 *     -> 400 on every approval, and no permit can be filed until compliance is
 *        accepted, so onboarding could not be completed by anyone
 *   - the same endpoint dropped effectiveDate/expiresAt with a 200
 *   - compliance waive took `note`, the drawer sends `waivedReason` -> 400
 *   - notary PATCH was .strict() and rejected the notary's own name -> 400
 *   - /api/documents dropped capturedAt on SUPERVISION_PHOTO uploads, which is
 *     the field that makes a photograph evidence rather than a picture
 *   - invoices ignored includeAgencyFees AND permitIds, so selecting permits
 *     and ticking the box billed nothing
 *
 * This test reads both sides and fails on any new instance.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

/**
 * Remove comments before any parsing.
 *
 * Both sides of this comparison are heavily commented, and a comma inside prose
 * ("who is doing the act, and under what commission") splits an object literal
 * in the wrong place — which made this test report the very fields it had just
 * been written to protect as still missing.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
    } else if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (src[i] === "'" || src[i] === '"' || src[i] === '`') {
      const q = src[i]!;
      out += q;
      i += 1;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') { out += src[i]! + (src[i + 1] ?? ''); i += 2; continue; }
        out += src[i]!;
        i += 1;
      }
      out += q;
      i += 1;
    } else {
      out += src[i]!;
      i += 1;
    }
  }
  return out;
}

/** Balanced-brace slice starting at an index that must point at '{'. */
function objAt(src: string, i: number): string | null {
  if (src[i] !== '{') return null;
  let d = 0;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '{') d += 1;
    else if (src[j] === '}') { d -= 1; if (d === 0) return src.slice(i, j + 1); }
  }
  return null;
}

/** Top-level keys of an object literal, ignoring anything nested. */
function topKeys(objSrc: string): string[] {
  const inner = objSrc.slice(1, -1);
  const parts: string[] = [];
  let d = 0, tick = 0, start = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === '{' || ch === '[' || ch === '(') d += 1;
    else if (ch === '}' || ch === ']' || ch === ')') d -= 1;
    else if (ch === '`') tick ^= 1;
    else if (ch === ',' && d === 0 && !tick) { parts.push(inner.slice(start, i)); start = i + 1; }
  }
  parts.push(inner.slice(start));

  const keys: string[] = [];
  for (const part of parts) {
    const m = part.match(/^\s*(?:\.\.\.\(?[^?]*\?\s*\{\s*)?['"]?([A-Za-z_$][\w$]*)['"]?\s*:/);
    if (m) { keys.push(m[1]!); continue; }
    const shorthand = part.match(/^\s*([A-Za-z_$][\w$]*)\s*$/);
    if (shorthand) keys.push(shorthand[1]!);
    // `...(cond ? { key: value } : {})` — a conditionally included field.
    const spread = part.match(/\.\.\.\s*\(?.*?\?\s*\{\s*([A-Za-z_$][\w$]*)\s*:/);
    if (spread) keys.push(spread[1]!);
  }
  return [...new Set(keys)];
}

const routePattern = (p: string) =>
  `/api${p.replace(/\$\{[^}]*\}/g, ':id').replace(/\?.*$/, '').replace(/\/+$/, '')}`;

interface Call { file: string; method: string; path: string; keys: string[] }

function frontendCalls(): Call[] {
  const calls: Call[] = [];
  for (const f of walk(join(ROOT, 'web/src'))) {
    const src = stripComments(readFileSync(f, 'utf8'));
    const re = /\b(post|patch|put)\s*<[^>]*>\s*\(|\b(post|patch|put)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const open = src.indexOf('(', m.index + m[0].length - 1);
      let i = open + 1;
      while (i < src.length && /\s/.test(src[i]!)) i += 1;
      const q = src[i];
      if (q !== '`' && q !== "'" && q !== '"') continue;
      let j = i + 1;
      while (j < src.length && src[j] !== q) { if (src[j] === '\\') j += 1; j += 1; }
      const path = src.slice(i + 1, j);
      if (!path.startsWith('/')) continue;
      let k = j + 1;
      while (k < src.length && /[\s,]/.test(src[k]!)) k += 1;
      const obj = objAt(src, k);
      if (!obj) continue;
      calls.push({
        file: f.replace(`${ROOT}/`, ''),
        method: (m[1] ?? m[2])!.toUpperCase(),
        path: routePattern(path),
        keys: topKeys(obj),
      });
    }
  }
  return calls;
}

function serverSchemas(): Map<string, { file: string; keys: string[] }> {
  const routes = new Map<string, { file: string; keys: string[] }>();
  for (const f of walk(join(ROOT, 'src/routes'))) {
    const src = stripComments(readFileSync(f, 'utf8'));
    const re = /app\.(post|patch|put)\s*\(\s*\n?\s*['"`]([^'"`]+)['"`]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const method = m[1]!.toUpperCase();
      const path = m[2]!.replace(/:[A-Za-z_]\w*/g, ':id');
      const after = src.slice(m.index, m.index + 6000);
      const bodyAt = after.indexOf('req.body');
      if (bodyAt < 0) continue;
      // The schema belonging to THIS body: the parse() that owns it, then the
      // z.object immediately inside. Searching backwards for z.object finds
      // whichever nested one sits closest and reports false mismatches.
      const parseAt = after.lastIndexOf('parse(', bodyAt);
      if (parseAt < 0) continue;
      const zAt = after.indexOf('z.object(', parseAt);
      if (zAt < 0 || zAt > bodyAt) continue;
      const obj = objAt(after, after.indexOf('{', zAt));
      if (!obj) continue;
      routes.set(`${method} ${path}`, { file: f.replace(`${ROOT}/`, ''), keys: topKeys(obj) });
    }
  }
  return routes;
}

describe('the screens and the endpoints agree on payloads', () => {
  const calls = frontendCalls();
  const routes = serverSchemas();

  it('reads both sides', () => {
    // If either extractor silently stops finding anything, every assertion
    // below passes vacuously — which is the one way this test could lie.
    expect(calls.length).toBeGreaterThan(30);
    expect(routes.size).toBeGreaterThan(50);
  });

  it('sends no field the endpoint would discard', () => {
    const problems: string[] = [];
    for (const c of calls) {
      if (c.keys.length === 0) continue;
      const route = routes.get(`${c.method} ${c.path}`);
      if (!route) continue; // path coverage is route-coverage.test.ts's job
      const unknown = c.keys.filter((k) => !route.keys.includes(k));
      if (unknown.length > 0) {
        problems.push(
          `${c.method} ${c.path}\n` +
          `    sends:   ${unknown.join(', ')}\n` +
          `    from:    ${c.file}\n` +
          `    server:  ${route.file}\n` +
          `    accepts: ${route.keys.join(', ')}`,
        );
      }
    }

    expect(
      problems,
      problems.length
        ? 'These fields are sent by a screen and are not in the endpoint\'s schema, ' +
          'so Zod strips them and the request still returns 200:\n\n' +
          `${problems.join('\n\n')}\n\n` +
          'Add the field to the schema and use it, or stop sending it. Do not ' +
          'leave it silently dropped — that is how four separate faults reached ' +
          'production in one day.'
        : '',
    ).toEqual([]);
  });
});

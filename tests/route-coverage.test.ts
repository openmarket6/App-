/**
 * Every address the frontend calls must have something behind it.
 *
 * This test exists because it found nine broken screens that nobody had
 * noticed, including `GET /api/permits/:id` — the page the whole product is
 * arranged around. The cause was structural, not careless: `/api/*` is a
 * hand-maintained mirror of `/v1/*`, the frontend speaks `/api/*` exclusively,
 * and pages were being built faster than the mirror grew. Nothing anywhere
 * compared the two, so a page shipped, returned `404 No route for …`, and
 * read to a user as "this permit does not exist".
 *
 * The check is mechanical: read the call sites out of `web/src`, read the
 * registered routes out of `src/routes`, and diff them. It takes milliseconds
 * and needs no database, no server and no browser.
 *
 * THE METHOD IS VERB-AWARE, and that is not a detail. The first version of this
 * comparison ignored HTTP verbs, and it was wrong in both directions: it
 * reported `GET /api/jurisdictions/:id` as missing when the page actually
 * sends a PATCH, and it silently missed `POST /api/permits` — that you could
 * not create a permit at all. A path that exists for one verb tells you
 * nothing about another.
 *
 * WHEN THIS FAILS, the fix is usually one of three things, in this order:
 *   1. the route was never written        -> write it
 *   2. the UI has the path or verb wrong  -> fix the call site
 *   3. it is deliberately not migrated    -> it should already be caught by
 *      NOT_MIGRATED_AREAS; if it is not, that list is what needs updating
 *
 * Do not silence a failure by adding to KNOWN_GAPS without a reason next to it.
 * The list below is a debt register, not a suppression file.
 */
import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOT_MIGRATED_AREAS } from '../src/routes/compat/not-migrated.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Paths the UI calls that have no route today, each with the reason it is
 * acceptable *for now*. Every entry is a known-broken screen or a decision
 * waiting to be made — not a thing that is fine.
 */
const KNOWN_GAPS: Record<string, string> = {
  'GET /api/documents/:id/content':
    'The UI wants raw bytes. Storage is deliberately private with per-request ' +
    'signed URLs, and rule 3 of services/storage.ts is that bytes never stream ' +
    'through this API. DocumentLink should fetch /documents/:id/download and ' +
    'use the URL it returns.',
};

/*
 * A call site's path can span lines — a template literal with an expression
 * broken across two. Capturing up to the CLOSING quote rather than to the
 * first newline is what makes that work; the first version of this regex
 * stopped at the line break and produced a "path" containing half an
 * expression, which then reported as a missing route.
 */
const CALL = /\b(get|post|patch|del|getBlobUrl)\s*(?:<[^>]*>)?\s*\(\s*(['"`])([\s\S]*?)\2/g;
/*
 * A route may carry a generic type argument — `app.get<{ Params: … }>(…)` — and
 * the first version of this pattern required the `(` to follow the verb
 * immediately. Five real, registered, reachable routes were therefore reported
 * as missing.
 *
 * That direction of error is the dangerous one. A missing route reads as a
 * broken screen, the obvious remedy is a KNOWN_GAPS entry, and the entry then
 * suppresses the check for that path permanently — so a regex that cannot see
 * a legal declaration quietly converts working code into a debt entry that
 * hides the next real break.
 */
const ROUTE = /app\.(get|post|patch|put|delete|all)\s*(?:<[^(]*?>)?\s*\(\s*\n?\s*'(\/api\/[^']+)'/g;
const VERB: Record<string, string> = {
  get: 'GET', post: 'POST', patch: 'PATCH', del: 'DELETE', getBlobUrl: 'GET',
};

async function walk(dir: string, ext: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, ext)));
    else if (ext.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

/** `${id}` and `:id` both mean "one segment, any value". */
function segments(path: string): string[] {
  return path
    .replace(/\$\{[\s\S]*?\}/g, '*')
    .split('/')
    .filter(Boolean)
    .map((s) => (s.startsWith(':') || s === '*' ? '*' : s));
}

function covers(route: { verb: string; path: string }, call: { verb: string; path: string }): boolean {
  if (route.verb !== 'ALL' && route.verb !== call.verb) return false;
  const r = segments(route.path);
  const c = segments(call.path);
  if (route.path.endsWith('/*')) {
    const head = r.slice(0, -1);
    return c.length >= head.length && head.every((s, i) => s === '*' || s === c[i]);
  }
  return r.length === c.length && r.every((s, i) => s === '*' || c[i] === '*' || s === c[i]);
}

/** An area that answers 501 is handled — badly, but on purpose. */
function isDeliberate501(path: string): boolean {
  const area = path.replace(/^\/api\//, '').split('/')[0];
  return NOT_MIGRATED_AREAS.includes(area ?? '');
}

describe('the frontend and the API agree on what exists', () => {
  it('has a route behind every path the UI calls', async () => {
    const routes: Array<{ verb: string; path: string }> = [];
    for (const file of await walk(join(ROOT, 'src/routes'), ['.ts'])) {
      const text = await readFile(file, 'utf8');
      for (const m of text.matchAll(ROUTE)) {
        routes.push({ verb: m[1]!.toUpperCase(), path: m[2]! });
      }
    }
    // If this ever reads zero routes the test would pass vacuously, which is
    // the one failure mode a checker like this must not have.
    expect(routes.length).toBeGreaterThan(50);

    const calls = new Map<string, Set<string>>();
    for (const file of await walk(join(ROOT, 'web/src'), ['.ts', '.tsx'])) {
      const text = await readFile(file, 'utf8');
      for (const m of text.matchAll(CALL)) {
        const raw = m[3]!.split('?')[0]!;
        if (!raw.startsWith('/')) continue;
        const key = `${VERB[m[1]!]} /api${raw}`;
        if (!calls.has(key)) calls.set(key, new Set());
        calls.get(key)!.add(file.replace(`${ROOT}/`, ''));
      }
    }
    expect(calls.size).toBeGreaterThan(40);

    const unmatched: string[] = [];
    for (const [key, files] of calls) {
      const [verb, path] = [key.slice(0, key.indexOf(' ')), key.slice(key.indexOf(' ') + 1)];
      if (isDeliberate501(path!)) continue;
      if (routes.some((r) => covers(r, { verb: verb!, path: path! }))) continue;

      // Normalise `${…}` to `:id` so a gap keeps the same name when somebody
      // renames the variable at the call site.
      const normalised = `${verb} ${path!.replace(/\$\{[\s\S]*?\}/g, ':id')}`;
      if (normalised in KNOWN_GAPS) continue;
      unmatched.push(`${normalised}  <-  ${[...files!].join(', ')}`);
    }

    expect(
      unmatched,
      `These UI calls have no route behind them. Either write the route, fix ` +
        `the call site, or — if it is deliberate — record it in KNOWN_GAPS ` +
        `with the reason:\n  ${unmatched.join('\n  ')}\n`,
    ).toEqual([]);
  });

  it('does not carry a gap that has quietly been fixed', async () => {
    // A stale entry here is worse than none: it hides a route that now exists
    // and tells the next reader the screen is still broken.
    const routes: Array<{ verb: string; path: string }> = [];
    for (const file of await walk(join(ROOT, 'src/routes'), ['.ts'])) {
      const text = await readFile(file, 'utf8');
      for (const m of text.matchAll(ROUTE)) {
        routes.push({ verb: m[1]!.toUpperCase(), path: m[2]! });
      }
    }

    const fixed = Object.keys(KNOWN_GAPS).filter((key) => {
      const verb = key.slice(0, key.indexOf(' '));
      const path = key.slice(key.indexOf(' ') + 1);
      return routes.some((r) => covers(r, { verb, path }));
    });

    expect(fixed, `Remove these from KNOWN_GAPS — they exist now: ${fixed.join(', ')}`)
      .toEqual([]);
  });
});

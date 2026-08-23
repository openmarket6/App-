/**
 * Per-contractor record numbers are the database's job.
 *
 * Four tables carry a number a contractor reads and quotes back: invoices,
 * projects, drafting orders, engagements. Each has a `before insert` trigger
 * that takes pg_advisory_xact_lock on the company, then counts within that
 * company — and each trigger only fires when the column arrives null.
 *
 * Three route handlers supplied the value instead, with a hand-rolled
 * `(select coalesce(max(n), 1000) + 1 from <table>)`. That skipped the trigger
 * and the lock with it, and it broke twice over:
 *
 *   Two staff creating at once both read the same max under READ COMMITTED and
 *   the second hit the unique constraint as an unhandled 500, with the record
 *   already assembled.
 *
 *   The subquery had no company filter and ran in service context, where
 *   row-level security is off — so the numbers came from a GLOBAL counter. One
 *   contractor's invoices ran 1206, then 1341, then 1352: their own sequence
 *   leaking the platform's total volume, and useless for their books.
 *
 * The check is on the source rather than on behaviour, because reproducing the
 * race needs two connections interleaved at exactly the wrong moment, and the
 * property worth defending — do not hand-roll a sequence — is plain to read.
 */
import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbConfigured, applyMigrations, client, ownerUrl } from './helpers/db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const describeIfDb = dbConfigured ? describe : describe.skip;

/**
 * Still hand-rolled, with the reason it is tolerated.
 *
 * Not a suppression list: an entry here is a known 500 waiting for two people
 * to click at once.
 */
const KNOWN: Record<string, string> = {
  'src/routes/compat/invoices.ts': 'Billing is deferred until Stripe is configured; ' +
    'left in place at the owner\'s instruction with the defect recorded here.',
};

describe('record numbers', () => {
  it('are assigned by the database, not by a route', async () => {
    const offenders: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) { await walk(full); continue; }
        if (!e.name.endsWith('.ts')) continue;
        const src = await readFile(full, 'utf8');
        const rel = full.replace(`${ROOT}/`, '');
        for (const m of src.matchAll(/coalesce\(max\((\w*_number)\)/g)) {
          /*
           * Only the four company-scoped record numbers.
           *
           * document_versions.version_number is deliberately not one of them:
           * it is a number within one document, it has no trigger, and it is
           * serialised by the `for update` already held on the parent document
           * row. Computing it from max(version_number) is the FIX there — the
           * previous version derived it from documents.version_count, which
           * only advances at completion, so an abandoned upload permanently
           * poisoned the next one.
           */
          if (m[1] === 'version_number') continue;
          if (KNOWN[rel]) continue;
          const line = src.slice(0, m.index!).split('\n').length;
          offenders.push(`${rel}:${line}  ${m[1]}`);
        }
      }
    };
    await walk(join(ROOT, 'src', 'routes'));

    expect(
      offenders,
      offenders.length
        ? 'These build a record number by hand, skipping the trigger that ' +
          'locks the company first:\n  ' + offenders.join('\n  ') + '\n' +
          'Leave the column out of the INSERT — the trigger already does this ' +
          'correctly, per company and under an advisory lock.'
        : '',
    ).toEqual([]);
  });
});

describeIfDb('the triggers that do it properly', () => {
  it('exist, and lock the company before counting', async () => {
    await applyMigrations();
    const c = client(ownerUrl!);
    await c.connect();
    try {
      const { rows } = await c.query<{ proname: string; src: string }>(
        `select p.proname, pg_get_functiondef(p.oid) as src
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'ocs' and p.proname like 'assign\\_%\\_number'`,
      );
      expect(rows.length, 'the number-assigning triggers are missing')
        .toBeGreaterThanOrEqual(3);

      for (const fn of rows) {
        expect(fn.src, `${fn.proname} counts without locking the company first`)
          .toContain('pg_advisory_xact_lock');
        expect(fn.src, `${fn.proname} counts across all companies`)
          .toMatch(/company_id\s*=\s*new\.company_id/);
      }
    } finally {
      await c.end();
    }
  });
});

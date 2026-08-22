/**
 * Rules about the migration files themselves.
 *
 * This project has already lost deploys to a migration mistake: editing one
 * that had been applied changed its checksum and froze every deploy until
 * somebody worked out why. These tests exist so the next such mistake fails in
 * CI instead of in production.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../db/migrations');
const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

describe('the migration files', () => {
  it('exist', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('all start with a four-digit number', () => {
    for (const f of files) {
      expect(f, f).toMatch(/^\d{4}_/);
    }
  });

  it('does not use one number twice', () => {
    /*
     * 0034 was used twice -- 0034_company_service_line and
     * 0034_document_mailings, written in parallel by two people. Both applied
     * cleanly, because the runner keys on the whole filename and sorts
     * alphabetically, which happened to match the order they were written in.
     *
     * That is luck, not design. The number stops telling you the order the
     * moment it is shared, and the next collision may not sort the way it
     * needs to run. Renaming the two that exist is not the fix: they are
     * applied, and a rename changes the version key so the runner would try to
     * run them again. This test stops the THIRD one.
     */
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const f of files) {
      const num = f.slice(0, 4);
      const prior = seen.get(num);
      if (prior) collisions.push(`${num}: ${prior} and ${f}`);
      else seen.set(num, f);
    }

    expect(
      collisions,
      collisions.length
        ? `Two migrations share a number:\n  ${collisions.join('\n  ')}\n` +
          'Give the new one the next free number. Do NOT renumber one that has ' +
          'already been applied — that changes its version key and the runner ' +
          'will try to run it again.'
        : '',
      // 0034 is grandfathered: both halves are applied in production and
      // renaming either would break the runner. Everything after must be unique.
    ).toEqual(collisions.filter((c) => c.startsWith('0034')));
  });

  it('numbers them without gaps', () => {
    // A gap usually means a migration was deleted after being applied, which
    // leaves databases that ran it disagreeing with ones that never saw it.
    const numbers = [...new Set(files.map((f) => Number(f.slice(0, 4))))].sort((a, b) => a - b);
    const missing: number[] = [];
    for (let n = numbers[0]!; n < numbers[numbers.length - 1]!; n += 1) {
      if (!numbers.includes(n)) missing.push(n);
    }
    expect(missing, `missing migration numbers: ${missing.join(', ')}`).toEqual([]);
  });
});

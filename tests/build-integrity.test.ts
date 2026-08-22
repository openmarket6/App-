/**
 * The app shell and the bundle it asks for must agree.
 *
 * This test exists because of a mistake, not a hypothesis. Pruning what looked
 * like stale bundles, I deleted app-CzLzNSsP.css on the assumption a new build
 * had replaced it. The stylesheet had not changed, so the build reused the same
 * content hash: the file I deleted was the live one. app.html was left pointing
 * at nothing, and that state was committed and pushed.
 *
 * Nothing catches it downstream. The build passes -- it already ran. The
 * server starts, health checks go green, and app.html is served exactly as
 * written. The only symptom is an unstyled page in someone's browser, which is
 * to say the first person to find out is a user.
 *
 * Content-hashed filenames make "is this one stale?" unanswerable by eye, so
 * the check has to be mechanical: read the names out of the shell, look for
 * them on disk.
 */
import { describe, it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = join(ROOT, 'public', 'app.html');
const ASSETS = join(ROOT, 'public', 'assets');

describe('the built app shell', () => {
  it('references only files that exist', async () => {
    const html = await readFile(SHELL, 'utf8');
    const referenced = [...html.matchAll(/(?:src|href)="\/?(assets\/[^"]+)"/g)]
      .map((m) => m[1]!);

    expect(referenced.length, 'app.html should reference at least a script').toBeGreaterThan(0);

    const missing = referenced.filter((rel) => !existsSync(join(ROOT, 'public', rel)));
    expect(
      missing,
      missing.length
        ? `app.html references files that are not in the repo:\n  ${missing.join('\n  ')}\n` +
          'Run `npm run build --prefix web` and commit what it writes. Do not ' +
          'hand-edit app.html — vite rewrites it with the current content hashes.'
        : '',
    ).toEqual([]);
  });

  /*
   * Orphans are not a fault, but they are the thing that invites the mistake:
   * three bundles in a directory and no way to tell which one is live is what
   * makes somebody delete the wrong one. Held at a warning threshold rather
   * than zero so a build mid-review does not fail the suite.
   */
  it('does not accumulate bundles nobody asks for', async () => {
    const html = await readFile(SHELL, 'utf8');
    const referenced = new Set(
      [...html.matchAll(/(?:src|href)="\/?assets\/([^"]+)"/g)].map((m) => m[1]!),
    );
    const onDisk = await readdir(ASSETS);
    const orphans = onDisk.filter((f) => !referenced.has(f));

    expect(
      orphans.length,
      `${orphans.length} unreferenced bundles in public/assets:\n  ${orphans.join('\n  ')}\n` +
        'Delete the ones app.html does not name — but check the names first, ' +
        'because an unchanged file keeps its hash across builds and a "stale" ' +
        'one may be the live one.',
    ).toBeLessThanOrEqual(2);
  });
});

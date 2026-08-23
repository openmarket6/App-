/**
 * A screen must not state a negative it did not establish.
 *
 * The contractor portal's dashboard renders "Nothing is waiting on you" when
 * its action list comes back empty, and assembles that list from six separate
 * requests. None of them surfaced a failure. So a failed compliance read
 * removed every insurance item from the list and left the reassurance
 * standing: a contractor whose general liability lapsed last week was told
 * their paperwork was in order, on a screen that looked entirely normal.
 *
 * This is a source check rather than a rendering one. It is looking for a
 * structural property — that a confident empty state is guarded by the failure
 * of the queries behind it — and that is visible in the source without a
 * browser, a DOM, or a fixture that would go stale.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web', 'src', 'pages');

/**
 * Screens that tell someone nothing is outstanding, and what has to be true
 * before they are allowed to say it.
 *
 * Only screens making a claim about the WORLD are listed. "No documents match
 * these filters" is a claim about the filters and is true however badly the
 * request went.
 */
const REASSURANCES: Array<{ file: string; text: string; guard: RegExp }> = [
  {
    file: 'PortalDashboard.tsx',
    text: 'Nothing is waiting on you',
    guard: /couldNotLoad\.length > 0/,
  },
  {
    file: 'PortalHome.tsx',
    text: 'Nothing needs you today',
    guard: /!actionsQ\.isError/,
  },
  {
    file: 'Supervision.tsx',
    text: 'No managed-licence permits',
    guard: /!permitsQ\.isError/,
  },
];

describe('screens that say nothing is outstanding', () => {
  it.each(REASSURANCES)('$file only says it when it knows', async ({ file, text, guard }) => {
    const src = await readFile(join(WEB, file), 'utf8');
    expect(src, `${file} no longer contains "${text}" — update this test`)
      .toContain(text);
    expect(
      guard.test(src),
      `${file} says "${text}" without checking whether the reads behind it ` +
      'failed. An empty list and a reassuring sentence is exactly what a ' +
      'contractor with nothing outstanding sees, so there is no way to tell ' +
      'the two apart from the screen.',
    ).toBe(true);
  });

  it('surfaces a failure for every read behind the portal action list', async () => {
    /*
     * The dashboard builds its list from six requests. Any one of them failing
     * silently drops a whole category of obligation -- insurance, agreements,
     * invoices -- out of a list the contractor is invited to treat as complete.
     */
    const src = await readFile(join(WEB, 'PortalDashboard.tsx'), 'utf8');
    for (const q of ['complianceQ', 'signingQ', 'invoicesQ', 'documentsQ', 'draftingQ', 'permitsQ']) {
      expect(
        new RegExp(`q:\\s*${q}\\b`).test(src),
        `${q} feeds the action list but is not in ACTION_QUERIES, so its ` +
        'failure is invisible and its items just vanish.',
      ).toBe(true);
    }
  });
});

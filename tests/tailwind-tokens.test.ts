/**
 * Colour classes that name a colour the palette does not have.
 *
 * Tailwind emits nothing for `bg-surface` when `surface` is not in the theme.
 * No build warning, no runtime error, no type error — the element simply
 * renders with no background, and the only way to find out is to look at the
 * page and notice a card that is not quite a card.
 *
 * There were five, in three files. `surface` was never defined; the palette
 * calls that colour `white`. A sixth was `bg-warning-soft` in a panel written
 * minutes before this test, which is roughly how long the mistake takes to
 * make: the token you reach for is the one the design system in your head has,
 * not the one this config declares.
 *
 * The check reads the palette out of tailwind.config.js rather than restating
 * it, so adding a colour there is all that is needed to use it.
 */
import { describe, it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');

/** Tailwind's built-in palette — always available whether or not it is named. */
const BUILTIN = new Set([
  'white', 'black', 'transparent', 'current', 'inherit',
  'slate', 'gray', 'zinc', 'neutral', 'stone', 'red', 'orange', 'amber',
  'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue',
  'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
]);

/*
 * Utilities whose value is not a colour at all. `border-collapse`,
 * `text-center` and `shadow-card` all match the same prefix-dash-word shape,
 * and treating their values as colour names is what makes this kind of check
 * unusable noise instead of a signal.
 */
const NOT_COLOURS = new Set([
  'collapse', 'separate', 'left', 'right', 'center', 'justify', 'start', 'end',
  'top', 'bottom', 'auto', 'none', 'solid', 'dashed', 'dotted', 'double',
  'hidden', 'balance', 'pretty', 'wrap', 'nowrap', 'clip', 'ellipsis',
  'card', 'inner', 'opacity', 'xs', 'sm', 'base', 'md', 'lg', 'xl',
  'full', 'px', 'x', 'y', 'b', 't', 'l', 'r', 'uppercase', 'lowercase',
]);

const COLOUR_CLASS =
  /\b(?:bg|text|border|ring|divide|from|via|to|fill|stroke|outline|accent|caret|placeholder|decoration)-([a-z][a-z0-9]*)(?:-[a-z0-9]+)?(?:\/\d+)?\b/g;

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else if (/\.(tsx?|css)$/.test(e.name)) out.push(full);
  }
  return out;
}

describe('tailwind colour tokens', () => {
  it('names only colours the palette defines', async () => {
    const config = await readFile(join(WEB, 'tailwind.config.js'), 'utf8');
    const colours = config.slice(config.indexOf('colors: {'));
    const declared = new Set(
      [...colours.matchAll(/^\s{8}([a-z][a-zA-Z0-9]*)\s*:/gm)].map((m) => m[1]!),
    );
    expect(declared.size, 'should have parsed the palette out of the config')
      .toBeGreaterThan(3);

    const known = new Set([...declared, ...BUILTIN]);
    const bad = new Map<string, Set<string>>();

    for (const file of await walk(join(WEB, 'src'))) {
      const src = await readFile(file, 'utf8');
      for (const m of src.matchAll(COLOUR_CLASS)) {
        const name = m[1]!;
        if (known.has(name) || NOT_COLOURS.has(name)) continue;
        // Only flag it if it looks like a class, i.e. it turned up inside a
        // className or an @apply, not in a sentence of prose.
        const around = src.slice(Math.max(0, m.index! - 120), m.index!);
        if (!/class(Name)?\s*=|@apply|`[^`]*$/.test(around)) continue;
        if (!bad.has(name)) bad.set(name, new Set());
        bad.get(name)!.add(file.replace(ROOT + '/', ''));
      }
    }

    const report = [...bad.entries()].map(
      ([name, files]) => `  ${name} — ${[...files].join(', ')}`,
    );
    expect(
      report,
      report.length
        ? 'Classes name colours the palette does not define. Tailwind emits ' +
          'nothing for these, so the element renders unstyled with no warning ' +
          `anywhere:\n${report.join('\n')}\n` +
          'Either add the colour to web/tailwind.config.js or use one that exists.'
        : '',
    ).toEqual([]);
  });
});

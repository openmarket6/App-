/**
 * The PM Portal as an installable app.
 *
 * A supervisor uses this one-handed, on a roof, on a phone with one bar. The
 * tests here pin the handful of things that decide whether it behaves like an
 * app or like a web page somebody bookmarked — and one rule that decides
 * whether the evidence it collects is trustworthy.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'public/app.webmanifest'), 'utf8'));
const sw = readFileSync(join(ROOT, 'public/sw.js'), 'utf8');
const shell = readFileSync(join(ROOT, 'web/app.html'), 'utf8');
const netlify = readFileSync(join(ROOT, 'netlify.toml'), 'utf8');

describe('the service worker', () => {
  it('never caches the API', () => {
    /*
     * The rule this whole file exists for. A supervisor reading yesterday's
     * visit list from a cache is worse off than one who can see they are
     * offline: a reassigned visit, a changed photograph requirement, or a
     * permit that moved stage all send somebody to the wrong place or let them
     * sign off work they should not.
     *
     * Writes are already safe without caching reads — every field action goes
     * to an IndexedDB outbox and sends itself when signal returns.
     */
    expect(sw).toContain("url.pathname.startsWith('/api/')");
    // The bail-out must come BEFORE any caching branch, or a later handler
    // catches API requests first and the rule is decorative.
    const bail = sw.indexOf("if (url.pathname.startsWith('/api/')) return;");
    const firstCache = sw.indexOf('caches.match(request)');
    expect(bail).toBeGreaterThan(0);
    expect(bail).toBeLessThan(firstCache);
  });

  it('goes to the network first for navigations', () => {
    // app.html is served no-cache so a deploy lands immediately. Serving a
    // cached shell first would reintroduce the stale-shell-pointing-at-missing
    // -assets white screen that netlify.toml works to prevent.
    const nav = sw.slice(sw.indexOf("request.mode === 'navigate'"));
    expect(nav.indexOf('fetch(request)')).toBeLessThan(nav.indexOf('caches.match'));
  });

  it('cleans up caches from previous versions', () => {
    expect(sw).toContain('caches.delete');
  });
});

describe('the manifest', () => {
  it('opens on the supervisor’s own visits, not the dashboard', () => {
    // Their account exists to do one thing. A page of operations numbers is
    // not it.
    expect(manifest.start_url).toBe('/field');
  });

  it('runs without browser chrome', () => {
    expect(manifest.display).toBe('standalone');
  });

  it('ships a maskable icon that actually exists', () => {
    // Without `maskable`, Android crops the logo itself into a circle. The
    // padded variant is what stops that.
    const maskable = (manifest.icons as Array<{ purpose?: string; src: string }>)
      .find((i) => i.purpose === 'maskable');
    expect(maskable).toBeTruthy();
    expect(existsSync(join(ROOT, 'public', maskable!.src))).toBe(true);
  });

  it('ships every icon it declares', () => {
    for (const icon of manifest.icons as Array<{ src: string }>) {
      expect(existsSync(join(ROOT, 'public', icon.src)), icon.src).toBe(true);
    }
  });
});

describe('the shell and the headers', () => {
  it('carries the iOS meta tags', () => {
    // iOS ignores the manifest's display mode. Without these a supervisor taps
    // the home-screen icon and gets Safari, address bar and all.
    expect(shell).toContain('apple-mobile-web-app-capable');
    expect(shell).toContain('<link rel="manifest"');
  });

  it('refuses to cache the service worker', () => {
    /*
     * A stale worker is STICKY: the browser keeps running the old one, and the
     * usual fix — reload the page — is precisely what it intercepts. A cached
     * sw.js can pin a phone to a previous version of the app.
     */
    const block = netlify.slice(netlify.indexOf('for = "/sw.js"'));
    expect(block).toContain('no-cache');
  });

  it('serves the manifest as a manifest', () => {
    // Browsers ignore one served as text/plain, and the symptom is an install
    // prompt that silently never appears.
    const block = netlify.slice(netlify.indexOf('for = "/app.webmanifest"'));
    expect(block).toContain('application/manifest+json');
  });
});

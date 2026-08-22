/*
 * Service worker for the PM Portal.
 *
 * ONE RULE ABOVE ALL OTHERS: THIS NEVER CACHES /api/.
 *
 * A supervisor standing on a roof reading a cached visit list from yesterday is
 * worse off than one who can see they are offline. Stale permit data, a visit
 * that was reassigned this morning, a photograph requirement that changed --
 * each of those sends somebody to the wrong site or lets them sign off work
 * they should not. Writes are already safe offline: every field action goes to
 * an IndexedDB outbox (web/src/lib/fieldQueue.ts) and sends itself when signal
 * returns. This file exists only so the APP ITSELF opens without a connection.
 *
 * What it caches: the shell. HTML, JS, CSS, icons. Things that change only when
 * we deploy, and whose filenames change with them.
 */

const VERSION = 'pm-portal-v1';
const SHELL = `${VERSION}-shell`;

/*
 * Cached on install so the very first offline launch works, rather than only
 * after the supervisor has happened to visit each URL online.
 */
const PRECACHE = [
  '/app.html',
  '/brand/1cs-icon-192.png',
  '/brand/1cs-icon-512.png',
  '/app.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      // Individually, so one missing file does not fail the whole install and
      // leave the app with no offline shell at all.
      .then((cache) => Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => undefined))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  /*
   * Never. Not stale-while-revalidate, not a short TTL, not "just the list
   * endpoint". If the network is down the request fails and the screen says so,
   * which is the truth and is actionable.
   */
  if (url.pathname.startsWith('/api/')) return;

  // Hashed assets: the filename changes when the content does, so a hit is
  // always correct and a miss is worth storing.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(SHELL).then((c) => c.put(request, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  /*
   * Navigations: network first, shell as the fallback.
   *
   * This order matters. app.html is served no-cache precisely so a deploy is
   * picked up immediately; serving a cached shell first would reintroduce the
   * stale-shell-pointing-at-missing-assets problem that netlify.toml goes out
   * of its way to prevent. Offline, the cached shell is strictly better than
   * the browser's error page -- the app boots, reads its outbox, and shows the
   * supervisor what is waiting to send.
   */
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put('/app.html', copy));
          }
          return res;
        })
        .catch(() => caches.match('/app.html').then((hit) => hit ?? Response.error())),
    );
  }
});

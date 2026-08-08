/**
 * CreativeFlow v5 service worker.
 * Registered as /sw.js?v=<APP_VERSION> — the query string versions the cache.
 *
 * Rules (CLAUDE.md constraint 1 lives here too):
 *  - Intercept same-origin GET ONLY. Every POST and every request to
 *    script.google.com / googleapis.com / accounts.google.com / youtube.com
 *    passes straight through — API answers are NEVER cached.
 *  - Navigations: network-first → cached shell → offline.html.
 *  - Hashed /assets/*: cache-first (immutable filenames).
 */
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = 'cf-' + VERSION;
const PRECACHE = ['./', './manifest.webmanifest', './offline.html',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting() && undefined).catch(() => {}));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('cf-') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // never touch POSTs
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // never touch cross-origin

  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        const c = await caches.open(CACHE);
        c.put('./', res.clone());
        return res;
      } catch {
        const c = await caches.open(CACHE);
        return (await c.match('./')) || (await c.match('./offline.html')) || Response.error();
      }
    })());
    return;
  }

  if (url.pathname.includes('/assets/') || PRECACHE.some(p => url.pathname.endsWith(p.slice(1)))) {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok) c.put(req, res.clone());
        return res;
      } catch { return Response.error(); }
    })());
  }
});

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

/* ── push notifications ────────────────────────────────────────────────────
   The server encrypts the text into the message itself (RFC 8291), so nothing
   here has to call the API before it can show something — which matters,
   because Chrome requires a visible notification for every push and shows its
   own "site was updated in the background" if we are too slow. */

/* The received-notification log.
   IndexedDB, not localStorage: the worker runs with the app closed — which is
   most of the time — and localStorage does not exist here. Written by the
   worker, read by the bell in the app. Kept deliberately small. */
const LOG_DB = 'cf-notifs', LOG_STORE = 'log', LOG_MAX = 60;

function logDb() {
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open(LOG_DB, 1);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains(LOG_STORE)) db.createObjectStore(LOG_STORE, { keyPath: 'id' });
    };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}

async function logPush(entry) {
  try {
    const db = await logDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(LOG_STORE, 'readwrite');
      const st = tx.objectStore(LOG_STORE);
      st.put(entry);
      /* trim oldest so a quiet phone that wakes to 200 notifications does not
         carry them all forever */
      const all = st.getAll();
      all.onsuccess = () => {
        const rows = (all.result || []).sort((a, b) => (b.at || '').localeCompare(a.at || ''));
        rows.slice(LOG_MAX).forEach(r => st.delete(r.id));
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { /* the notification still shows — the log is a convenience */ }
}

self.addEventListener('push', e => {
  e.waitUntil((async () => {
    let d = {};
    try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }

    const title = d.title || 'CreativeFlow';
    const body = d.body || 'You have an update.';
    const tag = d.taskId || d.kind || 'creativeflow';
    const at = d.at || new Date().toISOString();

    await logPush({ id: at + '|' + tag, title, body, taskId: d.taskId || '', kind: d.kind || '', at, seen: false });
    /* if a window is open, let it repaint the bell straight away */
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    open.forEach(c => c.postMessage({ type: 'CF_NOTIF', entry: { title, body, taskId: d.taskId || '', kind: d.kind || '', at } }));

    /* Collapse by task: five events on one task replace each other rather than
       stacking five banners. renotify still buzzes for the newest. */
    await self.registration.showNotification(title, {
      body,
      tag,
      renotify: true,
      icon: './icons/icon-192.png',
      badge: './icons/badge-96.png',
      timestamp: d.at ? Date.parse(d.at) || Date.now() : Date.now(),
      requireInteraction: d.kind === 'changes' || d.kind === 'overdue',
      data: { taskId: d.taskId || '', kind: d.kind || '', url: d.taskId ? ('./#/t/' + d.taskId) : './' },
    });
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil((async () => {
    const url = new URL(target, self.location.href).href;
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    /* Focus a tab that is already open rather than piling up windows — the
       installed app has exactly one, and this is what makes it feel native. */
    for (const c of all) {
      if (c.url.startsWith(self.location.origin)) {
        await c.focus();
        c.postMessage({ type: 'CF_OPEN', taskId: (e.notification.data || {}).taskId || '' });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});

/* A subscription can be rotated by the browser at any time. Without this the
   device goes silent for good, with nothing logged anywhere. */
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    all.forEach(c => c.postMessage({ type: 'CF_PUSH_RESUBSCRIBE' }));
  })());
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

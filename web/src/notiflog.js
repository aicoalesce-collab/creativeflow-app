/**
 * notiflog.js — the app's half of the received-notification log.
 *
 * The service worker writes every notification it shows into IndexedDB (it has
 * no localStorage, and it runs with the app closed). This reads that back for
 * the bell, so the panel shows what actually ARRIVED rather than only what the
 * client can infer from task state.
 *
 * The store shape is shared with web/public/sw.js. sw.js is served raw rather
 * than bundled, so it cannot import this — the few lines of IndexedDB opening
 * are duplicated there on purpose. Change one, change both.
 */
const DB = 'cf-notifs', STORE = 'log';

function open_() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('no indexedDB'));
    const rq = indexedDB.open(DB, 1);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}

/** Newest first. Never throws — the bell must render even if storage is gone
 *  (private windows, wiped profiles, a browser that refuses IndexedDB). */
export async function logList() {
  try {
    const db = await open_();
    const rows = await new Promise((resolve, reject) => {
      const rq = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      rq.onsuccess = () => resolve(rq.result || []);
      rq.onerror = () => reject(rq.error);
    });
    return rows.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  } catch (e) { return []; }
}

export async function logUnread() {
  return (await logList()).filter(r => !r.seen).length;
}

/** Called when the bell panel is opened: everything currently in the log is
 *  now "seen", so the unread badge clears. The entries stay readable. */
export async function logMarkSeen() {
  try {
    const db = await open_();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const st = tx.objectStore(STORE);
      const rq = st.getAll();
      rq.onsuccess = () => (rq.result || []).forEach(r => { if (!r.seen) st.put({ ...r, seen: true }); });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch (e) { return false; }
}

export async function logClear() {
  try {
    const db = await open_();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch (e) { return false; }
}

/** Used when a notification arrives while the app is open: the worker has
 *  already stored it, but the page wants it on screen without a re-read. */
export async function logAdd(entry) {
  try {
    const db = await open_();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ id: (entry.at || '') + '|' + (entry.taskId || entry.kind || ''), seen: false, ...entry });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch (e) { return false; }
}

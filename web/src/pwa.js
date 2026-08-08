/**
 * pwa.js — service-worker registration + update prompt + install hint.
 * Registration is GATED: only on https, never on Apps-Script-served pages
 * (can't own the scope), never on localhost (the exe's OTA is the updater
 * there), never in the single-file build.
 */
const IS_SINGLE = typeof __CF_SINGLEFILE__ !== 'undefined' && __CF_SINGLEFILE__;

function eligible() {
  if (IS_SINGLE) return false;
  if (!('serviceWorker' in navigator)) return false;
  if (location.protocol !== 'https:') return false;
  if (/googleusercontent\.com$|script\.google\.com$/.test(location.hostname)) return false;
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return false;
  return true;
}

function updateToast(reg) {
  if (document.getElementById('cf-sw-toast')) return;
  const el = document.createElement('div');
  el.id = 'cf-sw-toast';
  el.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:400;' +
    'background:var(--card,#1d1d1d);color:var(--ink,#fff);border:1px solid var(--accent,#eb5b2d);' +
    'border-radius:12px;padding:11px 16px;font:600 13px Inter,system-ui,sans-serif;display:flex;gap:12px;align-items:center;box-shadow:0 4px 18px rgba(0,0,0,.25)';
  el.innerHTML = 'New version ready <button style="background:var(--accent,#eb5b2d);color:#fff;border:none;border-radius:8px;padding:7px 14px;font-weight:700;cursor:pointer">Reload</button>';
  el.querySelector('button').onclick = () => {
    if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    let done = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!done) { done = true; location.reload(); } });
    setTimeout(() => { if (!done) { done = true; location.reload(); } }, 1200);
  };
  document.body.appendChild(el);
}

if (eligible()) {
  window.addEventListener('load', async () => {
    try {
      const v = (window.APP_VERSION || 'dev');
      const reg = await navigator.serviceWorker.register('./sw.js?v=' + encodeURIComponent(v));
      if (reg.waiting && navigator.serviceWorker.controller) updateToast(reg);
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) updateToast(reg);
        });
      });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    } catch (e) { /* PWA is a progressive enhancement — never break the app */ }
  });
}

/* install hint: stash the beforeinstallprompt event for the account sheet */
window.__cfInstallEvt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  window.__cfInstallEvt = e;
});
window.cfInstallApp = async function () {
  const evt = window.__cfInstallEvt;
  if (!evt) return false;
  evt.prompt();
  const res = await evt.userChoice.catch(() => null);
  if (res && res.outcome === 'accepted') window.__cfInstallEvt = null;
  return true;
};

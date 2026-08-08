/**
 * push.js — turning notifications on for this device, and keeping them on.
 *
 * Works in ordinary Chrome as well as the installed app: on Windows and
 * Android a plain browser tab can hold a push subscription, and the
 * notification lands in the OS the same way either way. The one platform that
 * insists on installation is iOS — Safari only allows push once the site has
 * been added to the Home Screen (iOS 16.4+) — which is why canPush() reports
 * the reason rather than a bare false.
 */

/** Chrome hands the VAPID key back as base64url; PushManager wants bytes. */
function urlB64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function bufToB64url(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A label so a member can tell their phone from their desk machine in the
 *  admin list. Deliberately coarse — no fingerprinting. */
export function deviceLabel() {
  const ua = navigator.userAgent || '';
  const os = /Android/i.test(ua) ? 'Android'
    : /iPhone|iPad|iPod/i.test(ua) ? 'iPhone/iPad'
    : /Windows/i.test(ua) ? 'Windows'
    : /Mac OS X/i.test(ua) ? 'Mac'
    : /Linux/i.test(ua) ? 'Linux' : 'Device';
  const installed = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return os + ' · ' + (installed ? 'installed app' : browser);
}

/**
 * Why this device can or cannot receive notifications. Returns a reason string
 * rather than a boolean so the UI can tell the truth instead of hiding a
 * greyed-out switch.
 */
export function pushSupport() {
  if (!('serviceWorker' in navigator)) return { ok: false, why: 'This browser has no service worker support.' };
  if (!('PushManager' in window)) {
    const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent || '');
    const standalone = window.navigator.standalone === true;
    if (ios && !standalone) {
      return { ok: false, why: 'On iPhone, notifications only work once you add CreativeFlow to your Home Screen: tap Share, then "Add to Home Screen", then open it from there.' };
    }
    return { ok: false, why: 'This browser cannot receive push notifications.' };
  }
  if (location.protocol !== 'https:') return { ok: false, why: 'Notifications need the secure (https) address.' };
  if (Notification.permission === 'denied') {
    return { ok: false, why: 'Notifications are blocked for this site. Turn them back on in the browser’s site settings (the icon at the left of the address bar), then try again.' };
  }
  return { ok: true, why: '' };
}

export async function pushState() {
  const sup = pushSupport();
  if (!sup.ok) return { supported: false, on: false, why: sup.why };
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return { supported: true, on: false, why: 'The app is still starting up — try again in a moment.' };
    const sub = await reg.pushManager.getSubscription();
    return { supported: true, on: !!sub, why: '' };
  } catch (e) {
    return { supported: true, on: false, why: String(e && e.message || e) };
  }
}

/**
 * Subscribes this device and registers it with the sheet.
 *
 * MUST be called from a click: browsers refuse a permission prompt that was not
 * asked for, and Chrome permanently penalises sites that ask on page load.
 */
export async function pushEnable(api, vapidKey) {
  const sup = pushSupport();
  if (!sup.ok) throw new Error(sup.why);
  if (!vapidKey) throw new Error('The server has not been set up for notifications yet.');

  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    throw new Error(perm === 'denied'
      ? 'You chose Block. Open the icon at the left of the address bar to allow notifications, then try again.'
      : 'Notifications were not allowed.');
  }

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();

  /* If a subscription exists for a DIFFERENT key it is dead to us — the server
     could never authenticate against it — so replace it rather than reuse it. */
  if (sub) {
    const existing = sub.options && sub.options.applicationServerKey
      ? bufToB64url(sub.options.applicationServerKey) : '';
    if (existing && existing !== vapidKey) { await sub.unsubscribe().catch(() => {}); sub = null; }
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,                 // required by Chrome; we always show one
      applicationServerKey: urlB64ToBytes(vapidKey),
    });
  }

  const json = sub.toJSON();
  await api('pushSubscribe', {
    endpoint: sub.endpoint,
    p256dh: json.keys && json.keys.p256dh,
    auth: json.keys && json.keys.auth,
    device: deviceLabel(),
  });
  return true;
}

export async function pushDisable(api) {
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return false;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return false;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  try { await api('pushUnsubscribe', { endpoint }); } catch (e) { /* gone locally either way */ }
  return true;
}

/**
 * Re-registers a subscription the browser silently rotated.
 *
 * Browsers may replace a subscription at any time (Chrome does it after long
 * idles and on some updates). Without this the device simply stops receiving
 * notifications and nothing anywhere reports a problem — the worst failure
 * mode a notification system has.
 */
export async function pushResync(api, vapidKey) {
  try {
    if (!vapidKey || Notification.permission !== 'granted') return false;
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return false;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return false;
    const json = sub.toJSON();
    await api('pushSubscribe', {
      endpoint: sub.endpoint,
      p256dh: json.keys && json.keys.p256dh,
      auth: json.keys && json.keys.auth,
      device: deviceLabel(),
    });
    return true;
  } catch (e) { return false; }
}

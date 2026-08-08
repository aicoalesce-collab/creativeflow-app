import { test, expect } from '@playwright/test';
import { login, resetMock, USERS, MOCK } from './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SW = path.join(HERE, '..', '..', 'web', 'public', 'sw.js');
const SINGLE = path.join(HERE, '..', '..', 'web', 'dist-single', 'index.html');

/**
 * Push notifications.
 *
 * The service worker cannot be exercised through the preview server: it is
 * deliberately not registered on 127.0.0.1 (the whole PWA layer is gated off
 * localhost), and there is no push service to deliver from. So the handlers are
 * tested two ways — the client-side decision logic against the real API, and
 * the worker's push/notificationclick handlers by running their source in a
 * page with the service-worker globals stubbed. That catches the failure that
 * actually matters: a handler that throws, or that never calls
 * showNotification, which Chrome punishes with its own generic banner.
 */
test.describe('push notifications', () => {
  test.beforeEach(async () => { await resetMock(); });

  const call = (page, body) => page.evaluate(async (b) => {
    const r = await fetch('http://127.0.0.1:8787', { method: 'POST', body: JSON.stringify(b) });
    return r.json();
  }, body);

  test('the server hands out a VAPID key on ping @smoke', async ({ page }) => {
    await login(page, USERS.memberG);
    const p = await call(page, { action: 'ping' });
    expect(p.vapidKey).toBeTruthy();
    // a P-256 point, uncompressed, base64url: 65 bytes -> 87 chars, leading 'B' (0x04)
    expect(p.vapidKey).toHaveLength(87);
    expect(p.vapidKey.startsWith('B')).toBe(true);
    expect(p.vapidKey).not.toMatch(/[+/=]/);           // base64URL, not base64
    const client = await page.evaluate(() => (window as any).state.vapidKey);
    expect(client).toBe(p.vapidKey);                   // and the client absorbed it
  });

  test('a device subscribes, and re-subscribing does not duplicate it', async ({ page }) => {
    await login(page, USERS.memberG);
    const M = { email: USERS.memberG.email, code: USERS.memberG.code };
    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', p256dh: 'BFakeKeyForTests', auth: 'authsecret', device: 'Windows · Chrome' };

    expect((await call(page, { action: 'pushSubscribe', ...sub, ...M })).ok).toBe(true);
    expect((await call(page, { action: 'pushSubscribe', ...sub, device: 'Windows · installed app', ...M })).ok).toBe(true);

    const st = await (await fetch(MOCK + '/__state')).json();
    expect(st.push).toHaveLength(1);                   // same endpoint updated in place
    expect(st.push[0].device).toBe('Windows · installed app');
    expect(st.push[0].member).toBe(USERS.memberG.email);
  });

  test('rubbish subscriptions are refused', async ({ page }) => {
    await login(page, USERS.memberG);
    const M = { email: USERS.memberG.email, code: USERS.memberG.code };
    expect((await call(page, { action: 'pushSubscribe', endpoint: 'http://insecure/x', p256dh: 'k', auth: 'a', ...M })).error).toBe('VALIDATION');
    expect((await call(page, { action: 'pushSubscribe', endpoint: 'https://fcm.googleapis.com/x', ...M })).error).toBe('VALIDATION');
  });

  test('one member cannot unsubscribe another member’s device', async ({ page }) => {
    await login(page, USERS.memberG);
    const M = { email: USERS.memberG.email, code: USERS.memberG.code };
    await call(page, { action: 'pushSubscribe', endpoint: 'https://fcm.googleapis.com/fcm/send/mine', p256dh: 'k', auth: 'a', ...M });

    await login(page, USERS.memberV);
    const V = { email: USERS.memberV.email, code: USERS.memberV.code };
    const r = await call(page, { action: 'pushUnsubscribe', endpoint: 'https://fcm.googleapis.com/fcm/send/mine', ...V });
    expect(r.error).toBe('FORBIDDEN');

    const st = await (await fetch(MOCK + '/__state')).json();
    expect(st.push).toHaveLength(1);                   // still there
  });

  test('push actions require a login', async ({ page }) => {
    await login(page, USERS.memberG);
    const r = await call(page, { action: 'pushSubscribe', endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: 'k', auth: 'a' });
    expect(r.error).toBe('AUTH');
  });

  /* ── the worker's own handlers ─────────────────────────────────────────── */

  test('the worker shows a notification for a real push payload', async ({ page }) => {
    await page.goto('/');
    const src = fs.readFileSync(SW, 'utf8');
    const out = await page.evaluate(async ({ src, payload }) => {
      const shown: any[] = [];
      const listeners: Record<string, Function> = {};
      const selfStub: any = {
        location: new URL('https://example.test/sw.js?v=9.9.9'),
        addEventListener: (k: string, fn: Function) => { listeners[k] = fn; },
        skipWaiting: () => {},
        clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => {} },
        registration: { showNotification: async (title: string, opts: any) => { shown.push({ title, opts }); } },
      };
      const cachesStub = { open: async () => ({ addAll: async () => {}, match: async () => null, put: async () => {} }), keys: async () => [] };
      new Function('self', 'caches', 'fetch', 'Response', src)(
        selfStub, cachesStub, () => Promise.reject(new Error('offline')), { error: () => ({}) });

      const waits: Promise<any>[] = [];
      await listeners.push({
        data: { json: () => payload },
        waitUntil: (p: Promise<any>) => waits.push(p),
      });
      await Promise.all(waits);
      return { shown, hasClick: typeof listeners.notificationclick === 'function', hasChange: typeof listeners.pushsubscriptionchange === 'function' };
    }, { src, payload: { title: 'Changes requested', body: 'GD-0007 · Menu card', taskId: 'GD-0007', kind: 'changes', at: new Date().toISOString() } });

    expect(out.shown).toHaveLength(1);
    expect(out.shown[0].title).toBe('Changes requested');
    expect(out.shown[0].opts.body).toContain('GD-0007');
    expect(out.shown[0].opts.tag).toBe('GD-0007');            // collapses per task
    expect(out.shown[0].opts.data.url).toBe('./#/t/GD-0007'); // deep-links to the task
    expect(out.shown[0].opts.requireInteraction).toBe(true);  // 'changes' is not dismissible noise
    expect(out.hasClick).toBe(true);
    expect(out.hasChange).toBe(true);                         // rotated subscriptions are handled
  });

  test('a payload-less push still shows something, never a silent failure', async ({ page }) => {
    await page.goto('/');
    const src = fs.readFileSync(SW, 'utf8');
    const shown = await page.evaluate(async ({ src }) => {
      const out: any[] = [];
      const listeners: Record<string, Function> = {};
      const selfStub: any = {
        location: new URL('https://example.test/sw.js?v=1'),
        addEventListener: (k: string, fn: Function) => { listeners[k] = fn; },
        skipWaiting: () => {},
        clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => {} },
        registration: { showNotification: async (t: string, o: any) => { out.push({ t, o }); } },
      };
      new Function('self', 'caches', 'fetch', 'Response', src)(
        selfStub, { open: async () => ({ addAll: async () => {}, match: async () => null, put: async () => {} }), keys: async () => [] },
        () => Promise.reject(new Error('offline')), { error: () => ({}) });
      const waits: Promise<any>[] = [];
      await listeners.push({ data: null, waitUntil: (p: Promise<any>) => waits.push(p) });
      await Promise.all(waits);
      return out;
    }, { src });

    // Chrome shows its own "site updated in the background" if we show nothing
    expect(shown).toHaveLength(1);
    expect(shown[0].t).toBe('CreativeFlow');
  });

  test('the service worker still never touches API POSTs', async () => {
    const sw = fs.readFileSync(SW, 'utf8');
    expect(sw).toContain("req.method !== 'GET'");
    expect(sw).toContain('url.origin !== self.location.origin');
    // and the push handler must not be behind the fetch guard
    expect(sw.indexOf("addEventListener('push'")).toBeLessThan(sw.indexOf("addEventListener('fetch'"));
  });

  test('the badge icon the notifications reference actually exists', async ({ page }) => {
    const r = await page.request.get('/icons/badge-96.png');
    expect(r.ok(), 'badge-96.png 404s on every notification if missing').toBeTruthy();
    const buf = await r.body();
    expect(buf.subarray(1, 4).toString()).toBe('PNG');
    expect(buf.readUInt32BE(16)).toBe(96);
    expect(buf[25]).toBe(6);                                   // RGBA — the alpha is the mask
  });

  test('the shipped build carries the push client', async () => {
    const html = fs.readFileSync(SINGLE, 'utf8');
    expect(html).toContain('pushSubscribe');
    expect(html).toContain('userVisibleOnly');
    // the iPhone caveat must reach the user, not just the docs
    expect(html).toMatch(/Add to Home Screen/i);
  });
});

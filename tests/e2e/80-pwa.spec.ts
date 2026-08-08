import { test, expect } from '@playwright/test';
import { login, resetMock, USERS } from './helpers';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', '..', 'web', 'dist');
const SINGLE = path.join(HERE, '..', '..', 'web', 'dist-single', 'index.html');

test.describe('PWA + build artifacts', () => {
  test.beforeEach(async () => { await resetMock(); });

  test('manifest is valid and lists the icon set @smoke', async ({ page }) => {
    const res = await page.request.get('/manifest.webmanifest');
    expect(res.ok()).toBeTruthy();
    const m = await res.json();
    expect(m.name).toBe('CreativeFlow');
    expect(m.display).toBe('standalone');
    expect(m.icons.length).toBeGreaterThanOrEqual(3);
    expect(m.icons.some((i: any) => i.purpose === 'maskable')).toBe(true);
    for (const i of m.icons) {
      const r = await page.request.get('/' + i.src);
      expect(r.ok(), i.src).toBeTruthy();
    }
  });

  test('offline shell is served and self-contained', async ({ page }) => {
    const r = await page.request.get('/offline.html');
    expect(r.ok()).toBeTruthy();
    const html = await r.text();
    expect(html).toContain("You're offline");
    expect(html).not.toContain('<script src=');   // no external deps
  });

  test('service worker never intercepts API POSTs', async () => {
    const sw = fs.readFileSync(path.join(DIST, 'sw.js'), 'utf8');
    expect(sw).toContain("req.method !== 'GET'");
    expect(sw).toContain('url.origin !== self.location.origin');
  });

  test('SW registration is gated off localhost and Apps Script origins', async ({ page }) => {
    await login(page, USERS.admin);
    const reg = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return 'no-sw-api';
      const rs = await navigator.serviceWorker.getRegistrations();
      return rs.length;
    });
    expect(reg).toBe(0); // preview runs on 127.0.0.1 → deliberately not registered
  });

  test('CF-BOOT sentinels survive both builds', async () => {
    for (const f of [path.join(DIST, 'index.html'), SINGLE]) {
      const html = fs.readFileSync(f, 'utf8');
      expect(html, f).toMatch(/window\.APP_VERSION\s*=\s*'[\d.]+'/);
      expect(html, f).toContain("window.CF_INJECTED_API = '';");
      expect(html, f).toContain("window.CF_GUEST_TOKEN = '';");
      expect(html, f).toContain("window.CF_OPEN_TASK = '';");
    }
  });

  test('single-file build is self-contained and OTA-shaped', async () => {
    const html = fs.readFileSync(SINGLE, 'utf8');
    expect(html.slice(0, 400)).toContain('<!DOCTYPE html');   // exe /update sanity check
    expect(html).toContain('CreativeFlow');                    // exe /update sanity check
    expect(html).not.toMatch(/<script[^>]+src="\.?\/assets/);  // nothing left to fetch
    expect(html).not.toMatch(/<link[^>]+href="\.?\/assets/);
  });

  test('server-side injection points still match the built markup', async () => {
    // serveApp_ does exact-literal replacement — a build change here breaks
    // ?page=app and every guest link served by Apps Script.
    const html = fs.readFileSync(SINGLE, 'utf8');
    const injected = html.replace("window.CF_INJECTED_API = '';", 'window.CF_INJECTED_API = "https://x/exec";');
    expect(injected).toContain('window.CF_INJECTED_API = "https://x/exec";');
  });

  test('the build talks to Google not at all — no sign-in of any kind', async () => {
    const html = fs.readFileSync(SINGLE, 'utf8');
    expect(html).not.toContain('googleLogin');                       // the retired API action
    expect(html).not.toMatch(/Sign in with Google|Continue with Google/);
    expect(html).not.toContain('google.accounts.id.renderButton');   // the login button
    expect(html).not.toContain('/oauth/start');                      // the exe PKCE flow
    // and since uploads became server-mediated, the Google Identity library is
    // no longer loaded either: no PC ever authenticates to Google
    expect(html).not.toContain('accounts.google.com/gsi/client');
    expect(html).not.toContain('initTokenClient');
  });

  test('uploads go through the server ticket, not a browser token', async () => {
    const html = fs.readFileSync(SINGLE, 'utf8');
    expect(html).toContain('uploadTicket');
    expect(html).toContain('uploadFinish');
    expect(html).toContain('origin');        // required for Drive to CORS-enable the session
  });
});

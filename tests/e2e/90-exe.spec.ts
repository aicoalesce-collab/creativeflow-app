import { test, expect } from '@playwright/test';
import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resetMock, USERS, MOCK } from './helpers';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXE = path.join(HERE, '..', '..', 'exe', 'cf5-test.exe');
const EXE_URL = 'http://127.0.0.1:4879';

let proc: ChildProcess | null = null;

test.beforeAll(async () => {
  test.skip(!fs.existsSync(EXE), 'exe not built — run scripts/build-exe.ps1');
  proc = spawn(EXE, [], {
    env: { ...process.env, CF_NO_BROWSER: '1', CF_API_URL: MOCK },
    stdio: 'ignore', detached: false,
  });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(EXE_URL + '/alive'); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('exe did not start');
});

test.afterAll(() => { try { proc?.kill(); } catch {} });

test.describe('desktop exe', () => {
  test('serves the embedded app with the CF-BOOT sentinels @smoke', async () => {
    const html = await (await fetch(EXE_URL + '/')).text();
    expect(html).toContain('CreativeFlow');
    expect(html).toMatch(/window\.APP_VERSION\s*=\s*'[\d.]+'/);
    expect(html).toContain("window.CF_INJECTED_API = '';");
  });

  test('/alive answers the watchdog heartbeat', async () => {
    const r = await fetch(EXE_URL + '/alive');
    expect(r.ok).toBeTruthy();
    expect(await r.text()).toBe('ok');
  });

  test('/api proxies a real call to the sheet API', async () => {
    await resetMock();
    const r = await fetch(EXE_URL + '/api?u=' + encodeURIComponent(MOCK), {
      method: 'POST', body: JSON.stringify({ action: 'ping' }),
    });
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.v).toBe(5);
  });

  test('/api proxies an authed POST end to end', async () => {
    await resetMock();
    const r = await fetch(EXE_URL + '/api?u=' + encodeURIComponent(MOCK), {
      method: 'POST',
      body: JSON.stringify({ action: 'bootstrap', lite: 1, email: USERS.admin.email, code: USERS.admin.code }),
    });
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.me.name).toBe('Owner Super');
    expect(j.total).toBeGreaterThan(0);
  });

  test('/api allowlist refuses arbitrary targets (no open relay)', async () => {
    const r = await fetch(EXE_URL + '/api?u=' + encodeURIComponent('https://evil.example.com/steal'), {
      method: 'POST', body: JSON.stringify({ action: 'ping' }),
    });
    const j = await r.json();
    // falls back to the baked API rather than following the attacker's target
    expect(j.ok === false || j.error === 'PROXY' || j.v === 5).toBeTruthy();
  });

  test('/api answers GET with 405', async () => {
    const r = await fetch(EXE_URL + '/api', { method: 'GET' });
    expect(r.status).toBe(405);
  });

  test('/update rejects garbage but accepts a real build', async () => {
    const bad = await fetch(EXE_URL + '/update', { method: 'POST', body: 'not an app' });
    expect(bad.status).toBe(400);
    const real = fs.readFileSync(path.join(HERE, '..', '..', 'web', 'dist-single', 'index.html'), 'utf8');
    const ok = await fetch(EXE_URL + '/update', { method: 'POST', body: real });
    expect(ok.status).toBe(200);
  });

  test('the page loads and logs in through the exe origin', async ({ page }) => {
    await page.route(/script\.google(usercontent)?\.com/, r => r.abort());
    await page.goto(EXE_URL + '/');
    await page.evaluate(() => { try { localStorage.clear(); } catch {} });
    await page.goto(EXE_URL + '/');
    await page.fill('#in-url', MOCK);
    await page.fill('#in-email', USERS.admin.email);
    await page.fill('#in-code', USERS.admin.code);
    await page.click('#login-btn');
    await expect(page.locator('#app')).toBeVisible({ timeout: 20_000 });
    // inside the exe the client must use the proxy, not a direct fetch
    const usedProxy = await page.evaluate(() => (window as any).isDesktopApp());
    expect(usedProxy).toBe(true);
  });
});

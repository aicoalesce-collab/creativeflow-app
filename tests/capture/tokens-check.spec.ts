import { test, expect, Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui-shots');
const MOCK = 'http://127.0.0.1:8787';

async function login(page: Page, email: string, code: string, theme = 'light') {
  await page.route(/script\.google(usercontent)?\.com/, r => r.abort());
  await page.addInitScript(({ url, theme }) => {
    try { localStorage.setItem('cf_url', url); localStorage.setItem('cf_theme', theme); } catch {}
    Object.defineProperty(window, 'CF_DEFAULT_API', { get: () => url, set: () => {}, configurable: true });
  }, { url: MOCK, theme });
  await page.goto('/');
  await page.evaluate(() => { try { localStorage.removeItem('cf_email'); localStorage.removeItem('cf_code'); } catch {} });
  await page.goto('/');
  await page.fill('#in-email', email);
  await page.fill('#in-code', code);
  await page.click('#login-btn');
  await expect(page.locator('#app')).toBeVisible({ timeout: 25_000 });
  await page.waitForTimeout(900);
}

test('pass 1 — tokens', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, 'owner.super@example.com', 'AAA111');
  await page.screenshot({ path: path.join(OUT, '_p1-dash.png'), fullPage: true });

  await page.evaluate(() => { (window as any).tab = 'tasks'; (window as any).renderAll(); });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, '_p1-tasks.png'), fullPage: true });

  // every row must carry exactly one state class — that is the whole vocabulary
  const states = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.trow')).map(el =>
      (el.className.match(/trow--(\w+)/) || [])[1] || 'none'));
  console.log('row states:', JSON.stringify(states.reduce((a: any, s) => (a[s] = (a[s] || 0) + 1, a), {})));
  expect(states.filter(s => s === 'none').length).toBe(0);
});

test('pass 1 — dark', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, 'owner.super@example.com', 'AAA111', 'dark');
  await page.screenshot({ path: path.join(OUT, '_p1-dark.png'), fullPage: true });
});

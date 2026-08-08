import { test, expect } from '@playwright/test';
import { spawnMock, waitMock, hermetic, useMock, USERS } from './helpers';

/**
 * THE CROWN JEWEL SUITE — the studio PC that stalls on large HTTPS responses.
 * These scenarios are why the paged protocol exists. If any of them regress,
 * that machine is locked out again.
 */
test.describe('problem-PC conditions', () => {

  test('A: login completes fast while BIG answers hang for 60s @smoke', async ({ page }) => {
    const m = spawnMock(8791, { MOCK_SLOW_BIG: '1', MOCK_PAGE_MAX: '4' });
    await waitMock(m.url);
    try {
      await hermetic(page);
      await useMock(page, m.url);
      await page.goto('/');
      const t0 = Date.now();
      await page.fill('#in-email', USERS.admin.email);
      await page.fill('#in-code', USERS.admin.code);
      await page.click('#login-btn');
      await expect(page.locator('#app')).toBeVisible({ timeout: 20_000 });
      const ms = Date.now() - t0;
      expect(ms, 'paged login must beat the 60s big-answer stall').toBeLessThan(15_000);
      // background pages keep arriving despite the 4-row clamp
      await expect.poll(async () => page.evaluate(() => (window as any).state.tasks.length), { timeout: 20_000 })
        .toBeGreaterThan(15);
    } finally { m.kill(); }
  });

  test('B: silent fallback to the classic single call on an old server', async ({ page }) => {
    const m = spawnMock(8792, { MOCK_NO_PAGER: '1' });
    await waitMock(m.url);
    try {
      await hermetic(page);
      await useMock(page, m.url);
      await page.goto('/');
      await page.fill('#in-email', USERS.admin.email);
      await page.fill('#in-code', USERS.admin.code);
      await page.click('#login-btn');
      await expect(page.locator('#app')).toBeVisible({ timeout: 20_000 });
      const n = await page.evaluate(() => (window as any).state.tasks.length);
      expect(n).toBeGreaterThan(15);
      // no user-visible error from the fallback
      await expect(page.locator('#login-err')).toBeHidden();
    } finally { m.kill(); }
  });

  test('C: size invariant — every login-path answer under 8KB', async ({ page }) => {
    // MOCK_STALL_OVER makes ANY response above the cap hang forever, so a
    // regression that fattens any endpoint fails here, not on the studio PC.
    const m = spawnMock(8793, { MOCK_STALL_OVER: '8192' });
    await waitMock(m.url);
    try {
      await hermetic(page);
      await useMock(page, m.url);
      await page.goto('/');
      await page.fill('#in-email', USERS.memberG.email);
      await page.fill('#in-code', USERS.memberG.code);
      await page.click('#login-btn');
      await expect(page.locator('#app')).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('#content')).toContainText(/GOOD|TASKS/i);
    } finally { m.kill(); }
  });

  test('D: one automatic retry on a timeout, then success', async ({ page }) => {
    const m = spawnMock(8794, { MOCK_TIMEOUT_ONCE: 'bootstrap' });
    await waitMock(m.url);
    try {
      await hermetic(page);
      await useMock(page, m.url);
      await page.goto('/');
      await page.fill('#in-email', USERS.admin.email);
      await page.fill('#in-code', USERS.admin.code);
      await page.click('#login-btn');
      // the client aborts at 45s and retries once — allow for it
      await expect(page.locator('#app')).toBeVisible({ timeout: 70_000 });
    } finally { m.kill(); }
  });

  test('E: exe proxy failure falls back to a direct call', async ({ page }) => {
    await hermetic(page);
    // emulate the exe's /api route answering PROXY (sheet unreachable via Go)
    await page.route('**/api?u=*', r => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'PROXY', message: 'engine could not reach the sheet' }),
    }));
    await useMock(page, 'http://127.0.0.1:8787');
    await page.goto('/');
    await page.fill('#in-email', USERS.admin.email);
    await page.fill('#in-code', USERS.admin.code);
    await page.click('#login-btn');
    await expect(page.locator('#app')).toBeVisible({ timeout: 20_000 });
  });

  test('F: a server HTML error page yields a human NOT_JSON message', async ({ page }) => {
    const m = spawnMock(8795, { MOCK_ERROR_HTML: 'bootstrap' });
    await waitMock(m.url);
    try {
      await hermetic(page);
      await useMock(page, m.url);
      await page.goto('/');
      await page.fill('#in-email', USERS.admin.email);
      await page.fill('#in-code', USERS.admin.code);
      await page.click('#login-btn');
      await expect(page.locator('#login-err')).toContainText(/webpage instead of data/i, { timeout: 20_000 });
    } finally { m.kill(); }
  });
});

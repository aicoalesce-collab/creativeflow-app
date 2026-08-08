import { test, expect } from '@playwright/test';
import { login, resetMock, hermetic, USERS, MOCK } from './helpers';

test.describe('auth @smoke', () => {
  test.beforeEach(async () => { await resetMock(); });

  test('code login lands on the dashboard; login screen is code-only', async ({ page }) => {
    await hermetic(page);
    await page.goto('/');
    // 4.9.2 owner order: NO Google button, ever
    await expect(page.locator('text=Sign in with Google')).toHaveCount(0);
    await login(page, USERS.admin);
    await expect(page.locator('#content')).toContainText('GOOD');
    await expect(page.locator('#app')).toContainText('Owner Super');
  });

  test('wrong code is rejected with a human message', async ({ page }) => {
    await hermetic(page);
    await page.goto('/');
    await page.fill('#in-url', MOCK);
    await page.fill('#in-email', USERS.admin.email);
    await page.fill('#in-code', 'WRONG1');
    await page.click('#login-btn');
    await expect(page.locator('#login-err')).toContainText(/didn’t match|did not match/i);
    await expect(page.locator('#app')).toBeHidden();
  });

  test('unknown email is rejected', async ({ page }) => {
    await hermetic(page);
    await page.goto('/');
    await page.fill('#in-url', MOCK);
    await page.fill('#in-email', 'stranger@example.com');
    await page.fill('#in-code', 'AAA111');
    await page.click('#login-btn');
    await expect(page.locator('#login-err')).toContainText(/didn’t match|did not match/i);
  });

  test('code is case-insensitive', async ({ page }) => {
    await login(page, { email: USERS.memberG.email, code: 'mmm444' });
    await expect(page.locator('#app')).toContainText('Maya Designer');
  });

  test('cleanUrl strips pasted ?action=ping tails', async ({ page }) => {
    await hermetic(page);
    await page.goto('/');
    await page.fill('#in-url', MOCK + '/?action=ping');
    await page.fill('#in-email', USERS.admin.email);
    await page.fill('#in-code', USERS.admin.code);
    await page.click('#login-btn');
    await expect(page.locator('#app')).toBeVisible({ timeout: 20_000 });
  });

  test('assigner tab set has no Dashboard and lands on review', async ({ page }) => {
    await login(page, USERS.assigner);
    await expect(page.locator('#nav')).not.toContainText('Dashboard');
    await expect(page.locator('#nav')).toContainText('Review');
    await expect(page).toHaveURL(/#review/); // force-redirected off overview
  });

  test('no CORS preflight: every API call is a simple text/plain POST', async ({ page }) => {
    const preflights: string[] = [];
    page.on('request', r => { if (r.method() === 'OPTIONS') preflights.push(r.url()); });
    await login(page, USERS.admin);
    expect(preflights).toHaveLength(0);
  });

  test('login-path responses stay ping-sized', async ({ page }) => {
    const sizes: Array<{ url: string; size: number }> = [];
    page.on('response', async r => {
      if (r.url().startsWith(MOCK) && r.request().method() === 'POST') {
        try { sizes.push({ url: r.url(), size: (await r.body()).length }); } catch {}
      }
    });
    await login(page, USERS.admin);
    await page.waitForTimeout(800);
    expect(sizes.length).toBeGreaterThan(1);
    for (const s of sizes) expect(s.size, s.url).toBeLessThan(32_768);
  });
});

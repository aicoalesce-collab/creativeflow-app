import { test, expect } from '@playwright/test';
import { login, resetMock, hermetic, useMock, USERS, MOCK } from './helpers';

/**
 * "Like a real app": a device that has signed in once never sees the login
 * form again until it signs out, and the board paints from the device cache
 * instead of waiting on a round trip.
 */
test.describe('session persistence', () => {
  test.beforeEach(async () => { await resetMock(); });

  test('a returning device goes straight to the board @smoke', async ({ page }) => {
    await login(page, USERS.admin);
    await expect(page.locator('#app')).toBeVisible();

    // reload, exactly like reopening the app tomorrow
    await page.reload();
    await expect(page.locator('#app')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#login')).toBeHidden();
    await expect(page.locator('#content')).toContainText(/GOOD|OVERDUE|OPEN/i);
  });

  test('the cached board paints before the server answers', async ({ page }) => {
    await login(page, USERS.admin);
    await expect.poll(() => page.evaluate(() => (window as any).state.tasks.length), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(20);

    // make every API call hang: only the cache can put tasks on screen
    await page.route(u => u.href.startsWith(MOCK), () => { /* never fulfil */ });
    await page.reload();
    await expect(page.locator('#app')).toBeVisible({ timeout: 10_000 });
    const n = await page.evaluate(() => (window as any).state.tasks.length);
    expect(n, 'board restored from the device cache while the network hangs').toBeGreaterThanOrEqual(20);
    await expect(page.locator('#login')).toBeHidden();
  });

  test('signing out wipes the cached board and shows the login screen', async ({ page }) => {
    await login(page, USERS.admin);
    await page.evaluate(() => (window as any).logout());
    await expect(page.locator('#login')).toBeVisible();
    const cache = await page.evaluate(() => localStorage.getItem('cf_board_v1'));
    expect(cache, 'no board data may survive a sign-out').toBeNull();
  });

  test('a rejected saved login falls back to the login screen', async ({ page }) => {
    await hermetic(page);
    await useMock(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('cf_email', 'owner.super@example.com'); localStorage.setItem('cf_code', 'BADCOD'); } catch {}
    });
    await page.goto('/');
    await expect(page.locator('#login')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#login-err')).toContainText(/didn’t match|did not match/i);
  });

  test('one account\'s cache is never shown to another', async ({ page }) => {
    await login(page, USERS.admin);
    await expect.poll(() => page.evaluate(() => (window as any).state.tasks.length), { timeout: 15_000 }).toBeGreaterThanOrEqual(20);
    // same device, different person signs in
    await login(page, USERS.memberG);
    const names = await page.evaluate(() => (window as any).state.tasks.map((t: any) => t.assignee));
    expect(new Set(names)).toEqual(new Set(['Maya Designer']));
  });
});

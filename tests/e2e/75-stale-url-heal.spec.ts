import { test, expect } from '@playwright/test';
import { hermetic, resetMock, USERS, MOCK } from './helpers';

/**
 * A saved cf_url pointing at a DEAD deployment must not brick the client.
 *
 * Real incident (08 Aug 2026): both exe generations serve on 127.0.0.1:4879 and
 * therefore share localStorage, so every PC that had run the old exe inherited
 * its retired /exec URL and timed out at login with no usable explanation.
 * The client now falls back to its built-in URL and adopts it permanently.
 */
const DEAD = 'https://script.google.com/macros/s/AKfycbxbzcdwZ52DEADDEADDEADDEADDEADiKY87erJ5Eg/exec';

/** Plant state BEFORE any page script runs.
 *  CF_DEFAULT_API is pinned with a getter because index.html's own CF-BOOT block
 *  assigns the real production URL after this init script and would clobber a
 *  plain assignment. */
async function seed(page, savedUrl: string, bakedUrl: string) {
  await page.addInitScript(([saved, baked]) => {
    try { localStorage.setItem('cf_url', saved); } catch {}
    Object.defineProperty(window, 'CF_DEFAULT_API', {
      get: () => baked, set: () => {}, configurable: true,
    });
  }, [savedUrl, bakedUrl]);
}

test.describe('stale saved URL self-heals', () => {
  test.beforeEach(async () => { await resetMock(); });

  test('a dead saved link is replaced by the built-in one at login @smoke', async ({ page }) => {
    await hermetic(page);            // all script.google.com traffic aborted → the dead URL really is dead
    await seed(page, DEAD, MOCK);
    await page.goto('/');

    // (no assertion that it STARTS on the dead link — the boot-time heal in
    // fetchPing usually wins the race, which is the desired behaviour)
    await page.fill('#in-email', USERS.admin.email);
    await page.fill('#in-code', USERS.admin.code);
    await page.click('#login-btn');

    await expect(page.locator('#app')).toBeVisible({ timeout: 40_000 });
    const saved = await page.evaluate(() => localStorage.getItem('cf_url'));
    expect(saved, 'the working URL must be persisted for next launch').toBe(MOCK);
  });

  test('the login screen heals before anyone types a code', async ({ page }) => {
    await hermetic(page);
    await seed(page, DEAD, MOCK);
    await page.goto('/');
    // fetchPing runs on boot: the dead link fails, the built-in one answers, and
    // the displayed address switches without the user doing anything
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('cf_url')), { timeout: 40_000 })
      .toBe(MOCK);
  });

  test('a deliberately different WORKING link is left alone', async ({ page }) => {
    // healing must never undo an admin who pointed this client at another sheet
    await hermetic(page);
    await seed(page, MOCK, 'https://script.google.com/macros/s/SOMEOTHERDEPLOYMENT/exec');
    await page.goto('/');
    await page.fill('#in-email', USERS.admin.email);
    await page.fill('#in-code', USERS.admin.code);
    await page.click('#login-btn');
    await expect(page.locator('#app')).toBeVisible({ timeout: 30_000 });
    const saved = await page.evaluate(() => localStorage.getItem('cf_url'));
    expect(saved, 'a working saved URL must survive').toBe(MOCK);
  });
});

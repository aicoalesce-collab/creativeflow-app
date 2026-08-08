import { test, expect } from '@playwright/test';
import { login, resetMock, hermetic, useMock, USERS, MOCK } from './helpers';

/** Short share links, and clients who can annotate rather than only comment. */
test.describe('share links + guest annotation', () => {
  test.beforeEach(async () => { await resetMock(); });

  const call = (page, body) => page.evaluate(async (b) => {
    const r = await fetch('http://127.0.0.1:8787', { method: 'POST', body: JSON.stringify(b) });
    return r.json();
  }, body);

  test('new tokens are short and the link has no api tail @smoke', async ({ page }) => {
    await login(page, USERS.headG);
    const s = await call(page, { action: 'createShare', taskId: 'GD-0004', mode: 'comment', email: USERS.headG.email, code: USERS.headG.code });
    expect(s.token).toHaveLength(12);

    const url = await page.evaluate(t => (window as any).shareUrl(t), s.token);
    expect(url).toContain('#/r/' + s.token);
    expect(url).not.toContain('api=');            // the app knows its own sheet
    expect(url.length).toBeLessThan(80);          // fits in a message
  });

  test('a short link opens the review room with no login', async ({ page }) => {
    await hermetic(page);
    await useMock(page);
    await page.goto('/#/r/AbCdEfGhJkMnPqRsTuVwXyZ234');   // legacy-length token still valid
    await expect(page.locator('#review')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#login')).toBeHidden();
    expect(await page.evaluate(() => (window as any).rv.guest)).toBe(true);
  });

  test('old ?review= links keep working', async ({ page }) => {
    await hermetic(page);
    await useMock(page);
    await page.goto('/?review=AbCdEfGhJkMnPqRsTuVwXyZ234&api=' + encodeURIComponent(MOCK));
    await expect(page.locator('#review')).toBeVisible({ timeout: 20_000 });
    expect(await page.evaluate(() => (window as any).rv.guest)).toBe(true);
  });

  test('a comment-link guest can place a pin and a marker', async ({ page }) => {
    await login(page, USERS.headG);
    const pin = await call(page, { action: 'guestComment', token: 'AbCdEfGhJkMnPqRsTuVwXyZ234', name: 'Priya', type: 'pin', x: 30.5, y: 44.25, text: 'move the logo left' });
    expect(pin.ok).toBe(true);
    expect(pin.item.type).toBe('pin');
    expect(pin.item.x).toBe(30.5);
    expect(pin.item.guest).toBe(true);
    expect(pin.item.status).toBe('Open');       // shows up as a real change marker

    const mk = await call(page, { action: 'guestComment', token: 'AbCdEfGhJkMnPqRsTuVwXyZ234', name: 'Priya', type: 'marker', tc: 42, text: 'cut here' });
    expect(mk.item.type).toBe('marker');
    expect(mk.item.tc).toBe(42);
  });

  test('a view-only guest still cannot annotate', async ({ page }) => {
    await login(page, USERS.headV);
    const r = await call(page, { action: 'guestComment', token: 'ViewOnlyTokenAbCdEfGhJkMn2', name: 'Nope', type: 'pin', x: 1, y: 1, text: 'x' });
    expect(r.error).toBe('FORBIDDEN');
  });

  test('the guest UI offers annotation only on a comment link', async ({ page }) => {
    await hermetic(page);
    await useMock(page);
    await page.goto('/#/r/AbCdEfGhJkMnPqRsTuVwXyZ234');     // comment mode
    await expect(page.locator('#review')).toBeVisible({ timeout: 20_000 });
    expect(await page.evaluate(() => (window as any).rvCanAnnotate())).toBe(true);

    await page.goto('/#/r/ViewOnlyTokenAbCdEfGhJkMn2');     // view-only
    await page.reload();
    await expect(page.locator('#review')).toBeVisible({ timeout: 20_000 });
    expect(await page.evaluate(() => (window as any).rvCanAnnotate())).toBe(false);
  });
});

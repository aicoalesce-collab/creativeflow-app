import { test, expect } from '@playwright/test';
import { login, resetMock, USERS } from './helpers';

/** New Task: Save · Save & add another · Save & start work. */
test.describe('new task options', () => {
  test.beforeEach(async () => { await resetMock(); });

  async function openNew(page, title = 'Option test') {
    await page.evaluate(() => (window as any).openNewTaskModal());
    await page.fill('#n-title', title);
    const due = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    await page.fill('#n-due', due);
  }

  test('plain Save creates the task as New @smoke', async ({ page }) => {
    await login(page, USERS.headG);
    await openNew(page, 'Plain save');
    await page.click('#create-btn');
    await expect.poll(() => page.evaluate(() =>
      (window as any).state.tasks.filter((t: any) => t.title === 'Plain save').length), { timeout: 15_000 }).toBe(1);
    const t = await page.evaluate(() => (window as any).state.tasks.find((x: any) => x.title === 'Plain save'));
    expect(t.status).toBe('New');
    expect(t.startedAt).toBeFalsy();
    await expect(page.locator('#overlay .modal')).toHaveCount(0);   // closed
  });

  test('Save & start work stamps the clock immediately', async ({ page }) => {
    await login(page, USERS.memberG);
    await openNew(page, 'Start now');
    await expect(page.locator('#create-start-btn')).toBeVisible();
    await page.click('#create-start-btn');
    await expect.poll(() => page.evaluate(() =>
      (window as any).state.tasks.filter((t: any) => t.title === 'Start now').length), { timeout: 15_000 }).toBe(1);
    const t = await page.evaluate(() => (window as any).state.tasks.find((x: any) => x.title === 'Start now'));
    expect(t.status).toBe('In Progress');
    expect(t.startedAt).toBeTruthy();
    expect(t.assignee).toBe('Maya Designer');   // a member claims their own
  });

  test('Save & add another keeps the box open and clears the title', async ({ page }) => {
    await login(page, USERS.headG);
    await openNew(page, 'First of many');
    await page.click('#create-again-btn');
    await expect.poll(() => page.evaluate(() =>
      (window as any).state.tasks.filter((t: any) => t.title === 'First of many').length), { timeout: 15_000 }).toBe(1);
    await expect(page.locator('#n-title')).toBeVisible();          // still open
    await expect(page.locator('#n-title')).toHaveValue('');        // ready for the next
    await expect(page.locator('#n-due')).not.toHaveValue('');      // due date kept

    await page.fill('#n-title', 'Second of many');
    await page.click('#create-again-btn');
    await expect.poll(() => page.evaluate(() =>
      (window as any).state.tasks.filter((t: any) => /of many$/.test(t.title)).length), { timeout: 15_000 }).toBe(2);
  });

  test('an assigner is not offered Save & start work', async ({ page }) => {
    await login(page, USERS.assigner);
    await page.evaluate(() => (window as any).openNewTaskModal());
    await expect(page.locator('#create-start-btn')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).canStartOwn_())).toBe(false);
  });
});

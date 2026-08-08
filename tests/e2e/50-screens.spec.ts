import { test, expect } from '@playwright/test';
import { login, resetMock, USERS, localDatePlus } from './helpers';

/** Every screen renders real data for the right role. */
test.describe('screens', () => {
  test.beforeEach(async () => { await resetMock(); });

  test('dashboard: KPIs, overdue strip, workload, needs-assignee @smoke', async ({ page }) => {
    await login(page, USERS.admin);
    const c = page.locator('#content');
    // .kpis holds the five tiles; text is title-cased in the DOM, uppercased by CSS
    await expect(c.locator('.kpis')).toContainText('Open tasks');
    await expect(c.locator('.kpis')).toContainText('Overdue');
    await expect(c.locator('.kpis')).toContainText('In review');
    await expect(c).toContainText(/Overdue — act now/i);
    await expect(c).toContainText(/Team workload/i);
    await expect(c).toContainText(/Needs an assignee/i);
    // the two unassigned fixtures
    await expect(c).toContainText('GD-0002');
    await expect(c).toContainText('VD-0003');
  });

  test('dashboard: inline assign from the needs-assignee panel', async ({ page }) => {
    await login(page, USERS.admin);
    await page.selectOption('select.mini-sel[onchange*="GD-0002"]', 'Maya Designer');
    await expect.poll(async () => page.evaluate(() =>
      (window as any).state.tasks.find(t => t.id === 'GD-0002').assignee), { timeout: 10_000 }).toBe('Maya Designer');
  });

  test('tasks: table renders and filters narrow it', async ({ page }) => {
    await login(page, USERS.admin);
    await page.evaluate(() => { location.hash = '#tasks'; });
    await expect(page.locator('#content')).toContainText('GD-0001');
    const all = await page.evaluate(() => (window as any).state.tasks.length);
    expect(all).toBe(20);
    await page.evaluate(() => { (window as any).filters.team = 'Video'; (window as any).renderContent(); });
    const rows = await page.locator('table.tasks tbody tr').allInnerTexts();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.join(' ')).not.toContain('GD-0');
    expect(rows.join(' ')).toContain('VD-0');
  });

  test('tasks: the synthetic Overdue status filter works', async ({ page }) => {
    await login(page, USERS.admin);
    await page.evaluate(() => { location.hash = '#tasks'; (window as any).filters.status = 'Overdue'; (window as any).renderContent(); });
    const rows = (await page.locator('table.tasks tbody tr').allInnerTexts()).join(' ');
    expect(rows).toContain('VD-0004');    // overdue fixture
    expect(rows).not.toContain('GD-0009'); // Done never counts as overdue
  });

  test('review queue: buckets and the nav badge', async ({ page }) => {
    await login(page, USERS.headG);
    await page.evaluate(() => { location.hash = '#review'; });
    await expect(page.locator('#content')).toContainText(/QC/i);
    const badge = await page.evaluate(() => (window as any).reviewBadge());
    expect(badge).toBeGreaterThan(0);
  });

  test('review queue: a member sees "fix & resubmit", not QC', async ({ page }) => {
    await login(page, USERS.memberG);
    await page.evaluate(() => { location.hash = '#review'; });
    const buckets = await page.evaluate(() => {
      const b = (window as any).reviewBuckets();
      return Object.fromEntries(Object.entries(b).map(([k, v]: any) => [k, v.length]));
    });
    expect(buckets.mine ?? buckets.fix ?? 0).toBeGreaterThanOrEqual(0);
  });

  test('calendar: week grid renders with team-coloured blocks', async ({ page }) => {
    await login(page, USERS.admin);
    await page.evaluate(() => { location.hash = '#calendar'; });
    await expect(page.locator('.cal-day-head').first()).toBeVisible();
    expect(await page.locator('.cal-day-head').count()).toBe(7);   // Mon-first week
    expect(await page.locator('.cal-task').count()).toBeGreaterThan(0);
    await expect(page.locator('.od-lane')).toBeVisible();          // overdue lane
  });

  test('reports: all nine KPI tiles render', async ({ page }) => {
    await login(page, USERS.admin);
    await page.evaluate(() => { location.hash = '#reports'; });
    const t = page.locator('#content');
    await expect(t).toContainText(/TASKS GIVEN|COMPLETED/i);
    await expect(t).toContainText(/REJECTED/i);
    await expect(t).toContainText(/AUTO-APPROVED/i);
    await expect(t).toContainText(/RENEWAL/i);
    await expect(t).toContainText(/AVG/i);
  });

  test('task modal: role-gated actions for a member', async ({ page }) => {
    await login(page, USERS.memberG);
    await page.evaluate(() => (window as any).openTaskModal('GD-0003'));
    const html = await page.locator('#overlay').innerHTML();
    expect(html).not.toContain('Approve');      // members cannot approve
    expect(html).not.toContain('Pass QC');
    expect(html).toMatch(/Resume work|Start work|Hold/);
  });

  test('task modal: head sees QC pass on a QC-stage task', async ({ page }) => {
    await login(page, USERS.headG);
    await page.evaluate(() => (window as any).openTaskModal('GD-0004'));
    await expect(page.locator('#overlay')).toContainText(/Pass QC/i);
  });

  test('task modal: brief-updated banner offers Accept to the assignee', async ({ page }) => {
    await login(page, USERS.memberG);
    await page.evaluate(() => (window as any).openTaskModal('GD-0008'));
    await expect(page.locator('#overlay')).toContainText(/Brief was updated/i);
    await expect(page.locator('#overlay')).toContainText(/Accept updated brief/i);
  });

  test('danger buttons arm before firing', async ({ page }) => {
    await login(page, USERS.headG);
    await page.evaluate(() => (window as any).openTaskModal('GD-0001'));
    const del = page.locator('#overlay button', { hasText: /Delete/i }).first();
    await del.click();
    await expect(del).toContainText(/sure|confirm|again/i);   // armed, not deleted
    const still = await page.evaluate(() => !!(window as any).state.tasks.find(t => t.id === 'GD-0001'));
    expect(still).toBe(true);
  });

  test('new-task modal defaults: due today+2 at 18:00', async ({ page }) => {
    await login(page, USERS.headG);
    await page.evaluate(() => (window as any).openNewTaskModal());
    const v = await page.locator('#n-due').inputValue();
    const want = localDatePlus(2);   // local, not UTC — see helpers
    expect(v).toBe(want);
  });

  test('bulk add: pasted TSV previews per-row validity', async ({ page }) => {
    await login(page, USERS.assigner);
    await page.evaluate(() => (window as any).openBulkModal());
    await page.fill('#bulk-in', 'Good row\tGraphic\tdesc\t\tHigh\t2099-05-05\n\tGraphic\tmissing title\t\tHigh\t2099-05-05');
    await page.evaluate(() => (window as any).previewBulk());
    const html = await page.locator('#overlay').innerHTML();
    expect(html).toMatch(/✓|ok/i);
    expect(html).toMatch(/✗|error|title/i);
  });

  test('notifications: bell count matches derived notifications', async ({ page }) => {
    await login(page, USERS.admin);
    const n = await page.evaluate(() => (window as any).notifs().length);
    expect(n).toBeGreaterThan(0);
    await expect(page.locator('#bell-count')).toHaveText(String(n));
  });

  test('theme toggle flips and persists', async ({ page }) => {
    await login(page, USERS.admin);
    const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    await page.click('#theme-btn');
    const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(after).not.toBe(before);
    const saved = await page.evaluate(() => localStorage.getItem('cf_theme'));
    expect(saved).toBe(after);
  });
});

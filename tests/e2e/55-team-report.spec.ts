import { test, expect } from '@playwright/test';
import { login, resetMock, USERS } from './helpers';

/**
 * A team head can see the whole studio's NUMBERS without gaining access to
 * another team's task details — that separation is the point of the feature.
 */
test.describe('all-teams report', () => {
  test.beforeEach(async () => { await resetMock(); });

  const call = (page, body) => page.evaluate(async (b) => {
    const r = await fetch('http://127.0.0.1:8787', { method: 'POST', body: JSON.stringify(b) });
    return r.json();
  }, body);

  test('a head sees both teams in the report @smoke', async ({ page }) => {
    await login(page, USERS.headG);
    await page.evaluate(() => { location.hash = '#reports'; });
    await expect(page.locator('#content')).toContainText(/All teams/i);
    await page.evaluate(() => (window as any).setReportScope('all'));
    await expect(page.locator('#content')).toContainText(/Whole studio/i, { timeout: 15_000 });
    const html = await page.locator('#content').innerHTML();
    expect(html).toContain('Graphic');
    expect(html).toContain('Video');           // the other team's numbers are visible
  });

  test('but their task access is still their own team only', async ({ page }) => {
    await login(page, USERS.headG);
    const teams = await page.evaluate(() => (window as any).state.tasks.map((t: any) => t.team));
    expect(new Set(teams)).toEqual(new Set(['Graphic']));
  });

  test('the numbers contain no task titles or links', async ({ page }) => {
    await login(page, USERS.headG);
    const r = await call(page, { action: 'teamStats', days: 30, email: USERS.headG.email, code: USERS.headG.code });
    expect(r.ok).toBe(true);
    const blob = JSON.stringify(r);
    expect(blob).not.toContain('Aftermovie');       // a Video task title
    expect(blob).not.toContain('drive.google.com'); // no deliverable links
    expect(r.teams.length).toBe(2);
    expect(r.teams.map((t: any) => t.name).sort()).toEqual(['Graphic', 'Video']);
  });

  test('members and assigners cannot request it', async ({ page }) => {
    await login(page, USERS.memberG);
    const a = await call(page, { action: 'teamStats', email: USERS.memberG.email, code: USERS.memberG.code });
    expect(a.error).toBe('FORBIDDEN');
    await login(page, USERS.assigner);
    const b = await call(page, { action: 'teamStats', email: USERS.assigner.email, code: USERS.assigner.code });
    expect(b.error).toBe('FORBIDDEN');
  });

  test('the toggle is hidden from members', async ({ page }) => {
    await login(page, USERS.memberG);
    await page.evaluate(() => { location.hash = '#reports'; });
    // match the button itself — the report copy legitimately says "all teams"
    await expect(page.locator('#content button', { hasText: /^All teams$/ })).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).canSeeAllTeams())).toBe(false);
  });

  test('totals line up with the underlying tasks', async ({ page }) => {
    await login(page, USERS.admin);
    const r = await call(page, { action: 'teamStats', days: 3650, email: USERS.admin.email, code: USERS.admin.code });
    const open = await page.evaluate(() =>
      (window as any).state.tasks.filter((t: any) => t.status !== 'Done' && t.status !== 'Rejected').length);
    const reported = r.teams.reduce((a: number, t: any) => a + t.open, 0);
    expect(reported).toBe(open);
  });
});

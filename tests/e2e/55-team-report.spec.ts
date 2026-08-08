import { test, expect } from '@playwright/test';
import { login, resetMock, USERS, localDatePlus } from './helpers';

/**
 * The combined report: a head sees THEIR team's numbers as one figure — their
 * own work and their members' together — with the per-person breakdown under
 * it. A Super Admin gets the same shape once per team. Nobody sees a studio-wide
 * mash-up any more, and no head sees a team that isn't theirs.
 */
test.describe('combined team report', () => {
  test.beforeEach(async () => { await resetMock(); });

  const call = (page, body) => page.evaluate(async (b) => {
    const r = await fetch('http://127.0.0.1:8787', { method: 'POST', body: JSON.stringify(b) });
    return r.json();
  }, body);

  test('a head sees their own team combined, with members under it @smoke', async ({ page }) => {
    await login(page, USERS.headG);
    const H = { email: USERS.headG.email, code: USERS.headG.code };
    // the point of "combined": the head's OWN work counts toward their team
    const own = await call(page, { action: 'createTask', title: 'Head does this one', assignee: 'Gina Head', dueDate: localDatePlus(3), ...H });
    expect(own.ok).toBe(true);

    await page.evaluate(() => { location.hash = '#reports'; });
    await expect(page.locator('#content button', { hasText: /^Team combined$/ })).toHaveCount(1);
    await page.evaluate(() => (window as any).setReportScope('team'));
    await expect(page.locator('#content')).toContainText(/Graphic team · combined/i, { timeout: 15_000 });

    const html = await page.locator('#content').innerHTML();
    expect(html).toContain('Maya Designer');     // a member of their team
    expect(html).toContain('Gina Head');         // …and the head's own row, alongside them

    const r = await call(page, { action: 'teamStats', days: 30, ...H });
    const head = r.people.find((p: any) => p.name === 'Gina Head');
    expect(head.open).toBeGreaterThan(0);
    expect(r.teams[0].open).toBeGreaterThanOrEqual(head.open);   // folded into the team figure
  });

  test('the All teams tab is gone, and a head cannot see the other team', async ({ page }) => {
    await login(page, USERS.headG);
    await page.evaluate(() => { location.hash = '#reports'; });
    await expect(page.locator('#content button', { hasText: /^All teams$/ })).toHaveCount(0);

    await page.evaluate(() => (window as any).setReportScope('team'));
    await expect(page.locator('#content')).toContainText(/Graphic team · combined/i, { timeout: 15_000 });
    const html = await page.locator('#content').innerHTML();
    expect(html).not.toContain('Video team · combined');
    expect(html).not.toContain('Vinod Editor');   // a Video member

    const r = await call(page, { action: 'teamStats', days: 30, email: USERS.headG.email, code: USERS.headG.code });
    expect(r.teams.map((t: any) => t.name)).toEqual(['Graphic']);   // not even sent
    expect(r.people.every((p: any) => p.team === 'Graphic')).toBe(true);
  });

  test('the team figure includes the head and unassigned work', async ({ page }) => {
    await login(page, USERS.headG);
    const r = await call(page, { action: 'teamStats', days: 3650, email: USERS.headG.email, code: USERS.headG.code });
    const team = r.teams[0];
    const peopleOpen = r.people.reduce((a: number, p: any) => a + p.open, 0);
    // combined counts every task in the team, so it is never LESS than the sum
    // of the individuals (unassigned tasks live only in the team figure)
    expect(team.open).toBeGreaterThanOrEqual(peopleOpen);
  });

  test('a Super Admin gets one combined section per team', async ({ page }) => {
    await login(page, USERS.admin);
    const r = await call(page, { action: 'teamStats', days: 30, email: USERS.admin.email, code: USERS.admin.code });
    expect(r.teams.map((t: any) => t.name).sort()).toEqual(['Graphic', 'Video']);

    await page.evaluate(() => { location.hash = '#reports'; });
    await page.evaluate(() => (window as any).setReportScope('team'));
    await expect(page.locator('#content')).toContainText(/Graphic team · combined/i, { timeout: 15_000 });
    await expect(page.locator('#content')).toContainText(/Video team · combined/i);
  });

  test('the people are readable on a phone, where the table is hidden', async ({ page }) => {
    // narrow screens hide .tbl-wrap by design; the report used to have no
    // mobile fallback, so a head on a phone saw team totals and nobody in them
    await page.setViewportSize({ width: 390, height: 780 });
    await login(page, USERS.headG);
    await page.evaluate(() => { location.hash = '#reports'; });
    await page.evaluate(() => (window as any).setReportScope('team'));
    await expect(page.locator('#content')).toContainText(/Graphic team · combined/i, { timeout: 15_000 });

    await expect(page.locator('#content .tbl-wrap').first()).toBeHidden();
    await expect(page.locator('#content .mob-list').first()).toBeVisible();
    await expect(page.locator('#content .mob-list').first()).toContainText('Maya Designer');
  });

  test('the combined report carries a task log, and it can be printed', async ({ page }) => {
    await login(page, USERS.headG);
    await page.evaluate(() => { location.hash = '#reports'; });
    await page.evaluate(() => (window as any).setReportScope('team'));
    await expect(page.locator('#content')).toContainText(/Graphic team · task log/i, { timeout: 15_000 });

    // real task titles, not just counts — including work that is still open
    const txt = await page.locator('#content').innerText();
    expect(txt).toContain('Menu card print file');     // GD-0005, In Review
    expect(txt).not.toContain('Aftermovie');           // a Video task: not this head's

    await expect(page.locator('#content button', { hasText: /Print/i })).toHaveCount(1);
  });

  test('the by-person view has the same log, and it follows the period picker', async ({ page }) => {
    await login(page, USERS.headG);
    await page.evaluate(() => { location.hash = '#reports'; });
    await expect(page.locator('#content')).toContainText(/task log/i, { timeout: 15_000 });

    const forMaya = await page.evaluate(() => {
      (window as any).reportSubject = 'Maya Designer'; (window as any).renderContent();
      return document.getElementById('content')!.innerText;
    });
    expect(forMaya).toMatch(/Maya Designer · task log/i);   // headings are uppercased by CSS
    // open work is listed too — the old log only ever showed completed tasks
    expect(forMaya).toMatch(/Brochure inner pages|Ticket design/i);
  });

  test('their task access is still their own team only', async ({ page }) => {
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
    await expect(page.locator('#content button', { hasText: /combined$/i })).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).canSeeTeamReport())).toBe(false);
  });

  test('an admin total still lines up with the underlying tasks', async ({ page }) => {
    await login(page, USERS.admin);
    const r = await call(page, { action: 'teamStats', days: 3650, email: USERS.admin.email, code: USERS.admin.code });
    const open = await page.evaluate(() =>
      (window as any).state.tasks.filter((t: any) => t.status !== 'Done' && t.status !== 'Rejected').length);
    const reported = r.teams.reduce((a: number, t: any) => a + t.open, 0);
    expect(reported).toBe(open);
  });
});

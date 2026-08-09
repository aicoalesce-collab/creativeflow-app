import { test, expect } from '@playwright/test';
import { login, resetMock, USERS, localDatePlus } from './helpers';

/**
 * Campaigns.
 *
 * A campaign groups tasks that belong together, and its notes hold briefs and
 * client feedback — so "who can see this campaign" is a real access question,
 * not a display preference. Several of these tests call the API directly to
 * prove the scoping survives someone bypassing the UI.
 */
test.describe('projects / campaigns', () => {
  test.beforeEach(async () => { await resetMock(); });

  const call = (page, body) => page.evaluate(async (b) => {
    const r = await fetch('http://127.0.0.1:8787', { method: 'POST', body: JSON.stringify(b) });
    return r.json();
  }, body);

  /* ── the list ──────────────────────────────────────────────────────────── */

  test('an admin sees every campaign with live counts @smoke', async ({ page }) => {
    await login(page, USERS.admin);
    const A = { email: USERS.admin.email, code: USERS.admin.code };
    const r = await call(page, { action: 'projects', ...A });
    expect(r.ok).toBe(true);
    const names = r.projects.map((p: any) => p.name);
    expect(names).toContain('Great White Launch');
    expect(names).toContain('Project 101');

    const gw = r.projects.find((p: any) => p.name === 'Great White Launch');
    const actual = await page.evaluate(() =>
      (window as any).state.tasks.filter((t: any) => t.project === 'Great White Launch').length);
    expect(gw.counts.total).toBe(actual);
    expect(gw.colour).toMatch(/^#[0-9a-f]{6}$/i);
  });

  test('a member only sees campaigns they actually have work in', async ({ page }) => {
    await login(page, USERS.memberV);            // a Video member
    const V = { email: USERS.memberV.email, code: USERS.memberV.code };
    const r = await call(page, { action: 'projects', ...V });
    // every campaign returned must contain at least one of their tasks
    expect(r.projects.every((p: any) => p.counts.total > 0)).toBe(true);
    const mine = await page.evaluate(() =>
      Array.from(new Set((window as any).state.tasks.map((t: any) => t.project).filter(Boolean))));
    for (const p of r.projects) expect(mine).toContain(p.name);
  });

  test('counts are the caller’s own share, not the studio’s', async ({ page }) => {
    await login(page, USERS.admin);
    const all = await call(page, { action: 'projects', email: USERS.admin.email, code: USERS.admin.code });
    await login(page, USERS.memberG);
    const mine = await call(page, { action: 'projects', email: USERS.memberG.email, code: USERS.memberG.code });
    const a = all.projects.find((p: any) => p.name === 'Great White Launch');
    const m = mine.projects.find((p: any) => p.name === 'Great White Launch');
    if (m) expect(m.counts.total).toBeLessThanOrEqual(a.counts.total);
  });

  /* ── creating ──────────────────────────────────────────────────────────── */

  test('a head can start a campaign; a member cannot', async ({ page }) => {
    await login(page, USERS.headG);
    const H = { email: USERS.headG.email, code: USERS.headG.code };
    const ok = await call(page, { action: 'projectCreate', name: 'Monsoon Sale', client: 'Acme', ...H });
    expect(ok.ok).toBe(true);
    expect(ok.project.colour).toBeTruthy();

    const dupe = await call(page, { action: 'projectCreate', name: 'monsoon sale', ...H });
    expect(dupe.error).toBe('VALIDATION');                      // case-insensitive

    await login(page, USERS.memberG);
    const no = await call(page, { action: 'projectCreate', name: 'Sneaky', email: USERS.memberG.email, code: USERS.memberG.code });
    expect(no.error).toBe('FORBIDDEN');
  });

  test('a new task can be filed under a campaign', async ({ page }) => {
    await login(page, USERS.headG);
    const H = { email: USERS.headG.email, code: USERS.headG.code };
    const c = await call(page, {
      action: 'createTask', title: 'Campaign filing test', assignee: 'Maya Designer',
      dueDate: localDatePlus(3), project: 'Great White Launch', ...H,
    });
    expect(c.ok).toBe(true);
    expect(c.task.project).toBe('Great White Launch');

    const r = await call(page, { action: 'projects', ...H });
    const gw = r.projects.find((p: any) => p.name === 'Great White Launch');
    expect(gw.counts.open).toBeGreaterThan(0);
  });

  /* ── notes: the part that carries briefs and client feedback ───────────── */

  test('campaign notes are a feed, newest first', async ({ page }) => {
    await login(page, USERS.headG);
    const H = { email: USERS.headG.email, code: USERS.headG.code };
    await call(page, { action: 'projectNoteAdd', project: 'Great White Launch', text: 'first note', ...H });
    await call(page, { action: 'projectNoteAdd', project: 'Great White Launch', text: 'second note', ...H });
    const r = await call(page, { action: 'projectNotes', project: 'Great White Launch', ...H });
    expect(r.notes).toHaveLength(2);
    expect(r.notes[0].text).toBe('second note');
    expect(r.notes[0].author).toBe('Gina Head');
  });

  test('someone outside a campaign cannot read its notes', async ({ page }) => {
    await login(page, USERS.headG);
    const H = { email: USERS.headG.email, code: USERS.headG.code };
    await call(page, { action: 'projectNoteAdd', project: 'Great White Launch', text: 'client hates the blue', ...H });

    /* The action is authed, but being signed in is not the same as being on the
       campaign. Guessing the name used to be enough to read the brief. */
    await login(page, USERS.memberV);            // Video: no Great White work
    const V = { email: USERS.memberV.email, code: USERS.memberV.code };
    const r = await call(page, { action: 'projectNotes', project: 'Great White Launch', ...V });
    expect(r.error).toBe('FORBIDDEN');
    expect(JSON.stringify(r)).not.toContain('client hates the blue');
  });

  test('a notes page stays ping-sized however long the notes are', async ({ page }) => {
    await login(page, USERS.headG);
    const H = { email: USERS.headG.email, code: USERS.headG.code };
    const huge = 'X'.repeat(4000);
    for (let i = 0; i < 8; i++) {
      await call(page, { action: 'projectNoteAdd', project: 'Great White Launch', text: huge, ...H });
    }
    const r = await call(page, { action: 'projectNotes', project: 'Great White Launch', ...H });
    expect(JSON.stringify(r).length).toBeLessThan(16 * 1024);   // the rule that broke the studio PC
    expect(r.notes.some((n: any) => n.more)).toBe(true);        // long ones are previewed, not dropped
  });

  test('you can remove your own note but not someone else’s', async ({ page }) => {
    await login(page, USERS.headG);
    const H = { email: USERS.headG.email, code: USERS.headG.code };
    const mine = await call(page, { action: 'projectNoteAdd', project: 'Great White Launch', text: 'head note', ...H });

    await login(page, USERS.memberG);
    const M = { email: USERS.memberG.email, code: USERS.memberG.code };
    const theirs = await call(page, { action: 'projectNoteAdd', project: 'Great White Launch', text: 'member note', ...M });
    const no = await call(page, { action: 'projectNoteDel', id: mine.note.id, ...M });
    expect(no.error).toBe('FORBIDDEN');

    const yes = await call(page, { action: 'projectNoteDel', id: theirs.note.id, ...M });
    expect(yes.ok).toBe(true);
  });

  /* ── the tab ───────────────────────────────────────────────────────────── */

  test('the Projects tab lists campaigns and opens one @smoke', async ({ page }) => {
    await login(page, USERS.admin);
    await page.evaluate(() => { (window as any).tab = 'projects'; (window as any).renderAll(); });
    await expect(page.locator('#content .pj-card').first()).toBeVisible({ timeout: 15_000 });

    const card = page.locator('#content .pj-card', { hasText: 'Great White Launch' });
    await expect(card).toHaveCount(1);
    await card.click();                                          // real click, not a direct call

    await expect(page.locator('#content .pj-hero-name')).toContainText('Great White Launch');
    expect(await page.evaluate(() => (window as any).projPick)).toBe('Great White Launch');
  });

  test('a campaign has Overview, Tasks, Gallery and Notes', async ({ page }) => {
    await login(page, USERS.admin);
    await page.evaluate(() => { (window as any).tab = 'projects'; (window as any).renderAll(); });
    await page.locator('#content .pj-card', { hasText: 'Great White Launch' }).click();

    for (const label of ['Overview', 'Tasks', 'Gallery', 'Notes']) {
      await expect(page.locator('#content .pj-subs button', { hasText: new RegExp('^' + label + '$') })).toHaveCount(1);
    }

    await page.locator('#content .pj-subs button', { hasText: /^Tasks$/ }).click();
    await expect(page.locator('#content')).toContainText('GD-', { timeout: 10_000 });

    await page.locator('#content .pj-subs button', { hasText: /^Notes$/ }).click();
    await expect(page.locator('#pn-text')).toBeVisible({ timeout: 10_000 });

    await page.locator('#content .pj-subs button', { hasText: /^Gallery$/ }).click();
    await expect(page.locator('#content')).toContainText(/finished|Nothing finished/i, { timeout: 10_000 });
  });

  test('the campaign task list holds only that campaign', async ({ page }) => {
    await login(page, USERS.admin);
    await page.evaluate(() => { (window as any).tab = 'projects'; (window as any).renderAll(); });
    await page.locator('#content .pj-card', { hasText: 'Great White Launch' }).click();
    await page.locator('#content .pj-subs button', { hasText: /^Tasks$/ }).click();

    const shown = await page.locator('#content tbody tr').count();
    const expected = await page.evaluate(() =>
      (window as any).state.tasks.filter((t: any) => t.project === 'Great White Launch').length);
    expect(shown).toBe(expected);
  });

  test('Add task inside a campaign pre-fills it', async ({ page }) => {
    await login(page, USERS.admin);
    await page.evaluate(() => { (window as any).tab = 'projects'; (window as any).renderAll(); });
    await page.locator('#content .pj-card', { hasText: 'Project 101' }).click();
    await page.locator('#content .pj-hero-a button', { hasText: /Add task/ }).click();
    await expect(page.locator('#n-project')).toBeVisible();
    expect(await page.locator('#n-project').inputValue()).toBe('Project 101');
  });

  test('the new-task dialog can start a campaign without leaving it', async ({ page }) => {
    await login(page, USERS.headG);
    await page.evaluate(() => (window as any).openNewTaskModal());
    await expect(page.locator('#n-project')).toBeVisible();

    await page.locator('#overlay button', { hasText: /＋ New/ }).click();
    await page.fill('#np-inline-name', 'Inline Campaign');
    await page.locator('#np-inline button', { hasText: /^Create$/ }).click();

    await expect.poll(() => page.locator('#n-project').inputValue(), { timeout: 10_000 }).toBe('Inline Campaign');
    await expect(page.locator('#np-inline')).toBeHidden();
  });

  /* ── the phone pill ────────────────────────────────────────────────────── */

  test('the phone + opens a pill offering task or campaign', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, USERS.admin);

    await page.locator('#tabbar .tb-new').click();
    await expect(page.locator('#add-pill')).toBeVisible();
    await expect(page.locator('#add-pill button', { hasText: 'Add task' })).toHaveCount(1);
    await expect(page.locator('#add-pill button', { hasText: 'Add campaign' })).toHaveCount(1);
    await expect(page.locator('#tabbar .tb-new')).toHaveClass(/open/);

    // tapping the scrim closes it
    await page.locator('#add-scrim').click({ position: { x: 10, y: 10 } });
    await expect(page.locator('#add-pill')).toHaveCount(0);
  });

  test('a member is not offered Add campaign', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, USERS.memberG);
    await page.locator('#tabbar .tb-new').click();
    await expect(page.locator('#add-pill button', { hasText: 'Add task' })).toHaveCount(1);
    await expect(page.locator('#add-pill button', { hasText: 'Add campaign' })).toHaveCount(0);
  });

  test('#projects survives a reload', async ({ page }) => {
    await login(page, USERS.admin);
    await page.evaluate(() => { (window as any).tab = 'projects'; (window as any).renderAll(); });
    expect(await page.evaluate(() => location.hash)).toBe('#projects');
    await page.reload();
    await expect(page.locator('#app')).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => page.evaluate(() => (window as any).tab), { timeout: 20_000 }).toBe('projects');
  });
});

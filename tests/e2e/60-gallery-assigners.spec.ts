import { test, expect } from '@playwright/test';
import { login, resetMock, USERS } from './helpers';

/**
 * The work gallery and the assigners tab.
 *
 * The gallery's scoping is enforced on the SERVER, not by filtering what the
 * client happens to hold — a gallery row carries a link to finished work, so
 * "member sees only their own" has to survive someone calling the action
 * directly. Half these tests do exactly that.
 */
test.describe('gallery + assigners', () => {
  test.beforeEach(async () => { await resetMock(); });

  const call = (page, body) => page.evaluate(async (b) => {
    const r = await fetch('http://127.0.0.1:8787', { method: 'POST', body: JSON.stringify(b) });
    return r.json();
  }, body);

  /* ── scoping, straight at the API ──────────────────────────────────────── */

  test('a member only ever gets their own finished work @smoke', async ({ page }) => {
    await login(page, USERS.memberG);
    const M = { email: USERS.memberG.email, code: USERS.memberG.code };
    const r = await call(page, { action: 'gallery', ...M });
    expect(r.ok).toBe(true);
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((i: any) => i.assignee === 'Maya Designer')).toBe(true);

    // and asking for the whole team changes nothing — the server ignores it
    const wide = await call(page, { action: 'gallery', scope: 'team', ...M });
    expect(wide.items.every((i: any) => i.assignee === 'Maya Designer')).toBe(true);
  });

  test('a head gets the whole team, and can narrow to just their own', async ({ page }) => {
    await login(page, USERS.headG);
    const H = { email: USERS.headG.email, code: USERS.headG.code };
    const team = await call(page, { action: 'gallery', scope: 'team', ...H });
    expect(team.items.every((i: any) => i.team === 'Graphic')).toBe(true);
    expect(team.items.some((i: any) => i.assignee !== 'Gina Head')).toBe(true);   // other people's work

    const mine = await call(page, { action: 'gallery', scope: 'mine', ...H });
    expect(mine.items.every((i: any) => i.assignee === 'Gina Head')).toBe(true);
    expect(mine.items.length).toBeLessThanOrEqual(team.items.length);
  });

  test('a head never sees the other team, however they ask', async ({ page }) => {
    await login(page, USERS.headG);
    const H = { email: USERS.headG.email, code: USERS.headG.code };
    const r = await call(page, { action: 'gallery', scope: 'team', team: 'Video', ...H });
    expect(r.items.every((i: any) => i.team === 'Graphic')).toBe(true);   // the team hint is ignored for heads
  });

  test('an assigner sees the work they commissioned, not the team’s', async ({ page }) => {
    await login(page, USERS.assigner);
    const A = { email: USERS.assigner.email, code: USERS.assigner.code };
    const r = await call(page, { action: 'gallery', ...A });
    expect(r.ok).toBe(true);
    expect(r.items.every((i: any) => i.requester === 'Rohit Mehta')).toBe(true);
  });

  test('an admin sees everything and can filter by team', async ({ page }) => {
    await login(page, USERS.admin);
    const A = { email: USERS.admin.email, code: USERS.admin.code };
    const all = await call(page, { action: 'gallery', ...A });
    const teams = new Set(all.items.map((i: any) => i.team));
    expect(teams.size).toBeGreaterThan(1);

    const vid = await call(page, { action: 'gallery', team: 'Video', ...A });
    expect(vid.items.every((i: any) => i.team === 'Video')).toBe(true);
  });

  test('only finished work with a file appears', async ({ page }) => {
    await login(page, USERS.admin);
    const A = { email: USERS.admin.email, code: USERS.admin.code };
    const r = await call(page, { action: 'gallery', ...A });
    expect(r.items.every((i: any) => i.link)).toBe(true);

    const tasks = await page.evaluate(() => (window as any).state.tasks);
    const doneWithFile = tasks.filter((t: any) => t.status === 'Done' && t.deliverable).length;
    expect(r.total).toBe(doneWithFile);
  });

  test('one entry per task — the latest version only, never a version history', async ({ page }) => {
    await login(page, USERS.admin);
    const A = { email: USERS.admin.email, code: USERS.admin.code };

    // GD-0005 and VD-0002 carry TWO deliverable versions in the fixtures
    const before = await call(page, { action: 'gallery', ...A });
    const ids = before.items.map((i: any) => i.id);
    expect(new Set(ids).size, 'a task appeared more than once').toBe(ids.length);

    // approve a multi-version task and confirm it still occupies exactly one card
    await call(page, { action: 'updateTask', id: 'VD-0002', patch: { status: 'Done' }, ...A });
    const after = await call(page, { action: 'gallery', ...A });
    const mine = after.items.filter((i: any) => i.id === 'VD-0002');
    expect(mine).toHaveLength(1);

    const versions = await call(page, { action: 'listReview', taskId: 'VD-0002', ...A });
    expect(versions.versions.length).toBeGreaterThan(1);   // it really does have several
    expect(mine[0].link).toBe(versions.versions[versions.versions.length - 1].link);   // …and we show the last
  });

  test('only Done work is in the gallery', async ({ page }) => {
    await login(page, USERS.admin);
    const A = { email: USERS.admin.email, code: USERS.admin.code };
    const r = await call(page, { action: 'gallery', ...A });
    const done = await page.evaluate(() => (window as any).state.tasks.filter((t: any) => t.status === 'Done').map((t: any) => t.id));
    expect(r.items.every((i: any) => done.includes(i.id))).toBe(true);
    // and every piece belongs to a real team
    expect(r.items.every((i: any) => ['Graphic', 'Video'].includes(i.team))).toBe(true);
  });

  test('the answer is paged and stays small', async ({ page }) => {
    await login(page, USERS.admin);
    const A = { email: USERS.admin.email, code: USERS.admin.code };
    const r = await call(page, { action: 'gallery', ...A });
    expect(r.items.length).toBeLessThanOrEqual(24);
    expect(JSON.stringify(r).length).toBeLessThan(16 * 1024);   // the ping-sized rule
    expect(r).toHaveProperty('next');
  });

  /* ── the gallery on screen ─────────────────────────────────────────────── */

  test('the gallery renders as a masonry of finished work', async ({ page }) => {
    await login(page, USERS.admin);
    await page.evaluate(() => { (window as any).tab = 'gallery'; (window as any).renderAll(); });
    await expect(page.locator('#content .gallery')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#content .g-card').first()).toBeVisible();

    const cols = await page.evaluate(() => getComputedStyle(document.querySelector('#content .gallery')!).columnCount);
    expect(Number(cols)).toBeGreaterThan(1);                   // it is actually columnar

    // cards carry the task id and open the task
    const first = page.locator('#content .g-card').first();
    await expect(first.locator('.g-s')).toContainText(/[A-Z]{2}-\d{4}/);
  });

  test('a card with no usable picture still says something', async ({ page }) => {
    await login(page, USERS.admin);
    await page.evaluate(() => { (window as any).tab = 'gallery'; (window as any).renderAll(); });
    await expect(page.locator('#content .gallery')).toBeVisible({ timeout: 15_000 });
    // force the failure path the way a dead Drive link would
    const text = await page.evaluate(() => {
      const img = document.querySelector('#content .g-card img') as HTMLImageElement;
      if (!img) return 'no-img';
      (window as any).galImgFail(img);
      return document.querySelector('#content .g-card .g-noimg')?.textContent || '';
    });
    expect(text).toMatch(/unavailable|no-img/);
  });

  test('the gallery tab is offered to every role', async ({ page }) => {
    for (const who of [USERS.admin, USERS.headG, USERS.memberG, USERS.assigner]) {
      await login(page, who);
      const ids = await page.evaluate(() => (window as any).TAB_DEFS_().map((t: any) => t.id));
      expect(ids, who.email).toContain('gallery');
    }
  });

  /* ── assigners tab ─────────────────────────────────────────────────────── */

  test('the assigners tab groups requests by who asked @smoke', async ({ page }) => {
    await login(page, USERS.admin);
    await page.evaluate(() => { (window as any).tab = 'assigners'; (window as any).renderAll(); });
    await expect(page.locator('#content')).toContainText('Rohit Mehta', { timeout: 15_000 });

    /* CLICK the chip — do not call setAssigner() directly. The first version of
       this markup emitted onclick="setAssigner("Name")", whose attribute ended
       at the second quote, so every chip was dead. Driving the function by hand
       sailed straight past that. */
    const chip = page.locator('#content .filters button', { hasText: 'Rohit Mehta' });
    await expect(chip).toHaveCount(1);
    await chip.click();

    const shown = await page.evaluate(() => ({
      txt: document.getElementById('content')!.innerText,
      picked: (window as any).assignerPick,
      tasks: (window as any).state.tasks.filter((t: any) => t.requester === 'Rohit Mehta').length,
    }));
    expect(shown.picked).toBe('Rohit Mehta');                                 // the click actually landed
    expect(shown.txt).toMatch(new RegExp(`${shown.tasks} requests?`, 'i'));   // headings are uppercased by CSS

    const rows = await page.locator('#content tbody tr').count();
    expect(rows).toBe(shown.tasks);
  });

  test('every assigner chip is clickable, including names with punctuation', async ({ page }) => {
    await login(page, USERS.admin);
    await page.evaluate(() => { (window as any).tab = 'assigners'; (window as any).renderAll(); });
    await expect(page.locator('#content .filters button').first()).toBeVisible({ timeout: 15_000 });

    const chips = page.locator('#content .filters button');
    const n = await chips.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      await chips.nth(i).click();
      const picked = await page.evaluate(() => (window as any).assignerPick);
      expect(picked, `chip ${i} did nothing`).toBeTruthy();
      await expect(page.locator('#content .panel .p-h h3')).toContainText(picked);
    }
  });

  test('a refresh on #gallery or #assigners lands where it left off', async ({ page }) => {
    await login(page, USERS.admin);
    for (const id of ['gallery', 'assigners']) {
      await page.evaluate((t) => { (window as any).tab = t; (window as any).renderAll(); }, id);
      expect(await page.evaluate(() => location.hash)).toBe('#' + id);
      await page.reload();
      await expect(page.locator('#app')).toBeVisible({ timeout: 20_000 });
      /* the boot whitelist knew only the original five tabs, AND enterApp
         overwrote whatever it restored — so no tab survived a refresh at all */
      await expect.poll(() => page.evaluate(() => (window as any).tab), {
        timeout: 20_000, message: `#${id} did not survive a reload`,
      }).toBe(id);
    }
  });

  test('a member cold-starting #assigners is put back on the dashboard', async ({ page }) => {
    await login(page, USERS.memberG);
    await page.evaluate(() => { location.hash = '#assigners'; });
    await page.reload();
    await expect(page.locator('#app')).toBeVisible({ timeout: 20_000 });
    expect(await page.evaluate(() => (window as any).tab)).toBe('overview');
  });

  test('the assigners tab is hidden from members and from assigners themselves', async ({ page }) => {
    await login(page, USERS.memberG);
    let ids = await page.evaluate(() => (window as any).TAB_DEFS_().map((t: any) => t.id));
    expect(ids).not.toContain('assigners');

    await login(page, USERS.assigner);
    ids = await page.evaluate(() => (window as any).TAB_DEFS_().map((t: any) => t.id));
    expect(ids).not.toContain('assigners');   // their own Tasks tab already IS their requests

    await login(page, USERS.headG);
    ids = await page.evaluate(() => (window as any).TAB_DEFS_().map((t: any) => t.id));
    expect(ids).toContain('assigners');
  });

  test('a head only sees their own team’s side of an assigner’s requests', async ({ page }) => {
    await login(page, USERS.headG);
    await page.evaluate(() => { (window as any).tab = 'assigners'; (window as any).renderAll(); });
    await expect(page.locator('#content')).toContainText('Rohit Mehta', { timeout: 15_000 });
    const teams = await page.evaluate(() => {
      const w = window as any;
      w.setAssigner('Rohit Mehta');
      return w.state.tasks.filter((t: any) => t.requester === 'Rohit Mehta').map((t: any) => t.team);
    });
    expect(new Set(teams)).toEqual(new Set(['Graphic']));   // task scope already did this
  });

  /* ── the phone ─────────────────────────────────────────────────────────── */

  test('seven tabs still fit across a 390px phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await login(page, USERS.admin);
    const bar = page.locator('#tabbar');
    await expect(bar).toBeVisible();

    const m = await page.evaluate(() => {
      const tb = document.getElementById('tabbar')!;
      return { scroll: tb.scrollWidth, client: tb.clientWidth, tight: tb.classList.contains('tight'), n: tb.querySelectorAll('.tb').length };
    });
    expect(m.n).toBeGreaterThan(6);            // 6 tabs + the ＋ button
    expect(m.tight).toBe(true);                // compact mode kicked in
    expect(m.scroll).toBeLessThanOrEqual(m.client + 1);   // and nothing runs off the side
  });
test("everyone who commissions work is listed, not only the Assigner role", async ({ page }) => {
    await login(page, USERS.admin);
    await page.evaluate(() => { (window as any).tab = "assigners"; (window as any).renderAll(); });
    await expect(page.locator("#content .filters button").first()).toBeVisible({ timeout: 15_000 });

    const seen = await page.evaluate(() => (window as any).assignerList_().map((p: any) => p.name));
    const requesters = await page.evaluate(() =>
      Array.from(new Set((window as any).state.tasks.map((t: any) => String(t.requester || "").trim()).filter(Boolean))));

    /* Restricting this to role === "Assigner" left the tab completely empty
       against real data, where heads and members request from each other. */
    for (const r of requesters) expect(seen, r + " commissions work but is missing").toContain(r);

    // and the busiest requester leads
    const counts = await page.evaluate(() => (window as any).assignerList_()
      .map((p: any) => (window as any).state.tasks.filter((t: any) => t.requester === p.name).length));
    expect(counts).toEqual([...counts].sort((a: number, b: number) => b - a));
  });
});

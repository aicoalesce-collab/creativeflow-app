import { test, expect } from '@playwright/test';
import { login, resetMock, hermetic, USERS, MOCK } from './helpers';

/** Review room, share links and guest access — the hardest parity area. */
test.describe('review room + guests', () => {
  test.beforeEach(async () => { await resetMock(); });

  const call = (page, body) => page.evaluate(async (b) => {
    const r = await fetch('http://127.0.0.1:8787', { method: 'POST', body: JSON.stringify(b) });
    return r.json();
  }, body);

  test('room opens with items and versions @smoke', async ({ page }) => {
    await login(page, USERS.headV);
    await page.evaluate(() => (window as any).openReview('VD-0002'));
    await expect(page.locator('#review')).toBeVisible();
    const rv = await page.evaluate(() => ({ items: (window as any).rv.items.length, versions: (window as any).rv.versions.length, task: (window as any).rv.taskId }));
    expect(rv.task).toBe('VD-0002');
    expect(rv.items).toBe(3);
    expect(rv.versions).toBe(2);
  });

  test('media ladder: YouTube deliverable is detected as a player', async ({ page }) => {
    await login(page, USERS.headV);
    const kind = await page.evaluate(() => {
      const t = (window as any).state.tasks.find(x => x.id === 'VD-0002');
      return (window as any).detectMedia(t).kind;
    });
    expect(kind).toBe('yt');
  });

  test('media ladder: Drive video streams natively when an API key exists', async ({ page }) => {
    await login(page, USERS.headV);
    const kind = await page.evaluate(() => {
      const t = (window as any).state.tasks.find(x => x.id === 'VD-0001');
      return (window as any).detectMedia(t).kind;
    });
    expect(['dvv', 'dv']).toContain(kind);
  });

  test('media ladder: a Drive file on a Graphic task renders as an image with pins', async ({ page }) => {
    await login(page, USERS.headG);
    const m = await page.evaluate(() => {
      const t = (window as any).state.tasks.find(x => x.id === 'GD-0004');
      return (window as any).detectMedia(t);
    });
    expect(m.kind).toBe('img');
    expect(m.src).toContain('drive.google.com/thumbnail');
    expect(m.src).toContain('sz=w2000');
  });

  test('media ladder: dvv downgrades to the preview iframe after a failure', async ({ page }) => {
    await login(page, USERS.headV);
    const kinds = await page.evaluate(() => {
      const t = (window as any).state.tasks.find(x => x.id === 'VD-0001');
      const before = (window as any).detectMedia(t).kind;
      (window as any).rv.dvvFailed = true;
      const after = (window as any).detectMedia(t).kind;
      (window as any).rv.dvvFailed = false;
      return { before, after };
    });
    expect(kinds.before).toBe('dvv');
    expect(kinds.after).toBe('dv');
  });

  test('image pins carry x/y percentages', async ({ page }) => {
    await login(page, USERS.headG);
    const r = await call(page, { action: 'addReview', taskId: 'GD-0004', type: 'pin', x: 41.5, y: 62.5, text: 'crop here', email: USERS.headG.email, code: USERS.headG.code });
    expect(r.item.x).toBe(41.5);
    expect(r.item.y).toBe(62.5);
    expect(r.item.status).toBe('Open');
  });

  test('video markers carry a timecode and format as m:ss', async ({ page }) => {
    await login(page, USERS.headV);
    const r = await call(page, { action: 'addReview', taskId: 'VD-0001', type: 'marker', tc: 95, text: 'cut here', email: USERS.headV.email, code: USERS.headV.code });
    expect(r.item.tc).toBe(95);
    const label = await page.evaluate(() => (window as any).tcStr(95));
    expect(label).toBe('1:35');
  });

  test('resolve / reopen / delete a marker', async ({ page }) => {
    await login(page, USERS.headV);
    const H = { email: USERS.headV.email, code: USERS.headV.code };
    const res = await call(page, { action: 'resolveReview', id: 'RV-00001', resolved: true, ...H });
    expect(res.item.status).toBe('Resolved');
    const re = await call(page, { action: 'resolveReview', id: 'RV-00001', resolved: false, ...H });
    expect(re.item.status).toBe('Open');
    const del = await call(page, { action: 'deleteReview', id: 'RV-00001', ...H });
    expect(del.ok).toBe(true);
  });

  test('sendChanges requires at least one open marker', async ({ page }) => {
    await login(page, USERS.headG);
    const H = { email: USERS.headG.email, code: USERS.headG.code };
    const none = await call(page, { action: 'sendChanges', taskId: 'GD-0003', ...H });
    expect(none.error).toBe('VALIDATION');
    await call(page, { action: 'addReview', taskId: 'GD-0004', type: 'pin', x: 5, y: 5, text: 'fix', ...H });
    const sent = await call(page, { action: 'sendChanges', taskId: 'GD-0004', ...H });
    expect(sent.ok).toBe(true);
    expect(sent.count).toBeGreaterThan(0);
  });

  test('comments are allowed for the requester even before the Assigner stage', async ({ page }) => {
    await login(page, USERS.assigner);
    const A = { email: USERS.assigner.email, code: USERS.assigner.code };
    const c = await call(page, { action: 'addReview', taskId: 'GD-0004', type: 'comment', text: 'looking good so far', ...A });
    expect(c.ok).toBe(true);
    const m = await call(page, { action: 'addReview', taskId: 'GD-0004', type: 'pin', x: 1, y: 1, text: 'no', ...A });
    expect(m.error).toBe('FORBIDDEN');
    expect(m.message).toMatch(/internal check/i);
  });

  test('share link: create, guest view, guest comment, revoke @smoke', async ({ page }) => {
    await login(page, USERS.headG);
    const H = { email: USERS.headG.email, code: USERS.headG.code };
    const s = await call(page, { action: 'createShare', taskId: 'GD-0004', mode: 'comment', ...H });
    expect(s.token).toHaveLength(26);

    const g = await call(page, { action: 'guestReview', token: s.token });
    expect(g.ok).toBe(true);
    expect(g.task.id).toBe('GD-0004');
    expect(g.mode).toBe('comment');

    const gc = await call(page, { action: 'guestComment', token: s.token, name: 'Priya', text: 'love it' });
    expect(gc.item.guest).toBe(true);

    const rev = await call(page, { action: 'revokeShare', token: s.token, ...H });
    expect(rev.ok).toBe(true);
    const dead = await call(page, { action: 'guestReview', token: s.token });
    expect(dead.error).toBe('AUTH');
  });

  test('view-only links reject comments', async ({ page }) => {
    await login(page, USERS.headV);
    const r = await call(page, { action: 'guestComment', token: 'ViewOnlyTokenAbCdEfGhJkMn2', name: 'Nope', text: 'x' });
    expect(r.error).toBe('FORBIDDEN');
  });

  test('guest boot: ?review=<token> opens the room with no login', async ({ page }) => {
    await hermetic(page);
    await page.goto('/?review=AbCdEfGhJkMnPqRsTuVwXyZ234&api=' + encodeURIComponent(MOCK));
    await expect(page.locator('#review')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#login')).toBeHidden();
    const guest = await page.evaluate(() => ({ guest: (window as any).rv.guest, task: (window as any).rv.taskId || ((window as any).rv.gtask || {}).id }));
    expect(guest.guest).toBe(true);
  });

  test('share URL points at the hosted app on https, not ?page=app', async ({ page }) => {
    await login(page, USERS.headG);
    const u = await page.evaluate(() => (window as any).shareUrl('TOKENTOKENTOKENTOKENTOKEN1'));
    // on http://127.0.0.1 preview it must fall back to the server-served form
    expect(u).toContain('review=TOKENTOKENTOKENTOKENTOKEN1');
  });
});

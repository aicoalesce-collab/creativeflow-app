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
    expect(s.token).toHaveLength(12);   // shortened deliberately (see 45-share-links)

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

  /* Guest ANNOTATION, driven through the real UI.
     The API accepted guest pins/markers from day one and the API-level test
     above passed — but the client returned a read-only hint for every guest
     before the annotation tools were ever reached, so in the actual product a
     guest could only type a reply. Nothing caught it because no test opened a
     guest link and tried to mark anything. These do. */

  /** The comment-link fixture is a Drive image; serve a real one so the click
   *  target has a real box, and keep the test off the network. */
  const stubImage = (page) => page.route(/drive\.google\.com\/thumbnail/, r => r.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#333"/></svg>',
  }));

  const openAsGuest = async (page, token: string) => {
    await hermetic(page);
    await page.route(/youtube\.com|youtu\.be/, r => r.abort());   // no player → manual timecode path
    await stubImage(page);
    await page.goto('/');
    await page.evaluate(() => { try { localStorage.clear(); } catch {} });
    await page.goto('/?review=' + token + '&api=' + encodeURIComponent(MOCK));
    await expect(page.locator('#review')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#rv-tools')).toBeVisible();
  };

  test('guest on a comment link can PIN a change on the image @smoke', async ({ page }) => {
    await openAsGuest(page, 'AbCdEfGhJkMnPqRsTuVwXyZ234');   // GD-0005, mode: comment

    // the annotation affordance must actually be offered — this is what was missing
    await expect(page.locator('#rv-tools')).toContainText(/click anywhere on the image/i);
    expect(await page.evaluate(() => (window as any).rvCanAnnotate())).toBe(true);

    const pinsBefore = await page.locator('#pin-layer .pin').count();   // GD-0005 already has one
    await page.locator('#img-wrap').click({ position: { x: 240, y: 180 } });
    await expect(page.locator('#pin-layer .pin.hot')).toHaveCount(1);   // ghost pin marks the spot

    // the note box must appear — and ask for the name in place, not 'below the comments'
    await expect(page.locator('#rv-form-text')).toBeVisible();
    await expect(page.locator('#rv-form-name')).toBeVisible();
    await page.fill('#rv-form-name', 'Ananya Client');
    await page.fill('#rv-form-text', 'logo sits too low here');
    await page.click('#rv-form-save');

    const mine = page.locator('#rv-scroll .mk').last();
    await expect(mine).toContainText('logo sits too low here');
    await expect(mine).toContainText('Ananya Client');
    await expect(mine).toContainText('guest');                          // attributed, not anonymous
    await expect(page.locator('#pin-layer .pin')).toHaveCount(pinsBefore + 1);
    await expect(page.locator('#rv-form-text')).toHaveCount(0);         // form closes after saving

    // and it really persisted, as a pin, with coordinates
    const g = await call(page, { action: 'guestReview', token: 'AbCdEfGhJkMnPqRsTuVwXyZ234' });
    const pin = g.items.find((i: any) => i.type === 'pin' && i.author === 'Ananya Client');
    expect(pin).toBeTruthy();
    expect(pin.guest).toBe(true);
    expect(pin.status).toBe('Open');
    expect(pin.x).toBeGreaterThan(0);
    expect(pin.y).toBeGreaterThan(0);
  });

  test('guest on a comment link can mark a video timecode', async ({ page }) => {
    await login(page, USERS.headV);
    const s = await call(page, { action: 'createShare', taskId: 'VD-0002', mode: 'comment', email: USERS.headV.email, code: USERS.headV.code });
    expect(s.ok).toBe(true);

    await openAsGuest(page, s.token);
    await page.fill('#rv-tc', '1:23');
    await page.click('#rv-tools .btn-p');

    await expect(page.locator('.rv-form-h')).toContainText('1:23');
    await page.fill('#rv-form-name', 'Ananya Client');
    await page.fill('#rv-form-text', 'cut the dead air here');
    await page.click('#rv-form-save');

    await expect(page.locator('#rv-scroll')).toContainText('cut the dead air here');
    const g = await call(page, { action: 'guestReview', token: s.token });
    const mk = g.items.find((i: any) => i.type === 'marker' && i.author === 'Ananya Client');
    expect(mk.tc).toBe(83);
    expect(mk.guest).toBe(true);
  });

  test('guests still cannot resolve or send changes, or touch studio entries', async ({ page }) => {
    await openAsGuest(page, 'AbCdEfGhJkMnPqRsTuVwXyZ234');
    await expect(page.locator('#rv-send')).toHaveCount(0);        // send-changes button
    await expect(page.locator('#rv-share-btn')).toHaveCount(0);   // share button
    await expect(page.locator('#rv-scroll .mk-a .mk-btn')).toHaveCount(0);  // no ✕ on the studio's markers
    expect(await page.evaluate(() => (window as any).rvCanAnnotate())).toBe(true);

    // and the server refuses even if the request is forged
    const studio = await call(page, { action: 'guestReview', token: 'AbCdEfGhJkMnPqRsTuVwXyZ234' });
    const theirs = studio.items.find((i: any) => !i.guest);
    const r = await call(page, { action: 'guestDelete', token: 'AbCdEfGhJkMnPqRsTuVwXyZ234', id: theirs.id, name: theirs.author });
    expect(r.error).toBe('FORBIDDEN');
  });

  test('a guest can delete a note they just added @smoke', async ({ page }) => {
    await openAsGuest(page, 'AbCdEfGhJkMnPqRsTuVwXyZ234');
    await page.locator('#img-wrap').click({ position: { x: 200, y: 150 } });
    await page.fill('#rv-form-name', 'Ananya Client');
    await page.fill('#rv-form-text', 'wrong spot, ignore this');
    await page.click('#rv-form-save');

    const mine = page.locator('#rv-scroll .mk').last();
    await expect(mine).toContainText('wrong spot, ignore this');

    const del = mine.locator('.mk-btn');
    await expect(del).toHaveCount(1);        // exactly one: delete, never resolve
    await del.click();                        // arm…
    await expect(del).toHaveText(/sure/i);
    await del.click();                        // …confirm

    await expect(page.locator('#rv-scroll')).not.toContainText('wrong spot, ignore this');
    const g = await call(page, { action: 'guestReview', token: 'AbCdEfGhJkMnPqRsTuVwXyZ234' });
    expect(g.items.some((i: any) => i.text === 'wrong spot, ignore this')).toBe(false);
  });

  test("a guest cannot delete another guest's note, or one already resolved", async ({ page }) => {
    await openAsGuest(page, 'AbCdEfGhJkMnPqRsTuVwXyZ234');
    const made = await call(page, { action: 'guestComment', token: 'AbCdEfGhJkMnPqRsTuVwXyZ234', name: 'First Client', type: 'pin', x: 10, y: 10, text: 'theirs' });

    const wrongName = await call(page, { action: 'guestDelete', token: 'AbCdEfGhJkMnPqRsTuVwXyZ234', id: made.item.id, name: 'Someone Else' });
    expect(wrongName.error).toBe('FORBIDDEN');
    expect(wrongName.message).toMatch(/different name/i);

    // once the studio resolves it, it is part of the record
    await login(page, USERS.headG);
    const res = await call(page, { action: 'resolveReview', id: made.item.id, resolved: true, email: USERS.headG.email, code: USERS.headG.code });
    expect(res.ok).toBe(true);
    const late = await call(page, { action: 'guestDelete', token: 'AbCdEfGhJkMnPqRsTuVwXyZ234', id: made.item.id, name: 'First Client' });
    expect(late.error).toBe('FORBIDDEN');
    expect(late.message).toMatch(/already actioned/i);
  });

  test('a view-only link cannot delete anything', async ({ page }) => {
    await login(page, USERS.headV);
    const items = await call(page, { action: 'listReview', taskId: 'VD-0002', email: USERS.headV.email, code: USERS.headV.code });
    const r = await call(page, { action: 'guestDelete', token: 'ViewOnlyTokenAbCdEfGhJkMn2', id: items.items[0].id, name: items.items[0].author });
    expect(r.error).toBe('FORBIDDEN');
  });

  test('a view-only guest link offers no annotation at all', async ({ page }) => {
    await openAsGuest(page, 'ViewOnlyTokenAbCdEfGhJkMn2');        // VD-0002, mode: view
    await expect(page.locator('#rv-tools')).toContainText(/view-only/i);
    await expect(page.locator('#rv-tools .btn')).toHaveCount(0);
    await expect(page.locator('#rv-tc')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).rvCanAnnotate())).toBe(false);
    await expect(page.locator('#rv-compose')).toContainText(/view-only/i);
  });

  test('share URL uses the short review route on its own origin', async ({ page }) => {
    await login(page, USERS.headG);
    const u = await page.evaluate(() => (window as any).shareUrl('TOKENTOKENTOKENTOKENTOKEN1'));
    // a hosted copy of the app serves the review route from its own origin
    expect(u).toContain('#/r/TOKENTOKENTOKENTOKENTOKEN1');
  });
});

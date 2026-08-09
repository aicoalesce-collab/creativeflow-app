import { test, expect } from '@playwright/test';
import { login, resetMock, USERS, localDatePlus } from './helpers';

/**
 * The QC → approval flow, and the two rules the owner set on top of it.
 *
 * Both rules are enforced on the SERVER, not just shaped in the UI — a hidden
 * field is a courtesy, a refused request is a rule. These tests call the API
 * directly for exactly that reason.
 */
test.describe('workflow rules', () => {
  test.beforeEach(async () => { await resetMock(); });

  const call = (page, body) => page.evaluate(async (b) => {
    const r = await fetch('http://127.0.0.1:8787', { method: 'POST', body: JSON.stringify(b) });
    return r.json();
  }, body);

  /* ── who allocates ─────────────────────────────────────────────────────── */

  test('an assigner cannot choose who does the work @smoke', async ({ page }) => {
    await login(page, USERS.assigner);
    const A = { email: USERS.assigner.email, code: USERS.assigner.code };
    const no = await call(page, {
      action: 'createTask', title: 'Assigner picks a person', assignee: 'Maya Designer',
      dueDate: localDatePlus(3), ...A,
    });
    expect(no.error).toBe('FORBIDDEN');
    expect(no.message).toMatch(/team head decides/i);

    // …but sending it in unassigned is exactly what they should do
    const yes = await call(page, {
      action: 'createTask', title: 'Assigner sends work in', team: 'Graphic',
      dueDate: localDatePlus(3), ...A,
    });
    expect(yes.ok).toBe(true);
    expect(yes.task.assignee).toBe('');
  });

  test('a member may keep their own work but not hand it to a colleague', async ({ page }) => {
    await login(page, USERS.memberG);
    const M = { email: USERS.memberG.email, code: USERS.memberG.code };

    const mine = await call(page, {
      action: 'createTask', title: 'Logging my own job', assignee: 'Maya Designer',
      dueDate: localDatePlus(2), ...M,
    });
    expect(mine.ok).toBe(true);
    expect(mine.task.assignee).toBe('Maya Designer');

    const theirs = await call(page, {
      action: 'createTask', title: 'Volunteering a colleague', assignee: 'Test Bot',
      dueDate: localDatePlus(2), ...M,
    });
    expect(theirs.error).toBe('FORBIDDEN');
  });

  test('a head allocates freely', async ({ page }) => {
    await login(page, USERS.headG);
    const H = { email: USERS.headG.email, code: USERS.headG.code };
    const r = await call(page, {
      action: 'createTask', title: 'Head allocates', assignee: 'Maya Designer',
      dueDate: localDatePlus(2), ...H,
    });
    expect(r.ok).toBe(true);
    expect(r.task.assignee).toBe('Maya Designer');
  });

  test('the new-task box drops the picker for anyone who cannot allocate', async ({ page }) => {
    await login(page, USERS.assigner);
    await page.evaluate(() => (window as any).openNewTaskModal());
    await expect(page.locator('#overlay')).toContainText(/Your team head decides/i);
    await expect(page.locator('#n-assignee')).toHaveCount(0);      // no picker at all

    await login(page, USERS.memberG);
    await page.evaluate(() => (window as any).openNewTaskModal());
    const opts = await page.locator('#n-assignee option').allTextContents();
    expect(opts.join(' ')).toMatch(/Maya Designer/);               // themselves
    expect(opts.join(' ')).not.toMatch(/Vinod|Test Bot/);          // nobody else

    await login(page, USERS.headG);
    await page.evaluate(() => (window as any).openNewTaskModal());
    const all = await page.locator('#n-assignee option').allTextContents();
    expect(all.length).toBeGreaterThan(3);                         // the full roster
  });

  /* ── nothing attached, nothing to review ───────────────────────────────── */

  test('a task with no file cannot go to QC @smoke', async ({ page }) => {
    await login(page, USERS.memberG);
    const M = { email: USERS.memberG.email, code: USERS.memberG.code };
    // GD-0011 is In Progress with no deliverable and no pending brief
    const r = await call(page, { action: 'updateTask', id: 'GD-0011', patch: { status: 'In Review' }, ...M });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toMatch(/attach the file|paste a link/i);

    const still = await call(page, { action: 'taskDetail', id: 'GD-0011', ...M });
    expect(still.task.status).toBe('In Progress');                 // and it really did not move
  });

  test('attaching the file in the same breath is allowed', async ({ page }) => {
    await login(page, USERS.memberG);
    const M = { email: USERS.memberG.email, code: USERS.memberG.code };
    const r = await call(page, {
      action: 'updateTask', id: 'GD-0011',
      patch: { status: 'In Review', deliverable: 'https://drive.google.com/file/d/1BrandNewFileIdAbCdEfGh/view' }, ...M,
    });
    expect(r.ok).toBe(true);
    expect(r.task.status).toBe('In Review');
    expect(r.task.stage).toBe('QC');                               // to the head first
  });

  /* ── the round trip ────────────────────────────────────────────────────── */

  test('member → head → assigner → revisions → back round again', async ({ page }) => {
    const M = { email: USERS.memberG.email, code: USERS.memberG.code };
    const H = { email: USERS.headG.email, code: USERS.headG.code };
    const A = { email: USERS.assigner.email, code: USERS.assigner.code };

    await login(page, USERS.memberG);
    let r = await call(page, {
      action: 'updateTask', id: 'GD-0011',
      patch: { status: 'In Review', deliverable: 'https://drive.google.com/file/d/1RoundTripFileIdAbCdEfG/view' }, ...M,
    });
    expect(r.task.stage).toBe('QC');                               // head first, not the client

    await login(page, USERS.headG);
    r = await call(page, { action: 'qcPass', id: 'GD-0011', ...H });
    expect(r.ok).toBe(true);
    expect(r.task.stage).toBe('Assigner');                         // now it is the client's move

    // the assigner asks for changes
    await login(page, USERS.assigner);
    await call(page, { action: 'addReview', taskId: 'GD-0011', type: 'comment', text: 'colour is off', ...A });
    r = await call(page, { action: 'updateTask', id: 'GD-0011', patch: { status: 'Revisions' }, ...A });
    expect(r.ok).toBe(true);

    await login(page, USERS.memberG);
    const back = await call(page, { action: 'taskDetail', id: 'GD-0011', ...M });
    expect(back.task.status).toBe('Revisions');
    expect(back.task.revisions).toBe(1);                            // round 1 counted

    r = await call(page, { action: 'acceptChanges', id: 'GD-0011', ...M });
    expect(r.task.status).toBe('In Progress');                      // and round two begins
  });

  test('a head sending work back at QC does not burn a revision round', async ({ page }) => {
    const M = { email: USERS.memberG.email, code: USERS.memberG.code };
    const H = { email: USERS.headG.email, code: USERS.headG.code };

    await login(page, USERS.memberG);
    await call(page, {
      action: 'updateTask', id: 'GD-0011',
      patch: { status: 'In Review', deliverable: 'https://drive.google.com/file/d/1QcBounceFileIdAbCdEfG/view' }, ...M,
    });

    await login(page, USERS.headG);
    const r = await call(page, { action: 'updateTask', id: 'GD-0011', patch: { status: 'Revisions' }, ...H });
    expect(r.ok).toBe(true);

    const after = await call(page, { action: 'taskDetail', id: 'GD-0011', ...H });
    /* The internal check is free — only the assigner's changes count against
       the three-round limit. */
    expect(after.task.revisions).toBe(0);
    expect(after.task.qcRounds).toBe(1);
  });

  test('the client offers Send for QC instead of a status dropdown', async ({ page }) => {
    await login(page, USERS.memberG);
    await page.evaluate(() => (window as any).openTaskModal('GD-0011'));
    const btn = page.locator('#overlay button', { hasText: /Send for QC/ });
    await expect(btn).toHaveCount(1);

    // no file on GD-0011 yet: it should refuse before it ever reaches the server
    await btn.click();
    await expect(page.locator('#toasts')).toContainText(/attach the file|paste a link/i);
  });
});

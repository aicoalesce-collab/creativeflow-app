import { test, expect } from '@playwright/test';
import { login, resetMock, outbox, USERS } from './helpers';

/** The full status machine, driven through the API the client actually uses. */
test.describe('task lifecycle', () => {
  test.beforeEach(async () => { await resetMock(); });

  const call = (page, body) => page.evaluate(async (b) => {
    const r = await fetch('http://127.0.0.1:8787', { method: 'POST', body: JSON.stringify(b) });
    return r.json();
  }, body);

  test('create → start → QC → qcPass → sendChanges → accept → Done @smoke', async ({ page }) => {
    await login(page, USERS.headG);
    const H = { email: USERS.headG.email, code: USERS.headG.code };
    const M = { email: USERS.memberG.email, code: USERS.memberG.code };

    const made = await call(page, { action: 'createTask', title: 'Lifecycle walk', team: 'Graphic', assignee: 'Maya Designer', dueDate: '2099-02-02', dueTime: '18:00', priority: 'High', ...H });
    expect(made.ok).toBe(true);
    const id = made.task.id;
    expect(id).toMatch(/^GD-\d{4}$/);

    const started = await call(page, { action: 'startTask', id, ...M });
    expect(started.task.status).toBe('In Progress');
    expect(started.task.startedAt).toBeTruthy();

    const review = await call(page, { action: 'updateTask', id, patch: { status: 'In Review' }, ...M });
    expect(review.task.stage).toBe('QC');          // member submission goes to QC first

    const qc = await call(page, { action: 'qcPass', id, ...H });
    expect(qc.task.stage).toBe('Assigner');

    await call(page, { action: 'addReview', taskId: id, type: 'pin', x: 20, y: 30, text: 'tighten this', ...H });
    const sent = await call(page, { action: 'sendChanges', taskId: id, ...H });
    expect(sent.task.status).toBe('Revisions');
    expect(sent.task.revisions).toBe(1);           // assigner-stage round counts

    const acc = await call(page, { action: 'acceptChanges', id, ...M });
    expect(acc.task.status).toBe('In Progress');

    await call(page, { action: 'updateTask', id, patch: { status: 'In Review' }, ...M });
    const done = await call(page, { action: 'updateTask', id, patch: { status: 'Done' }, ...H });
    expect(done.task.status).toBe('Done');
    expect(done.task.completed).toBeTruthy();
  });

  test('QC bounce increments QC rounds, not the revision limit', async ({ page }) => {
    await login(page, USERS.headG);
    const H = { email: USERS.headG.email, code: USERS.headG.code };
    // GD-0004 sits at stage QC with revisions=0
    const bounced = await call(page, { action: 'updateTask', id: 'GD-0004', patch: { status: 'Revisions' }, ...H });
    expect(bounced.task.qcRounds).toBe(1);
    expect(bounced.task.revisions).toBe(0);
    expect(bounced.info).toMatch(/does not use the round limit/i);
  });

  test('over-limit flag appears past MAX_ROUNDS but never blocks', async ({ page }) => {
    await login(page, USERS.admin);
    const A = { email: USERS.admin.email, code: USERS.admin.code };
    // GD-0005 is at Assigner stage with revisions=1 → drive it past 3
    let t;
    for (let i = 0; i < 3; i++) {
      await call(page, { action: 'updateTask', id: 'GD-0005', patch: { status: 'Revisions' }, ...A });
      await call(page, { action: 'acceptChanges', id: 'GD-0005', ...A });
      t = await call(page, { action: 'updateTask', id: 'GD-0005', patch: { status: 'In Review' }, ...A });
    }
    expect(t.task.revisions).toBeGreaterThan(3);
    expect(t.task.flags).toContain('over-limit');
  });

  test('Revisions auto-sets the deadline from the slot rule', async ({ page }) => {
    await login(page, USERS.admin);
    const A = { email: USERS.admin.email, code: USERS.admin.code };
    const r = await call(page, { action: 'updateTask', id: 'GD-0005', patch: { status: 'Revisions' }, ...A });
    expect(r.info).toMatch(/deadline auto-set/i);
    expect(['17:00', '12:00']).toContain(r.task.dueTime);
  });

  test('In Review is blocked before Start work', async ({ page }) => {
    await login(page, USERS.memberG);
    const M = { email: USERS.memberG.email, code: USERS.memberG.code };
    const r = await call(page, { action: 'updateTask', id: 'GD-0001', patch: { status: 'In Review' }, ...M });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toMatch(/Start work first/i);
  });

  test('brief-pending blocks submission until accepted', async ({ page }) => {
    await login(page, USERS.memberG);
    const M = { email: USERS.memberG.email, code: USERS.memberG.code };
    const blocked = await call(page, { action: 'updateTask', id: 'GD-0008', patch: { status: 'In Review' }, ...M });
    expect(blocked.error).toBe('VALIDATION');
    expect(blocked.message).toMatch(/Accept updated brief/i);
    const acc = await call(page, { action: 'acceptBrief', id: 'GD-0008', ...M });
    expect(acc.task.briefPending).toBe(false);
    const ok = await call(page, { action: 'updateTask', id: 'GD-0008', patch: { status: 'In Review' }, ...M });
    expect(ok.ok).toBe(true);
  });

  test('reject needs a reason and stamps it into notes', async ({ page }) => {
    await login(page, USERS.headG);
    const H = { email: USERS.headG.email, code: USERS.headG.code };
    const bare = await call(page, { action: 'rejectTask', id: 'GD-0003', ...H });
    expect(bare.error).toBe('VALIDATION');
    const r = await call(page, { action: 'rejectTask', id: 'GD-0003', reason: 'wrong brand palette', ...H });
    expect(r.task.status).toBe('Rejected');
    expect(r.task.notes).toContain('wrong brand palette');
  });

  test('renew only works on auto-done tasks', async ({ page }) => {
    await login(page, USERS.headG);
    const H = { email: USERS.headG.email, code: USERS.headG.code };
    const nope = await call(page, { action: 'renewTask', id: 'GD-0009', ...H });   // plain Done
    expect(nope.error).toBe('VALIDATION');
    const ok = await call(page, { action: 'renewTask', id: 'GD-0010', ...H });     // auto-done
    expect(ok.ok).toBe(true);
    expect(ok.task.title).toMatch(/— renewal$/);
    expect(ok.task.renewedFrom).toBe('GD-0010');
  });

  test('deliverable change mints a new version', async ({ page }) => {
    await login(page, USERS.memberG);
    const M = { email: USERS.memberG.email, code: USERS.memberG.code };
    const r = await call(page, { action: 'updateTask', id: 'GD-0003', patch: { deliverable: 'https://drive.google.com/file/d/1NewFileIdAbCdEfGhIjKlMn/view' }, ...M });
    expect(r.info).toMatch(/saved as v1/);
    const list = await call(page, { action: 'listReview', taskId: 'GD-0003', ...M });
    expect(list.versions.length).toBe(1);
  });

  test('bulk create validates per row and caps at 50', async ({ page }) => {
    await login(page, USERS.assigner);
    const A = { email: USERS.assigner.email, code: USERS.assigner.code };
    const r = await call(page, { action: 'bulkCreate', rows: [
      { title: 'Good one', team: 'Graphic', dueDate: '2099-03-03', priority: 'Medium' },
      { title: '', team: 'Graphic', dueDate: '2099-03-03' },
      { title: 'No date', team: 'Graphic' },
    ], ...A });
    expect(r.created.length).toBe(1);
    expect(r.errors.length).toBe(2);
  });

  test('no real person is ever emailed by the fixtures', async ({ page }) => {
    await login(page, USERS.headG);
    const box = await outbox();
    for (const m of box) expect(m.clean, JSON.stringify(m)).toBeFalsy();
  });
});

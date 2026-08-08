import { test, expect } from '@playwright/test';
import { login, resetMock, USERS, MOCK } from './helpers';

/** Scoping + the forbidden-action matrix, enforced server-side. */
test.describe('roles and scoping', () => {
  test.beforeEach(async () => { await resetMock(); });

  const call = (page, body) => page.evaluate(async (b) => {
    const r = await fetch('http://127.0.0.1:8787', { method: 'POST', body: JSON.stringify(b) });
    return r.json();
  }, body);

  test('each role sees only its own slice @smoke', async ({ page }) => {
    await login(page, USERS.memberG);
    let ids = await page.evaluate(() => (window as any).state.tasks.map(t => t.assignee));
    expect(new Set(ids)).toEqual(new Set(['Maya Designer']));

    await login(page, USERS.headV);
    let teams = await page.evaluate(() => (window as any).state.tasks.map(t => t.team));
    expect(new Set(teams)).toEqual(new Set(['Video']));

    await login(page, USERS.assigner);
    let reqs = await page.evaluate(() => (window as any).state.tasks.map(t => t.requester));
    expect(new Set(reqs)).toEqual(new Set(['Rohit Mehta']));

    await login(page, USERS.admin);
    const n = await page.evaluate(() => (window as any).state.tasks.length);
    expect(n).toBe(20);
  });

  test('member cannot mark Done or Rejected', async ({ page }) => {
    await login(page, USERS.memberG);
    const a = await call(page, { action: 'updateTask', id: 'GD-0003', patch: { status: 'Done' }, email: USERS.memberG.email, code: USERS.memberG.code });
    expect(a.error).toBe('FORBIDDEN');
    const b = await call(page, { action: 'updateTask', id: 'GD-0003', patch: { status: 'Rejected' }, email: USERS.memberG.email, code: USERS.memberG.code });
    expect(b.error).toBe('FORBIDDEN');
  });

  test('member cannot edit fields that belong to the head', async ({ page }) => {
    await login(page, USERS.memberG);
    const r = await call(page, { action: 'updateTask', id: 'GD-0003', patch: { priority: 'Low' }, email: USERS.memberG.email, code: USERS.memberG.code });
    expect(r.error).toBe('FORBIDDEN');
  });

  test('only heads can pass QC', async ({ page }) => {
    await login(page, USERS.memberG);
    const r = await call(page, { action: 'qcPass', id: 'GD-0004', email: USERS.memberG.email, code: USERS.memberG.code });
    expect(r.error).toBe('FORBIDDEN');
    const ok = await call(page, { action: 'qcPass', id: 'GD-0004', email: USERS.headG.email, code: USERS.headG.code });
    expect(ok.ok).toBe(true);
    expect(ok.task.stage).toBe('Assigner');
  });

  test('assigner verdict is gated on the Assigner stage', async ({ page }) => {
    await login(page, USERS.assigner);
    // GD-0004 is at QC — the team is still on it
    const early = await call(page, { action: 'updateTask', id: 'GD-0004', patch: { status: 'Done' }, email: USERS.assigner.email, code: USERS.assigner.code });
    expect(['VALIDATION', 'FORBIDDEN']).toContain(early.error);
    // GD-0005 has reached the assigner
    const ok = await call(page, { action: 'updateTask', id: 'GD-0005', patch: { status: 'Done' }, email: USERS.assigner.email, code: USERS.assigner.code });
    expect(ok.ok).toBe(true);
  });

  test('assigner cannot patch team-owned fields, and can only send Done/Revisions', async ({ page }) => {
    await login(page, USERS.assigner);
    const bad = await call(page, { action: 'updateTask', id: 'GD-0005', patch: { assignee: 'Gina Head' }, email: USERS.assigner.email, code: USERS.assigner.code });
    expect(bad.error).toBe('FORBIDDEN');
    const bad2 = await call(page, { action: 'updateTask', id: 'GD-0005', patch: { status: 'On Hold' }, email: USERS.assigner.email, code: USERS.assigner.code });
    expect(bad2.error).toBe('FORBIDDEN');
  });

  test('assigner can delete only an unstarted New task they requested', async ({ page }) => {
    await login(page, USERS.assigner);
    const started = await call(page, { action: 'deleteTask', id: 'GD-0003', email: USERS.assigner.email, code: USERS.assigner.code });
    expect(started.error).toBe('VALIDATION');
    const fresh = await call(page, { action: 'deleteTask', id: 'GD-0001', email: USERS.assigner.email, code: USERS.assigner.code });
    expect(fresh.ok).toBe(true);
  });

  test('a member cannot start someone else\'s task, but can claim an unassigned one', async ({ page }) => {
    await login(page, USERS.memberV);
    const other = await call(page, { action: 'startTask', id: 'GD-0003', email: USERS.memberV.email, code: USERS.memberV.code });
    expect(other.error).toBe('FORBIDDEN');
    const claim = await call(page, { action: 'startTask', id: 'VD-0003', email: USERS.memberV.email, code: USERS.memberV.code });
    expect(claim.ok).toBe(true);
    expect(claim.task.assignee).toBe('Vinod Editor');
    expect(claim.info).toMatch(/yours now/i);
  });

  test('bulk add is for requesters and heads only', async ({ page }) => {
    await login(page, USERS.memberG);
    const r = await call(page, { action: 'bulkCreate', rows: [{ title: 'x', team: 'Graphic', dueDate: '2099-01-01' }], email: USERS.memberG.email, code: USERS.memberG.code });
    expect(r.error).toBe('FORBIDDEN');
  });

  test('admin ops are Super Admin only', async ({ page }) => {
    await login(page, USERS.headG);
    const r = await call(page, { action: 'admin', op: 'report', email: USERS.headG.email, code: USERS.headG.code });
    expect(r.error).toBe('FORBIDDEN');
  });
});

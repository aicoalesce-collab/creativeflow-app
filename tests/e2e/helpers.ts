import { Page, expect } from '@playwright/test';
import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const MOCK = 'http://127.0.0.1:8787';

export const USERS = {
  admin:    { email: 'owner.super@example.com',    code: 'AAA111', name: 'Owner Super' },
  headG:    { email: 'head.graphic@example.com',   code: 'GGG222', name: 'Gina Head' },
  headV:    { email: 'head.video@example.com',     code: 'VVV333', name: 'Vikram Head' },
  memberG:  { email: 'member.graphic@example.com', code: 'MMM444', name: 'Maya Designer' },
  memberV:  { email: 'member.video@example.com',   code: 'MMM555', name: 'Vinod Editor' },
  assigner: { email: 'assigner@example.com',       code: 'RRT777', name: 'Rohit Mehta' },
  testbot:  { email: 'testbot@example.com',        code: 'TB6363', name: 'Test Bot' },
};

/** Hermetic guard: no suite may ever touch the real Google. */
export async function hermetic(page: Page) {
  await page.route(/script\.google(usercontent)?\.com/, r => r.abort());
}

export async function resetMock(mockUrl = MOCK) {
  await fetch(mockUrl + '/__reset', { method: 'POST' });
}

export async function outbox(mockUrl = MOCK): Promise<any[]> {
  return (await fetch(mockUrl + '/__outbox')).json();
}

/** Point the client at the mock BEFORE it boots.
 *  Releases bake the production URL into the page, so the login screen hides
 *  the URL field entirely (the team never pastes a link) — tests must therefore
 *  seed the saved URL rather than type one. */
export async function useMock(page: Page, mockUrl = MOCK) {
  await page.addInitScript(url => {
    try { localStorage.setItem('cf_url', url); } catch {}
    Object.defineProperty(window, 'CF_DEFAULT_API', { get: () => url, set: () => {}, configurable: true });
  }, mockUrl);
}

/** UI login through the real login screen. Safe to call repeatedly in one test. */
export async function login(page: Page, user: { email: string; code: string }, mockUrl = MOCK) {
  await hermetic(page);
  await useMock(page, mockUrl);
  await page.goto('/');
  await page.evaluate(() => { try { localStorage.removeItem('cf_email'); localStorage.removeItem('cf_code'); } catch {} });
  await page.goto('/');
  await page.fill('#in-email', user.email);
  await page.fill('#in-code', user.code);
  await page.click('#login-btn');
  await expect(page.locator('#app')).toBeVisible({ timeout: 20_000 });
  // background pages settle fast against the local mock
  await page.waitForTimeout(400);
}

/** Spawn a knob-configured mock on its own port; returns kill fn. */
export function spawnMock(port: number, env: Record<string, string>): { url: string; kill: () => void } {
  const p: ChildProcess = spawn(process.execPath, [path.join(HERE, '..', 'mock', 'mock-api.mjs')], {
    env: { ...process.env, MOCK_PORT: String(port), ...env },
    stdio: 'ignore',
  });
  return { url: `http://127.0.0.1:${port}`, kill: () => { try { p.kill(); } catch {} } };
}

export async function waitMock(url: string) {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(url + '/__state'); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('mock did not come up: ' + url);
}

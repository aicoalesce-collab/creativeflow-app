import { test, expect, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Captures every screen, role and modal of the real built client.
 *
 * Runs against the mock rather than production on purpose: the fixtures cover
 * states the live sheet does not currently contain (rejected, over-limit,
 * brief-pending, guest links, an empty member), and nothing here can write to
 * the studio's real data.
 *
 *   npx playwright test --config=capture.config.ts
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', '..', 'ui-shots');
const MOCK = 'http://127.0.0.1:8787';

const USERS = {
  admin:    { email: 'owner.super@example.com',    code: 'AAA111', name: 'Owner Super',   role: 'Super Admin' },
  headG:    { email: 'head.graphic@example.com',   code: 'GGG222', name: 'Gina Head',     role: 'Team Head' },
  memberG:  { email: 'member.graphic@example.com', code: 'MMM444', name: 'Maya Designer', role: 'Member' },
  assigner: { email: 'assigner@example.com',       code: 'RRT777', name: 'Rohit Mehta',   role: 'Assigner' },
};

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const shots: { file: string; title: string; role: string; group: string; device: string }[] = [];

fs.mkdirSync(OUT, { recursive: true });

/** Deliverable thumbnails would hit the real network and fail; serve shaped
 *  placeholders so the gallery and review room look like themselves. */
async function stubMedia(page: Page) {
  const svg = (w: number, h: number, a: string, b: string, label: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
      <rect width="${w}" height="${h}" fill="url(#g)"/>
      <text x="50%" y="50%" font-family="Inter,sans-serif" font-size="${Math.round(w / 16)}"
        fill="rgba(255,255,255,.82)" text-anchor="middle" dominant-baseline="middle">${label}</text>
    </svg>`;
  const palettes = [
    ['#eb5b2d', '#8e3bb0', 800, 600, 'ARTWORK'],
    ['#2d6ceb', '#22b8a6', 800, 1100, 'POSTER'],
    ['#111827', '#eb5b2d', 800, 450, 'VIDEO'],
    ['#7c3aed', '#ec4899', 800, 800, 'SOCIAL'],
    ['#0f766e', '#84cc16', 800, 520, 'STAGE'],
  ] as const;
  let n = 0;
  await page.route(/drive\.google\.com\/thumbnail|img\.youtube\.com|googleapis\.com\/drive/, r => {
    const p = palettes[n++ % palettes.length];
    r.fulfill({ contentType: 'image/svg+xml', body: svg(p[2] as number, p[3] as number, p[0], p[1], p[4] as string) });
  });
  await page.route(/youtube\.com\/(iframe_api|embed)|drive\.google\.com\/file/, r =>
    r.fulfill({ contentType: 'text/html', body: '<body style="margin:0;background:#101010;color:#888;font:600 20px Inter,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">VIDEO PLAYER</body>' }));
}

async function login(page: Page, u: { email: string; code: string }) {
  await page.route(/script\.google(usercontent)?\.com/, r => r.abort());
  await stubMedia(page);
  await page.addInitScript(url => {
    try { localStorage.setItem('cf_url', url); localStorage.setItem('cf_theme', 'light'); } catch {}
    Object.defineProperty(window, 'CF_DEFAULT_API', { get: () => url, set: () => {}, configurable: true });
  }, MOCK);
  await page.goto('/');
  await page.evaluate(() => { try { localStorage.removeItem('cf_email'); localStorage.removeItem('cf_code'); } catch {} });
  await page.goto('/');
  await page.fill('#in-email', u.email);
  await page.fill('#in-code', u.code);
  await page.click('#login-btn');
  await expect(page.locator('#app')).toBeVisible({ timeout: 25_000 });
  await page.waitForTimeout(900);
}

async function shot(page: Page, name: string, title: string, role: string, group: string, device = 'desktop', full = true) {
  const file = `${name}.png`;
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(OUT, file), fullPage: full });
  shots.push({ file, title, role, group, device });
  console.log('  ✓', file);
}

async function goTab(page: Page, tab: string) {
  await page.evaluate(t => { (window as any).tab = t; (window as any).renderAll(); }, tab);
  await page.waitForTimeout(700);
}

test.describe.configure({ mode: 'serial' });

test('01 — login and shell', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.route(/script\.google(usercontent)?\.com/, r => r.abort());
  await page.addInitScript(url => {
    try { localStorage.setItem('cf_url', url); localStorage.setItem('cf_theme', 'light'); } catch {}
    Object.defineProperty(window, 'CF_DEFAULT_API', { get: () => url, set: () => {}, configurable: true });
  }, MOCK);
  await page.goto('/');
  await page.waitForTimeout(1200);
  await shot(page, '01-login', 'Login', 'everyone', 'Sign in');

  await page.fill('#in-email', USERS.admin.email);
  await page.fill('#in-code', 'WRONG1');
  await page.click('#login-btn');
  await page.waitForTimeout(1500);
  await shot(page, '02-login-error', 'Login — wrong code', 'everyone', 'Sign in');
});

test('02 — Super Admin', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await login(page, USERS.admin);

  await shot(page, '10-admin-dashboard', 'Dashboard', 'Super Admin', 'Main tabs');

  await goTab(page, 'tasks');
  await shot(page, '11-admin-tasks', 'Tasks — list + filters', 'Super Admin', 'Main tabs');

  await goTab(page, 'review');
  await shot(page, '12-admin-review-queue', 'Review queue', 'Super Admin', 'Main tabs');

  await goTab(page, 'assigners');
  await shot(page, '13-admin-assigners', 'Assigners — who asked for what', 'Super Admin', 'Main tabs');

  await goTab(page, 'gallery');
  await page.waitForTimeout(1400);
  await shot(page, '14-admin-gallery', 'Gallery — finished work', 'Super Admin', 'Main tabs');

  await goTab(page, 'calendar');
  await shot(page, '15-admin-calendar', 'Calendar — drag to reschedule', 'Super Admin', 'Main tabs');

  await goTab(page, 'reports');
  await shot(page, '16-admin-reports-person', 'Reports — by person', 'Super Admin', 'Main tabs');

  await page.evaluate(() => (window as any).setReportScope('team'));
  await page.waitForTimeout(1600);
  await shot(page, '17-admin-reports-combined', 'Reports — teams combined + task log', 'Super Admin', 'Main tabs');

  // panels
  await goTab(page, 'overview');
  await page.click('#bell');
  await page.waitForTimeout(600);
  await shot(page, '20-admin-notifications', 'Notifications panel (bell)', 'Super Admin', 'Panels & menus', 'desktop', false);
  await page.keyboard.press('Escape');

  await page.click('#userchip');
  await page.waitForTimeout(600);
  await shot(page, '21-admin-account', 'Account menu — notifications, theme, sign out', 'Super Admin', 'Panels & menus', 'desktop', false);
  await page.keyboard.press('Escape');
});

test('03 — modals', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await login(page, USERS.admin);

  await page.evaluate(() => (window as any).openTaskModal('GD-0004'));
  await page.waitForTimeout(800);
  await shot(page, '30-task-modal', 'Task detail — full edit', 'Super Admin', 'Modals', 'desktop', false);
  await page.keyboard.press('Escape');

  await page.evaluate(() => (window as any).openTaskModal('GD-0007'));
  await page.waitForTimeout(800);
  await shot(page, '31-task-modal-overlimit', 'Task detail — over revision limit', 'Super Admin', 'Modals', 'desktop', false);
  await page.keyboard.press('Escape');

  await page.evaluate(() => (window as any).openNewTaskModal());
  await page.waitForTimeout(800);
  await shot(page, '32-new-task', 'New task — save / add another / start work', 'Super Admin', 'Modals', 'desktop', false);
  await page.keyboard.press('Escape');

  await page.evaluate(() => (window as any).openBulkModal());
  await page.waitForTimeout(800);
  await shot(page, '33-bulk-add', 'Bulk add — paste rows', 'Super Admin', 'Modals', 'desktop', false);
  await page.keyboard.press('Escape');
});

test('04 — review room', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await login(page, USERS.admin);

  await page.evaluate(() => (window as any).openReview('GD-0005'));
  await page.waitForTimeout(2200);
  await shot(page, '40-review-image', 'Review room — image, pins', 'Super Admin', 'Review room', 'desktop', false);

  await page.evaluate(() => (window as any).toggleShare());
  await page.waitForTimeout(900);
  await shot(page, '41-review-share', 'Review room — share links', 'Super Admin', 'Review room', 'desktop', false);
  await page.evaluate(() => (window as any).toggleShare());

  await page.evaluate(() => (window as any).closeReview());
  await page.waitForTimeout(400);
  await page.evaluate(() => (window as any).openReview('VD-0002'));
  await page.waitForTimeout(2400);
  await shot(page, '42-review-video', 'Review room — video, timecode markers', 'Super Admin', 'Review room', 'desktop', false);
});

test('05 — guest review links', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.route(/script\.google(usercontent)?\.com/, r => r.abort());
  await stubMedia(page);
  await page.addInitScript(url => {
    try { localStorage.setItem('cf_url', url); localStorage.setItem('cf_theme', 'light'); } catch {}
    Object.defineProperty(window, 'CF_DEFAULT_API', { get: () => url, set: () => {}, configurable: true });
  }, MOCK);

  await page.goto('/?g=1#/r/AbCdEfGhJkMnPqRsTuVwXyZ234');
  await page.waitForTimeout(3000);
  await shot(page, '50-guest-comment', 'Guest link — can annotate', 'Client (guest)', 'Review room', 'desktop', false);

  await page.goto('/?g=2#/r/ViewOnlyTokenAbCdEfGhJkMn2');
  await page.waitForTimeout(3000);
  await shot(page, '51-guest-viewonly', 'Guest link — view only', 'Client (guest)', 'Review room', 'desktop', false);
});

test('06 — Team Head', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await login(page, USERS.headG);
  await shot(page, '60-head-dashboard', 'Dashboard', 'Team Head', 'Other roles');
  await goTab(page, 'gallery');
  await page.waitForTimeout(1400);
  await shot(page, '61-head-gallery', 'Gallery — whole team / just mine', 'Team Head', 'Other roles');
  await goTab(page, 'reports');
  await page.evaluate(() => (window as any).setReportScope('team'));
  await page.waitForTimeout(1600);
  await shot(page, '62-head-reports', 'Reports — team combined', 'Team Head', 'Other roles');
});

test('07 — Member', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await login(page, USERS.memberG);
  await shot(page, '70-member-dashboard', 'Dashboard — only my work', 'Member', 'Other roles');
  await goTab(page, 'tasks');
  await shot(page, '71-member-tasks', 'Tasks', 'Member', 'Other roles');
  await goTab(page, 'gallery');
  await page.waitForTimeout(1400);
  await shot(page, '72-member-gallery', 'Gallery — my finished work', 'Member', 'Other roles');
});

test('08 — Assigner', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await login(page, USERS.assigner);
  await page.waitForTimeout(600);
  await shot(page, '80-assigner-home', 'Assigner home — review first', 'Assigner', 'Other roles');
  await goTab(page, 'tasks');
  await shot(page, '81-assigner-tasks', 'My requests', 'Assigner', 'Other roles');
  await goTab(page, 'gallery');
  await page.waitForTimeout(1400);
  await shot(page, '82-assigner-gallery', 'Gallery — work I commissioned', 'Assigner', 'Other roles');
});

test('09 — phone', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await login(page, USERS.admin);
  await shot(page, '90-phone-dashboard', 'Dashboard', 'Super Admin', 'Phone (390px)', 'phone');
  await goTab(page, 'tasks');
  await shot(page, '91-phone-tasks', 'Tasks', 'Super Admin', 'Phone (390px)', 'phone');
  await goTab(page, 'gallery');
  await page.waitForTimeout(1400);
  await shot(page, '92-phone-gallery', 'Gallery', 'Super Admin', 'Phone (390px)', 'phone');
  await goTab(page, 'assigners');
  await shot(page, '93-phone-assigners', 'Assigners', 'Super Admin', 'Phone (390px)', 'phone');
  await goTab(page, 'reports');
  await page.evaluate(() => (window as any).setReportScope('team'));
  await page.waitForTimeout(1500);
  await shot(page, '94-phone-reports', 'Reports — combined', 'Super Admin', 'Phone (390px)', 'phone');
  await page.evaluate(() => (window as any).openTaskModal('GD-0004'));
  await page.waitForTimeout(800);
  await shot(page, '95-phone-task', 'Task detail', 'Super Admin', 'Phone (390px)', 'phone', false);
});

test('10 — dark theme', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await login(page, USERS.admin);
  await page.evaluate(() => (window as any).applyTheme('dark'));
  await page.waitForTimeout(600);
  await shot(page, 'A0-dark-dashboard', 'Dashboard — dark', 'Super Admin', 'Dark theme');
  await goTab(page, 'gallery');
  await page.waitForTimeout(1400);
  await shot(page, 'A1-dark-gallery', 'Gallery — dark', 'Super Admin', 'Dark theme');
  await page.evaluate(() => (window as any).openReview('GD-0005'));
  await page.waitForTimeout(2200);
  await shot(page, 'A2-dark-review', 'Review room — dark', 'Super Admin', 'Dark theme', 'desktop', false);
});

test.afterAll(async () => {
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(shots, null, 2));
  console.log(`\n${shots.length} screenshots -> ${OUT}`);
});

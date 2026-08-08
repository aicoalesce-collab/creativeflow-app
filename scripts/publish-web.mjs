/**
 * Publishes web/dist to the gh-pages branch of the app repo.
 *
 * Deliberately NOT a GitHub Actions workflow: pushing .github/workflows/**
 * requires the `workflow` OAuth scope, which would cost the owner another
 * approval round. We build locally anyway (the release always goes through
 * scripts/build-app.ps1), so a direct branch publish is equivalent and needs
 * no extra permission.
 *
 *   node scripts/publish-web.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'web', 'dist');
const REMOTE = process.env.CF_PAGES_REMOTE || 'https://github.com/aicoalesce-collab/creativeflow-app.git';
const STAGE = path.join(process.env.TEMP || '/tmp', 'cf5-ghpages');

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  throw new Error('web/dist is missing — run scripts/build-app.ps1 first');
}
// the sentinels must survive into what we publish
const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
for (const needle of ["window.CF_INJECTED_API = '';", "window.CF_GUEST_TOKEN = '';", "window.CF_OPEN_TASK = '';"]) {
  if (!html.includes(needle)) throw new Error('CF-BOOT sentinel missing from the build: ' + needle);
}
if (!/window\.CF_DEFAULT_API\s*=\s*'https:\/\/script\.google\.com\/.+\/exec'/.test(html)) {
  throw new Error('the production /exec URL is not baked in — run node scripts/bake-url.mjs');
}

fs.rmSync(STAGE, { recursive: true, force: true });
fs.cpSync(DIST, STAGE, { recursive: true });
// GitHub Pages runs Jekyll by default and drops files/folders starting with _
fs.writeFileSync(path.join(STAGE, '.nojekyll'), '');

const git = (...args) => execFileSync('git', args, { cwd: STAGE, stdio: 'pipe' }).toString().trim();
git('init', '-q');
git('checkout', '-q', '-B', 'gh-pages');
git('add', '-A');
git('-c', 'user.email=aicoalesce@gmail.com', '-c', 'user.name=Coalesce', 'commit', '-q', '-m', 'Publish CreativeFlow client');
execFileSync('git', ['push', '-f', REMOTE, 'gh-pages'], { cwd: STAGE, stdio: 'inherit' });
console.log('published web/dist -> gh-pages on ' + REMOTE);

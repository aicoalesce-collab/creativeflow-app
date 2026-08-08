/**
 * Stamps the pinned PROD /exec URL into the client and the exe.
 *
 * Node, not PowerShell: PS 5.1 reads files as ANSI unless they carry a BOM, so
 * a read-modify-write there silently mangles every non-ASCII character in the
 * file (it corrupted the login screen's text once — don't reintroduce it).
 *
 *   node scripts/bake-url.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dep = JSON.parse(fs.readFileSync(path.join(ROOT, 'deployments.json'), 'utf8'));
const url = dep.prod && dep.prod.url;
if (!url) throw new Error('deployments.json has no prod.url yet — create the PROD deployment first');
if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(url)) {
  throw new Error('prod.url does not look like an /exec Web app URL: ' + url);
}

// client: a global the CF-BOOT block exposes, read by config in app.js
const idx = path.join(ROOT, 'web', 'index.html');
let html = fs.readFileSync(idx, 'utf8');
if (/window\.CF_DEFAULT_API\s*=/.test(html)) {
  html = html.replace(/window\.CF_DEFAULT_API\s*=\s*'[^']*';/, `window.CF_DEFAULT_API = '${url}';`);
} else {
  html = html.replace("window.CF_INJECTED_API = '';", `window.CF_INJECTED_API = '';\nwindow.CF_DEFAULT_API = '${url}';`);
}
fs.writeFileSync(idx, html, 'utf8');

// exe: the baked fallback target of the /api proxy
const cfg = path.join(ROOT, 'exe', 'config.go');
let go = fs.readFileSync(cfg, 'utf8');
go = go.replace(/const bakedAPI = "[^"]*"/, `const bakedAPI = "${url}"`);
fs.writeFileSync(cfg, go, 'utf8');

console.log('baked ' + url + '\n  -> web/index.html (CF_DEFAULT_API)\n  -> exe/config.go (bakedAPI)\nNow rebuild both artifacts.');

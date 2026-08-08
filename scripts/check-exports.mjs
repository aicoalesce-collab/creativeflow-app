/**
 * Guards the ESM shim, in BOTH directions.
 *
 * The ported markup drives the app through inline onclick handlers, so every
 * function they call has to be published onto `window`. Two ways that breaks,
 * and both have actually happened here:
 *
 *  1. The exposure list names something that no longer exists. Object.assign
 *     throws, and because it runs last the app still RENDERS while every button
 *     silently does nothing. (A cleanup deleted pickUpload/startUpload while the
 *     list kept naming them.)
 *
 *  2. A handler exists but was never added to the list. Nothing throws — worse,
 *     Vite sees a function no module code references, tree-shakes it out, and
 *     takes any module it imported with it. That is how the entire push
 *     notification client vanished from a build that looked fine.
 *
 *   node scripts/check-exports.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'web', 'src', 'app.js');
const INDEX = path.join(ROOT, 'web', 'index.html');
const src = fs.readFileSync(APP, 'utf8');
const html = fs.existsSync(INDEX) ? fs.readFileSync(INDEX, 'utf8') : '';

/* ── what the module defines ─────────────────────────────────────────────── */
const defined = new Set();
for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1]);
for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
  for (const raw of m[1].split(',')) {
    const n = raw.trim().split(/\s+as\s+/).pop().trim();
    if (n) defined.add(n);
  }
}

/* ── what the module publishes to window ─────────────────────────────────── */
const exposed = new Set();
const missing = [];
for (const block of src.matchAll(/Object\.assign\(window,\s*\{([^}]*)\}\s*\)/g)) {
  for (const raw of block[1].split(',')) {
    const name = raw.trim().split(':')[0].trim();
    if (!name || /^\.\.\./.test(name)) continue;
    exposed.add(name);
    if (!defined.has(name)) missing.push(name);
  }
}
/* live accessor bindings count as exposed too — they are defined with
   Object.defineProperty rather than in the assign literal */
for (const m of src.matchAll(/\[\s*'([A-Za-z_$][\w$]*)'\s*,\s*v\s*=>/g)) exposed.add(m[1]);
for (const m of src.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)) exposed.add(m[1]);

/* ── what the inline handlers actually call ──────────────────────────────── */
const GLOBALS = new Set([
  'window', 'document', 'location', 'event', 'this', 'alert', 'confirm', 'console',
  'Math', 'JSON', 'Number', 'String', 'Boolean', 'Array', 'Object', 'Date', 'parseInt',
  'parseFloat', 'setTimeout', 'setInterval', 'encodeURIComponent', 'decodeURIComponent',
  'return', 'if', 'else', 'for', 'while', 'typeof', 'new', 'void', 'true', 'false',
  'null', 'undefined', 'function', 'catch', 'try',
]);

const called = new Map();   // name -> example handler
for (const [file, text] of [['web/src/app.js', src], ['web/index.html', html]]) {
  for (const h of text.matchAll(/\son[a-z]+\s*=\s*"([^"]*)"/g)) {
    const body = h[1];
    if (!body || body.includes('${')) {
      /* interpolated handlers still contain literal calls around the hole, so
         strip the interpolation rather than skipping the whole attribute */
    }
    const cleaned = body.replace(/\$\{[^}]*\}/g, ' ');
    for (const c of cleaned.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = c[2];
      if (GLOBALS.has(name)) continue;
      if (!called.has(name)) called.set(name, `${file}: on…="${body.slice(0, 70)}"`);
    }
  }
}

const unexposed = [...called.keys()].filter(n => defined.has(n) && !exposed.has(n));
const undef = [...called.keys()].filter(n => !defined.has(n) && !exposed.has(n));

let bad = false;
if (missing.length) {
  bad = true;
  console.error('check-exports FAILED — exposed names that no longer exist:\n  ' + missing.join('\n  ') +
    '\n\n  Object.assign would throw and every inline click handler would be dead.');
}
if (unexposed.length) {
  bad = true;
  console.error('check-exports FAILED — inline handlers call functions that are NOT on window:\n' +
    unexposed.map(n => `  ${n}()  ← ${called.get(n)}`).join('\n') +
    '\n\n  These are dead on click, and Vite will tree-shake them (and anything they\n' +
    '  import) out of the bundle entirely. Add them to Object.assign(window, {…}).');
}
if (undef.length) {
  bad = true;
  console.error('check-exports FAILED — inline handlers call names defined nowhere:\n  ' + undef.join('\n  '));
}
if (bad) process.exit(1);

console.log(`check-exports: ok (${defined.size} definitions, ${exposed.size} exposed, ${called.size} handler calls all resolve)`);

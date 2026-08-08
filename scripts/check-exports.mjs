/**
 * Guards the ESM shim.
 *
 * The ported markup drives the app through inline onclick handlers, so every
 * function they call is published onto `window` in one Object.assign. If that
 * list names something that no longer exists, the assign throws — and because
 * it runs last, the app still *renders* while every button silently does
 * nothing. That is a horrible failure to debug from the outside, and it has
 * happened once (a cleanup deleted pickUpload/startUpload while the list kept
 * naming them). This check makes it impossible to ship again.
 *
 *   node scripts/check-exports.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'web', 'src', 'app.js'), 'utf8');

const defined = new Set();
for (const m of src.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
for (const m of src.matchAll(/(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1]);

let missing = [];
for (const block of src.matchAll(/Object\.assign\(window,\s*\{([^}]*)\}\s*\)/g)) {
  for (const raw of block[1].split(',')) {
    const name = raw.trim().split(':')[0].trim();
    if (!name || /^\.\.\./.test(name)) continue;
    if (!defined.has(name)) missing.push(name);
  }
}

if (missing.length) {
  console.error('check-exports FAILED — window exposure names that no longer exist:\n  ' + missing.join('\n  ') +
    '\n\nThe app would render but every inline click handler would be dead.');
  process.exit(1);
}
console.log('check-exports: ok (' + defined.size + ' definitions, all exposed names resolve)');

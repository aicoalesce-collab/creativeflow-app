/**
 * Fails the build if a PowerShell script contains non-ASCII text without a BOM.
 *
 * Windows PowerShell 5.1 reads a BOM-less file as ANSI, not UTF-8. An em-dash
 * in a comment then decodes to mojibake, and if the bytes happen to land badly
 * the file stops parsing — the error points at a `while` loop twenty lines
 * away and says "missing closing brace", which is a miserable thing to chase.
 *
 * That has now happened twice in this project: once corrupting user-visible
 * login text, once breaking the release script mid-deploy. Editors here write
 * UTF-8 without a BOM by default, so this is not something discipline fixes.
 *
 *   node scripts/check-encoding.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['tools', 'scripts'];

const bad = [];
for (const dir of DIRS) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) continue;
  for (const name of fs.readdirSync(full)) {
    if (!name.endsWith('.ps1')) continue;
    const file = path.join(full, name);
    const buf = fs.readFileSync(file);
    const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    const nonAscii = buf.some(b => b > 127);
    if (nonAscii && !hasBom) {
      // report the first offending line so the fix is obvious
      const text = buf.toString('utf8');
      const line = text.split('\n').findIndex(l => [...l].some(c => c.charCodeAt(0) > 127)) + 1;
      bad.push(`${dir}/${name}:${line}`);
    }
  }
}

if (bad.length) {
  console.error('check-encoding FAILED — PowerShell files with non-ASCII text and no BOM:\n  ' +
    bad.join('\n  ') +
    '\n\n  PowerShell 5.1 will read these as ANSI and mangle them.' +
    '\n  Fix: re-save with a UTF-8 BOM, or keep the file pure ASCII.');
  process.exit(1);
}
console.log('check-encoding: ok (all .ps1 files are ASCII or BOM-marked)');

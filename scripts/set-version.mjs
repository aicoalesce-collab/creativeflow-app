/**
 * Stamps the client's APP_VERSION sentinel so it always matches the version
 * being deployed.
 *
 * Forgetting this is a guaranteed failed deploy: the smoke check compares
 * ping's appVersion against the release version, so a stale sentinel aborts the
 * run AFTER the script has already been pushed and versioned. Now deploy.ps1
 * calls this first and the two can't drift.
 *
 * Node, not PowerShell: PS 5.1 reads a BOM-less file as ANSI and would mangle
 * the em-dashes in the login copy on write-back (that happened once).
 *
 *   node scripts/set-version.mjs 5.0.2
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const version = String(process.argv[2] || '').trim();
if (!/^\d+\.\d+(\.\d+)?$/.test(version)) {
  console.error('usage: node scripts/set-version.mjs <x.y[.z]>');
  process.exit(1);
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'web', 'index.html');
const src = fs.readFileSync(FILE, 'utf8');
const re = /(window\.APP_VERSION\s*=\s*')([\d.]+)(')/;
const m = src.match(re);
if (!m) { console.error('APP_VERSION sentinel not found in web/index.html'); process.exit(1); }

if (m[2] === version) { console.log(`APP_VERSION already ${version}`); process.exit(0); }
fs.writeFileSync(FILE, src.replace(re, `$1${version}$3`), 'utf8');
console.log(`APP_VERSION ${m[2]} -> ${version}`);

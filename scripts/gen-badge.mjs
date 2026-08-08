/**
 * Generates web/public/icons/badge-96.png — the small monochrome mark Android
 * shows in the status bar next to a notification.
 *
 * Android masks the badge down to its ALPHA channel and paints the result in
 * the system colour, so this draws an opaque white glyph on transparency;
 * colour here is irrelevant, coverage is everything. A missing badge means a
 * 404 on every single notification, so it is generated rather than hand-made.
 *
 * No image library: a PNG is a handful of length-prefixed, CRC'd chunks around
 * a zlib stream, and pulling in a dependency to draw a checkmark would be worse.
 *
 *   node scripts/gen-badge.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SIZE = 96;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'web', 'public', 'icons', 'badge-96.png');

/* ── the glyph: a checkmark, drawn as two thick segments ──────────────────── */
const px = new Uint8Array(SIZE * SIZE * 4);            // RGBA, all zero = transparent

/** Shortest distance from point p to segment a–b; used to give strokes width. */
function distToSeg(px_, py_, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px_ - ax) * dx + (py_ - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px_ - cx, py_ - cy);
}

const STROKE = 11;                                      // half-width in px
const SEGS = [
  [22, 50, 40, 68],                                     // down-stroke of the tick
  [40, 68, 75, 30],                                     // up-stroke
];

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let d = Infinity;
    for (const [ax, ay, bx, by] of SEGS) d = Math.min(d, distToSeg(x + 0.5, y + 0.5, ax, ay, bx, by));
    /* antialias across one pixel at the edge, so the mark is not jagged when
       the system scales it down */
    const a = Math.max(0, Math.min(1, (STROKE / 2 - d) + 0.5));
    if (a <= 0) continue;
    const i = (y * SIZE + x) * 4;
    px[i] = 255; px[i + 1] = 255; px[i + 2] = 255;
    px[i + 3] = Math.round(a * 255);
  }
}

/* ── PNG container ────────────────────────────────────────────────────────── */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;    // bit depth
ihdr[9] = 6;    // colour type: RGBA
// 10,11,12 = compression, filter, interlace — all 0

// each scanline carries a leading filter byte (0 = none)
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.writeFileSync(OUT, png);
console.log(`badge written: ${path.relative(ROOT, OUT)} (${SIZE}x${SIZE}, ${png.length} bytes)`);

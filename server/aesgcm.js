/**
 * ============================================================================
 *  aesgcm.js — AES-128-GCM in pure JavaScript.
 *
 *  The second primitive Apps Script does not have. Web Push payloads use the
 *  aes128gcm content encoding (RFC 8188), so without this we could only send
 *  empty "wake up" pushes and make the service worker fetch the text over the
 *  network before it could show anything. That round trip goes through Apps
 *  Script, which is slow to cold-start, and Chrome punishes a push that fails
 *  to show a notification in time by showing "This site has been updated in
 *  the background" instead. Encrypting the text into the push avoids all of it.
 *
 *  Checked against the NIST GCM test vectors and against Node's native
 *  createDecipheriv in tests/unit/crypto.test.mjs — what this encrypts, Node
 *  decrypts. Do not edit without re-running those.
 * ============================================================================
 */

const AES_SBOX = [
  0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
  0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
  0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
  0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
  0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
  0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
  0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
  0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
  0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
  0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
  0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
  0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
  0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
  0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
  0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
  0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16,
];
const AES_RCON = [0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36];

/** GF(2^8) multiply, used by MixColumns. */
function xtime_(a) { return ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 0xff; }
function gmul_(a, b) {
  let r = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) r ^= a;
    a = xtime_(a);
    b >>= 1;
  }
  return r & 0xff;
}

/** AES-128 key schedule: 11 round keys of 16 bytes. */
function aesExpandKey_(key) {
  if (key.length !== 16) throw new Error('aesgcm: AES-128 needs a 16-byte key');
  const w = [];
  for (let i = 0; i < 16; i++) w.push(key[i] & 0xff);
  for (let i = 16; i < 176; i += 4) {
    let t = [w[i - 4], w[i - 3], w[i - 2], w[i - 1]];
    if (i % 16 === 0) {
      t = [AES_SBOX[t[1]] ^ AES_RCON[(i / 16) - 1], AES_SBOX[t[2]], AES_SBOX[t[3]], AES_SBOX[t[0]]];
    }
    for (let j = 0; j < 4; j++) w.push(w[i - 16 + j] ^ t[j]);
  }
  return w;
}

/** One 16-byte block, encryption only — GCM never needs the inverse cipher. */
function aesEncryptBlock_(rk, input) {
  const s = input.slice(0, 16);
  for (let i = 0; i < 16; i++) s[i] ^= rk[i];
  for (let round = 1; round <= 10; round++) {
    for (let i = 0; i < 16; i++) s[i] = AES_SBOX[s[i] & 0xff];
    // ShiftRows (column-major state: byte r + 4c)
    let t;
    t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t;
    t = s[2]; s[2] = s[10]; s[10] = t;
    t = s[6]; s[6] = s[14]; s[14] = t;
    t = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = s[3]; s[3] = t;
    if (round !== 10) {
      for (let c = 0; c < 4; c++) {
        const o = c * 4;
        const a0 = s[o], a1 = s[o + 1], a2 = s[o + 2], a3 = s[o + 3];
        s[o]     = gmul_(a0, 2) ^ gmul_(a1, 3) ^ a2 ^ a3;
        s[o + 1] = a0 ^ gmul_(a1, 2) ^ gmul_(a2, 3) ^ a3;
        s[o + 2] = a0 ^ a1 ^ gmul_(a2, 2) ^ gmul_(a3, 3);
        s[o + 3] = gmul_(a0, 3) ^ a1 ^ a2 ^ gmul_(a3, 2);
      }
    }
    for (let i = 0; i < 16; i++) s[i] ^= rk[round * 16 + i];
  }
  return s;
}

/* ── GHASH: multiplication in GF(2^128) ────────────────────────────────────
   GCM numbers bits "backwards" relative to how they sit in memory, which is
   the classic place to get this wrong. Blocks are held as four 32-bit words,
   most significant first, and the reduction polynomial is 0xe1 << 120. */

function ghashMul_(X, Y) {
  const Z = [0, 0, 0, 0];
  const V = Y.slice(0);
  for (let i = 0; i < 128; i++) {
    const bit = (X[i >>> 5] >>> (31 - (i & 31))) & 1;
    if (bit) { for (let j = 0; j < 4; j++) Z[j] ^= V[j]; }
    const lsb = V[3] & 1;
    for (let j = 3; j > 0; j--) V[j] = ((V[j] >>> 1) | (V[j - 1] << 31)) >>> 0;
    V[0] = (V[0] >>> 1) >>> 0;
    if (lsb) V[0] = (V[0] ^ 0xe1000000) >>> 0;
  }
  return Z.map(function (w) { return w >>> 0; });
}

function bytesToWords_(b, off) {
  const w = [];
  for (let i = 0; i < 4; i++) {
    const o = off + i * 4;
    w.push((((b[o] & 0xff) << 24) | ((b[o + 1] & 0xff) << 16) | ((b[o + 2] & 0xff) << 8) | (b[o + 3] & 0xff)) >>> 0);
  }
  return w;
}
function wordsToBytes_(w) {
  const out = [];
  for (let i = 0; i < 4; i++) out.push((w[i] >>> 24) & 0xff, (w[i] >>> 16) & 0xff, (w[i] >>> 8) & 0xff, w[i] & 0xff);
  return out;
}

/** GHASH over a byte array, zero-padded to a 16-byte boundary. */
function ghash_(H, data, state) {
  let X = state || [0, 0, 0, 0];
  for (let i = 0; i < data.length; i += 16) {
    const block = data.slice(i, i + 16);
    while (block.length < 16) block.push(0);
    const B = bytesToWords_(block, 0);
    X = ghashMul_([X[0] ^ B[0], X[1] ^ B[1], X[2] ^ B[2], X[3] ^ B[3]].map(function (x) { return x >>> 0; }), H);
  }
  return X;
}

function incCounter_(ctr) {
  for (let i = 15; i >= 12; i--) {
    ctr[i] = (ctr[i] + 1) & 0xff;
    if (ctr[i] !== 0) break;
  }
}

/**
 * AES-128-GCM seal. Returns ciphertext with the 16-byte tag appended, which is
 * the layout every Web Push implementation expects.
 *
 * nonce must be 12 bytes and must never repeat under the same key. Web Push
 * derives both from HKDF over a fresh random salt per message, so that holds.
 */
function aes128gcmEncrypt_(key, nonce, plaintext, aad) {
  if (nonce.length !== 12) throw new Error('aesgcm: nonce must be 12 bytes');
  const rk = aesExpandKey_(key);
  const H = bytesToWords_(aesEncryptBlock_(rk, new Array(16).fill(0)), 0);

  const j0 = nonce.slice(0, 12).concat([0, 0, 0, 1]);
  const ctr = j0.slice(0);
  const out = [];
  for (let i = 0; i < plaintext.length; i += 16) {
    incCounter_(ctr);
    const ks = aesEncryptBlock_(rk, ctr.slice(0));
    const n = Math.min(16, plaintext.length - i);
    for (let j = 0; j < n; j++) out.push((plaintext[i + j] & 0xff) ^ ks[j]);
  }

  const A = aad || [];
  let X = ghash_(H, A, null);
  X = ghash_(H, out, X);
  // length block: bit lengths of AAD and ciphertext, each 64-bit big-endian
  const lenBlock = [];
  const push64 = function (n) {
    const hi = Math.floor(n / 0x100000000), lo = n >>> 0;
    lenBlock.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
                  (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);
  };
  push64(A.length * 8);
  push64(out.length * 8);
  X = ghash_(H, lenBlock, X);

  const s = aesEncryptBlock_(rk, j0.slice(0));
  const tagBytes = wordsToBytes_(X);
  const tag = [];
  for (let i = 0; i < 16; i++) tag.push(tagBytes[i] ^ s[i]);
  return out.concat(tag);
}

/**
 * ============================================================================
 *  p256.js — NIST P-256 (secp256r1) in pure JavaScript.
 *
 *  WHY THIS EXISTS
 *  Web Push is not optional cryptography. Every push message must carry a VAPID
 *  JWT signed with ES256 (ECDSA over P-256), and every payload must be sealed
 *  with aes128gcm keyed by an ECDH agreement against the browser's public key.
 *
 *  Apps Script gives us SHA-256 and HMAC-SHA256 and nothing else — no ECDSA, no
 *  ECDH, no AES. So the curve arithmetic is here, on BigInt, which the V8
 *  runtime does support. (The old .gs Rhino runtime did not; if this project is
 *  ever reverted to Rhino, push dies with it.)
 *
 *  The alternative was to route push through a third-party service, which would
 *  mean the studio's task titles leaving Google to a vendor nobody here can
 *  audit, plus another account to keep alive. This is ~200 lines we own.
 *
 *  VERIFICATION: every function here is checked against published test vectors
 *  and against Node's native WebCrypto in tests/unit/crypto.test.mjs. Do not
 *  "tidy" this file without re-running those — hand-written curve code that is
 *  subtly wrong still produces plausible-looking output.
 * ============================================================================
 */

/* curve parameters (FIPS 186-4, D.1.2.3) */
const P256_P  = BigInt('0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff');
const P256_A  = BigInt('0xffffffff00000001000000000000000000000000fffffffffffffffffffffffc'); // -3 mod p
const P256_B  = BigInt('0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b');
const P256_N  = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
const P256_GX = BigInt('0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296');
const P256_GY = BigInt('0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5');

/* ── byte helpers ──────────────────────────────────────────────────────────
   Apps Script's digest/HMAC calls hand back SIGNED bytes (-128..127). Every
   value crossing that boundary goes through u8_ or it silently corrupts. */

function u8_(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i] & 0xff);
  return out;
}

function bytesToBig_(bytes) {
  let n = BigInt(0);
  for (let i = 0; i < bytes.length; i++) n = (n << BigInt(8)) | BigInt(bytes[i] & 0xff);
  return n;
}

/** Fixed-width big-endian encoding. Width matters: a 31-byte r in a JOSE
 *  signature is not "the same number", it is an invalid signature. */
function bigToBytes_(n, len) {
  const out = new Array(len).fill(0);
  let v = n;
  for (let i = len - 1; i >= 0; i--) { out[i] = Number(v & BigInt(0xff)); v >>= BigInt(8); }
  return out;
}

function concatBytes_() {
  const out = [];
  for (let i = 0; i < arguments.length; i++) {
    const a = arguments[i];
    for (let j = 0; j < a.length; j++) out.push(a[j] & 0xff);
  }
  return out;
}

function strToBytes_(s) {
  return Utilities.newBlob(s).getBytes().map(function (b) { return b & 0xff; });
}

/** base64url, no padding — every field in a JWT and in VAPID uses this. */
function b64url_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes.map(function (b) { return b > 127 ? b - 256 : b; }))
    .replace(/=+$/, '');
}

function b64urlDecode_(s) {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  return u8_(Utilities.base64Decode(pad + '==='.slice(0, (4 - pad.length % 4) % 4)));
}

function sha256_(bytes) {
  return u8_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    bytes.map(function (b) { return b > 127 ? b - 256 : b; })));
}

function hmacSha256_(keyBytes, msgBytes) {
  const sign = function (a) { return a.map(function (b) { return b > 127 ? b - 256 : b; }); };
  return u8_(Utilities.computeHmacSha256Signature(sign(msgBytes), sign(keyBytes)));
}

/* ── modular arithmetic ──────────────────────────────────────────────────── */

function mod_(a, m) { const r = a % m; return r < BigInt(0) ? r + m : r; }

/** Extended Euclid. Fermat (a^(p-2)) would also work but costs 256 squarings
 *  per inversion, and we invert once per point conversion. */
function modInv_(a, m) {
  let lo = mod_(a, m), hi = m, x0 = BigInt(1), x1 = BigInt(0);
  while (lo > BigInt(1)) {
    if (hi === BigInt(0)) throw new Error('p256: value is not invertible');
    const q = lo / hi;
    let t = hi; hi = lo - q * hi; lo = t;
    t = x1; x1 = x0 - q * x1; x0 = t;
  }
  return mod_(x0, m);
}

/* ── curve points, Jacobian (X, Y, Z) with x = X/Z², y = Y/Z³ ───────────────
   Jacobian coordinates keep inversions out of the inner loop: one inversion at
   the end instead of one per addition. */

const JZERO = { x: BigInt(1), y: BigInt(1), z: BigInt(0) };   // point at infinity

function jDouble_(pt) {
  if (pt.z === BigInt(0) || pt.y === BigInt(0)) return JZERO;
  const p = P256_P;
  const A = mod_(pt.y * pt.y, p);
  const B = mod_(BigInt(4) * pt.x * A, p);
  const C = mod_(BigInt(8) * A * A, p);
  const zz = mod_(pt.z * pt.z, p);
  const D = mod_(BigInt(3) * (pt.x - zz) * (pt.x + zz), p);   // uses a = -3
  const X = mod_(D * D - BigInt(2) * B, p);
  return {
    x: X,
    y: mod_(D * (B - X) - C, p),
    z: mod_(BigInt(2) * pt.y * pt.z, p),
  };
}

function jAdd_(a, b) {
  if (a.z === BigInt(0)) return b;
  if (b.z === BigInt(0)) return a;
  const p = P256_P;
  const z1z1 = mod_(a.z * a.z, p);
  const z2z2 = mod_(b.z * b.z, p);
  const u1 = mod_(a.x * z2z2, p);
  const u2 = mod_(b.x * z1z1, p);
  const s1 = mod_(a.y * b.z * z2z2, p);
  const s2 = mod_(b.y * a.z * z1z1, p);
  if (u1 === u2) return s1 === s2 ? jDouble_(a) : JZERO;
  const h = mod_(u2 - u1, p);
  const r = mod_(s2 - s1, p);
  const hh = mod_(h * h, p);
  const hhh = mod_(h * hh, p);
  const v = mod_(u1 * hh, p);
  const X = mod_(r * r - hhh - BigInt(2) * v, p);
  return {
    x: X,
    y: mod_(r * (v - X) - s1 * hhh, p),
    z: mod_(a.z * b.z * h, p),
  };
}

function jToAffine_(pt) {
  if (pt.z === BigInt(0)) return null;                 // infinity has no affine form
  const p = P256_P;
  const zi = modInv_(pt.z, p);
  const zi2 = mod_(zi * zi, p);
  return { x: mod_(pt.x * zi2, p), y: mod_(pt.y * zi2 * zi, p) };
}

/** k·P by double-and-add. Not constant-time: Apps Script cannot promise timing
 *  invariance anyway, and the attacker model here (a push service seeing only
 *  our output) does not include local timing observation. */
function jMul_(k, pt) {
  let acc = JZERO, add = pt, n = k;
  while (n > BigInt(0)) {
    if (n & BigInt(1)) acc = jAdd_(acc, add);
    add = jDouble_(add);
    n >>= BigInt(1);
  }
  return acc;
}

function onCurve_(x, y) {
  const p = P256_P;
  return mod_(y * y, p) === mod_(x * x * x + P256_A * x + P256_B, p);
}

/* ── public API ────────────────────────────────────────────────────────────
   Keys and points travel as uncompressed SEC1: 0x04 || X(32) || Y(32). That is
   exactly what a browser's PushSubscription p256dh field contains. */

function p256PublicFromPrivate_(dBytes) {
  const d = bytesToBig_(dBytes);
  if (d <= BigInt(0) || d >= P256_N) throw new Error('p256: private key out of range');
  const q = jToAffine_(jMul_(d, { x: P256_GX, y: P256_GY, z: BigInt(1) }));
  return concatBytes_([0x04], bigToBytes_(q.x, 32), bigToBytes_(q.y, 32));
}

function p256ParsePublic_(pub) {
  if (pub.length !== 65 || (pub[0] & 0xff) !== 0x04) throw new Error('p256: expected a 65-byte uncompressed point');
  const x = bytesToBig_(pub.slice(1, 33));
  const y = bytesToBig_(pub.slice(33, 65));
  if (!onCurve_(x, y)) throw new Error('p256: point is not on the curve');
  return { x: x, y: y, z: BigInt(1) };
}

/** ECDH: the shared secret is the X coordinate only, 32 bytes (RFC 6090 §4). */
function p256SharedSecret_(privBytes, peerPublicBytes) {
  const d = bytesToBig_(privBytes);
  const s = jToAffine_(jMul_(d, p256ParsePublic_(peerPublicBytes)));
  if (!s) throw new Error('p256: ECDH produced the point at infinity');
  return bigToBytes_(s.x, 32);
}

/**
 * Deterministic k, RFC 6979 §3.2.
 *
 * Using a derived k rather than a random one is not just tidiness: Apps Script
 * has no CSPRNG (Math.random is not one), and ECDSA with a predictable or
 * repeated k leaks the private key outright. RFC 6979 removes randomness from
 * the equation entirely, and makes every signature reproducible in tests.
 */
function rfc6979K_(privBytes, hashBytes) {
  let v = new Array(32).fill(0x01);
  let k = new Array(32).fill(0x00);
  const h1 = hashBytes;
  k = hmacSha256_(k, concatBytes_(v, [0x00], privBytes, h1));
  v = hmacSha256_(k, v);
  k = hmacSha256_(k, concatBytes_(v, [0x01], privBytes, h1));
  v = hmacSha256_(k, v);
  for (let guard = 0; guard < 1000; guard++) {
    v = hmacSha256_(k, v);
    const cand = bytesToBig_(v);
    if (cand > BigInt(0) && cand < P256_N) return cand;
    k = hmacSha256_(k, concatBytes_(v, [0x00]));
    v = hmacSha256_(k, v);
  }
  throw new Error('p256: could not derive k');
}

/** ECDSA-SHA256. Returns the 64-byte r||s form that JOSE/ES256 requires —
 *  NOT DER. A DER signature here is rejected by every push service. */
function p256SignEs256_(privBytes, msgBytes) {
  const d = bytesToBig_(privBytes);
  const h = sha256_(msgBytes);
  const z = bytesToBig_(h);
  for (let attempt = 0; attempt < 8; attempt++) {
    const k = attempt === 0 ? rfc6979K_(privBytes, h)
      : rfc6979K_(privBytes, sha256_(concatBytes_(h, [attempt])));
    const pt = jToAffine_(jMul_(k, { x: P256_GX, y: P256_GY, z: BigInt(1) }));
    const r = mod_(pt.x, P256_N);
    if (r === BigInt(0)) continue;
    let s = mod_(modInv_(k, P256_N) * (z + r * d), P256_N);
    if (s === BigInt(0)) continue;
    /* low-s form: both are valid ECDSA, but some verifiers reject high-s and
       it costs nothing to normalise. */
    if (s > P256_N / BigInt(2)) s = P256_N - s;
    return concatBytes_(bigToBytes_(r, 32), bigToBytes_(s, 32));
  }
  throw new Error('p256: signing failed');
}

/** Verification is not needed to SEND push. It exists so the self-test can
 *  prove, inside the real Apps Script runtime, that signing is sound. */
function p256VerifyEs256_(pubBytes, msgBytes, sig) {
  if (sig.length !== 64) return false;
  const r = bytesToBig_(sig.slice(0, 32));
  const s = bytesToBig_(sig.slice(32, 64));
  if (r <= BigInt(0) || r >= P256_N || s <= BigInt(0) || s >= P256_N) return false;
  const z = bytesToBig_(sha256_(msgBytes));
  const w = modInv_(s, P256_N);
  const u1 = mod_(z * w, P256_N);
  const u2 = mod_(r * w, P256_N);
  const pt = jToAffine_(jAdd_(
    jMul_(u1, { x: P256_GX, y: P256_GY, z: BigInt(1) }),
    jMul_(u2, p256ParsePublic_(pubBytes))
  ));
  if (!pt) return false;
  return mod_(pt.x, P256_N) === r;
}

/** HKDF-SHA256 (RFC 5869). Web Push derives every key it uses through this. */
function hkdf_(salt, ikm, info, length) {
  const prk = hmacSha256_(salt, ikm);
  let t = [], out = [], i = 1;
  while (out.length < length) {
    t = hmacSha256_(prk, concatBytes_(t, info, [i]));
    out = out.concat(t);
    i++;
  }
  return out.slice(0, length);
}

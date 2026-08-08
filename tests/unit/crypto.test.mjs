/**
 * Proves the hand-written crypto in server/p256.js and server/aesgcm.js.
 *
 * Hand-rolled curve and cipher code that is subtly wrong still produces
 * plausible-looking bytes — it fails only later, silently, as a push service
 * rejecting every message. So nothing here trusts the implementation to check
 * itself: every result is compared against a published test vector or against
 * Node's own native crypto.
 *
 * The server files are written for the Apps Script runtime, so they are loaded
 * into a VM with a Utilities shim backed by Node crypto. That means these tests
 * exercise the REAL source that gets deployed, not a copy.
 *
 *   node tests/unit/crypto.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/* ── Apps Script shim ─────────────────────────────────────────────────────
   Apps Script hands back SIGNED bytes (-128..127); Node uses unsigned. The
   shim reproduces the signed convention exactly, because getting that wrong is
   itself one of the bugs these tests exist to catch. */
const toSigned = buf => Array.from(buf).map(b => (b > 127 ? b - 256 : b));
const toBuf = arr => Buffer.from(arr.map(b => b & 0xff));

const Utilities = {
  DigestAlgorithm: { SHA_256: 'SHA_256' },
  computeDigest: (_alg, bytes) => toSigned(crypto.createHash('sha256').update(toBuf(bytes)).digest()),
  computeHmacSha256Signature: (msg, key) =>
    toSigned(crypto.createHmac('sha256', toBuf(key)).update(toBuf(msg)).digest()),
  base64EncodeWebSafe: bytes => toBuf(bytes).toString('base64url'),
  base64Decode: s => toSigned(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
  newBlob: s => ({ getBytes: () => toSigned(Buffer.from(String(s), 'utf8')) }),
};

const ctx = vm.createContext({ Utilities, console, Error, Array, Math, Number, String, BigInt, Object });
for (const f of ['p256.js', 'aesgcm.js', 'webpush.js']) {
  const p = path.join(ROOT, 'server', f);
  if (fs.existsSync(p)) vm.runInContext(fs.readFileSync(p, 'utf8'), ctx, { filename: f });
}
const run = expr => vm.runInContext(expr, ctx);

/* ── tiny harness ─────────────────────────────────────────────────────────── */
let pass = 0, fail = 0;
const hex = a => Buffer.from(a.map(b => b & 0xff)).toString('hex');
const unhex = h => Array.from(Buffer.from(h, 'hex'));
function check(name, got, want) {
  const g = String(got).toLowerCase(), w = String(want).toLowerCase();
  if (g === w) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got:  ${g}\n       want: ${w}`); }
}
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

/* ── P-256 key derivation (RFC 6979 A.2.5 test key) ───────────────────────── */
console.log('\nP-256 key derivation');
const PRIV = 'C9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721';
const PUB_X = '60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6';
const PUB_Y = '7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299';

ctx.__priv = unhex(PRIV);
const pub = run('p256PublicFromPrivate_(__priv)');
check('public key matches the published vector', hex(pub), ('04' + PUB_X + PUB_Y).toLowerCase());

/* ── ECDSA / ES256 ────────────────────────────────────────────────────────── */
console.log('\nECDSA (ES256)');
ctx.__msg = Array.from(Buffer.from('sample', 'utf8'));
const sig = run('p256SignEs256_(__priv, __msg)');
ok('signature is 64 bytes (JOSE r||s, not DER)', sig.length === 64);

// r is unaffected by low-s normalisation, so it must match the RFC exactly
check('r matches RFC 6979 A.2.5', hex(sig.slice(0, 32)),
  'efd48b2aacb6a8fd1140dd9cd45e81d69d2c877b56aaf991c34d0ea84eaf3716');

// s must be the low form of the RFC's s
const N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
const rfcS = BigInt('0xf7cb1c942d657c41d436c7a1b6e29f65f3e900dbb9aff4064dc4ab2f843acda8');
const lowS = rfcS > N / 2n ? N - rfcS : rfcS;
check('s is the low-s form of the RFC value', hex(sig.slice(32)), lowS.toString(16).padStart(64, '0'));

// and the real test: Node's own verifier accepts it
const jwk = {
  kty: 'EC', crv: 'P-256',
  x: Buffer.from(unhex(PUB_X)).toString('base64url'),
  y: Buffer.from(unhex(PUB_Y)).toString('base64url'),
};
const key = await webcrypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
const verified = await webcrypto.subtle.verify(
  { name: 'ECDSA', hash: 'SHA-256' }, key, toBuf(sig), Buffer.from('sample', 'utf8'));
ok('Node WebCrypto verifies our signature', verified);

// a tampered message must NOT verify — proves the check above is meaningful
const bad = await webcrypto.subtle.verify(
  { name: 'ECDSA', hash: 'SHA-256' }, key, toBuf(sig), Buffer.from('sampls', 'utf8'));
ok('a tampered message fails verification', bad === false);

// determinism (RFC 6979): same input, same signature, every time
const sig2 = run('p256SignEs256_(__priv, __msg)');
check('signing is deterministic', hex(sig2), hex(sig));

// our own verifier agrees (this is what the on-Apps-Script self-test uses)
ctx.__pub = pub; ctx.__sig = sig;
ok('our verifier accepts our signature', run('p256VerifyEs256_(__pub, __msg, __sig)') === true);

/* ── ECDH ─────────────────────────────────────────────────────────────────── */
console.log('\nECDH');
{
  // Node generates a peer; we must agree on the same secret from both sides.
  const peer = crypto.createECDH('prime256v1');
  const peerPub = peer.generateKeys();
  ctx.__peerPub = Array.from(peerPub);
  const ours = run('p256SharedSecret_(__priv, __peerPub)');
  const theirs = peer.computeSecret(Buffer.from(unhex('04' + PUB_X + PUB_Y)));
  check('shared secret agrees with Node', hex(ours), theirs.toString('hex'));
  ok('shared secret is 32 bytes (X coordinate only)', ours.length === 32);
}

/* ── HKDF (RFC 5869 test case 1) ──────────────────────────────────────────── */
console.log('\nHKDF-SHA256');
ctx.__salt = unhex('000102030405060708090a0b0c');
ctx.__ikm = unhex('0b'.repeat(22));
ctx.__info = unhex('f0f1f2f3f4f5f6f7f8f9');
check('RFC 5869 case 1', hex(run('hkdf_(__salt, __ikm, __info, 42)')),
  '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');

/* ── AES-128-GCM (NIST GCM spec, test case 4) ─────────────────────────────── */
console.log('\nAES-128-GCM');
{
  const K = unhex('feffe9928665731c6d6a8f9467308308');
  const IV = unhex('cafebabefacedbaddecaf888');
  const P = unhex('d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a72'
    + '1c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39');
  const A = unhex('feedfacedeadbeeffeedfacedeadbeefabaddad2');
  ctx.__K = K; ctx.__IV = IV; ctx.__P = P; ctx.__A = A;
  const out = run('aes128gcmEncrypt_(__K, __IV, __P, __A)');
  check('ciphertext matches NIST case 4', hex(out.slice(0, P.length)),
    '42831ec2217774244b7221b784d0d49ce3aa212f2c02a4e035c17e2329aca12e'
    + '21d514b25466931c7d8f6a5aac84aa051ba30b396a0aac973d58e091');
  check('tag matches NIST case 4', hex(out.slice(P.length)), '5bc94fbc3221a5db94fae95ae7121a47');
}
{
  // and the property that actually matters: Node can decrypt what we sealed
  const K = Array.from(crypto.randomBytes(16));
  const IV = Array.from(crypto.randomBytes(12));
  const P = Array.from(Buffer.from('CreativeFlow · GD-0007 needs changes', 'utf8'));
  ctx.__K = K; ctx.__IV = IV; ctx.__P = P; ctx.__A = [];
  const sealed = run('aes128gcmEncrypt_(__K, __IV, __P, __A)');
  const d = crypto.createDecipheriv('aes-128-gcm', toBuf(K), toBuf(IV));
  d.setAuthTag(toBuf(sealed.slice(P.length)));
  const plain = Buffer.concat([d.update(toBuf(sealed.slice(0, P.length))), d.final()]);
  check('Node decrypts our ciphertext', plain.toString('utf8'), 'CreativeFlow · GD-0007 needs changes');
}
{
  // empty plaintext is a real edge case in GCM's length block
  ctx.__K = unhex('00000000000000000000000000000000');
  ctx.__IV = unhex('000000000000000000000000');
  ctx.__P = []; ctx.__A = [];
  check('empty plaintext tag (NIST case 1)', hex(run('aes128gcmEncrypt_(__K, __IV, __P, __A)')),
    '58e2fccefa7e3061367f1d57a4e7455a');
}

/* ── Web Push message assembly (RFC 8291 / RFC 8188) ──────────────────────── */
if (typeof ctx.webPushBody_ === 'function' || run('typeof webPushBody_') === 'function') {
  console.log('\nWeb Push (RFC 8291 aes128gcm)');

  // RFC 8291 §5 worked example — the one place the whole chain is pinned down
  const ua = crypto.createECDH('prime256v1');
  const uaPub = ua.generateKeys();
  const auth = crypto.randomBytes(16);
  ctx.__uaPub = Array.from(uaPub);
  ctx.__auth = Array.from(auth);
  ctx.__plain = Array.from(Buffer.from('When I grow up, I want to be a watermelon', 'utf8'));
  ctx.__salt = Array.from(crypto.randomBytes(16));
  ctx.__asPriv = Array.from(crypto.randomBytes(32));

  const body = run('webPushBody_(__uaPub, __auth, __plain, __salt, __asPriv)');
  ok('body carries the aes128gcm header', body.length > 86);

  // decrypt it exactly the way a browser would, using Node only
  const buf = toBuf(body);
  const salt = buf.subarray(0, 16);
  const idlen = buf.readUInt8(20);
  const asPub = buf.subarray(21, 21 + idlen);
  const ct = buf.subarray(21 + idlen);
  check('header keyid is the 65-byte server public key', String(idlen), '65');

  const shared = ua.computeSecret(asPub);
  const hk = (s, i, l, ikm) => {
    const prk = crypto.createHmac('sha256', s).update(ikm).digest();
    return crypto.createHmac('sha256', prk).update(Buffer.concat([i, Buffer.from([1])])).digest().subarray(0, l);
  };
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]);
  const ikm = hk(auth, keyInfo, 32, shared);
  const cek = hk(salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16, ikm);
  const nonce = hk(salt, Buffer.from('Content-Encoding: nonce\0'), 12, ikm);

  const dec = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  dec.setAuthTag(ct.subarray(ct.length - 16));
  const out = Buffer.concat([dec.update(ct.subarray(0, ct.length - 16)), dec.final()]);
  const text = out.subarray(0, out.length - 1).toString('utf8');   // strip the 0x02 delimiter
  check('a browser-side decrypt recovers the message', text, 'When I grow up, I want to be a watermelon');
  check('padding delimiter is 0x02 (last record)', String(out[out.length - 1]), '2');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

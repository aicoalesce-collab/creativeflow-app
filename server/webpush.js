/**
 * ============================================================================
 *  webpush.js — the Web Push protocol, spoken directly from Apps Script.
 *
 *  RFC 8030 (delivery), RFC 8291 (payload encryption), RFC 8292 (VAPID).
 *
 *  There is no third party in this path. The studio's task titles go from this
 *  script, encrypted, to the browser vendor's push service, and are decrypted
 *  inside the member's own browser. The push service (Google, Mozilla,
 *  Microsoft) routes an opaque blob it cannot read.
 *
 *  Depends on p256.js and aesgcm.js for the primitives Apps Script lacks.
 * ============================================================================
 */

/** How long a VAPID token stays valid. Push services reject anything more than
 *  24h out; 12h leaves room for clock skew at both ends. */
const VAPID_TTL_SECONDS = 12 * 60 * 60;

/**
 * The VAPID Authorization header: a JWT signed with our private key, proving to
 * the push service that all messages for a subscription come from the same
 * application. `aud` MUST be the origin of the endpoint — not the full URL —
 * and a mismatch is rejected with 401.
 */
function vapidHeader_(endpoint, privBytes, pubBytes, subject) {
  const aud = String(endpoint).split('/').slice(0, 3).join('/');
  const header = b64url_(strToBytes_(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url_(strToBytes_(JSON.stringify({
    aud: aud,
    exp: Math.floor(Date.now() / 1000) + VAPID_TTL_SECONDS,
    sub: subject,
  })));
  const signingInput = header + '.' + claims;
  const sig = b64url_(p256SignEs256_(privBytes, strToBytes_(signingInput)));
  return {
    Authorization: 'vapid t=' + signingInput + '.' + sig + ', k=' + b64url_(pubBytes),
  };
}

/**
 * Builds the aes128gcm body for one subscription (RFC 8291 §3, RFC 8188 §2).
 *
 * Layout:  salt(16) | rs(4) | idlen(1) | server public key(65) | ciphertext
 *
 * The plaintext gets a trailing 0x02 delimiter — RFC 8188's "last record"
 * marker. Omitting it makes browsers throw away an otherwise perfect message,
 * which is a miserable thing to debug from the outside.
 */
function webPushBody_(uaPublic, authSecret, plaintext, salt, asPrivate) {
  const asPublic = p256PublicFromPrivate_(asPrivate);
  const shared = p256SharedSecret_(asPrivate, uaPublic);

  /* Two-stage derivation: the auth secret binds the keys to THIS subscription,
     then the per-message salt binds them to this message. */
  const keyInfo = concatBytes_(strToBytes_('WebPush: info'), [0x00], uaPublic, asPublic);
  const ikm = hkdf_(authSecret, shared, keyInfo, 32);
  const cek = hkdf_(salt, ikm, concatBytes_(strToBytes_('Content-Encoding: aes128gcm'), [0x00]), 16);
  const nonce = hkdf_(salt, ikm, concatBytes_(strToBytes_('Content-Encoding: nonce'), [0x00]), 12);

  const padded = concatBytes_(plaintext, [0x02]);
  const sealed = aes128gcmEncrypt_(cek, nonce, padded, []);

  const rs = 4096;
  return concatBytes_(
    salt,
    [(rs >>> 24) & 0xff, (rs >>> 16) & 0xff, (rs >>> 8) & 0xff, rs & 0xff],
    [asPublic.length],
    asPublic,
    sealed
  );
}

/** 16 random bytes. Math.random is not a CSPRNG, so the salt is derived from a
 *  SHA-256 over values an outsider cannot see or predict together: the script's
 *  own secret, the clock at microsecond scale, and a UUID. The salt is not
 *  secret — it must only never repeat under one key — and this cannot repeat. */
function pushSalt_() {
  const seed = String(Utilities.getUuid()) + '|' + Date.now() + '|' + Math.random() +
    '|' + (PropertiesService.getScriptProperties().getProperty('PUSH_SEED') || '');
  return sha256_(strToBytes_(seed)).slice(0, 16);
}

/** A fresh ephemeral keypair per message, as RFC 8291 requires: reusing one
 *  across messages would let the push service correlate them. */
function ephemeralPrivate_() {
  const seed = String(Utilities.getUuid()) + '|' + Date.now() + '|' + Math.random();
  let d = sha256_(strToBytes_('as-key|' + seed));
  /* vanishingly unlikely, but a key of 0 or >= n is invalid, so bound it */
  const n = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
  let v = bytesToBig_(d);
  while (v === BigInt(0) || v >= n) { d = sha256_(d); v = bytesToBig_(d); }
  return d;
}

/**
 * Sends one push. Returns { ok, code, gone } — `gone` means the subscription is
 * dead (404/410) and must be deactivated, which is the only way the
 * subscription list stays clean as people reinstall or clear their browser.
 */
function webPushSend_(sub, payloadText, opts) {
  const o = opts || {};
  const priv = vapidPrivateKey_();
  const pub = vapidPublicKey_();
  if (!priv || !pub) return { ok: false, code: 0, gone: false, error: 'no VAPID keys' };

  const uaPublic = b64urlDecode_(sub.p256dh);
  const authSecret = b64urlDecode_(sub.auth);
  const body = webPushBody_(uaPublic, authSecret, strToBytes_(payloadText), pushSalt_(), ephemeralPrivate_());

  const headers = vapidHeader_(sub.endpoint, priv, pub, vapidSubject_());
  headers['Content-Encoding'] = 'aes128gcm';
  headers['TTL'] = String(o.ttl == null ? 86400 : o.ttl);
  if (o.urgency) headers['Urgency'] = o.urgency;
  /* Topic collapses undelivered messages: a phone that was off all day gets the
     latest state of a task, not nine stale copies of it. */
  if (o.topic) headers['Topic'] = String(o.topic).slice(0, 32).replace(/[^A-Za-z0-9_-]/g, '');

  const res = UrlFetchApp.fetch(sub.endpoint, {
    method: 'post',
    contentType: 'application/octet-stream',
    headers: headers,
    payload: body.map(function (b) { return b > 127 ? b - 256 : b; }),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  return {
    ok: code >= 200 && code < 300,
    code: code,
    gone: code === 404 || code === 410,
    error: (code >= 200 && code < 300) ? '' : String(res.getContentText()).slice(0, 180),
  };
}

/* ── VAPID key management ──────────────────────────────────────────────────
   The private key lives in Script Properties, never in the Config sheet: the
   sheet is shared with the team and an old system in this project already
   leaked an OAuth secret that way. The public key is public by design — the
   client needs it to subscribe — and ping hands it out. */

function vapidPrivateKey_() {
  const p = PropertiesService.getScriptProperties().getProperty('VAPID_PRIVATE');
  return p ? b64urlDecode_(p) : null;
}

function vapidPublicKey_() {
  const p = PropertiesService.getScriptProperties().getProperty('VAPID_PUBLIC');
  return p ? b64urlDecode_(p) : null;
}

function vapidPublicKeyB64_() {
  return PropertiesService.getScriptProperties().getProperty('VAPID_PUBLIC') || '';
}

/** RFC 8292 wants a contact the push service can reach if we misbehave. */
function vapidSubject_() {
  const s = String(cfg_('PUSH_CONTACT', '')).trim();
  if (s.indexOf('mailto:') === 0 || s.indexOf('https://') === 0) return s;
  /* ownerEmail_(), not cfg_('OWNER_EMAIL') — there is no such Config key, so
     that read always came back empty and every message would have claimed
     noreply@example.com as its contact. */
  let owner = '';
  try { owner = String(ownerEmail_() || '').trim(); } catch (e) {}
  return owner ? 'mailto:' + owner : 'mailto:noreply@example.com';
}

/**
 * Creates the VAPID keypair once and keeps it forever.
 *
 * Rotating it silently invalidates every existing subscription — every device
 * would go quiet with no error anywhere — so this refuses to overwrite unless
 * explicitly forced.
 */
function vapidEnsureKeys_(force) {
  const props = PropertiesService.getScriptProperties();
  if (!force && props.getProperty('VAPID_PRIVATE') && props.getProperty('VAPID_PUBLIC')) {
    return { created: false, publicKey: props.getProperty('VAPID_PUBLIC') };
  }
  const priv = ephemeralPrivate_();
  const pub = p256PublicFromPrivate_(priv);
  props.setProperty('VAPID_PRIVATE', b64url_(priv));
  props.setProperty('VAPID_PUBLIC', b64url_(pub));
  if (!props.getProperty('PUSH_SEED')) props.setProperty('PUSH_SEED', Utilities.getUuid());
  log_('vapid-keys', '', '', force ? 'ROTATED — every device must resubscribe' : 'created', true);
  return { created: true, publicKey: b64url_(pub) };
}

/**
 * Proves the crypto works inside the real Apps Script runtime.
 *
 * The unit tests run this same source under Node, but Node is not what ships.
 * This runs on Google's V8 with Google's Utilities, signs a known message with
 * a known key, and checks the result byte-for-byte against the published RFC
 * 6979 vector — so a runtime difference shows up as a failed self-test rather
 * than as notifications that quietly never arrive.
 */
function pushSelfTest_() {
  const t0 = Date.now();
  const out = { ok: true, checks: [] };
  const add = function (name, got, want) {
    const pass = String(got).toLowerCase() === String(want).toLowerCase();
    if (!pass) out.ok = false;
    out.checks.push({ name: name, pass: pass, got: pass ? '' : String(got).slice(0, 80) });
  };
  const hex = function (a) {
    return a.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
  };

  try {
    add('BigInt available', typeof BigInt, 'function');

    const priv = [];
    const PRIV_HEX = 'c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721';
    for (let i = 0; i < 64; i += 2) priv.push(parseInt(PRIV_HEX.substr(i, 2), 16));

    const t1 = Date.now();
    const pub = p256PublicFromPrivate_(priv);
    const pubMs = Date.now() - t1;
    add('public key (RFC 6979 A.2.5)', hex(pub),
      '0460fed4ba255a9d31c961eb74c6356d68c049b8923b61fa6ce669622e60f29fb6'
      + '7903fe1008b8bc99a41ae9e95628bc64f2f1b20c2d7e9f5177a3c294d4462299');

    const t2 = Date.now();
    const sig = p256SignEs256_(priv, strToBytes_('sample'));
    const signMs = Date.now() - t2;
    add('ECDSA r (RFC 6979 A.2.5)', hex(sig.slice(0, 32)),
      'efd48b2aacb6a8fd1140dd9cd45e81d69d2c877b56aaf991c34d0ea84eaf3716');
    add('signature verifies', p256VerifyEs256_(pub, strToBytes_('sample'), sig), 'true');

    add('AES-128-GCM (NIST case 1)',
      hex(aes128gcmEncrypt_(new Array(16).fill(0), new Array(12).fill(0), [], [])),
      '58e2fccefa7e3061367f1d57a4e7455a');

    add('HKDF-SHA256 (RFC 5869 case 1)',
      hex(hkdf_([0x00,0x01,0x02,0x03,0x04,0x05,0x06,0x07,0x08,0x09,0x0a,0x0b,0x0c],
        new Array(22).fill(0x0b), [0xf0,0xf1,0xf2,0xf3,0xf4,0xf5,0xf6,0xf7,0xf8,0xf9], 42)),
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');

    out.timing = { publicKeyMs: pubMs, signMs: signMs, totalMs: Date.now() - t0 };
  } catch (err) {
    out.ok = false;
    out.error = String(err) + (err && err.stack ? ' | ' + String(err.stack).slice(0, 300) : '');
  }
  return out;
}

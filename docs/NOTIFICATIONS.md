# Push notifications

CreativeFlow sends real OS notifications — the kind that appear in the Windows
Action Center or on an Android lock screen — with the app closed.

No Firebase project, no third-party notification service, no extra account.
The Apps Script server speaks the Web Push protocol directly.

## What a member does

Open the app → tap their name (top right) → **🔔 Notifications: OFF** → allow.

That is the whole setup. It is per-device: turning it on at a desk does not
turn it on for a phone.

## Where it works

| Platform | Works? | Notes |
|---|---|---|
| **Windows — Chrome/Edge, installed as an app** | Yes | Best experience. Arrives with the app closed. |
| **Windows — Chrome/Edge, ordinary tab** | Yes | Installation is not required. |
| **Android — Chrome, installed or not** | Yes | The system push service wakes the browser; the phone can be locked. |
| **iPhone / iPad** | Only after **Add to Home Screen** | Safari refuses push to a normal tab. iOS 16.4+. The app says so in plain words when someone tries. |
| **Apps Script `?page=app` fallback** | No | Sandboxed origin; a service worker cannot own that scope. |
| **The old desktop exe** | No | Retired — see below. |

### "Even when closed" — the honest detail

On **Android** this is unconditional: the push arrives at the OS, which wakes
the browser. The app, the browser, and the screen can all be off.

On **Windows** the notification is delivered by Chrome's background process,
which normally keeps running after you close the window — that is the default
once a site is installed as an app. If someone fully quits Chrome *and* has
"Continue running background apps" switched off, messages queue at Google for
up to 24 hours (our TTL) and land the moment Chrome opens again. Nothing is
lost; it is just late.

## What triggers one

`PUSH_LEVEL` is **all** by default — push is free, so everything fires.
`EMAIL_LEVEL` stays **balanced**, so the inbox stays quiet. That asymmetry is
deliberate: the account can send about 100 emails a day, and the old system
once burned that in minutes.

- a task assigned to you
- changes requested on your work
- a task completed / ready for your review / ready to QC
- a task rejected
- something overdue (one message per person, not one per task)
- a comment, including a client's comment through a share link
- the brief changed after you started
- a new app version is out (fired by `tools/deploy.ps1` after the prod smoke)

`PUSH_MUTE=YES` in Config silences everything and logs instead — the same
escape hatch `EMAIL_MUTE` gives. Test accounts (`@example.com`) are never sent
to, and nothing a test account does notifies a real person.

## The bell

The bell shows what actually **arrived** on this device, newest first, written
by the service worker even while the app was closed. The badge counts unread
arrivals and clears when the panel is opened; entries stay readable until
**Clear**. Below them sits the derived "needs attention" list (overdue, waiting
for review), which is not dismissible because it reflects live state — an
overdue task is still overdue whether or not you read about it.

The log lives in IndexedDB on the device, capped at 60 entries.

## How it works underneath

Web Push needs two things Apps Script does not have: an ECDSA P-256 signature
for the VAPID header, and an ECDH + AES-128-GCM sealed payload. Both are
implemented in `server/p256.js` and `server/aesgcm.js`, on BigInt.

- `server/webpush.js` — VAPID JWT, RFC 8291 encryption, sending, dead-device detection
- `server/push.js` — the device list, the queue, who gets told what
- `web/public/sw.js` — receives, shows, logs, routes the tap
- `web/src/push.js` — permission and subscription from the app

Messages are encrypted end to end: Google's push service routes a blob it
cannot read, and it is decrypted inside the member's own browser.

**Verification.** `node tests/unit/crypto.test.mjs` checks every primitive
against published RFC 6979 / RFC 5869 / NIST GCM vectors *and* against Node's
native crypto — including a full browser-side decrypt of a message our code
sealed. `admin { "op": "pushSelfTest" }` runs the same vectors inside the live
Apps Script runtime, because Node is not what ships. Sending to a well-formed
but non-existent endpoint returns **410 Gone**, not 401 — proof that Google
accepted the signature and the ciphertext and rejected only the fake device.

### Keys

The VAPID keypair is minted once by `setup()` and stored in Script Properties,
never in the Config sheet (an earlier system in this project leaked a secret
that way). The public half is handed out by `ping`.

**Never rotate it casually.** New keys invalidate every existing subscription
and every device goes silent with no error anywhere. `vapidEnsureKeys_` refuses
to overwrite unless forced with an explicit, deliberately ugly string.

## Admin operations

    { "op": "pushSelfTest" }   crypto vectors, on the live runtime
    { "op": "pushList" }       every registered device
    { "op": "pushTest",  "member": "someone@example.com" }
    { "op": "pushAppUpdate", "version": "5.3.0" }
    { "op": "setConfig", "key": "PUSH_LEVEL", "value": "balanced" }
    { "op": "setConfig", "key": "PUSH_MUTE",  "value": "YES" }

Dead subscriptions clean themselves up: a 404/410 from the push service
deactivates the row immediately, and ten consecutive failures retires it.

## The desktop exe is retired

The owner installs the app from Chrome instead, which does everything the exe
did and adds notifications, which the exe never had.

The source and its test suite stay in the repo (`exe/`, `tests/e2e/90-exe.spec.ts`)
and still pass, so it remains available if GitHub Pages ever goes down. It is
simply no longer built or handed out as part of a release, and no longer
mentioned in rollout instructions.

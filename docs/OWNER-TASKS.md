# What only you can do (everything else is scripted)

Five short interactive moments. Each is a browser click-through — no typing
commands, no code. Claude drives everything around them.

## 1. Google sign-in for the build tools (~3 min, once)

- **`clasp login`** — a browser tab opens; approve access for your Google
  account (**aicoalesce@gmail.com**, the account that owns the sheets).
- **Turn on the Apps Script API** — open
  <https://script.google.com/home/usersettings> and switch
  "Google Apps Script API" to **ON**. (Without this, nothing can be deployed
  from here and we are back to pasting code by hand.)
- **`gh auth login`** — approve the GitHub device code so the app's web
  hosting can be created and updated automatically.

## 2. One-time consent for the new Apps Script project (~2 min)

After the new sheet is created, open it → **Extensions ▸ Apps Script** → pick
`authorize` in the function dropdown → **Run** → approve the permission
screens (it is your own script; the "unverified app" warning is expected —
choose Advanced ▸ Go to CreativeFlow).

Then run `setup` the same way, once. After that every maintenance action is
available remotely and you never need to open the editor again.

## 3. Google Cloud console: let the app upload to Drive (~5 min)

APIs & Services ▸ **Credentials** ▸ open the existing **Web** OAuth client ▸
**Authorized JavaScript origins** ▸ *Add*:

- `https://<your-github-username>.github.io`
- `https://app.<your-domain>` — when the domain arrives

Keep the existing `http://localhost:4879` entry (that is the desktop app).
Also check the **Drive API key**: Application restrictions should say *None*
(if a referrer restriction was ever added, the two origins above need adding
there too).

## 4. Device walkthrough before cutover (~30 min, together)

We test on: your PC (browser + installed app + desktop exe), **the problem
PC** (this is the gate — if it cannot log in, we do not cut over), one Android
phone, a guest link from outside the office, one real upload, one digest email.
Checklist: `docs/runbooks/DEVICE-MATRIX.md`.

## 5. Cutover evening (~1 hour)

You: send the freeze message, paste the old sheet link, approve the one-cell
"we've moved" banner on the old sheet, and forward the per-person rollout
messages. Claude: runs the migration, validates the counts, smoke-tests, and
hands you the messages ready to send. Runbook: `docs/runbooks/CUTOVER.md`.

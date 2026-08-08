# CreativeFlow v5 — read this first

Clean-room rebuild of the Coalesce Eventz studio task platform (Graphic + Video
teams). Google Sheet = database · Apps Script (`server/`, clasp-managed) = JSON
API · Vite/TS client (`web/`) = PWA on GitHub Pages + single-file fallback
(`?page=app`) + embedded in the Windows exe (`exe/`).

The old system lives in `D:\claude test\Main Creative Flow` — **reference only,
never modify it, never resurrect its dead URLs.** Full plan:
`C:\Users\Admin\.claude\plans\wiggly-drifting-pebble.md`. Runbooks in `docs/`.

## Non-negotiable constraints (paid for in blood — do not relearn)

1. **Every API response stays ping-sized.** Login = `bootstrap {lite:1}` +
   `tasksPage` (25/page, clamp 50). One studio PC stalls on large HTTPS
   responses. Never put a mandatory big answer on the login path; legacy
   `tasks` is a fallback only.
2. **Deploys only ever update pinned deployment IDs** via
   `clasp deploy -i <id>` (`tools/deploy.ps1` enforces this). A bare
   `clasp deploy` mints a NEW /exec URL and kills every client. Never delete
   or archive a deployment. IDs live in `deployments.json`.
3. **Auth = roster email + 6-char access code ONLY.** Google login was removed
   at the owner's explicit order — never re-add it.
4. **API POSTs are `text/plain` JSON** (simple request, no CORS preflight —
   Apps Script cannot answer preflights). Never add custom headers to the
   sheet transport.
5. **Remote fetch tools lie about `/exec`** (404/mangled). Only trustworthy
   probes: a real browser (in-app Browser pane) or a Go HTTP client
   (`tools/probe.exe`).
6. **Sentinel lines** in `web/index.html` (`window.APP_VERSION`,
   `CF_INJECTED_API`, `CF_GUEST_TOKEN`, `CF_OPEN_TASK`) are rewritten by the
   server's `serveApp_`, regexed by ping's `appVersion`, and checked by the
   exe OTA. They must survive builds un-minified and un-renamed.
7. **Email safety**: `@example.com` recipients are never mailed; actions by
   `@example.com` actors never email anyone real; Config `EMAIL_MUTE=YES`
   silences everything (logged as muted). Test Bot = `testbot@example.com`.
8. Timezone is `Asia/Calcutta` everywhere; all local-time math goes through
   `Utilities.parseDate/formatDate` with the Config TIMEZONE — never
   `new Date(y,m,d,h,m)`.

## Layout

- `server/` — clasp root (.js files appear as .gs). Router in `main.js`;
  every handler is registered in `ROUTES`. Locks via the dispatch wrapper;
  emails are queued (`queueMail_`) and flushed AFTER lock release.
- `web/` — Vite + vanilla TS, no framework. Two builds: normal (Pages) and
  `SINGLEFILE=1` (→ `server/app.html` + `exe/app/index.html`).
- `tests/` — `npm run mock` (mock API :8787), `npm test` (Playwright).
  Suites are hermetic: they abort all script.google.com traffic.
- `tools/` — deploy.ps1 / smoke.ps1 / migrate.ps1 / drift-check.ps1 / probe.

## Build state (2026-08-08)

Everything that can be built without the owner's Google/GitHub sign-in is
**built, tested and committed**: 19 server modules, the client (all screens),
the PWA layer, the Windows exe v5.0.0, the mock API + fixtures, and an
**81-test Playwright battery that is fully green** (`cd tests; npx playwright test`).

Remaining work is gated on the owner — see `docs/OWNER-TASKS.md` and
`docs/SETUP.md`: clasp login + Apps Script API toggle, `authorize`/`setup` in
the editor, `gh auth login`, the OAuth origin for uploads, then the device
matrix and cutover.

## Live identifiers

Filled in as they are created — keep current:

| Item | Value |
|---|---|
| New Sheet URL | (after `clasp create`) |
| Script ID | (`.clasp.json`) |
| STAGING deploymentId + /exec | (deployments.json) |
| PROD deploymentId + /exec | (deployments.json) |
| Pages URL | (after Phase 4) |
| Old sheet (migration source, READ-ONLY) | (owner supplies at cutover) |

## What v5 adds beyond the old system

- **Assigner sheet sync** (`server/extsync.js`, `docs/ASSIGNER-SHEETS.md`) —
  premade per-assigner Google Sheets whose rows become real tasks, with status
  and finished work flowing back into a Completed feed for content calendars.
- **taskDetail action + preview-capped list rows** — one 200KB description can
  no longer inflate a page and re-break the studio PC (old DIAGNOSTICS R4).
- Uploads work from any registered origin, not just the exe.
- Real time triggers instead of lazy sweeps; queued mail sent after lock release.
- `EMAIL_MUTE` + actor guard + Test Bot, so production can be smoke-tested
  without mailing the team.

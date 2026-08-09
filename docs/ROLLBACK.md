# Rolling back

The redesign ships in passes. Each pass is deployed on its own, and each one can
be undone without touching the others.

## The one command

```
tools\rollback.ps1 -To v5.6.0-before-redesign
```

It rebuilds the client from that tag, republishes the site, and points the PROD
Apps Script deployment back at that tag's immutable version. Same URLs, same
sheet, same data — only the code moves.

Add `-WhatIf` to see what it would do without doing it.

## Restore points

| Tag | What it is | Apps Script version | Pages commit |
|---|---|---|---|
| `v5.6.0-before-redesign` | Everything working, before any visual change: campaigns, gallery, push, the QC rules | 33 | `cbb6868` |

Every deploy adds a row here. `docs/runbooks/DEPLOY-LOG.md` has the full history.

## What a rollback does and does not touch

**Moves back:** the client (Pages + the `?page=app` fallback + the exe's embedded
copy) and the server code.

**Stays exactly as it is:** the sheet and every row in it, the Roster and access
codes, campaigns, the Portfolio and its stills, push subscriptions, share links,
Config. Nothing anyone has done is undone by a rollback — this only changes the
code that reads and writes it.

**The one exception:** a rollback past a *schema* change leaves the new columns
in place, unread. That is deliberate and safe — an unread column costs nothing,
and dropping it would destroy data. There is no schema change in the redesign;
the last one was campaigns (column 31), in 5.5.0.

## Doing it by hand

If the script is unavailable:

```
git checkout v5.6.0-before-redesign
scripts\build-app.ps1
node scripts\publish-web.mjs
clasp update-deployment AKfycbwgIxm64fS8lwfbhv8Ro1e7JlF9JzLAUjLvQ3TNgJnFiW8yf8SWmaqpgkpLSMoaldEl -V 33
tools\smoke.ps1 -Url <prod-exec-url> -ExpectV 5.6.0
```

Never `clasp deploy` without `-i` / `update-deployment` — a bare deploy mints a
new /exec URL and every client on earth points at a corpse. That happened once
and cost the studio a day.

## Afterwards

Team devices pick up the older client the next time they open the app; the
service worker's update prompt handles it. Anyone mid-session can carry on —
nothing in flight breaks, because the data has not moved.

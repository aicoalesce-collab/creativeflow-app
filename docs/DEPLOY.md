# Deploying CreativeFlow v5

## The one rule

**Never run `clasp deploy` without `-i <deploymentId>`.** A bare deploy mints a
NEW /exec URL; every client keeps pointing at the old one. This killed the old
studio for a day. Never delete or archive a deployment either.

## Deployment IDs

Two immortal Web-app deployments are created ONCE at project birth and updated
in place forever. They live in `deployments.json` at the repo root:

```json
{ "staging": { "id": "", "url": "" }, "prod": { "id": "", "url": "" } }
```

(Also mirrored in the new sheet's Config tab and in CLAUDE.md.)

## Release procedure (server and/or client)

1. Build the client if it changed: `scripts/build-app.ps1`
   (runs both Vite builds, copies single-file → `server/app.html` + `exe/app/index.html`).
2. `tools/deploy.ps1 -Version X.Y.Z`
   - preflight: `clasp login --status`, git tree clean, `tools/drift-check.ps1`
   - `clasp push -f`
   - `clasp version "vX.Y.Z"` → immutable version N
   - `clasp deploy -i <STAGING> -V N` → `tools/smoke.ps1 -Target staging`
   - `clasp deploy -i <PROD> -V N` → `tools/smoke.ps1 -Target prod`
   - refuses to continue at any red step
3. Pages client: `git push` (Actions deploys), then verify appVersion via probe.
4. Append a line to `docs/runbooks/DEPLOY-LOG.md`.

## Manual fallback (only if clasp auth is broken)

Apps Script editor → Deploy → **Manage deployments → pencil ✏️ on the existing
deployment → Version: New version → Deploy.** NEVER "New deployment".

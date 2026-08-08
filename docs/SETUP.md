# Bringing the new system online (the remaining steps)

Everything below is scripted; the four ★ steps need the owner's browser once.

## 1. Create the new Sheet + bound script

```powershell
★ clasp login                       # owner approves in the browser
★ # switch ON: https://script.google.com/home/usersettings  (Apps Script API)
cd "D:\claude test\creativeflow-v5"
clasp create --type sheets --title "CreativeFlow" --rootDir ./server
```

Record the printed **sheet URL** and **script id** in `CLAUDE.md`.

```powershell
.\scripts\build-app.ps1             # puts the built client in server/app.html
cd server; clasp push -f
```

★ Open the sheet → Extensions ▸ Apps Script → run `authorize`, approve → run
`setup`. The sheet builds itself (all 10 tabs, validations, formulas,
protections, the Task Request form, 9 triggers) and emails the owner.

## 2. Two immortal deployments

```powershell
cd server
clasp deploy -d "staging v5.0.0"    # copy the deploymentId + /exec url
clasp deploy -d "prod v5.0.0"       # copy the deploymentId + /exec url
```

Put both into `deployments.json`. **These two ids are created once and never
again** — every later release updates them in place via `tools/deploy.ps1`.

```powershell
.\scripts\bake-url.ps1              # stamps the prod /exec into client + exe
.\tools\smoke.ps1 -Url <prod-url> -ExpectV 5.0.0
```

## 3. Hosting (GitHub Pages)

```powershell
★ gh auth login
gh repo create creativeflow-app --public --source . --push
gh api -X POST repos/{owner}/creativeflow-app/pages -f build_type=workflow
git push                            # Actions builds + deploys web/dist
```

Then set the app's own base URL so email deep links point at the PWA:

```powershell
.\tools\probe\probe.exe admin <prod-url> <admin-email> <code> '{"op":"setConfig","key":"APP_BASE_URL","value":"https://<owner>.github.io/creativeflow-app/"}'
```

★ Google Cloud console: add that origin to the Web OAuth client (docs/OWNER-TASKS.md §3).

## 4. Roster + codes

Migration carries the old roster **and everyone's existing access codes**. For
a brand-new person: add the Roster row, then

```powershell
probe.exe admin <prod-url> <admin> <code> '{"op":"generateCodes"}'
probe.exe admin <prod-url> <admin> <code> '{"op":"rebuildMirrors"}'
```

## 5. Go-live

`docs/runbooks/DEVICE-MATRIX.md` → `docs/runbooks/CUTOVER.md`.

## Everyday operations (after go-live)

| Task | Command |
|---|---|
| Ship a code change | `.\tools\deploy.ps1 -Version 5.0.1` |
| Ship a client-only change | `git push` (Actions), then verify appVersion via probe |
| Health check | `.\tools\smoke.ps1 -Url <prod-url>` |
| Rebuild the exe | `.\scripts\build-exe.ps1 -Version 5.0.1` |
| Rename a person safely | `probe admin … '{"op":"renameMember","from":"Old","to":"New"}'` |
| Backup now | `probe admin … '{"op":"backupNow"}'` (also weekly, automatic) |
| Give an assigner their sheet | `probe admin … '{"op":"createAssignerSheet","assigner":"Name"}'` |
| Hook up their calendar sheet | `probe admin … '{"op":"registerCalendarSheet","assigner":"Name","src":"<url>"}'` |

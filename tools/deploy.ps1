# The ONLY sanctioned way to ship server code.
#
# Hard rule: `clasp deploy` is NEVER run without -i <deploymentId>. A bare
# deploy mints a NEW /exec URL and every client on earth points at a corpse —
# that happened once and cost the studio a day.
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [switch]$SkipTests,
  [switch]$ProdOnly,
  [switch]$NoAnnounce,                                    # skip the "new version" push
  [string]$AnnounceEmail = 'aicoalesce@gmail.com',
  [string]$AnnounceCode = 'PYTUSF'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$dep = Get-Content "$root\deployments.json" -Raw | ConvertFrom-Json

function Need($v, $what) { if (-not $v) { throw "deployments.json is missing $what — see docs/DEPLOY.md" } }
Need $dep.staging.id 'staging.id'; Need $dep.staging.url 'staging.url'
Need $dep.prod.id    'prod.id';    Need $dep.prod.url    'prod.url'

Write-Host "== preflight =="
# clasp 3 renamed this; `login --status` is the 2.x spelling and errors out
$who = clasp show-authorized-user 2>&1 | Out-String
if ($LASTEXITCODE -or $who -notmatch '@') { throw "clasp is not logged in — run: clasp login" }
Write-Host ("authenticated as " + $who.Trim())
& "$root\tools\drift-check.ps1"
if ($LASTEXITCODE) { throw "the live script differs from git — reconcile before deploying" }

# Always, even with -SkipTests: the push crypto is hand-written, and shipping a
# broken curve implementation shows up only as notifications that never arrive.
Write-Host "== crypto vectors =="
node "$root\tests\unit\crypto.test.mjs"
if ($LASTEXITCODE) { throw "crypto vectors FAILED - not deploying" }

if (-not $SkipTests) {
  Write-Host "== test battery =="
  Push-Location "$root\tests"
  try { npx playwright test; if ($LASTEXITCODE) { throw "tests failed — not deploying" } }
  finally { Pop-Location }
}

Write-Host "== build + push =="
# stamp the client sentinel first: the smoke check compares it against $Version,
# so a forgotten bump fails the deploy after the push has already happened
node "$root\scripts\set-version.mjs" $Version
if ($LASTEXITCODE) { throw "could not stamp APP_VERSION" }
& "$root\scripts\build-app.ps1"
Push-Location $root      # .clasp.json is at the repo root (rootDir: server)
try {
  clasp push -f
  if ($LASTEXITCODE) { throw "clasp push failed" }
  $out = clasp create-version "v$Version" 2>&1 | Out-String
  if ($LASTEXITCODE) { throw "clasp version failed: $out" }
  $n = [regex]::Match($out, '\d+').Value
  if (-not $n) { throw "could not read the new version number from: $out" }
  Write-Host "immutable version $n created"

  if (-not $ProdOnly) {
    Write-Host "== staging =="
    clasp update-deployment $dep.staging.id -V $n -d "staging v$Version"
    if ($LASTEXITCODE) { throw "staging deploy failed" }
    & "$root\tools\smoke.ps1" -Url $dep.staging.url -ExpectV $Version
    if ($LASTEXITCODE) { throw "staging smoke failed — prod not touched" }
  }

  Write-Host "== prod =="
  clasp update-deployment $dep.prod.id -V $n -d "prod v$Version"
  if ($LASTEXITCODE) { throw "prod deploy failed" }
  & "$root\tools\smoke.ps1" -Url $dep.prod.url -ExpectV $Version
  if ($LASTEXITCODE) { throw "PROD SMOKE FAILED — investigate immediately" }

  # Tell every subscribed device a new build is out. AFTER the smoke: a push
  # advertising a version that failed its own health check would be worse than
  # no push at all. Never fatal — a release is not broken by a quiet phone.
  if (-not $NoAnnounce) {
    $probe = "$root\tools\probe\probe.exe"
    if (Test-Path $probe) {
      # /exec caches CODE separately from the app HTML: ping can already report
      # the new version while a brand-new admin op still 404s. Retry rather than
      # give up on the first miss.
      $sent = $false
      for ($i = 1; $i -le 4 -and -not $sent; $i++) {
        $out = & $probe admin $dep.prod.url $AnnounceEmail $AnnounceCode "{`"op`":`"pushAppUpdate`",`"version`":`"$Version`"}" 2>&1 | Out-String
        if ($out -match '"queued"') { $sent = $true; break }
        Start-Sleep -Seconds 8
      }
      if ($sent) { Write-Host "announced v$Version to subscribed devices" }
      else { Write-Host "note: update announcement did not send (not fatal)" }
    }
  }
} finally { Pop-Location }

$line = "{0}  v{1}  version {2}  prod {3}  OK" -f (Get-Date -Format 'yyyy-MM-dd HH:mm'), $Version, $n, $dep.prod.id
Add-Content "$root\docs\runbooks\DEPLOY-LOG.md" $line
Write-Host "`ndeployed v$Version to the SAME urls (staging + prod). Logged."
# without this the script inherits the exit code of the last native command,
# so a successful release could still report failure to whatever called it
exit 0

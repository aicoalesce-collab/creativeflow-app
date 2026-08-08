# The ONLY sanctioned way to ship server code.
#
# Hard rule: `clasp deploy` is NEVER run without -i <deploymentId>. A bare
# deploy mints a NEW /exec URL and every client on earth points at a corpse —
# that happened once and cost the studio a day.
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [switch]$SkipTests,
  [switch]$ProdOnly
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
} finally { Pop-Location }

$line = "{0}  v{1}  version {2}  prod {3}  OK" -f (Get-Date -Format 'yyyy-MM-dd HH:mm'), $Version, $n, $dep.prod.id
Add-Content "$root\docs\runbooks\DEPLOY-LOG.md" $line
Write-Host "`ndeployed v$Version to the SAME urls (staging + prod). Logged."

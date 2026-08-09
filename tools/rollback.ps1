# Puts the studio back on an earlier release, in one command.
#
# Code only. The sheet, the roster, campaigns, uploads, push subscriptions and
# share links are untouched - this moves the client and the server, nothing else.
#
#   tools\rollback.ps1 -To v5.6.0-before-redesign
#   tools\rollback.ps1 -To v5.6.0-before-redesign -WhatIf
#
# See docs\ROLLBACK.md for the restore points.
param(
  [Parameter(Mandatory = $true)][string]$To,
  [switch]$WhatIf,
  [switch]$SkipPages
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$dep = Get-Content "$root\deployments.json" -Raw | ConvertFrom-Json

# The tag must exist, or we would happily "roll back" to nothing.
$sha = (git -C $root rev-parse --verify "$To^{commit}" 2>$null)
if (-not $sha) { throw "No such tag or commit: $To  (git tag --list to see them)" }

# The Apps Script version to restore is read from the tag's own deploy log, so a
# rollback cannot point the server at a version that never held that code.
$logLine = git -C $root show "${To}:docs/runbooks/DEPLOY-LOG.md" 2>$null |
  Where-Object { $_ -match '\s+version\s+(\d+)\s+' } | Select-Object -Last 1
if (-not $logLine) { throw "Could not read a deployed version out of $To's DEPLOY-LOG.md" }
$version = [regex]::Match($logLine, '\s+version\s+(\d+)\s+').Groups[1].Value
$appVer = [regex]::Match($logLine, '\sv([\d.]+)\s').Groups[1].Value

Write-Host "== rollback plan =="
Write-Host "  to tag        : $To  ($($sha.Substring(0,8)))"
Write-Host "  client version: $appVer"
Write-Host "  script version: $version  -> prod $($dep.prod.id)"
Write-Host "  pages         : $(if ($SkipPages) { 'skipped' } else { 'republished from that tag' })"
if ($WhatIf) { Write-Host "`n-WhatIf: nothing changed."; exit 0 }

$dirty = git -C $root status --porcelain
if ($dirty) { throw "Working tree is dirty - commit or stash first, or the rollback will mix code." }
$was = (git -C $root rev-parse --abbrev-ref HEAD)

Write-Host "`n== building $To =="
git -C $root checkout --quiet $To
try {
  & "$root\scripts\build-app.ps1"
  if ($LASTEXITCODE) { throw "build failed" }

  Write-Host "== server =="
  Push-Location $root
  try {
    clasp push -f
    if ($LASTEXITCODE) { throw "clasp push failed" }
    clasp update-deployment $dep.prod.id -V $version -d "ROLLBACK to $To"
    if ($LASTEXITCODE) { throw "prod redeploy failed" }
    clasp update-deployment $dep.staging.id -V $version -d "ROLLBACK to $To"
  } finally { Pop-Location }

  if (-not $SkipPages) {
    Write-Host "== site =="
    node "$root\scripts\publish-web.mjs"
    if ($LASTEXITCODE) { throw "publish failed" }
  }

  Write-Host "== smoke =="
  & "$root\tools\smoke.ps1" -Url $dep.prod.url -ExpectV $appVer
  if ($LASTEXITCODE) { throw "PROD SMOKE FAILED after rollback - investigate immediately" }
} finally {
  # Always come back to the branch, even if something above threw, so the repo
  # is never left sitting on a detached HEAD after a stressful moment.
  git -C $root checkout --quiet $was
}

$line = "{0}  ROLLBACK to {1}  (v{2}, version {3})" -f (Get-Date -Format 'yyyy-MM-dd HH:mm'), $To, $appVer, $version
Add-Content "$root\docs\runbooks\DEPLOY-LOG.md" $line
Write-Host "`nrolled back to $To. The sheet and everything in it is untouched."
exit 0

# Post-deploy smoke check. Uses probe.exe (a Go HTTP client) because
# fetch-style tools lie about Apps Script /exec responses.
param(
  [Parameter(Mandatory = $true)][string]$Url,
  [string]$ExpectV = '',
  [string]$TestEmail = 'testbot@example.com',
  [string]$TestCode = 'TB6363'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$probe = "$root\tools\probe\probe.exe"
if (-not (Test-Path $probe)) {
  Push-Location "$root\tools\probe"
  try { $env:PATH += ";C:\Program Files\Go\bin"; go build -o probe.exe . } finally { Pop-Location }
}

Write-Host "-- smoke $Url"
$pingArgs = @('ping', $Url)
if ($ExpectV) { $pingArgs += @('-expect-app', $ExpectV) }

# Apps Script keeps serving the previous version for a few seconds after
# update-deployment. Without a retry that shows up as "PROD SMOKE FAILED —
# investigate immediately" on a perfectly good release, which is exactly the
# kind of false alarm that gets a real one ignored later.
# Observed lag: staging flips within seconds, prod has taken over a minute.
# 10 x 12s gives it two minutes before crying wolf.
$attempt = 0
$maxTries = 10
while ($true) {
  $attempt++
  & $probe @pingArgs
  if (-not $LASTEXITCODE) { break }
  if ($attempt -ge $maxTries) { Write-Host "FAIL  version never caught up after $attempt attempts"; exit 1 }
  Write-Host "      not serving $ExpectV yet - retrying ($attempt/$maxTries)"
  Start-Sleep -Seconds 12
}

# Test Bot can log in but can never receive mail (@example.com guard), and
# nothing it triggers emails a real person (actor guard in flushMailQueue_).
& $probe login $Url $TestEmail $TestCode
if ($LASTEXITCODE) { exit 1 }

# Expected to FAIL: Test Bot is a Member, so admin ops must be refused. If this
# ever succeeds, a non-admin just got admin rights — that is the alarm.
try { & $probe admin $Url $TestEmail $TestCode '{"op":"report"}' 2>&1 | Out-Null } catch {}
if ($LASTEXITCODE -eq 0) { Write-Host "FAIL  a Member was allowed to run admin ops"; exit 1 }
Write-Host "ok    admin ops correctly refused to a non-admin"

Write-Host "smoke PASSED for $Url"
exit 0   # without this the script inherits the deliberately-failing probe above

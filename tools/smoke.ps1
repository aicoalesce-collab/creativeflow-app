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
& $probe @pingArgs
if ($LASTEXITCODE) { exit 1 }

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

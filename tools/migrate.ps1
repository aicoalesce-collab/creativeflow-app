# One command migrates the OLD sheet into the new one.
#
# The work is paginated server-side (<=500 rows per call) so the 6-minute
# Apps Script execution ceiling can never kill it; this script just drives
# migrateStep until it reports done, then prints the validation report.
# The old sheet is opened READ-ONLY and is never written to.
param(
  [Parameter(Mandatory = $true)][string]$OldSheet,   # url or id
  [string]$Target = 'prod',
  [string]$Email,
  [string]$Code,
  [switch]$DryRun,
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$dep = Get-Content "$root\deployments.json" -Raw | ConvertFrom-Json
$url = if ($Target -eq 'staging') { $dep.staging.url } else { $dep.prod.url }
if (-not $url) { throw "no $Target url in deployments.json" }
if (-not $Email -or -not $Code) { throw "pass -Email and -Code for a Super Admin" }
$probe = "$root\tools\probe\probe.exe"

function AdminOp($json) {
  $out = & $probe admin $url $Email $Code $json
  $out | Write-Host
  return $out
}

Write-Host "== preflight (no writes) =="
AdminOp ('{"op":"migratePreflight","src":"' + $OldSheet + '"}') | Out-Null
if ($DryRun) { Write-Host "`ndry run only — nothing was imported."; return }

Write-Host "`n== migrating (paginated) =="
$step = 0
do {
  $step++
  if ($step -gt 200) { throw "migration did not finish in 200 steps — investigate" }
  $body = '{"op":"migrateStep","src":"' + $OldSheet + '","confirm":"MIGRATE"' + $(if ($Force) { ',"force":1' } else { '' }) + '}'
  $out = & $probe admin $url $Email $Code $body | Out-String
  Write-Host ("  step {0}: {1}" -f $step, (($out -split "`n" | Where-Object { $_ -match '"(tab|copied|nextTab|done)"' }) -join ' '))
  if ($out -match '"ok":\s*false') { throw "migration step failed:`n$out" }
} while ($out -notmatch '"done":\s*true')

Write-Host "`n== validation report =="
AdminOp ('{"op":"migrateReport","src":"' + $OldSheet + '"}') | Out-Null
Write-Host "`nCheck every counts.*.match is true before going live."

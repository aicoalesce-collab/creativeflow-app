# Git is the source of truth for the Apps Script project. If someone edits the
# code in the Apps Script editor, the next clasp push silently overwrites it —
# so we detect that BEFORE deploying and stop.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$scratch = Join-Path $env:TEMP ("cf5-drift-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $scratch | Out-Null
try {
  Copy-Item "$root\server\.clasp.json" $scratch -ErrorAction SilentlyContinue
  Push-Location $scratch
  try {
    clasp pull 2>&1 | Out-Null
    if ($LASTEXITCODE) { Write-Host "drift-check: clasp pull failed (first deploy? auth?) — continuing"; exit 0 }
  } finally { Pop-Location }

  $diff = git diff --no-index --stat "$root\server" $scratch 2>&1 | Out-String
  # .clasp.json / app.html hash noise is expected; only .js divergence matters
  $realDrift = git diff --no-index --name-only "$root\server" $scratch 2>&1 |
    Where-Object { $_ -match '\.js$' -or $_ -match 'appsscript\.json$' }
  if ($realDrift) {
    Write-Host "DRIFT DETECTED — the live script differs from git in:"
    $realDrift | ForEach-Object { Write-Host "  $_" }
    Write-Host "`nReconcile first (copy the live change into server/ and commit, or accept the overwrite deliberately)."
    exit 1
  }
  Write-Host "drift-check: clean"
  exit 0
} finally {
  Remove-Item $scratch -Recurse -Force -ErrorAction SilentlyContinue
}

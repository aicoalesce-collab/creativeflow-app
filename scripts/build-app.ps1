# Builds the client ONCE and distributes the same artifact to all three
# channels: the hosted PWA (web/dist), the Apps Script ?page=app fallback
# (server/app.html) and the exe's embedded copy (exe/app/index.html).
# One artifact, three channels — they can never drift.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

# a stale name in the window exposure list silently kills every click handler
# a BOM-less .ps1 with an em-dash in it stops parsing on PowerShell 5.1
node "$root\scripts\check-encoding.mjs"
if ($LASTEXITCODE) { throw "check-encoding failed" }

# a stale name in the window exposure list silently kills every click handler
node "$root\scripts\check-exports.mjs"
if ($LASTEXITCODE) { throw "check-exports failed" }

Push-Location "$root\web"
try {
  npm run build
  if ($LASTEXITCODE) { throw "vite build failed" }
  npm run build:single
  if ($LASTEXITCODE) { throw "vite single-file build failed" }
} finally { Pop-Location }

$single = "$root\web\dist-single\index.html"
if (-not (Test-Path $single)) { throw "single-file build missing: $single" }

# The sentinels are load-bearing: serveApp_ rewrites them, ping regexes the
# version out of them, and the exe's OTA check reads them. Fail loudly.
$html = Get-Content $single -Raw
foreach ($needle in @("window.CF_INJECTED_API = '';", "window.CF_GUEST_TOKEN = '';", "window.CF_OPEN_TASK = '';")) {
  if ($html -notmatch [regex]::Escape($needle)) { throw "CF-BOOT sentinel missing from the build: $needle" }
}
if ($html -notmatch "window\.APP_VERSION\s*=\s*'[\d.]+'") { throw "APP_VERSION sentinel missing from the build" }

Copy-Item $single "$root\server\app.html" -Force
New-Item -ItemType Directory -Force -Path "$root\exe\app" | Out-Null
Copy-Item $single "$root\exe\app\index.html" -Force

$v = [regex]::Match($html, "window\.APP_VERSION\s*=\s*'([\d.]+)'").Groups[1].Value
Write-Host "client v$v built and distributed (web/dist, server/app.html, exe/app/index.html)"

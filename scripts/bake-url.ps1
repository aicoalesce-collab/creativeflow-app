# Stamps the pinned PROD /exec URL into the client and the exe.
# Run once after the production deployment exists, and never again unless the
# deployment id itself changes (which it must not — see docs/DEPLOY.md).
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$dep = Get-Content "$root\deployments.json" -Raw | ConvertFrom-Json
$url = $dep.prod.url
if (-not $url) { throw "deployments.json has no prod.url yet — create the PROD deployment first" }
if ($url -notmatch '^https://script\.google\.com/macros/s/.+/exec$') { throw "prod.url does not look like an /exec Web app URL: $url" }

# client: a plain global read by config in app.js (index.html CF-BOOT block)
$idx = "$root\web\index.html"
$html = Get-Content $idx -Raw
if ($html -match "window\.CF_DEFAULT_API\s*=") {
  $html = [regex]::Replace($html, "window\.CF_DEFAULT_API\s*=\s*'[^']*';", "window.CF_DEFAULT_API = '$url';")
} else {
  $html = $html -replace "(window\.CF_INJECTED_API = '';)", "`$1`nwindow.CF_DEFAULT_API = '$url';"
}
Set-Content $idx $html -NoNewline -Encoding UTF8

# exe: the baked fallback target of the /api proxy
$cfg = "$root\exe\config.go"
$go = Get-Content $cfg -Raw
$go = [regex]::Replace($go, 'const bakedAPI = "[^"]*"', "const bakedAPI = `"$url`"")
Set-Content $cfg $go -NoNewline -Encoding UTF8

Write-Host "baked $url into web/index.html and exe/config.go — rebuild both artifacts"

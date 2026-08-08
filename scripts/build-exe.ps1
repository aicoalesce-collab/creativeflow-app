# Builds the Windows desktop wrapper natively (no mingw, no cross-compile).
# Prereqs: Go (winget GoLang.Go) and go-winres (go install github.com/tc-hib/go-winres@latest)
param([string]$Version = '5.0.0')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$env:PATH += ";C:\Program Files\Go\bin;$env:USERPROFILE\go\bin"

# always embed the CURRENT client build
& "$root\scripts\build-app.ps1"

Push-Location "$root\exe"
try {
  # icon + version resources → rsrc_windows_amd64.syso (linked automatically)
  go-winres make
  if ($LASTEXITCODE) { throw "go-winres failed" }

  $out = "$root\exe\CreativeFlow-$Version.exe"
  go build -ldflags="-H windowsgui -s -w" -o $out .
  if ($LASTEXITCODE) { throw "go build failed" }

  # test build (console, same code) for the Playwright exe suite
  go build -o "$root\exe\cf5-test.exe" .
  Write-Host "built $out"
} finally { Pop-Location }

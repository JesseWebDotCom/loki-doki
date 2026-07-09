<#
  Dev launcher for Loki Doki: Vite dev server (port 5173) + hot-reloading backend,
  for local editing with instant HMR. This is a thin wrapper around run.ps1 -Dev so
  there's a single supervisor implementation.

  For normal/remote use, prefer run.ps1 (production: builds the UI and serves the whole
  app from one fast process on port 3000). The dev server ships ~18 MB of unbundled
  modules and is slow to load over the LAN.

  Usage:
    powershell -ExecutionPolicy Bypass -File .\run-dev.ps1
#>

param()

& (Join-Path $PSScriptRoot 'run.ps1') -Dev @args
exit $LASTEXITCODE

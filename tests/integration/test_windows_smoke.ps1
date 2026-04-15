# tests/integration/test_windows_smoke.ps1
#
# End-to-end smoke check for the Windows bootstrap flow. Run on a
# Windows 10/11 box (or the ``bootstrap-integration-windows`` CI
# workflow). Pairs with tests/unit/bootstrap/test_windows_paths.py —
# the unit tests cover path resolution, this script covers the full
# install pipeline.
#
# Usage (PowerShell 7+):
#     pwsh -File tests/integration/test_windows_smoke.ps1
#
# Exits 0 if the FastAPI app answers /api/health before the timeout,
# non-zero otherwise.

param(
    [int]$TimeoutMinutes = 20,
    [string]$HealthUrl = "http://127.0.0.1:8000/api/v1/health"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repoRoot

if (-not (Test-Path ".\run.bat")) {
    Write-Error "run.bat not found at $repoRoot\run.bat"
    exit 1
}

Write-Host "Starting run.bat in a detached cmd window..."
$proc = Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/c", "run.bat" `
    -WorkingDirectory $repoRoot `
    -PassThru `
    -WindowStyle Hidden

$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
$ok = $false
while ((Get-Date) -lt $deadline) {
    if ($proc.HasExited) {
        Write-Error "run.bat exited with code $($proc.ExitCode) before the wizard became ready"
        break
    }
    try {
        $resp = Invoke-WebRequest -UseBasicParsing -Uri $HealthUrl -TimeoutSec 5
        if ($resp.StatusCode -eq 200) {
            Write-Host "bootstrap ready at $HealthUrl"
            $ok = $true
            break
        }
    } catch {
        Start-Sleep -Seconds 10
    }
}

if (-not $ok) {
    Write-Error "bootstrap did not answer $HealthUrl within $TimeoutMinutes minutes"
    if (-not $proc.HasExited) { $proc.Kill() }
    if (Test-Path ".\.lokidoki\logs") {
        Write-Host "Log directory contents:"
        Get-ChildItem -Recurse ".\.lokidoki\logs"
    }
    exit 1
}

exit 0

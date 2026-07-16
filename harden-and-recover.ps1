#requires -RunAsAdministrator
<#
  harden-and-recover.ps1  (2026-07-15)

  Brownout hardening + eGPU (3070) recovery in one elevated pass.

  eGPU recovery: the 3070 is at PnP code 47 (eject-hold) but STILL on the PCI bus
  and the enclosure/TB link is alive (Razer Synapse/Chroma reach it). Per this box's
  history a clean reboot reliably re-enumerates it and clears code 47. That is the
  ONLY reliable remote lever short of a physical cable replug -- the software devnode
  cycle does NOT work here (user verdict 2026-07-15), so this script does not attempt it.

  Brownout hardening (only with -DisarmNOS): drop the EC charge limit to 28% to disarm
  MSI Hybrid Power (NOS), removing the battery from the peak-load current path. Everything
  else (PROCTHROTTLEMAX 99, gpu-power-guard, Windows Update gating) is already in place.

  USAGE (in an Admin PowerShell):
     .\harden-and-recover.ps1 -DisarmNOS          # drop to 28% NOS-disarm, then reboot   (recommended)
     .\harden-and-recover.ps1                      # just reboot to recover the eGPU (keep 58%)
     add  -NoReboot                                # apply changes but do NOT reboot
#>
[CmdletBinding()]
param(
    [switch]$DisarmNOS,
    [int]$ChargePercent = 28,
    [switch]$NoReboot
)

$ErrorActionPreference = 'Stop'
function Say($m){ Write-Host "  $m" }

Write-Host "`n=== harden-and-recover ===" -ForegroundColor Cyan

# --- 0. Report current baseline -------------------------------------------------
$cfgPath = 'C:\ProgramData\Sparronator9999\YAMDCC\CurrentConfig.xml'
try {
    $ptm = (powercfg /query SCHEME_CURRENT SUB_PROCESSOR PROCTHROTTLEMAX | Select-String 'Current AC').ToString()
    Say "PROCTHROTTLEMAX (AC): $($ptm.Trim())   (0x63 = 99, no-turbo clamp OK)"
} catch { Say "PROCTHROTTLEMAX read failed: $_" }

if (Test-Path $cfgPath) {
    [xml]$cfg = Get-Content $cfgPath -Raw
    $cur = [int]$cfg.YAMDCC_Config.ChargeLimitConf.CurVal
    Say "Charge limit currently: $cur%  (>=30 => Hybrid Power/NOS armed)"
} else { Say "YAMDCC CurrentConfig.xml NOT FOUND at $cfgPath" }

# --- 1. Disarm NOS (optional) ---------------------------------------------------
if ($DisarmNOS) {
    if ($ChargePercent -ge 30) { throw "ChargePercent must be < 30 to disarm NOS (got $ChargePercent)" }
    if (-not (Test-Path $cfgPath)) { throw "Cannot set charge limit: $cfgPath missing" }

    Write-Host "`n-- Disarming NOS: charge limit -> $ChargePercent% --" -ForegroundColor Yellow
    [xml]$cfg = Get-Content $cfgPath -Raw
    $cfg.YAMDCC_Config.ChargeLimitConf.CurVal = "$ChargePercent"   # YAMDCC CurVal is the PERCENT; svc writes MinVal(128)+CurVal to EC reg 239 (0xEF)
    $cfg.Save($cfgPath)
    Say "Wrote CurVal=$ChargePercent to CurrentConfig.xml (EC 0xEF target = $((128 + $ChargePercent)) )"

    # keep the Downloads editing template in sync if present (cosmetic, so ConfigEditor shows the same)
    Get-ChildItem "$env:USERPROFILE\Downloads\*.xml" -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            [xml]$t = Get-Content $_.FullName -Raw
            if ($t.YAMDCC_Config.ChargeLimitConf) {
                $t.YAMDCC_Config.ChargeLimitConf.CurVal = "$ChargePercent"; $t.Save($_.FullName)
                Say "synced template $($_.Name)"
            }
        } catch {}
    }

    # (re)start the service so it writes the EC register now
    $svc = Get-Service yamdccsvc -ErrorAction SilentlyContinue
    if ($svc) {
        if ($svc.Status -ne 'Running') { Start-Service yamdccsvc } else { Restart-Service yamdccsvc }
        Start-Sleep 3
        Say "yamdccsvc: $((Get-Service yamdccsvc).Status)"
    } else { Say "WARNING: yamdccsvc not installed -- charge limit not enforced by service" }

    # best-effort EC read-back
    $ecInspect = 'C:\Program Files\Sparronator9999\YAMDCC\ec-inspect.exe'
    if (Test-Path $ecInspect) {
        try { $rb = & $ecInspect read 0xEF 2>&1; Say "ec-inspect read 0xEF => $rb  (expect $((128 + $ChargePercent)) = 0x$('{0:X}' -f (128 + $ChargePercent)))" } catch {}
    }
    Say "NOTE: NOS fully disarms only after the pack drains below 30% on battery once."
} else {
    Say "`n(keeping charge limit as-is; run with -DisarmNOS to drop to 28%)"
}

# --- 2. Report guard task -------------------------------------------------------
Write-Host "`n-- gpu-power-guard --" -ForegroundColor Yellow
$t = schtasks /query /tn LokiDoki-GpuPowerGuard 2>&1
if ($LASTEXITCODE -eq 0) { Say "LokiDoki-GpuPowerGuard: present" } else { Say "LokiDoki-GpuPowerGuard: NOT found ($t)" }

# --- 3. Reboot to recover the eGPU ---------------------------------------------
if ($NoReboot) {
    Write-Host "`nDone (no reboot). The 3070 stays at code 47 until you reboot or physically replug." -ForegroundColor Cyan
} else {
    Write-Host "`nRebooting in 15s to re-enumerate the eGPU (Ctrl+C to abort)..." -ForegroundColor Green
    Start-Sleep 15
    shutdown /r /t 0
}

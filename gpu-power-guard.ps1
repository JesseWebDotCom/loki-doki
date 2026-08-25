<#
  gpu-power-guard.ps1 - persistent GPU transient-brownout guard.

  Why this exists: the box hard power-offs under load (Kernel-Power 41, bugcheck 0,
  no WHEA = raw power loss). The desktop RTX 3070 in the Thunderbolt enclosure spikes
  well above its sustained limit for milliseconds (documented Ampere behavior), and a
  plain `nvidia-smi -pl` cap cannot catch those spikes: the power limiter is an
  average controller that reacts slower than the transient (igor'sLAB measured peaks
  ~66% above a deep software cap). What DOES bound the instantaneous draw is locking
  the max graphics clock (`-lgc`): the high-voltage boost bins are never requested, so
  peak power is capped by physics rather than by a lagging control loop. NVENC encode
  is unaffected (separate video-clock domain); LLM inference on an 8 GB card is
  memory-bound, so a modest core-clock ceiling costs little.

  On Windows, -pl and -lgc reset on reboot, on driver restart (TDR), and on every
  Thunderbolt replug of the eGPU. A launch-time cap in run.ps1 is therefore not
  enough (and needs an elevated shell, so in practice it was never active). This
  script is the durable version: installed as a SYSTEM scheduled task it applies the
  limits at boot/logon (retrying until the driver is up), reapplies on device-arrival
  events (eGPU replug), and re-asserts hourly (covers TDR driver resets).

  It also clamps the CPU "maximum processor state" to 99% (no Turbo Boost). This
  laptop's Hybrid Power design pulls from AC + battery together under peak load, and
  a worn battery hard-cuts the machine; killing turbo removes most of that peak.
  Pass -CpuMaxPct 0 to skip the CPU clamp.

  Usage:
    powershell -ExecutionPolicy Bypass -File .\gpu-power-guard.ps1 -Once       # apply now, exit
    powershell -ExecutionPolicy Bypass -File .\gpu-power-guard.ps1            # apply + keep watching
    powershell -ExecutionPolicy Bypass -File .\gpu-power-guard.ps1 -Install   # SYSTEM task (needs elevated shell)
    powershell -ExecutionPolicy Bypass -File .\gpu-power-guard.ps1 -Uninstall

  Log: data\logs\gpu-power-guard.log
#>

param(
  # Sustained power ceiling (W) for each settable NVIDIA GPU. 0 disables.
  [int]$PowerLimit = 150,
  # Graphics clock lock range (MHz). MaxClock is snapped down to the nearest
  # driver-supported bin. 0 disables the clock lock.
  [int]$MaxClock = 1400,
  [int]$MinClock = 210,
  # CPU maximum processor state (%). 99 disables Turbo Boost. 0 skips.
  [int]$CpuMaxPct = 99,
  [switch]$Once,
  [switch]$Install,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Continue'
$Root = $PSScriptRoot
$TaskName = 'MaiPaiHome-GpuPowerGuard'
$LogDir = Join-Path $Root 'data\logs'
$LogFile = Join-Path $LogDir 'gpu-power-guard.log'

function Write-Log([string]$msg) {
  if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
  # Cap the log so it never grows unbounded (this task lives forever).
  if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 1MB) {
    Move-Item -Path $LogFile -Destination "$LogFile.1" -Force -ErrorAction SilentlyContinue
  }
  $line = (Get-Date -Format 's') + '  ' + $msg
  Add-Content -Path $LogFile -Value $line -Encoding utf8
  Write-Host $line
}

# ── Install / uninstall (SYSTEM scheduled task: boot + logon triggers) ─────────
if ($Install) {
  $elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $elevated) {
    Write-Host 'Install needs an elevated shell (the task runs as SYSTEM). Re-run from an Administrator PowerShell.' -ForegroundColor Yellow
    exit 1
  }
  $argLine = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" -PowerLimit $PowerLimit -MaxClock $MaxClock -MinClock $MinClock -CpuMaxPct $CpuMaxPct"
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine
  $triggers = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -AtLogOn))
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers `
    -Principal $principal -Settings $settings `
    -Description 'MaiPai Home GPU transient-brownout guard: power limit + clock lock, reapplied on boot/replug/driver reset' -Force | Out-Null
  Write-Host "Installed SYSTEM task '$TaskName' (boot + logon). Starting it now..."
  Start-ScheduledTask -TaskName $TaskName
  exit 0
}
if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed task '$TaskName'. Limits reset at next reboot (or run: nvidia-smi -rgc; nvidia-smi -pl <default>)."
  exit 0
}

# ── nvidia-smi resolution ──────────────────────────────────────────────────────
function Find-NvidiaSmi {
  $cmd = Get-Command nvidia-smi -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $guess = Join-Path $env:SystemRoot 'System32\nvidia-smi.exe'
  if (Test-Path $guess) { return $guess }
  return $null
}

# ── CPU clamp (persists per power scheme, but MSI Center scheme switches and OS
#    updates can undo it, so it is re-asserted on the same cadence as the GPU caps) ──
function Set-CpuClamp {
  if ($CpuMaxPct -le 0) { return }
  try {
    powercfg /setacvalueindex scheme_current sub_processor PROCTHROTTLEMAX $CpuMaxPct | Out-Null
    powercfg /setdcvalueindex scheme_current sub_processor PROCTHROTTLEMAX $CpuMaxPct | Out-Null
    powercfg /setactive scheme_current | Out-Null
  } catch { Write-Log "cpu clamp failed: $($_.Exception.Message)" }
}

# ── GPU limits ─────────────────────────────────────────────────────────────────
# Applies -pl and -lgc to every settable NVIDIA GPU (cards whose power limit reads
# [N/A], like the internal Max-Q, are locked by the vendor and skipped). Returns
# $true when at least one GPU was configured.
function Apply-GpuLimits {
  $smi = Find-NvidiaSmi
  if (-not $smi) { return $false }
  $applied = $false
  try {
    $rows = & $smi --query-gpu=index,name,power.limit,power.min_limit,power.max_limit --format=csv,noheader,nounits 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $rows) { return $false }
    foreach ($r in $rows) {
      $f = $r -split ',' | ForEach-Object { $_.Trim() }
      if ($f.Count -lt 5) { continue }
      $idx = [int]$f[0]; $name = $f[1]
      if ($f[2] -match 'N/A') { continue }   # vendor-locked limit (Max-Q): not the transient source
      $ok = $true

      if ($PowerLimit -gt 0) {
        $min = [double]$f[3]; $max = [double]$f[4]
        $target = [int][math]::Max($min, [math]::Min($PowerLimit, $max))
        if ($target -lt $max) {
          & $smi -i $idx -pl $target | Out-Null
          if ($LASTEXITCODE -ne 0) { $ok = $false }
        }
      }

      if ($MaxClock -gt 0) {
        # Snap to the nearest supported clock bin at or below MaxClock; drivers can
        # reject arbitrary values. Fall back to the raw value if the query fails.
        $lock = $MaxClock
        $supported = & $smi -i $idx --query-supported-clocks=graphics --format=csv,noheader,nounits 2>$null
        if ($LASTEXITCODE -eq 0 -and $supported) {
          $valid = @($supported | ForEach-Object { "$_".Trim() } | Where-Object { $_ -match '^\d+$' } |
                     ForEach-Object { [int]$_ } | Where-Object { $_ -le $MaxClock })
          if ($valid.Count -gt 0) { $lock = ($valid | Measure-Object -Maximum).Maximum }
        }
        & $smi -i $idx -lgc "$MinClock,$lock" | Out-Null
        if ($LASTEXITCODE -ne 0) { $ok = $false }
      }

      if ($ok) {
        $applied = $true
        Write-Log "GPU $idx ($name): power limit $PowerLimit W, graphics clock locked $MinClock-$MaxClock MHz"
      } else {
        Write-Log "GPU $idx ($name): could not apply limits (exit $LASTEXITCODE)"
      }
    }
  } catch { Write-Log "apply failed: $($_.Exception.Message)" }
  return $applied
}

# ── Main ───────────────────────────────────────────────────────────────────────
Set-CpuClamp

if ($Once) {
  $ok = Apply-GpuLimits
  if (-not $ok) { Write-Log 'no GPU limits applied (eGPU detached, driver not ready, or shell not elevated)' }
  exit 0
}

# Boot path: the NVIDIA driver (and the Thunderbolt GPU especially) may not be
# enumerated yet when the task fires. Retry until something applies, then settle
# into the event loop.
$tries = 0
while (-not (Apply-GpuLimits)) {
  $tries++
  if ($tries -ge 30) { Write-Log 'giving up initial apply after 30 tries; watching for device arrival'; break }
  Start-Sleep -Seconds 10
}

# Watch loop: reapply on device arrival (eGPU replug re-initializes the card with
# defaults) and re-assert hourly (covers TDR driver resets, which fire no
# device-arrival event, and MSI Center power-scheme switches for the CPU clamp).
Register-WmiEvent -Query "SELECT * FROM Win32_DeviceChangeEvent WHERE EventType = 2" -SourceIdentifier LokiGpuArrival | Out-Null
Write-Log 'guard running: reapplying on device arrival + hourly re-assert'
while ($true) {
  $e = Wait-Event -SourceIdentifier LokiGpuArrival -Timeout 3600
  if ($e) {
    Remove-Event -EventIdentifier $e.EventIdentifier -ErrorAction SilentlyContinue
    # Drain the burst (one replug fires several change events), then let the device settle.
    Get-Event -SourceIdentifier LokiGpuArrival -ErrorAction SilentlyContinue | Remove-Event -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 5
    if (Apply-GpuLimits) { Write-Log 'reapplied after device arrival' }
  } else {
    Set-CpuClamp
    Apply-GpuLimits | Out-Null
  }
}

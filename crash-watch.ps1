<#
  crash-watch.ps1 — lightweight system telemetry sampler for diagnosing the
  recurring unexpected shutdowns (see: no WHEA / no thermal / no bugcheck, i.e.
  the machine dies without leaving a trail). This fills that gap by writing one
  CSV row every few seconds and FLUSHING EACH ROW TO DISK, so after the next hard
  power-off the last line tells us exactly what temp / load / GPU / battery state
  the machine was in the instant before it died.

  Usage:
    powershell -ExecutionPolicy Bypass -File .\crash-watch.ps1            # sample every 10s
    powershell -ExecutionPolicy Bypass -File .\crash-watch.ps1 -Interval 5
    powershell -ExecutionPolicy Bypass -File .\crash-watch.ps1 -Install   # auto-start at logon
    powershell -ExecutionPolicy Bypass -File .\crash-watch.ps1 -Uninstall # remove auto-start

  Log:  data\logs\system-telemetry.csv   (rotated at ~20 MB -> .1.csv)
  To read the run-up to a crash: open the CSV, find the gap in timestamps (the
  reboot), and read the rows just before it.
#>

param(
  [int]$Interval = 3,
  [switch]$Install,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Continue'
$Root = $PSScriptRoot
$TaskName = 'LokiDoki-CrashWatch'

# ── Auto-start install / uninstall (logon scheduled task, current user) ────────
if ($Install) {
  $action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Description 'Loki Doki system telemetry sampler' -Force | Out-Null
  Write-Host "Installed logon task '$TaskName'. It will sample telemetry on every login."
  Write-Host "Starting it now..."
  Start-ScheduledTask -TaskName $TaskName
  exit 0
}
if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed logon task '$TaskName'."
  exit 0
}

# ── Log file setup ─────────────────────────────────────────────────────────────
$LogDir = Join-Path $Root 'data\logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$LogFile = Join-Path $LogDir 'system-telemetry.csv'
$MaxBytes = 20MB

# Per-GPU columns (g0=first card, g1=second) so we can see WHICH card spiked, plus the
# battery electricals (voltage + charge/discharge rate) that reveal a power brownout: a
# voltage sag or a sudden discharge spike while on AC = the adapter couldn't cover a load
# transient and the battery got pulled down. That is the signature we're hunting.
$Header = 'timestamp,uptime_min,cpu_pct,ram_used_pct,ram_used_mb,cpu_temp_c,' +
          'g0_temp_c,g0_util_pct,g0_power_w,g0_mem_mb,g1_temp_c,g1_util_pct,g1_power_w,g1_mem_mb,' +
          'battery_pct,battery_mv,charge_rate_mw,discharge_rate_mw,ac_online,top_proc'

function Ensure-Header {
  if (-not (Test-Path $LogFile) -or (Get-Item $LogFile).Length -eq 0) {
    Add-Content -Path $LogFile -Value $Header -Encoding utf8
  }
}

function Rotate-IfBig {
  if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt $MaxBytes) {
    $bak = Join-Path $LogDir 'system-telemetry.1.csv'
    Move-Item -Path $LogFile -Destination $bak -Force -ErrorAction SilentlyContinue
  }
}

# ── nvidia-smi detection (GPU telemetry is the most likely smoking gun) ────────
$NvidiaSmi = $null
$cmd = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($cmd) { $NvidiaSmi = $cmd.Source }
else {
  $guess = Join-Path $env:SystemRoot 'System32\nvidia-smi.exe'
  if (Test-Path $guess) { $NvidiaSmi = $guess }
}

# Returns a flat 8-element array: [g0_temp,g0_util,g0_pw,g0_mem, g1_temp,g1_util,g1_pw,g1_mem].
# Queries per-index so a two-GPU box (e.g. laptop Max-Q + desktop card) shows each card's
# own power draw — the aggregate would hide which one spiked into the brownout.
function Get-GpuSample {
  $blank = @('','','','','','','','')
  if (-not $NvidiaSmi) { return $blank }
  try {
    $rows = & $NvidiaSmi --query-gpu=index,temperature.gpu,utilization.gpu,power.draw,memory.used `
      --format=csv,noheader,nounits 2>$null
    $byIdx = @{}
    foreach ($r in $rows) {
      $f = $r -split ',' | ForEach-Object { $_.Trim() }
      if ($f.Count -ge 5) { $byIdx[[int]$f[0]] = @($f[1], $f[2], $f[3], $f[4]) }
    }
    $g0 = if ($byIdx.ContainsKey(0)) { $byIdx[0] } else { @('','','','') }
    $g1 = if ($byIdx.ContainsKey(1)) { $byIdx[1] } else { @('','','','') }
    return @($g0 + $g1)
  } catch { }
  return $blank
}

# Battery electricals via ACPI: voltage (mV) and charge/discharge rate (mW). A sag in
# voltage or a nonzero discharge_rate while on AC is the power-brownout fingerprint.
function Get-BatteryElectrical {
  try {
    $s = Get-CimInstance -Namespace root\wmi -ClassName BatteryStatus -ErrorAction Stop | Select-Object -First 1
    if ($s) { return @($s.Voltage, $s.ChargeRate, $s.DischargeRate) }
  } catch { }
  return @('','','')
}

# CPU temperature via ACPI thermal zone (often unsupported on laptops -> blank).
function Get-CpuTempC {
  try {
    $z = Get-CimInstance -Namespace 'root/wmi' -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop |
         Select-Object -First 1
    if ($z) { return [math]::Round(($z.CurrentTemperature / 10) - 273.15, 1) }
  } catch { }
  return ''
}

# ── Sample loop ────────────────────────────────────────────────────────────────
Ensure-Header
Add-Content -Path $LogFile -Value ("# watcher started " + (Get-Date -Format 's') + " interval=${Interval}s gpu=" + [bool]$NvidiaSmi) -Encoding utf8
Write-Host "crash-watch running (every ${Interval}s) -> $LogFile"
Write-Host "GPU telemetry: $([bool]$NvidiaSmi)$(if($NvidiaSmi){" ($NvidiaSmi)"})   Press Ctrl+C to stop."

$os = Get-CimInstance Win32_OperatingSystem
$bootTime = $os.LastBootUpTime

while ($true) {
  try {
    $now = Get-Date
    $ts = $now.ToString('s')
    $uptimeMin = [math]::Round(($now - $bootTime).TotalMinutes, 1)

    $osNow = Get-CimInstance Win32_OperatingSystem
    $totalMb = [math]::Round($osNow.TotalVisibleMemorySize / 1KB)
    $freeMb  = [math]::Round($osNow.FreePhysicalMemory / 1KB)
    $usedMb  = $totalMb - $freeMb
    $ramPct  = if ($totalMb) { [math]::Round($usedMb / $totalMb * 100, 1) } else { '' }

    $cpuPct = ''
    try { $cpuPct = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average } catch { }

    $cpuTemp = Get-CpuTempC
    $gpu = Get-GpuSample          # g0_temp,g0_util,g0_pw,g0_mem, g1_temp,g1_util,g1_pw,g1_mem
    $batE = Get-BatteryElectrical # voltage_mV, charge_rate_mW, discharge_rate_mW

    $batPct = ''; $ac = ''
    try {
      $b = Get-CimInstance Win32_Battery -ErrorAction Stop | Select-Object -First 1
      if ($b) {
        $batPct = $b.EstimatedChargeRemaining
        # BatteryStatus 2 = on AC (not discharging).
        $ac = if ($b.BatteryStatus -eq 2) { 1 } else { 0 }
      }
    } catch { }

    $top = ''
    try {
      $tp = Get-Process | Sort-Object CPU -Descending | Select-Object -First 1
      if ($tp) { $top = $tp.ProcessName }
    } catch { }

    $row = @($ts, $uptimeMin, $cpuPct, $ramPct, $usedMb, $cpuTemp,
             $gpu[0], $gpu[1], $gpu[2], $gpu[3], $gpu[4], $gpu[5], $gpu[6], $gpu[7],
             $batPct, $batE[0], $batE[1], $batE[2], $ac, $top) -join ','
    Rotate-IfBig
    Ensure-Header
    # Add-Content opens/writes/closes each call -> the row is flushed to disk
    # immediately, surviving a hard power-off.
    Add-Content -Path $LogFile -Value $row -Encoding utf8
  } catch {
    try { Add-Content -Path $LogFile -Value ("# sample error: " + $_.Exception.Message) -Encoding utf8 } catch { }
  }
  Start-Sleep -Seconds $Interval
}

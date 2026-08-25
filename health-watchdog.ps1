<#
  health-watchdog.ps1 — outer self-healer for the MaiPai Home app.

  run.ps1 already supervises the backend, but it has deliberate give-up paths
  (crash-loop cap, "port 3000 would not clear") and it dies with its console
  window. When any of those happen the app stays down until a human notices —
  production was down 12:10→15:45 on 7/29 exactly that way. This watchdog is
  the layer above: it probes /api/health and relaunches run.ps1 when the app
  is genuinely gone.

  Usage:
    powershell -ExecutionPolicy Bypass -File .\health-watchdog.ps1             # run in foreground
    powershell -ExecutionPolicy Bypass -File .\health-watchdog.ps1 -Install   # auto-start at logon
    powershell -ExecutionPolicy Bypass -File .\health-watchdog.ps1 -Uninstall # remove auto-start

  To take the app down ON PURPOSE and keep it down (maintenance), create the
  file data\watchdog-off (contents irrelevant) — the watchdog idles while it
  exists. Delete it to resume healing. Note the admin panel's "Shut down
  server" alone is NOT honored as permanent: the watchdog will resurrect the
  app within ~2 minutes unless watchdog-off is present.

  Log: data\logs\watchdog.log
#>

param(
  # Seconds between health probes.
  [int]$Interval = 30,
  # Consecutive failed probes before the app counts as down (3 × 30s ≈ 90s of grace,
  # enough to ride out an admin restart, which is down for a few seconds only).
  [int]$FailThreshold = 3,
  [switch]$Install,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Continue'
$Root = $PSScriptRoot
$TaskName = 'MaiPaiHome-Watchdog'
$HealthUrl = 'http://localhost:3000/api/health'
$OffFile = Join-Path $Root 'data\watchdog-off'
$LogFile = Join-Path $Root 'data\logs\watchdog.log'
# Relaunch budget: after this many recoveries inside one hour, stop trying until the
# window slides — a boot-crash (bad deploy) would otherwise thrash forever.
$MaxRestartsPerHour = 4

# ── Auto-start install / uninstall (logon scheduled task, current user) ────────
if ($Install) {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)   # no 72h default kill
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Description 'MaiPai Home health watchdog (auto-restarts the app)' -Force | Out-Null
  Write-Host "Installed logon task '$TaskName'. Starting it now..."
  Start-ScheduledTask -TaskName $TaskName
  exit 0
}
if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed logon task '$TaskName'."
  exit 0
}

# ── Helpers ────────────────────────────────────────────────────────────────────
function Write-Log([string]$msg) {
  $dir = Split-Path $LogFile
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
  if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 5MB) {
    Move-Item $LogFile "$LogFile.1" -Force -ErrorAction SilentlyContinue
  }
  Add-Content -Path $LogFile -Value ("[" + (Get-Date -Format 's') + "] " + $msg) -Encoding utf8
}

function Test-Healthy {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri $HealthUrl -TimeoutSec 5
    return $r.StatusCode -eq 200
  } catch { return $false }
}

# A run.ps1 launcher that started recently is (re)booting or rebuilding the app —
# leave it alone. A launcher older than the grace with the app still down is wedged
# or has given up supervising; run.ps1's own Stop-Existing displaces it safely.
function Get-YoungLauncherAgeMin {
  try {
    $procs = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
      Where-Object { $_.CommandLine -match 'run\.ps1' -and $_.ProcessId -ne $PID }
    $ages = foreach ($p in $procs) { ((Get-Date) - $p.ConvertToDateTime($p.CreationDate)).TotalMinutes }
    $young = $ages | Where-Object { $_ -lt 10 } | Sort-Object | Select-Object -First 1
    if ($null -ne $young) { return [math]::Round($young, 1) }
  } catch { }
  return $null
}

# A port-3000 socket whose owning PID no longer exists is a listen handle some backend
# child inherited before the backend died (observed 7/29: a wedged yt-dlp). run.ps1's
# launch sweep kills the usual suspects, but clear it here too so the relaunch can't
# die on 'Port 3000 would not clear'.
function Clear-ZombiePort {
  try {
    $conns = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue
    if (-not $conns) { return }
    foreach ($ownerPid in ($conns | Select-Object -ExpandProperty OwningProcess -Unique)) {
      if (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue) { return }  # live owner: run.ps1's job
    }
    $binDir = Join-Path $Root 'data\bin'
    $orphans = Get-CimInstance Win32_Process | Where-Object {
      $_.ExecutablePath -and $_.ExecutablePath.StartsWith($binDir, 'OrdinalIgnoreCase') -and $_.Name -ne 'ollama.exe'
    }
    foreach ($o in $orphans) {
      Write-Log "killing orphaned backend child holding port 3000 hostage: $($o.Name) (pid $($o.ProcessId))"
      Stop-Process -Id $o.ProcessId -Force -Confirm:$false -ErrorAction SilentlyContinue
    }
  } catch { }
}

function Start-App {
  Clear-ZombiePort
  Write-Log 'relaunching run.ps1 (hidden, -NoBrowser)'
  Start-Process powershell -WindowStyle Hidden -WorkingDirectory $Root `
    -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $Root 'run.ps1'), '-NoBrowser'
}

# ── Watch loop ─────────────────────────────────────────────────────────────────
Write-Log "watchdog started (interval=${Interval}s, threshold=$FailThreshold, budget=$MaxRestartsPerHour/h)"
$failures = 0
$restarts = @()   # timestamps of recent relaunches (sliding 1h window)
$pausedLogged = $false

while ($true) {
  Start-Sleep -Seconds $Interval

  if (Test-Path $OffFile) {
    if (-not $pausedLogged) { Write-Log 'data\watchdog-off present - pausing (delete it to resume)'; $pausedLogged = $true }
    $failures = 0
    continue
  }
  if ($pausedLogged) { Write-Log 'watchdog-off removed - resuming'; $pausedLogged = $false }

  if (Test-Healthy) {
    if ($failures -ge $FailThreshold) { Write-Log 'app is healthy again' }
    $failures = 0
    continue
  }

  $failures++
  if ($failures -lt $FailThreshold) { continue }
  if ($failures -eq $FailThreshold) { Write-Log "health check failed $failures times (~$($failures * $Interval)s down)" }

  $launcherAge = Get-YoungLauncherAgeMin
  if ($null -ne $launcherAge) {
    Write-Log "a launcher started $launcherAge min ago - assuming boot/rebuild in progress, waiting"
    continue
  }

  $restarts = @($restarts | Where-Object { ((Get-Date) - $_).TotalMinutes -lt 60 })
  if ($restarts.Count -ge $MaxRestartsPerHour) {
    Write-Log "restart budget exhausted ($MaxRestartsPerHour/h) - app is crash-looping, check data\logs\app.log. Backing off."
    continue
  }

  $restarts += Get-Date
  Start-App
  # Give the launch a full boot's worth of quiet before probing counts again
  # (a stale frontend bundle rebuild can take a couple of minutes).
  Start-Sleep -Seconds 90
  $failures = 0
}

<#
  Windows launcher for Loki Doki, the PowerShell counterpart to run.sh.

  Usage:
    powershell -ExecutionPolicy Bypass -File .\run.ps1            # production (default)
    powershell -ExecutionPolicy Bypass -File .\run.ps1 -Dev       # dev servers + HMR
    powershell -ExecutionPolicy Bypass -File .\run.ps1 -Uninstall

  Two modes:
    • Production (default): builds the frontend bundle (only when stale) and serves
      the whole app — API + bundled UI — from ONE backend process on port 3000. The
      bundle is a fraction of dev's ~18 MB of unbundled modules, so remote/LAN loads
      are fast. No live reload; rebuild happens on the next launch.
    • Dev (-Dev, or run-dev.ps1): Vite dev server on 5173 + hot-reloading backend,
      for local editing with instant HMR. Heavy to load over the LAN.

  Loki Doki runs on the Bun runtime. This installs Bun automatically on first run
  so a fresh machine needs nothing but this script and Ollama (which you install
  once from https://ollama.com/download; the app auto-detects it). Ollama and the
  AI models download on first launch from the setup wizard.
#>

param(
  [switch]$Dev,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot

# Ports every app + sidecar listens on: vite, backend, ComfyUI, voice, kiwix,
# GraphHopper (+admin), pod gateway.
$Ports = @(5173, 3000, 8188, 8092, 8091, 8090, 8002, 8003, 10700)

# Full-command-line signatures for detached sidecars that outlive the servers.
$SidecarPatterns = @(
  'bun run --hot src/index.ts',                 # backend (dev)
  'bun run src/index.ts',                        # backend (production)
  'bun run start',                               # backend (production wrapper)
  "$Root\frontend\node_modules",                # frontend (vite)
  "$Root\data\comfyui",                         # ComfyUI (python)
  'bun run dev'                                 # leftover dev wrappers
)

# ── Bun bootstrap ─────────────────────────────────────────────────────────────
function Ensure-Bun {
  if (Get-Command bun -ErrorAction SilentlyContinue) { return }
  # Bun may already be installed at its default location but missing from this
  # session's PATH: its installer only updates the *user* PATH, which existing
  # terminals don't pick up. Add it and skip the (re)install if so, otherwise
  # every run from such a shell re-triggers the installer, which then errors
  # with "An older installation exists and is open".
  $bunBin = Join-Path $env:USERPROFILE '.bun\bin'
  if (Test-Path (Join-Path $bunBin 'bun.exe')) {
    $env:Path = "$bunBin;$env:Path"
    if (Get-Command bun -ErrorAction SilentlyContinue) { return }
  }
  Write-Host 'Bun runtime not found, installing it...'
  Invoke-RestMethod https://bun.sh/install.ps1 | Invoke-Expression
  if (Test-Path $bunBin) { $env:Path = "$bunBin;$env:Path" }
  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    throw 'Bun install did not add bun to PATH. Open a new terminal and re-run, or install Bun manually from https://bun.sh.'
  }
}

# ── Dependency bootstrap ──────────────────────────────────────────────────────
# Install/refresh a workspace's dependencies when node_modules is missing OR the
# lockfile/package.json has changed since the last successful install (e.g. a
# `git pull` added a dependency). Gating only on "node_modules exists" is not
# enough: after pulling a commit that adds a package, the stale node_modules is
# missing it and the app fails at runtime with no obvious cause (observed: Vite
# could not resolve `hls.js` after it was added to package.json but the machine's
# node_modules predated it). A successful install stamps a marker we compare write
# times against; `bun install` is a fast no-op when everything is already satisfied.
function Ensure-Deps([string]$Dir) {
  if (-not (Test-Path (Join-Path $Dir 'package.json'))) { return }
  $stamp = Join-Path $Dir 'node_modules\.loki-install-stamp'
  $needs = $false
  if (-not (Test-Path (Join-Path $Dir 'node_modules'))) { $needs = $true }
  elseif (-not (Test-Path $stamp)) { $needs = $true }
  else {
    $stampTime = (Get-Item $stamp).LastWriteTimeUtc
    foreach ($f in @('bun.lock', 'package.json')) {
      $p = Join-Path $Dir $f
      if ((Test-Path $p) -and (Get-Item $p).LastWriteTimeUtc -gt $stampTime) { $needs = $true }
    }
  }
  if ($needs) {
    Write-Host "Installing/refreshing dependencies in $(Split-Path $Dir -Leaf)..."
    Push-Location $Dir
    bun install
    $ok = ($LASTEXITCODE -eq 0)
    Pop-Location
    if ($ok) { New-Item -ItemType File -Path $stamp -Force | Out-Null }
  }
}

# ── Production frontend build ──────────────────────────────────────────────────
# Build the frontend bundle into frontend/dist, but only when it's missing or stale,
# so a production `run` serves an up-to-date bundle without paying the (~1 min) build
# on every launch. Staleness uses the same "stamp vs inputs" idea as Ensure-Deps: a
# rebuild is needed when any source under src/ (or a build-config file) is newer than
# the last successful build's stamp. `bun run build` runs `tsc -b && vite build` and
# its prebuild hook (asset copies), so we always go through it rather than calling vite
# directly. A failed build aborts the launch rather than serving a stale/broken bundle.
function Ensure-FrontendBuild([string]$Dir) {
  $dist  = Join-Path $Dir 'dist'
  $index = Join-Path $dist 'index.html'
  $stamp = Join-Path $dist '.loki-build-stamp'
  $needs = $false
  if (-not (Test-Path $index)) { $needs = $true }
  elseif (-not (Test-Path $stamp)) { $needs = $true }
  else {
    $stampTime = (Get-Item $stamp).LastWriteTimeUtc
    $inputs = [System.Collections.Generic.List[object]]::new()
    $src = Join-Path $Dir 'src'
    if (Test-Path $src) { Get-ChildItem -Path $src -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object { $inputs.Add($_) } }
    foreach ($f in @('index.html','package.json','bun.lock','vite.config.ts','vite.config.js','tsconfig.json','tsconfig.app.json','tailwind.config.ts')) {
      $p = Join-Path $Dir $f
      if (Test-Path $p) { $inputs.Add((Get-Item $p)) }
    }
    $newest = ($inputs | Measure-Object -Property LastWriteTimeUtc -Maximum).Maximum
    if ($newest -and $newest -gt $stampTime) { $needs = $true }
  }
  if (-not $needs) { Write-Host 'Frontend bundle is up to date.'; return }
  Write-Host 'Building the frontend for production (this can take a minute)...'
  Push-Location $Dir
  bun run build
  $ok = ($LASTEXITCODE -eq 0)
  Pop-Location
  if (-not $ok) { throw 'Frontend production build failed (see errors above). Fix it, or use run-dev.ps1 for the dev server.' }
  # Stamp AFTER a clean build; vite empties dist on build, so the stamp must be recreated last.
  New-Item -ItemType File -Path $stamp -Force | Out-Null
}

# ── Teardown helpers ──────────────────────────────────────────────────────────
function Stop-Port([int]$Port) {
  try {
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique |
      ForEach-Object {
        if (Get-Process -Id $_ -ErrorAction SilentlyContinue) {
          Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
        } else {
          # Owning process is already dead but the port is still bound: on Windows a
          # detached child inherits the parent's listen-socket handle and keeps the
          # port alive, while netstat still attributes it to the dead parent (observed:
          # ollama.exe holding port 3000 after a backend crash, bricking every restart).
          # Ollama is the only sidecar deliberately left running across restarts, so
          # it's the only inheritor that can still be standing — restart it.
          Stop-Process -Name 'ollama' -Force -ErrorAction SilentlyContinue
        }
      }
  } catch { }
}

function Stop-ByCommandLine([string]$Pattern) {
  try {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -like "*$Pattern*" } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  } catch { }
}

# Completely stop any previous instance before starting. Killing the dev servers
# (or their ports) is NOT enough: the backend spawns detached sidecars (ComfyUI,
# voice server, kiwix, GraphHopper, the Wyoming pod gateway) that outlive it and
# pile up across runs. Free every known port, then sweep this project's dev
# runtimes + spawned children by command line so nothing lingers. Scoped to
# "$Root" / specific signatures so unrelated work on the machine is never touched.
function Stop-Existing {
  Write-Host 'Stopping any previous instance (servers + sidecars)...'
  foreach ($p in $Ports) { Stop-Port $p }
  foreach ($sig in $SidecarPatterns) { Stop-ByCommandLine $sig }
  Start-Sleep -Seconds 1
}

# Unload Ollama models on exit so they don't linger in VRAM across sessions.
# The backend's own SIGTERM handler runs first; this is the fallback for crashes.
function Invoke-OllamaUnload {
  $ollama = if ($env:OLLAMA_URL) { $env:OLLAMA_URL.TrimEnd('/') } else { 'http://localhost:11434' }
  try {
    $ps = Invoke-RestMethod -Uri "$ollama/api/ps" -TimeoutSec 3
    foreach ($m in $ps.models) {
      try {
        $body = @{ model = $m.name; keep_alive = 0 } | ConvertTo-Json -Compress
        Invoke-RestMethod -Method Post -Uri "$ollama/api/generate" -Body $body -ContentType 'application/json' -TimeoutSec 5 | Out-Null
      } catch { }
    }
  } catch { }
}

# ── Uninstall path ────────────────────────────────────────────────────────────
if ($Uninstall) {
  Ensure-Bun
  Write-Host ''
  Write-Host 'WARNING: This will permanently delete all app data, AI models, ComfyUI,'
  Write-Host 'voice/map caches, and the downloaded runtimes from this machine.'
  Write-Host ''
  $confirm = Read-Host 'Type UNINSTALL to confirm'
  if ($confirm -ne 'UNINSTALL') { Write-Host 'Cancelled.'; exit 1 }
  Set-Location (Join-Path $Root 'backend')
  if (-not (Test-Path 'node_modules')) { bun install --silent }
  bun run src/uninstall-cli.ts
  exit $LASTEXITCODE
}

# ── Launch ────────────────────────────────────────────────────────────────────
Ensure-Bun

$backend = $null
$frontend = $null

try {
  Stop-Existing

  $backendDir  = Join-Path $Root 'backend'
  $frontendDir = Join-Path $Root 'frontend'
  Ensure-Deps $backendDir
  Ensure-Deps $frontendDir

  # The `dev` script sets NODE_ENV=development itself; production `start` doesn't, so
  # set it here — the backend serves frontend/dist only when NODE_ENV != development.
  $env:NODE_ENV = if ($Dev) { 'development' } else { 'production' }

  if ($Dev) {
    Write-Host 'Starting backend (dev, hot reload)...'
    $backend = Start-Process -FilePath 'bun' -ArgumentList 'run', 'dev' `
      -WorkingDirectory $backendDir -NoNewWindow -PassThru
    Write-Host 'Starting frontend (Vite dev server)...'
    $frontend = Start-Process -FilePath 'bun' -ArgumentList 'run', 'dev' `
      -WorkingDirectory $frontendDir -NoNewWindow -PassThru
    $webPort = 5173
  } else {
    Ensure-FrontendBuild $frontendDir
    Write-Host 'Starting the app (production: one process serves the API + bundled UI)...'
    $backend = Start-Process -FilePath 'bun' -ArgumentList 'run', 'start' `
      -WorkingDirectory $backendDir -NoNewWindow -PassThru
    $frontend = $null   # production serves the built UI from the backend process
    $webPort = 3000
  }

  # Wait for the web port to bind, then open the browser (Chrome if available,
  # otherwise the default browser).
  Write-Host 'Waiting for the app to come up...'
  while (-not (Get-NetTCPConnection -LocalPort $webPort -State Listen -ErrorAction SilentlyContinue)) {
    if ($backend.HasExited) { throw "Backend exited before it started listening on port $webPort. Check data\logs\app.log." }
    if ($frontend -and $frontend.HasExited) { throw 'Frontend exited before it started listening on port 5173.' }
    Start-Sleep -Milliseconds 200
  }
  $url = "http://localhost:$webPort"
  try { Start-Process 'chrome.exe' "--new-window $url" }
  catch { Start-Process $url }

  Write-Host ''
  Write-Host "Loki Doki is running at $url  (press Ctrl+C to stop)"

  # Supervise: a crashed server restarts automatically instead of taking the whole
  # app down (previously one backend crash killed everything until a manual re-run).
  # Capped at 5 restarts per 5 minutes per server so a genuine crash-loop stops
  # instead of thrashing. Ctrl+C still exits via the finally block below.
  $restartLog = @{ backend = @(); frontend = @() }
  function Should-Restart([string]$name) {
    $now = Get-Date
    $restartLog[$name] = @($restartLog[$name] | Where-Object { ($now - $_).TotalMinutes -lt 5 })
    if ($restartLog[$name].Count -ge 5) { return $false }
    $restartLog[$name] += $now
    return $true
  }

  # Wait for a port to actually clear (not just the wrapper PID to report exited —
  # `bun run dev` spawns a grandchild for the real `--hot` listener, which can outlive
  # the wrapper briefly). Restarting into a still-bound port crashes immediately with
  # EADDRINUSE, and that crash-loops through the whole restart budget in seconds while
  # every attempt re-runs the full boot sequence (previously observed: exactly this).
  function Wait-PortFree([int]$Port, [int]$TimeoutSeconds = 10) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
      if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { return $true }
      Stop-Port $Port
      Start-Sleep -Milliseconds 300
    }
    return -not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  }

  $backendArgs = if ($Dev) { @('run', 'dev') } else { @('run', 'start') }
  while ($true) {
    Start-Sleep -Milliseconds 500
    if ($backend.HasExited) {
      if (-not (Should-Restart 'backend')) { Write-Host 'Backend is crash-looping (5 restarts in 5 min) - giving up. Check data\logs\app.log.'; break }
      Write-Host "Backend exited (code $($backend.ExitCode)) - restarting it..."
      if (-not (Wait-PortFree 3000)) { Write-Host 'Port 3000 would not clear - giving up.'; break }
      $backend = Start-Process -FilePath 'bun' -ArgumentList $backendArgs `
        -WorkingDirectory $backendDir -NoNewWindow -PassThru
    }
    if ($frontend -and $frontend.HasExited) {
      if (-not (Should-Restart 'frontend')) { Write-Host 'Frontend is crash-looping (5 restarts in 5 min) - giving up.'; break }
      Write-Host "Frontend exited (code $($frontend.ExitCode)) - restarting it..."
      if (-not (Wait-PortFree 5173)) { Write-Host 'Port 5173 would not clear - giving up.'; break }
      $frontend = Start-Process -FilePath 'bun' -ArgumentList 'run', 'dev' `
        -WorkingDirectory $frontendDir -NoNewWindow -PassThru
    }
  }
}
finally {
  Write-Host ''
  Write-Host 'Shutting down...'
  # Ask the backend to stop first so its own SIGTERM handler can unload models.
  if ($backend  -and -not $backend.HasExited)  { Stop-Process -Id $backend.Id  -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  Invoke-OllamaUnload
  if ($frontend -and -not $frontend.HasExited) { Stop-Process -Id $frontend.Id -Force -ErrorAction SilentlyContinue }
  # Sweep any detached sidecars the servers left behind.
  foreach ($p in $Ports) { Stop-Port $p }
  foreach ($sig in $SidecarPatterns) { Stop-ByCommandLine $sig }
}

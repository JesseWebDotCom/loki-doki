import { join } from 'node:path'
import { existsSync, writeFileSync, readFileSync } from 'node:fs'
import { execSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { dataDir } from '@/lib/download'
import { detectHardware, resolveComfyUILaunchConfig } from '@/lib/hwfit'
import type { ComfyUILaunchConfig } from '@/lib/hwfit'

export const COMFYUI_PORT = 8188
export const COMFYUI_DIR  = join(dataDir, 'comfyui')
export const COMFYUI_VENV = join(dataDir, 'comfyui-venv')

const EXTRA_MODEL_PATHS_FILE = join(COMFYUI_DIR, 'extra_model_paths.yaml')

// Keep extra_model_paths.yaml pointing at our loras directory so ComfyUI
// can find installed LoRA files without manual symlinking.
function ensureExtraModelPaths(): void {
  const yaml = `loki-doki:\n    base_path: ${dataDir}/\n    loras: loras/\n`
  try {
    if (!existsSync(EXTRA_MODEL_PATHS_FILE) || readFileSync(EXTRA_MODEL_PATHS_FILE, 'utf8') !== yaml) {
      writeFileSync(EXTRA_MODEL_PATHS_FILE, yaml)
    }
  } catch { /* non-fatal */ }
}

// Bump this whenever the ComfyUI launch args change (e.g. new flags added).
// On boot, if a running instance was spawned with an older version, it is
// restarted automatically so the new args take effect without manual action.
const LAUNCH_VERSION  = 3
const LAUNCH_VER_FILE = join(dataDir, 'comfyui.launch_ver')

const PID_FILE      = join(dataDir, 'comfyui.pid')
const LOG_FILE      = join(dataDir, 'comfyui.log')
const RING_MAX      = 500

export const comfyRing        = [] as string[]
export const comfySubscribers = new Set<(line: string) => void>()

function appendComfyLine(raw: string): void {
  const entry = JSON.stringify({ time: Date.now(), raw })
  if (comfyRing.length >= RING_MAX) comfyRing.shift()
  comfyRing.push(entry)
  for (const sub of comfySubscribers) {
    try { sub(entry) } catch { comfySubscribers.delete(sub) }
  }
}

let tailProc: ChildProcess | null = null

function startLogTail(fresh = false): void {
  if (process.platform === 'win32') return
  try { tailProc?.kill() } catch { /* already dead */ }
  tailProc = null
  // Kill any orphaned tail processes from previous backend restarts — module-scoped
  // tailProc resets to null on hot-reload, so processes from prior runs accumulate.
  try { execSync(`pkill -f "tail.*${LOG_FILE}" 2>/dev/null`, { timeout: 2_000 }) } catch { /* none running */ }

  // Truncate when starting a new ComfyUI session; skip truncation when
  // attaching to an already-running process (e.g. after backend hot-reload).
  if (fresh) {
    try { writeFileSync(LOG_FILE, '') } catch { /* non-fatal */ }
  }

  const t = spawn('tail', ['-F', LOG_FILE], { stdio: ['ignore', 'pipe', 'ignore'] })
  tailProc = t

  let buf = ''
  t.stdout?.on('data', (chunk: Buffer) => {
    buf += chunk.toString()
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trimEnd()
      if (trimmed) appendComfyLine(trimmed)
    }
  })

  t.on('error', () => { if (tailProc === t) tailProc = null })
  t.on('exit',  () => { if (tailProc === t) tailProc = null })
}

export function comfyUrl(): string {
  return (process.env.COMFYUI_URL ?? `http://127.0.0.1:${COMFYUI_PORT}`).replace(/\/$/, '')
}

export function venvPython(): string {
  return process.platform === 'win32'
    ? join(COMFYUI_VENV, 'Scripts', 'python.exe')
    : join(COMFYUI_VENV, 'bin', 'python')
}

export function venvPip(): string {
  return process.platform === 'win32'
    ? join(COMFYUI_VENV, 'Scripts', 'pip.exe')
    : join(COMFYUI_VENV, 'bin', 'pip')
}

export function isComfyUIInstalled(): boolean {
  return existsSync(join(COMFYUI_DIR, 'main.py')) && existsSync(venvPython())
}

export function isComfyUICheckpointPresent(dest: string): boolean {
  return existsSync(join(dataDir, dest))
}

// ── State machine ─────────────────────────────────────────────────────────────

export type ComfyUIState = 'idle' | 'installing' | 'warming' | 'ready' | 'failed'

const state = { current: 'idle' as ComfyUIState, error: '' }
let pollTimer: ReturnType<typeof setTimeout> | null = null
// Synchronous in-flight guard. spawnComfyUI/maybeSpawnComfyUI are async (they await
// hardware detection / health probes before the state flips to 'warming'), so two
// near-simultaneous callers could both pass the state check and double-spawn. This
// flag is set before the first await and cleared once state settles. (Mirrors how
// kiwix/voice mark 'starting' synchronously.)
let spawnInFlight = false

export function getComfyUIState(): ComfyUIState  { return state.current }
export function getComfyUIError(): string         { return state.error }

export function markComfyUIInstalling(): void {
  state.current = 'installing'
  state.error   = ''
}

export function markComfyUIReady(): void {
  state.current = 'ready'
  state.error   = ''
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }
}

export function markComfyUIError(msg: string): void {
  state.current = 'failed'
  state.error   = msg
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }
}

// ── Spawn ─────────────────────────────────────────────────────────────────────

export function spawnComfyUI(config: ComfyUILaunchConfig): void {
  if (state.current === 'warming' || state.current === 'ready') return
  const python = venvPython()
  const mainPy = join(COMFYUI_DIR, 'main.py')
  if (!existsSync(python) || !existsSync(mainPy)) return
  ensureExtraModelPaths()

  let child: ChildProcess

  if (process.platform === 'win32') {
    // Windows: no shell redirect available; keep stdio ignored to avoid EPIPE.
    // Logs won't be captured on this platform.
    const args = [
      mainPy,
      '--listen', '127.0.0.1',
      '--port', String(COMFYUI_PORT),
      '--disable-auto-launch',
      '--preview-method', 'latent2rgb',
      ...config.extraArgs,
    ]
    child = spawn(python, args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...config.env },
    })
  } else {
    // Unix: redirect stdout+stderr to log file via `exec` in a shell.
    // Using exec replaces the shell with Python so child.pid IS the Python PID.
    // File redirection avoids EPIPE on backend hot-reload — the file descriptor
    // inside the Python process remains valid regardless of backend state.
    // (Bun's child_process doesn't support integer fd values in the stdio array,
    // so the only way to redirect to a file without a pipe is via shell redirection.)
    const extraQuoted = config.extraArgs.map((a) => `"${a}"`).join(' ')
    const shellCmd = `exec "$COMFY_PYTHON" "$COMFY_MAIN" --listen 127.0.0.1 --port ${COMFYUI_PORT} --disable-auto-launch --preview-method auto ${extraQuoted} >> "$COMFY_LOG" 2>&1`
    child = spawn('sh', ['-c', shellCmd], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...config.env, COMFY_PYTHON: python, COMFY_MAIN: mainPy, COMFY_LOG: LOG_FILE },
    })
    startLogTail(true)
  }

  if (child.pid !== undefined) {
    try { writeFileSync(PID_FILE, String(child.pid)) } catch { /* non-fatal */ }
  }
  try { writeFileSync(LAUNCH_VER_FILE, String(LAUNCH_VERSION)) } catch { /* non-fatal */ }
  child.unref()

  state.current = 'warming'
  state.error   = ''
  startHealthPoll()
}

// Kill the running ComfyUI process (if any) by port. Used both by restart and by
// the process shutdown handler so the sidecar doesn't linger after the backend exits.
// On Unix: -sTCP:LISTEN restricts to the listener only, excluding backend client connections
// to ComfyUI which would otherwise appear in lsof output and cause the backend to SIGTERM itself.
// On Windows: fall back to PID file.
export function stopComfyUI(): void {
  if (process.platform !== 'win32') {
    try {
      const pids = execSync(`lsof -ti tcp:${COMFYUI_PORT} -sTCP:LISTEN 2>/dev/null`, { encoding: 'utf8', timeout: 3_000 }).trim()
      for (const pid of pids.split('\n').filter(Boolean)) {
        const n = parseInt(pid, 10)
        if (n === process.pid || Number.isNaN(n)) continue
        try { process.kill(n, 'SIGTERM') } catch { /* already dead */ }
      }
    } catch { /* lsof not available or no process on port */ }
  } else {
    try {
      const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10)
      if (!isNaN(pid)) try { process.kill(pid, 'SIGTERM') } catch { /* already dead */ }
    } catch { /* no pid file */ }
  }
}

// Kill the running ComfyUI process (if any) and respawn it cleanly.
export async function restartComfyUI(): Promise<void> {
  stopComfyUI()

  // Wait until the port is free (up to 10 s) so the new spawn doesn't get "port in use".
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      await fetch(`${comfyUrl()}/system_stats`, { signal: AbortSignal.timeout(1_000) })
      await new Promise<void>(r => setTimeout(r, 500))
    } catch {
      break  // port is free
    }
  }

  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }
  state.current = 'idle'
  state.error   = ''

  const hw     = detectHardware()
  const config = await resolveComfyUILaunchConfig(hw)
  spawnComfyUI(config)
}

// Returns true when the running ComfyUI was launched with an older config
// and should be restarted to pick up the current launch args.
export function isLaunchVersionStale(): boolean {
  try {
    const stored = parseInt(readFileSync(LAUNCH_VER_FILE, 'utf8').trim(), 10)
    return stored !== LAUNCH_VERSION
  } catch {
    return true  // no file → was never spawned with versioned args
  }
}

// Spawn ComfyUI if installed and venv is Python 3.10+ compatible.
// Safe to call multiple times — no-ops if already warming/ready.
// Returns false if venv is incompatible (needs repair via boot sequence).
export async function maybeSpawnComfyUI(): Promise<boolean> {
  if (state.current === 'warming' || state.current === 'ready') return true
  if (!isComfyUIInstalled()) return false
  // Synchronous re-entrancy guard: a second caller arriving before our awaits flip the
  // state to 'warming' would otherwise sail past the checks above and spawn a duplicate.
  if (spawnInFlight) return true
  spawnInFlight = true

  try {
    try {
      const already = await fetch(`${comfyUrl()}/system_stats`, { signal: AbortSignal.timeout(2_000) })
      if (already.ok) { markComfyUIReady(); startLogTail(); return true }
    } catch { /* not running yet */ }

    try {
      const minor = execSync(
        `"${venvPython()}" -c "import sys; print(sys.version_info.minor)"`,
        { encoding: 'utf8', timeout: 5_000 },
      ).trim()
      if (parseInt(minor, 10) < 10) return false
    } catch { /* assume compatible */ }

    const hw     = detectHardware()
    const config = await resolveComfyUILaunchConfig(hw)
    spawnComfyUI(config)
    return true
  } finally {
    spawnInFlight = false
  }
}

function startHealthPoll(): void {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }
  const deadline = Date.now() + 180_000

  async function poll() {
    if (state.current !== 'warming') return
    try {
      const r = await fetch(`${comfyUrl()}/system_stats`, { signal: AbortSignal.timeout(3_000) })
      if (r.ok) { state.current = 'ready'; return }
    } catch { /* not up yet */ }
    if (Date.now() >= deadline) {
      state.current = 'failed'
      state.error   = 'ComfyUI did not start within 3 minutes'
      return
    }
    pollTimer = setTimeout(poll, 5_000)
  }

  pollTimer = setTimeout(poll, 5_000)
}

// ── Health wait (blocking, used during setup) ─────────────────────────────────

export async function waitForComfyUI(timeoutMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${comfyUrl()}/system_stats`, { signal: AbortSignal.timeout(3_000) })
      if (r.ok) return true
    } catch { /* not up yet */ }
    await new Promise<void>((r) => setTimeout(r, 2_000))
  }
  return false
}

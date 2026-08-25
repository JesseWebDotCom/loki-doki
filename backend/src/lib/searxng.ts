// Managed SearXNG metasearch sidecar — the quality engine behind webSearch.
//
// Why a service at all: from a residential/home IP, bare server-side scraping of the
// big engines is dead — Google serves a JS-only shell to `fetch()` (0 parseable
// results) and CAPTCHAs headless Chromium; DuckDuckGo's HTML/vqd endpoints anomaly-
// block. SearXNG's per-engine adapters shape requests well enough to get through
// (Google/Brave/Startpage all return from the same IP that blocks us), and because it
// aggregates ~20 engines, one blocked engine (DDG still CAPTCHAs) never sinks a query.
//
// Runtime: a Python ≥3.10 venv (reuses lib/python.ensurePython) running SearXNG from a
// shallow git checkout via `python -m searx.webapp` (Flask dev server — fine for a
// single-user localhost bind; never exposed). Modeled on lib/comfyui.ts: idle→installing
// →starting→ready/failed state machine, tail-based log ring, PID file + lsof teardown,
// health poll on /healthz. Install/repair is wired through lib/installRegistry.

import { join } from 'node:path'
import { existsSync, writeFileSync, readFileSync, statSync, renameSync, rmSync, mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { execSync, execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { dataDir } from '@/lib/download'
import { ensurePython } from '@/lib/python'
import { IS_WIN, spawnDetachedHidden } from '@/lib/platform'
import { ensureGit, gitBin } from '@/lib/git'
import { logger } from '@/lib/logger'
import { getAppSetting, setAppSetting } from '@/lib/settings'

const execFileAsync = promisify(execFile)

export const SEARXNG_PORT = 8091
export const SEARXNG_DIR   = join(dataDir, 'searxng')          // shallow git checkout
export const SEARXNG_VENV  = join(dataDir, 'searxng-venv')
const SETTINGS_FILE = join(dataDir, 'searxng-settings.yml')
const SECRET_FILE   = join(dataDir, 'searxng-secret')          // generated once, persisted
const PID_FILE      = join(dataDir, 'searxng.pid')
const LOG_FILE      = join(dataDir, 'searxng.log')
const OLD_LOG_FILE  = join(dataDir, 'searxng.old.log')
const LOG_MAX_BYTES = 20 * 1024 * 1024
const RING_MAX      = 500

// Rotate an oversized log at spawn time ONLY. The sidecar writes via a shell `>>`
// redirect, which holds an fd to the ORIGINAL inode — renaming while it runs would
// leave it appending to the renamed file forever and the fresh path would never be
// recreated. So in-session growth is unbounded; we can only rotate between sessions
// (preserving the previous session's tail in .old.log instead of truncating it away).
function rotateLogIfLarge(): void {
  try {
    if (statSync(LOG_FILE).size > LOG_MAX_BYTES) renameSync(LOG_FILE, OLD_LOG_FILE)
  } catch { /* no log yet */ }
}

const SEARXNG_REPO  = 'https://github.com/searxng/searxng.git'

// Auto-updater bookkeeping (mirrors the yt-dlp manager). SearXNG's per-engine adapters
// break as the upstream sites change, so a stale checkout silently rots — we pull the
// latest commit on a cadence so the admin never has to think about it.
const CHECKED_KEY  = 'search.searxng_checked_at'
const VERSION_KEY  = 'search.searxng_version'
const CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000  // weekly: frequent enough for adapter fixes, rare enough to avoid churn

export function searxngUrl(): string {
  return (process.env.SEARXNG_URL ?? `http://127.0.0.1:${SEARXNG_PORT}`).replace(/\/$/, '')
}

function venvBin(name: string): string {
  return IS_WIN ? join(SEARXNG_VENV, 'Scripts', `${name}.exe`) : join(SEARXNG_VENV, 'bin', name)
}

// Exposed for the install registry's functional probe: the venv survives an OS wipe
// on the data drive, but its interpreter launcher points at a base Python that may be gone.
export function searxngVenvPython(): string {
  return venvBin('python')
}

export function isSearXNGInstalled(): boolean {
  return existsSync(join(SEARXNG_DIR, 'searx', 'webapp.py')) && existsSync(venvBin('python'))
}

// ── log ring (mirrors comfyRing; feeds the admin tab's live log stream) ──────────

export const searxngRing        = [] as string[]
export const searxngSubscribers = new Set<(line: string) => void>()

function appendLine(raw: string): void {
  const entry = JSON.stringify({ time: Date.now(), raw })
  if (searxngRing.length >= RING_MAX) searxngRing.shift()
  searxngRing.push(entry)
  for (const sub of searxngSubscribers) {
    try { sub(entry) } catch { searxngSubscribers.delete(sub) }
  }
}

let tailProc: ChildProcess | null = null

function startLogTail(fresh = false): void {
  if (IS_WIN) return
  try { tailProc?.kill() } catch { /* already dead */ }
  tailProc = null
  // Reap orphaned tails from prior backend hot-reloads (module state resets to null).
  try { execSync(`pkill -f "tail.*${LOG_FILE}" 2>/dev/null`, { timeout: 2_000 }) } catch { /* none */ }
  if (fresh) { try { writeFileSync(LOG_FILE, '') } catch { /* non-fatal */ } }

  const t = spawn('tail', ['-F', LOG_FILE], { stdio: ['ignore', 'pipe', 'ignore'] })
  tailProc = t
  let buf = ''
  t.stdout?.on('data', (chunk: Buffer) => {
    buf += chunk.toString()
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) { const s = line.trimEnd(); if (s) appendLine(s) }
  })
  t.on('error', () => { if (tailProc === t) tailProc = null })
  t.on('exit',  () => { if (tailProc === t) tailProc = null })
}

// ── State machine ────────────────────────────────────────────────────────────────

export type SearXNGState = 'idle' | 'installing' | 'starting' | 'ready' | 'failed'

const state = { current: 'idle' as SearXNGState, error: '' }
let pollTimer: ReturnType<typeof setTimeout> | null = null

export function getSearXNGState(): SearXNGState { return state.current }
export function getSearXNGError(): string        { return state.error }
export function markSearXNGInstalling(): void { state.current = 'installing'; state.error = '' }

function markReady(): void { state.current = 'ready'; state.error = ''; if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }; startSupervision() }
function markError(msg: string): void {
  state.current = 'failed'; state.error = msg
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }
  logger.warn(`[searxng] ${msg}`)
}

// ── Post-ready supervision ───────────────────────────────────────────────────────
// The startup poll stops at markReady(); if the Python process dies later the state
// would stay 'ready' with nothing respawning it. A low-frequency liveness re-probe
// catches that and restarts — capped so a persistently-crashing install can't
// respawn-loop forever.

const SUPERVISE_INTERVAL_MS = 60_000
const SUPERVISE_RETRY_MS    = 5_000       // quick re-probe before declaring death
const RESTART_WINDOW_MS     = 10 * 60_000
const RESTART_MAX           = 3

let superviseTimer: ReturnType<typeof setTimeout> | null = null
let superviseFailures = 0
let restartTimes: number[] = []
let sxProc: ChildProcess | null = null

function stopSupervision(): void {
  if (superviseTimer) { clearTimeout(superviseTimer); superviseTimer = null }
  superviseFailures = 0
}

function startSupervision(): void {
  if (superviseTimer) return  // already supervising this instance
  superviseFailures = 0
  const tick = async (): Promise<void> => {
    if (state.current !== 'ready') { superviseTimer = null; return }
    let ok = false
    try {
      const res = await fetch(`${searxngUrl()}/healthz`, { signal: AbortSignal.timeout(3_000) })
      ok = res.ok
    } catch { /* down or wedged */ }
    if (state.current !== 'ready') { superviseTimer = null; return }  // stopped while probing
    if (ok) {
      superviseFailures = 0
      superviseTimer = setTimeout(() => void tick(), SUPERVISE_INTERVAL_MS)
      return
    }
    superviseFailures++
    if (superviseFailures < 2) {
      superviseTimer = setTimeout(() => void tick(), SUPERVISE_RETRY_MS)
      return
    }
    superviseTimer = null
    handleCrash()
  }
  superviseTimer = setTimeout(() => void tick(), SUPERVISE_INTERVAL_MS)
}

// Shared respawn path for the liveness probe and the child 'exit' accelerator.
// Old restart timestamps age out of the window, so a sustained healthy period
// naturally resets the cap.
function handleCrash(): void {
  stopSupervision()
  const now = Date.now()
  restartTimes = restartTimes.filter((t) => now - t < RESTART_WINDOW_MS)
  if (restartTimes.length >= RESTART_MAX) {
    markError(`SearXNG crashed ${RESTART_MAX}+ times within 10 minutes — giving up`)
    logger.error('[searxng] SearXNG keeps crashing — not respawning again (restart the backend or check data/searxng.log)')
    return
  }
  restartTimes.push(now)
  logger.warn('[searxng] SearXNG died — respawning')
  void restartSearXNG().catch((err) => markError(`respawn failed: ${err}`))
}

// ── settings ─────────────────────────────────────────────────────────────────────

function getSecretKey(): string {
  try { const s = readFileSync(SECRET_FILE, 'utf8').trim(); if (s.length >= 32) return s } catch { /* generate */ }
  const secret = randomBytes(32).toString('hex')
  try { writeFileSync(SECRET_FILE, secret, { mode: 0o600 }) } catch { /* non-fatal */ }
  return secret
}

// Generate settings.yml. `use_default_settings: true` inherits SearXNG's full engine
// roster; we override only what makes it usable as a local JSON API:
//   formats: [..json]   — JSON output is OFF by default → /search?format=json 403s without it
//   limiter: false      — the bot-detection limiter blocks our own programmatic requests
//   secret_key          — SearXNG refuses to start with the default placeholder key
function writeSettings(): void {
  const yaml = `# Generated by maipai-home — do not edit; regenerated on each launch.
use_default_settings: true
general:
  instance_name: "maipai-home"
  debug: false
  donation_url: false
server:
  port: ${SEARXNG_PORT}
  bind_address: "127.0.0.1"
  secret_key: "${getSecretKey()}"
  limiter: false
  public_instance: false
  image_proxy: false
  method: "GET"
ui:
  static_use_hash: true
search:
  safe_search: 0
  autocomplete: ""
  formats:
    - html
    - json
`
  try { writeFileSync(SETTINGS_FILE, yaml) } catch (e) { logger.warn(`[searxng] could not write settings: ${e}`) }
}

// ── install / repair (dispatched from installRegistry) ──────────────────────────

type StatusFn = (msg: string) => void

function run(cmd: string, args: string[], opts: { cwd?: string; signal?: AbortSignal; onStatus?: StatusFn } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const onAbort = () => { try { child.kill('SIGTERM') } catch { /* dead */ } }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    let lastErr = ''
    const onData = (b: Buffer) => { const s = b.toString().trim(); if (s) { lastErr = s.split('\n').pop() ?? lastErr; opts.onStatus?.(s.split('\n').pop() ?? '') } }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (err) => { opts.signal?.removeEventListener('abort', onAbort); reject(err) })
    child.on('exit', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      if (opts.signal?.aborted) return reject(new Error('aborted'))
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${lastErr}`))
    })
  })
}

/**
 * Install (or repair) the SearXNG runtime: resolve a Python ≥3.10, shallow-clone the
 * repo, build a venv, install requirements, and write settings. Idempotent — skips the
 * clone/venv if already present. Streams coarse status messages; throws on failure.
 */
export async function installSearXNG(onStatus: StatusFn = () => {}, signal?: AbortSignal): Promise<void> {
  markSearXNGInstalling()
  try {
    onStatus('Resolving Python ≥3.10…')
    const python = await ensurePython()
    if (!python) throw new Error('no suitable Python (≥3.10) could be resolved')

    if (!existsSync(join(SEARXNG_DIR, 'searx', 'webapp.py'))) {
      // A crash mid-clone leaves a partial, non-empty SEARXNG_DIR. `git clone` into a
      // non-empty directory fails with exit 128 ("destination path already exists and is
      // not an empty directory"), and since the sentinel above is still missing the job
      // retries forever with the same error. Wipe any partial checkout first so the clone
      // starts clean.
      if (existsSync(SEARXNG_DIR)) {
        onStatus('Removing incomplete SearXNG checkout…')
        rmSync(SEARXNG_DIR, { recursive: true, force: true })
      }
      onStatus('Cloning SearXNG…')
      await ensureGit(onStatus)
      const git = gitBin()
      if (IS_WIN) {
        // The searxng repo ships deploy templates whose filenames contain a colon, e.g.
        // `utils/templates/etc/nginx/default.apps-available/searxng.conf:socket`. A colon
        // is illegal in Windows/NTFS filenames, so a normal `git clone` aborts the ENTIRE
        // checkout with exit 128 ("unable to checkout working tree") and leaves nothing
        // usable. Clone without checking out, then `git restore` the working tree: restore
        // writes every valid file and merely warns-and-skips the handful of colon paths
        // (which we never use - SearXNG runs via `python -m searx.webapp`), exiting 0.
        await run(git, ['clone', '--no-checkout', '--depth', '1', SEARXNG_REPO, SEARXNG_DIR], { signal, onStatus })
        await run(git, ['-C', SEARXNG_DIR, 'restore', '--source=HEAD', ':/'], { signal, onStatus })
      } else {
        await run(git, ['clone', '--depth', '1', SEARXNG_REPO, SEARXNG_DIR], { signal, onStatus })
      }
    }

    // A venv that survived on disk (e.g. the data drive kept it through an OS
    // reinstall, or an interpreter it points to got moved/removed) can look
    // installed to existsSync while its python.exe is actually dead — every
    // pip/webapp invocation then fails immediately ("No Python", exit 103) and
    // the job retries forever without ever fixing anything. Verify it actually
    // runs before trusting it; rebuild from scratch if not.
    if (existsSync(venvBin('python'))) {
      const venvOk = await execFileAsync(venvBin('python'), ['--version'], { timeout: 10_000, windowsHide: true })
        .then(() => true).catch(() => false)
      if (!venvOk) {
        onStatus('Existing Python virtualenv is broken — rebuilding…')
        rmSync(SEARXNG_VENV, { recursive: true, force: true })
      }
    }
    if (!existsSync(venvBin('python'))) {
      onStatus('Creating Python virtualenv…')
      await run(python, ['-m', 'venv', SEARXNG_VENV], { signal, onStatus })
    }

    onStatus('Upgrading pip…')
    await run(venvBin('python'), ['-m', 'pip', 'install', '--upgrade', 'pip'], { signal, onStatus })

    onStatus('Installing SearXNG dependencies (this can take a few minutes)…')
    await run(venvBin('python'), ['-m', 'pip', 'install', '-r', join(SEARXNG_DIR, 'requirements.txt')], { signal, onStatus })

    if (IS_WIN) {
      // Standalone Windows Python ships no timezone database (no /usr/share/zoneinfo
      // equivalent), so ZoneInfo(...) raises and every engine that stamps timestamps
      // (bilibili, others as upstream adds them) fails to register at startup. The
      // `tzdata` PyPI package is the stdlib's documented fallback source.
      onStatus('Installing timezone database…')
      await run(venvBin('python'), ['-m', 'pip', 'install', 'tzdata'], { signal, onStatus })
    }

    writeSettings()
    onStatus('SearXNG installed.')
    state.current = 'idle'  // ready to spawn
  } catch (err) {
    markError(`install failed: ${err instanceof Error ? err.message : String(err)}`)
    throw err
  }
}

// ── Windows compat shim ──────────────────────────────────────────────────────
// searx/valkeydb.py unconditionally does `import pwd` at module load — a Unix-only
// stdlib module that doesn't exist on Windows at all, crashing the whole process
// before it can even bind its port. The only real use (pwd.getpwuid, inside an
// `except ValkeyError` branch logging a failed connection) is unreachable for this
// app: we never set valkey.url/redis.url, so initialize() returns early long before
// that line. A stub module that merely satisfies the import — placed in a directory
// we own (NOT the vendored checkout, which a `git reset --hard` during auto-update
// would wipe) and prepended to PYTHONPATH — is the standard, safe fix for a portable
// Python app that assumes POSIX for a code path it doesn't actually need.
const WIN_STUB_DIR = join(dataDir, 'searxng-winstubs')

function ensureWindowsStubs(): void {
  if (!IS_WIN) return
  try {
    mkdirSync(WIN_STUB_DIR, { recursive: true })
    const stubPath = join(WIN_STUB_DIR, 'pwd.py')
    if (!existsSync(stubPath)) {
      writeFileSync(stubPath, [
        '# Stub for Windows: the real `pwd` module is POSIX-only. Only satisfies',
        '# `import pwd` for code paths this app never exercises (no valkey/redis',
        '# configured) — see backend/src/lib/searxng.ts ensureWindowsStubs().',
        'from collections import namedtuple',
        "_Passwd = namedtuple('struct_passwd', ['pw_name', 'pw_uid', 'pw_gid', 'pw_gecos', 'pw_dir', 'pw_shell'])",
        'def getpwuid(uid):',
        "    import os",
        "    return _Passwd(os.environ.get('USERNAME', 'unknown'), uid, 0, '', '', '')",
        '',
      ].join('\n'))
    }
  } catch (err) {
    logger.warn(`[searxng] could not write Windows pwd stub: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ── spawn / lifecycle (mirrors comfyui) ─────────────────────────────────────────

export function spawnSearXNG(): void {
  if (state.current === 'starting' || state.current === 'ready') return
  if (!isSearXNGInstalled()) return
  writeSettings()  // refresh so config/port changes always take effect
  ensureWindowsStubs()

  const python = venvBin('python')
  const env = {
    ...process.env,
    SEARXNG_SETTINGS_PATH: SETTINGS_FILE,
    ...(IS_WIN ? { PYTHONPATH: [WIN_STUB_DIR, process.env.PYTHONPATH].filter(Boolean).join(';') } : {}),
  }

  let child: ChildProcess
  if (IS_WIN) {
    // No shell redirect; logs uncaptured on Windows (matches comfyui).
    child = spawnDetachedHidden(python, ['-m', 'searx.webapp'], { cwd: SEARXNG_DIR, env })
  } else {
    // `exec` so child.pid IS the Python PID; file redirect avoids EPIPE on hot-reload.
    const shellCmd = `exec "$SX_PY" -m searx.webapp >> "$SX_LOG" 2>&1`
    rotateLogIfLarge()  // must happen before the child opens its `>>` fd
    child = spawn('sh', ['-c', shellCmd], {
      cwd: SEARXNG_DIR, detached: true, stdio: 'ignore',
      env: { ...env, SX_PY: python, SX_LOG: LOG_FILE },
    })
    startLogTail(true)
  }

  if (child.pid !== undefined) { try { writeFileSync(PID_FILE, String(child.pid)) } catch { /* non-fatal */ } }
  // Crash accelerator while we still hold the handle (`exec` makes child.pid the Python
  // PID, so 'exit' fires when SearXNG itself dies). Adopted orphans (post hot-reload)
  // have no handle — the HTTP probe covers them. stopSearXNG nulls sxProc before the
  // exit event fires, so intentional kills never respawn.
  sxProc = child
  child.on('exit', () => {
    if (sxProc !== child) return
    sxProc = null
    if (state.current === 'ready') handleCrash()
  })
  child.unref()

  state.current = 'starting'
  state.error   = ''
  startHealthPoll()
}

// Kill the running SearXNG by listening port (Unix) or PID file (Windows). Used by
// restart and the backend shutdown handler so the sidecar never lingers.
export function stopSearXNG(): void {
  stopSupervision()  // intentional stop (shutdown/restart) must never trigger a respawn
  sxProc = null      // detach the exit accelerator before the kill lands
  if (!IS_WIN) {
    try {
      const pids = execSync(`lsof -ti tcp:${SEARXNG_PORT} -sTCP:LISTEN 2>/dev/null`, { encoding: 'utf8', timeout: 3_000 }).trim()
      for (const pid of pids.split('\n').filter(Boolean)) {
        const n = parseInt(pid, 10)
        if (n === process.pid || Number.isNaN(n)) continue
        try { process.kill(n, 'SIGTERM') } catch { /* already dead */ }
      }
    } catch { /* lsof unavailable or nothing on port */ }
  } else {
    try {
      const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10)
      if (!Number.isNaN(pid)) try { process.kill(pid, 'SIGTERM') } catch { /* already dead */ }
    } catch { /* no pid file */ }
  }
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }
  if (state.current === 'ready' || state.current === 'starting') state.current = 'idle'
}

export async function restartSearXNG(): Promise<void> {
  stopSearXNG()
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try { await fetch(`${searxngUrl()}/healthz`, { signal: AbortSignal.timeout(1_000) }); await new Promise<void>(r => setTimeout(r, 500)) }
    catch { break }  // port free
  }
  state.current = 'idle'; state.error = ''
  spawnSearXNG()
}

// Spawn if installed; no-op if already starting/ready. Safe to call repeatedly (boot).
export function maybeSpawnSearXNG(): boolean {
  if (state.current === 'starting' || state.current === 'ready') return true
  if (!isSearXNGInstalled()) return false
  spawnSearXNG()
  return true
}

// ── health poll ──────────────────────────────────────────────────────────────────

function startHealthPoll(): void {
  if (pollTimer) clearTimeout(pollTimer)
  const deadline = Date.now() + 90_000  // SearXNG dev server boots in a few seconds; allow slack
  const tick = async (): Promise<void> => {
    try {
      const res = await fetch(`${searxngUrl()}/healthz`, { signal: AbortSignal.timeout(2_000) })
      if (res.ok) { markReady(); logger.info('[searxng] ready'); return }
    } catch { /* not up yet */ }
    if (Date.now() > deadline) { markError('did not become healthy within 90s'); return }
    pollTimer = setTimeout(() => void tick(), 2_000)
  }
  pollTimer = setTimeout(() => void tick(), 1_500)
}

// ── auto-update (git pull + pip + restart, mirrors the yt-dlp manager) ──────────

// `-c safe.directory` on every git invocation: after an OS reinstall the data drive
// survives but the user account's SID doesn't, so the checkout is "owned by" a SID
// that no longer resolves and git refuses to touch it ("detected dubious ownership").
// Forward slashes — git canonicalizes safe.directory entries that way even on Windows.
const GIT_SAFE_ARGS = ['-c', `safe.directory=${SEARXNG_DIR.replace(/\\/g, '/')}`]

function execGit(args: string[]): string {
  // gitBin() is 'git' until ensureGit() has resolved a managed/portable copy; quoted so a Windows
  // portable-git path containing spaces still works. Callers wrap this in try/catch fallbacks.
  return execSync(`"${gitBin()}" ${[...GIT_SAFE_ARGS, ...args].map(a => `"${a}"`).join(' ')}`, { cwd: SEARXNG_DIR, encoding: 'utf8', timeout: 60_000, windowsHide: true }).trim()
}

/** Current checkout version: `git describe` (tag-ish), falling back to the short SHA. */
export function searxngVersion(): string | null {
  if (!existsSync(join(SEARXNG_DIR, '.git'))) return null
  try { return execGit(['describe', '--tags', '--always']) } catch { return null }
}

/**
 * Pull the latest SearXNG when a check is due (or forced), reinstall deps only if the
 * checkout actually moved, and restart the service to pick up new adapters. Never throws
 * — a failed update just leaves the working copy as-is. Gated by a persisted timestamp so
 * boot and the daily interval both no-op until genuinely due.
 */
export async function maybeUpdateSearXNG(force = false): Promise<void> {
  if (!isSearXNGInstalled() || !existsSync(join(SEARXNG_DIR, '.git'))) return
  try {
    const last = (await getAppSetting(CHECKED_KEY)) as number | null
    const due = force || !last || Date.now() - last > CHECK_INTERVAL_MS
    if (!due) return

    // Re-resolve git (a restart resets the in-process handle to 'git'; on Windows this repoints
    // to the portable copy). If git truly can't be resolved, skip the update rather than throw.
    let git: string
    try { git = await ensureGit() } catch { logger.info('[searxng] update skipped — git unavailable'); return }

    const before = (() => { try { return execGit(['rev-parse', 'HEAD']) } catch { return '' } })()
    const branch = (() => { try { return execGit(['rev-parse', '--abbrev-ref', 'HEAD']) } catch { return 'master' } })()
    logger.info(`[searxng] checking for updates (branch ${branch})…`)
    // Shallow checkout → fetch the tip and hard-reset (a normal `pull` can't fast-forward
    // a depth-1 clone). Use the async run() helper so the event loop stays unblocked
    // during the network fetch — execSync here would stall health probes for up to 60s.
    await run(git, [...GIT_SAFE_ARGS, 'fetch', '--depth', '1', 'origin', branch], { cwd: SEARXNG_DIR })
    if (IS_WIN) {
      // `git reset --hard` aborts the ENTIRE update on Windows: SearXNG ships deploy
      // templates whose filenames contain a colon (e.g. `searxng.conf:socket`), illegal on
      // NTFS, and git refuses to reset to a tree it can't fully materialize ("Could not
      // reset index file to revision"). Mirror the install path instead — move the branch
      // ref, then restore just the working tree from the new commit. `restore` writes every
      // valid file and skips the colon paths with an "invalid path" warning, exiting 0
      // (a hard-reset never gets that far). The index is left untouched — cosmetic only;
      // every consumer reads commit/ref state, never the index.
      await run(git, [...GIT_SAFE_ARGS, 'update-ref', `refs/heads/${branch}`, 'FETCH_HEAD'], { cwd: SEARXNG_DIR })
      await run(git, [...GIT_SAFE_ARGS, 'restore', '--source', branch, '--worktree', '--', ':/'], { cwd: SEARXNG_DIR })
    } else {
      await run(git, [...GIT_SAFE_ARGS, 'reset', '--hard', 'FETCH_HEAD'], { cwd: SEARXNG_DIR })
    }
    const after = (() => { try { return execGit(['rev-parse', 'HEAD']) } catch { return '' } })()

    await setAppSetting(CHECKED_KEY, Date.now())

    if (before && after && before !== after) {
      logger.info(`[searxng] updated ${before.slice(0, 7)} → ${after.slice(0, 7)}; reinstalling deps + restarting`)
      // Dependencies can shift between commits — reinstall before restarting.
      await run(venvBin('python'), ['-m', 'pip', 'install', '-r', join(SEARXNG_DIR, 'requirements.txt')])
      await restartSearXNG()
    } else {
      logger.info('[searxng] already up to date')
    }
    const v = searxngVersion()
    if (v) await setAppSetting(VERSION_KEY, v)
  } catch (err) {
    logger.warn(`[searxng] update check failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export interface SearXNGInfo {
  installed: boolean
  state: SearXNGState
  error: string
  version: string | null
  checkedAt: number | null
  /** AGPL-3.0 attribution surfaced in the admin panel — SearXNG must not be a hidden component. */
  license: string
  sourceUrl: string
  localSource: string
}

/** Status snapshot for the admin panel (and the AGPL attribution it must show). */
export async function getSearXNGInfo(): Promise<SearXNGInfo> {
  return {
    installed: isSearXNGInstalled(),
    state: state.current,
    error: state.error,
    version: searxngVersion() ?? ((await getAppSetting(VERSION_KEY)) as string | null) ?? null,
    checkedAt: (await getAppSetting(CHECKED_KEY)) as number | null ?? null,
    license: 'AGPL-3.0-or-later',
    sourceUrl: 'https://github.com/searxng/searxng',
    localSource: SEARXNG_DIR,
  }
}

// ── query ────────────────────────────────────────────────────────────────────────

export interface SearxResult { title: string; snippet: string; url: string; thumbnail?: string }

/**
 * Query the local SearXNG JSON API. Returns up to `limit` results, or [] when the
 * service isn't ready or the request fails (never throws) — so webSearch can fall
 * through to its keyless scrapers. Results are already merged/deduped across engines
 * by SearXNG and returned in its relevance order.
 */
export async function searxngSearch(query: string, limit = 5, timeoutMs = 6000, safesearch: 0 | 1 | 2 = 0, pageno = 1): Promise<SearxResult[]> {
  if (state.current !== 'ready') return []
  const q = query.trim()
  if (!q) return []
  try {
    const url = `${searxngUrl()}/search?q=${encodeURIComponent(q)}&format=json&safesearch=${safesearch}${pageno > 1 ? `&pageno=${pageno}` : ''}`
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) {
      // A non-200 here (403 = formats config, 429 = limiter) is the whole search
      // silently dying — surface it instead of returning a mute [].
      logger.warn(`[searxng] general search HTTP ${res.status} for "${q}"`)
      return []
    }
    const data = await res.json() as {
      results?: Array<{ title?: string; content?: string; url?: string; img_src?: string; thumbnail?: string }>
    }
    return (data.results ?? [])
      .filter(r => r.url && r.title)
      .slice(0, limit)
      .map(r => ({
        title: r.title!, snippet: r.content ?? '', url: r.url!,
        // Some general-category engines (Bing/Brave/Startpage via SearXNG) attach a
        // thumbnail even outside the images category — opportunistic, most results
        // won't have one and the frontend falls back to a favicon.
        thumbnail: r.img_src || r.thumbnail || undefined,
      }))
  } catch (err) {
    // Usually a timeout (upstream engines slow/suspended) — log so an empty
    // result page is diagnosable from data/logs instead of a silent mystery.
    logger.warn(`[searxng] general search failed for "${q}": ${String(err instanceof Error ? err.name : err)}`)
    return []
  }
}

export interface SearxImage { title: string; imageUrl: string; thumbnailUrl: string; source: string; width: number | null; height: number | null }

/**
 * Image search via the local SearXNG JSON API (categories=images). Returns up to `limit`
 * images ordered by SearXNG's relevance, largest-first within ties. [] when not ready or on
 * failure — never throws. Used to source backdrop/wallpaper art keylessly.
 */
export async function searxngImageSearch(query: string, limit = 8, timeoutMs = 7000, safesearch: 0 | 1 | 2 = 1): Promise<SearxImage[]> {
  if (state.current !== 'ready') return []
  const q = query.trim()
  if (!q) return []
  try {
    const url = `${searxngUrl()}/search?q=${encodeURIComponent(q)}&format=json&categories=images&safesearch=${safesearch}`
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return []
    const data = await res.json() as {
      results?: Array<{ title?: string; img_src?: string; thumbnail_src?: string; thumbnail?: string; source?: string; img_format?: string; resolution?: string }>
    }
    const parseDim = (r: { resolution?: string }): [number | null, number | null] => {
      const m = (r.resolution ?? '').match(/(\d+)\s*[x×]\s*(\d+)/)
      return m ? [Number(m[1]), Number(m[2])] : [null, null]
    }
    return (data.results ?? [])
      .filter(r => r.img_src)
      .map(r => {
        const [width, height] = parseDim(r)
        return {
          title: r.title ?? '',
          imageUrl: r.img_src!,
          thumbnailUrl: r.thumbnail_src ?? r.thumbnail ?? r.img_src!,
          source: r.source ?? '',
          width, height,
        }
      })
      .slice(0, limit)
  } catch { return [] }
}

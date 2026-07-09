import { join, basename, dirname } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rm, copyFile, readdir, stat } from 'node:fs/promises'
import { exec, execSync, execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import type { ChildProcess } from 'node:child_process'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)
import { dataDir, downloadUrl } from '@/lib/download'
import { IS_WIN, extractZip, findFileInTree, spawnDetachedHidden } from '@/lib/platform'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { logger } from '@/lib/logger'

export const KIWIX_PORT   = 8090
export const kiwixZimDir  = join(dataDir, 'zim')

// Backend directory (contains package.json and zim-server.ts)
const BACKEND_DIR      = join(import.meta.dir, '../..')
const ZIM_SERVER_SCRIPT = join(BACKEND_DIR, 'zim-server.ts')

// ── Windows backend: prebuilt kiwix-serve ──────────────────────────────────────
// macOS/Linux compile @openzim/libzim and run the custom zim-server.ts. Windows can't
// compile that without MSVC build tools, so there we auto-download the official static
// kiwix-tools (kiwix-serve + kiwix-manage) and serve via a generated library.xml.
// Last-resort pin only; the real version is resolved live from kiwix's release listing
// (kiwixToolsUrl below). kiwix purges old builds from its mirrors, so a hardcoded version
// eventually 404s EVERY fresh install — which is exactly what stranded the offline-library
// downloads. Keep this pointed at a currently-available build in case the listing is
// unreachable, but the resolver is what normally picks the version.
const KIWIX_TOOLS_FALLBACK_VERSION = '3.8.1'
const KIWIX_TOOLS_RELEASE_DIR      = 'https://download.kiwix.org/release/kiwix-tools/'
// Auto-update manager state (mirrors the yt-dlp / SearXNG updaters). Windows only — mac/Linux
// use the bundled @openzim/libzim native module, which npm/node-gyp keeps current, not a
// versioned download.
const KIWIX_VERSION_KEY        = 'kiwix.tools_version'
const KIWIX_CHECKED_KEY        = 'kiwix.tools_checked_at'
const KIWIX_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000
const BIN_DIR             = join(dataDir, 'bin')
const KIWIX_SERVE_BIN     = join(BIN_DIR, IS_WIN ? 'kiwix-serve.exe' : 'kiwix-serve')
const KIWIX_MANAGE_BIN    = join(BIN_DIR, IS_WIN ? 'kiwix-manage.exe' : 'kiwix-manage')
const KIWIX_LIBRARY_XML   = join(kiwixZimDir, 'library.xml')

// Numeric-component compare for versions like "3.8.1" and "3.7.0-2" (rebuild suffix).
function compareKiwixVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map(Number)
  const pb = b.split(/[.-]/).map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

// kiwix publishes win-x86_64 only (runs on ARM Windows under emulation).
function kiwixToolsUrlFor(version: string): string {
  return `${KIWIX_TOOLS_RELEASE_DIR}kiwix-tools_win-x86_64-${version}.zip`
}

// Resolve the LATEST available build from the release listing instead of a hardcoded version, so
// a purged build never 404s the install. Falls back to a known-good pin when the listing can't
// be fetched (offline first-install still works against a currently-available build).
async function resolveLatestKiwixVersion(): Promise<string> {
  try {
    const res = await fetch(KIWIX_TOOLS_RELEASE_DIR, { signal: AbortSignal.timeout(15_000) })
    if (res.ok) {
      const html = await res.text()
      const versions = [...html.matchAll(/kiwix-tools_win-x86_64-([\d.]+(?:-\d+)?)\.zip/g)].map((m) => m[1]!)
      const latest = versions.sort(compareKiwixVersions).at(-1)
      if (latest) return latest
    }
  } catch { /* offline / listing unavailable */ }
  return KIWIX_TOOLS_FALLBACK_VERSION
}

// Windows book-name lookup, populated from library.xml at (re)spawn. Path → book name.
let winBookNames = new Map<string, string>()

// ── Content-URL scheme (differs per backend) ───────────────────────────────────
// kiwix-serve serves articles under /content/<book>/…; the custom zim-server serves
// them at /<book>/…. The proxy uses these so it never hardcodes either scheme.
export function kiwixContentBase(bookName: string): string {
  return IS_WIN ? `${kiwixUrl()}/content/${bookName}` : `${kiwixUrl()}/${bookName}`
}
export function kiwixContentRelPrefix(bookName: string): string {
  return IS_WIN ? `/content/${bookName}/` : `/${bookName}/`
}

// ── Install detection ─────────────────────────────────────────────────────────

export function isKiwixInstalled(): boolean {
  if (IS_WIN) return existsSync(KIWIX_SERVE_BIN)
  const nativeModule = join(
    BACKEND_DIR,
    'node_modules/@openzim/libzim/build/Release/zim_binding.node',
  )
  return existsSync(nativeModule)
}

// ── Book name extraction ────────────────────────────────────────────────────────
// Windows: read it from the generated library.xml. Unix: ask the running zim-server.
export async function getZimBookName(zimPath: string, retries = 6): Promise<string | null> {
  if (IS_WIN) {
    if (winBookNames.has(zimPath)) return winBookNames.get(zimPath)!
    const base = basename(zimPath)
    for (const [p, n] of winBookNames) if (basename(p) === base) return n
    return null
  }
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(
        `${kiwixUrl()}/api/name?path=${encodeURIComponent(zimPath)}`,
        { signal: AbortSignal.timeout(4_000) },
      )
      if (res.ok) {
        const data = await res.json() as { name?: string }
        return data.name ?? null
      }
    } catch { /* server not ready yet */ }
    if (i < retries - 1) await new Promise<void>((r) => setTimeout(r, 1_500))
  }
  return null
}

// ── Install ─────────────────────────────────────────────────────────────────────

export async function installKiwixTools(
  onStatus: (msg: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (isKiwixInstalled()) {
    onStatus(IS_WIN ? 'kiwix-serve already installed' : 'libzim already installed')
    return
  }

  if (IS_WIN) {
    await installKiwixServeWindows(onStatus, signal)
    return
  }

  // ── macOS / Linux: compile @openzim/libzim (unchanged) ────────────────────────
  // On macOS, Xcode CLT provides the C++ compiler node-gyp needs
  if (process.platform === 'darwin') {
    try {
      const xcodePath = execSync('xcode-select -p 2>/dev/null', { encoding: 'utf8', timeout: 5_000 }).trim()
      if (!xcodePath) throw new Error('empty')
    } catch {
      throw new Error(
        'Xcode Command Line Tools are required. Run: xcode-select --install, then retry.',
      )
    }
  }

  onStatus('Downloading and compiling libzim (may take 1–2 minutes)…')

  await mkdir(join(BACKEND_DIR, 'node_modules'), { recursive: true })

  await new Promise<void>((resolve, reject) => {
    // npm properly runs the package's `install` lifecycle script (node-gyp rebuild).
    // bun add skips lifecycle scripts for native addons so the .node file never compiles.
    const proc = spawn('npm', ['install', '@openzim/libzim'], {
      cwd: BACKEND_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    proc.stdout.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim()
      if (line) onStatus(line)
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim()
      if (line) onStatus(line)
    })
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`npm install @openzim/libzim failed (exit ${code})`))
    })
    proc.on('error', reject)

    signal?.addEventListener('abort', () => {
      proc.kill()
      reject(new DOMException('Cancelled', 'AbortError'))
    })
  })

  if (!isKiwixInstalled()) {
    throw new Error('libzim compiled but native module not found — installation may have failed')
  }
  onStatus('libzim installed successfully')
}

// Download + extract the static kiwix-tools bundle (Windows only). Resolves the latest available
// version when one isn't passed (auto-update passes the target it already resolved). Records the
// installed version so the update manager can tell when a newer build ships.
async function installKiwixServeWindows(onStatus: (msg: string) => void, signal?: AbortSignal, version?: string): Promise<void> {
  const v = version ?? await resolveLatestKiwixVersion()
  const url = kiwixToolsUrlFor(v)
  const archive = join(BIN_DIR, 'kiwix-tools.zip')
  const extractDir = join(BIN_DIR, '_kiwix_extract')
  try {
    await mkdir(BIN_DIR, { recursive: true })
    onStatus(`Downloading kiwix-serve ${v}…`)
    // Shared downloader: resume (.part) + retries + stall detection + size verification.
    await downloadUrl(url, archive, () => {}, signal, { minBytes: 1_000_000 })

    onStatus('Extracting kiwix-serve…')
    await rm(extractDir, { recursive: true, force: true })
    await mkdir(extractDir, { recursive: true })
    await extractZip(archive, extractDir, 120_000)

    // The 3.8.x Windows builds are NOT self-contained: kiwix-serve/kiwix-manage dynamically link
    // bundled ICU DLLs (icu*.dll) shipped alongside them in the archive. Copy EVERY file from the
    // exe's directory (both exes + all DLLs), not just the two .exes, or the tools fail at launch
    // with "error while loading shared libraries" and every ZIM then reports "failed to open".
    const serveSrc = await findFileInTree(extractDir, 'kiwix-serve.exe')
    if (!serveSrc) throw new Error('kiwix-serve.exe not found in archive')
    const srcDir = dirname(serveSrc)
    for (const name of await readdir(srcDir)) {
      const src = join(srcDir, name)
      try { if ((await stat(src)).isFile()) await copyFile(src, join(BIN_DIR, name)) } catch { /* skip unreadable entries */ }
    }

    if (!isKiwixInstalled()) throw new Error('kiwix-serve missing after extraction')
    await setAppSetting(KIWIX_VERSION_KEY, v)
    await setAppSetting(KIWIX_CHECKED_KEY, Date.now())
    onStatus('kiwix-serve installed')
  } finally {
    await rm(archive, { force: true }).catch(() => {})
    await rm(extractDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Auto-update manager (Windows): on boot and then daily, roll out a newer kiwix-tools build if
 *  one has shipped. On mac/Linux the ZIM engine is the bundled @openzim/libzim (no versioned
 *  binary), so this is a no-op there. First install is handled by installKiwixTools with the
 *  same resolver, so this only updates an already-installed copy. Never throws — mirrors the
 *  yt-dlp / SearXNG updaters. */
export async function maybeUpdateKiwixTools(force = false): Promise<void> {
  if (!IS_WIN || !isKiwixInstalled()) return
  try {
    const last = (await getAppSetting(KIWIX_CHECKED_KEY)) as number | null
    if (!force && last && Date.now() - last < KIWIX_UPDATE_INTERVAL_MS) return
    const latest = await resolveLatestKiwixVersion()
    const installed = (await getAppSetting(KIWIX_VERSION_KEY)) as string | null
    await setAppSetting(KIWIX_CHECKED_KEY, Date.now())
    if (installed && compareKiwixVersions(latest, installed) <= 0) return  // already current
    logger.info(`[kiwix] updating kiwix-tools ${installed ?? '(unknown)'} → ${latest}`)
    // kiwix-serve.exe can't be overwritten while running (Windows locks the file). Stop it, swap
    // the binaries, then respawn with the current archive set so serving continues on the new build.
    const wasRunning = getKiwixState() === 'ready'
    await stopKiwix()
    await installKiwixServeWindows(() => {}, undefined, latest)
    logger.info(`[kiwix] kiwix-tools updated to ${latest}`)
    if (wasRunning) {
      const { syncKiwixWithArchives } = await import('@/lib/archives')
      await syncKiwixWithArchives().catch(() => {})
    }
  } catch (err) {
    logger.warn(`[kiwix] auto-update check failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ── Validate a ZIM without libzim (Windows): kiwix-manage opens it or it's bad ───
export async function validateZimWindows(zimPath: string): Promise<boolean> {
  if (!existsSync(KIWIX_MANAGE_BIN)) return true  // can't check → don't block the download
  const tmpLib = join(kiwixZimDir, `_validate_${Date.now()}.xml`)
  try {
    await execFileAsync(KIWIX_MANAGE_BIN, [tmpLib, 'add', zimPath], { timeout: 30_000, windowsHide: true })
    return existsSync(tmpLib)  // a successful add wrote a library entry
  } catch {
    return false
  } finally {
    await rm(tmpLib, { force: true }).catch(() => {})
  }
}

// ── State machine ─────────────────────────────────────────────────────────────

export type KiwixState = 'idle' | 'starting' | 'ready' | 'failed'

const state = { current: 'idle' as KiwixState, error: '' }
let pollTimer: ReturnType<typeof setTimeout> | null = null
let kiwixProc: ChildProcess | null = null
// Archive list from the last spawn, so post-ready supervision can respawn with the
// same books (also captured when we adopt an already-running server after hot-reload).
let lastZimPaths: string[] = []

export function getKiwixState(): KiwixState { return state.current }
export function getKiwixError(): string      { return state.error }
export function kiwixUrl(): string           { return `http://127.0.0.1:${KIWIX_PORT}` }

function markReady()              { state.current = 'ready'; state.error = ''; clearPoll(); startSupervision() }
function markFailed(msg: string)  { state.current = 'failed'; state.error = msg; clearPoll() }
function clearPoll()              { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null } }

// ── Post-ready supervision ────────────────────────────────────────────────────
// The startup poll stops at markReady(); if the server dies later (OOM, crash) the
// state would stay 'ready' forever. A low-frequency liveness re-probe catches that
// and respawns — capped so a persistently-crashing server can't loop forever.

const SUPERVISE_INTERVAL_MS = 60_000
const SUPERVISE_RETRY_MS    = 5_000       // quick re-probe before declaring death
const RESTART_WINDOW_MS     = 10 * 60_000
const RESTART_MAX           = 3

let superviseTimer: ReturnType<typeof setTimeout> | null = null
let superviseFailures = 0
let restartTimes: number[] = []

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
      const r = await fetch(`${kiwixUrl()}/catalog/v2/entries`, { signal: AbortSignal.timeout(3_000) })
      ok = r.ok
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

// Shared respawn path for both the liveness probe and the child 'exit' accelerator.
// Old restart timestamps age out of the window, so a sustained healthy period
// naturally resets the cap.
function handleCrash(): void {
  stopSupervision()
  const now = Date.now()
  restartTimes = restartTimes.filter((t) => now - t < RESTART_WINDOW_MS)
  if (restartTimes.length >= RESTART_MAX) {
    markFailed(`ZIM server crashed ${RESTART_MAX}+ times within 10 minutes — giving up`)
    logger.error('[kiwix] ZIM server keeps crashing — not respawning again (restart the backend to retry)')
    return
  }
  restartTimes.push(now)
  logger.warn('[kiwix] ZIM server died — respawning')
  void restartKiwix(lastZimPaths)
}

// Accelerator when we still hold the child handle (post hot-reload the server is an
// adopted orphan and only the HTTP probe can catch a crash). stopKiwix nulls kiwixProc
// synchronously before the exit event fires, so intentional kills never respawn.
function watchProc(child: ChildProcess): void {
  child.on('exit', () => {
    if (kiwixProc !== child) return
    kiwixProc = null
    if (state.current === 'ready') handleCrash()
  })
}

// ── Spawn ─────────────────────────────────────────────────────────────────────

export function spawnKiwix(zimPaths: string[]): void {
  if (state.current === 'starting' || state.current === 'ready') return
  if (!isKiwixInstalled()) return

  const validZims = zimPaths.filter(existsSync)
  if (validZims.length === 0) return
  lastZimPaths = validZims

  if (IS_WIN) {
    // Mark starting synchronously; library build + spawn are async.
    state.current = 'starting'
    state.error   = ''
    void spawnKiwixServe(validZims).catch((err) => markFailed(String(err)))
    return
  }

  const child = spawnDetachedHidden('bun', [ZIM_SERVER_SCRIPT, ...validZims], { cwd: BACKEND_DIR })
  kiwixProc = child
  watchProc(child)
  child.unref()

  state.current = 'starting'
  state.error   = ''
  startHealthPoll()
}

// Windows: (re)build library.xml via kiwix-manage, then serve it with kiwix-serve.
async function spawnKiwixServe(validZims: string[]): Promise<void> {
  await mkdir(kiwixZimDir, { recursive: true })
  await rm(KIWIX_LIBRARY_XML, { force: true }).catch(() => {})
  for (const zim of validZims) {
    try { await execFileAsync(KIWIX_MANAGE_BIN, [KIWIX_LIBRARY_XML, 'add', zim], { timeout: 30_000, windowsHide: true }) }
    catch (err) { logger.warn(`[kiwix] kiwix-manage add failed for ${zim}: ${err}`) }
  }
  winBookNames = parseLibrary(KIWIX_LIBRARY_XML)

  const child = spawnDetachedHidden(KIWIX_SERVE_BIN, ['--port', String(KIWIX_PORT), '--address', '127.0.0.1', '--library', KIWIX_LIBRARY_XML], { cwd: BACKEND_DIR })
  kiwixProc = child
  watchProc(child)
  child.unref()
  startHealthPoll()
}

// Parse `<book … name="…" path="…">` entries from a kiwix library.xml into path → name.
function parseLibrary(libPath: string): Map<string, string> {
  const map = new Map<string, string>()
  try {
    const xml = readFileSync(libPath, 'utf8')
    for (const m of xml.matchAll(/<book\b[^>]*>/g)) {
      const tag  = m[0]
      const name = tag.match(/\bname="([^"]+)"/)?.[1]
      const path = tag.match(/\bpath="([^"]+)"/)?.[1]
      if (name && path) map.set(path, name)
    }
  } catch { /* no library yet */ }
  return map
}

// Serialize restarts: concurrent ZIM downloads each finish and ask to restart the
// server. Without a queue they stomp each other (stop kills a just-spawned process),
// thrashing the server so it never settles. Chained, the last call wins with the
// fullest archive list.
let restartChain: Promise<void> = Promise.resolve()
export function restartKiwix(zimPaths: string[]): Promise<void> {
  restartChain = restartChain.catch(() => {}).then(() => doRestartKiwix(zimPaths))
  return restartChain
}

async function doRestartKiwix(zimPaths: string[]): Promise<void> {
  await stopKiwix()
  clearPoll()
  state.current = 'idle'
  state.error   = ''
  spawnKiwix(zimPaths.filter(existsSync))
}

export async function stopKiwix(): Promise<void> {
  stopSupervision()  // intentional stop (shutdown/restart) must never trigger a respawn
  if (kiwixProc) {
    try { kiwixProc.kill('SIGTERM') } catch { /* already dead */ }
    kiwixProc = null
  }

  if (process.platform !== 'win32') {
    try {
      // CRITICAL: filter to LISTEN sockets only (-sTCP:LISTEN), and never kill our own
      // PID. The backend holds OUTBOUND connections to this port for kiwix health checks;
      // a bare `lsof -ti tcp:PORT` matches those client sockets too, so it can return the
      // backend's own PID — and SIGTERM-ing ourselves trips the shutdown handler and kills
      // the whole backend. (We only ever want to kill the kiwix-serve listener.)
      // Async, NOT execSync — execSync blocks the single-threaded event loop, which would
      // freeze every other in-flight download (they stall mid-"Resolving…").
      const { stdout } = await execAsync(`lsof -ti tcp:${KIWIX_PORT} -sTCP:LISTEN 2>/dev/null`, { timeout: 3_000 })
      for (const pid of stdout.trim().split('\n').filter(Boolean)) {
        const n = parseInt(pid, 10)
        if (n === process.pid || Number.isNaN(n)) continue
        try { process.kill(n, 'SIGTERM') } catch { /* already dead */ }
      }
    } catch { /* lsof unavailable or no match */ }
  }

  // Wait for port to free (up to 5 s)
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      await fetch(`${kiwixUrl()}/`, { signal: AbortSignal.timeout(400) })
      await new Promise<void>((r) => setTimeout(r, 300))
    } catch {
      break
    }
  }
}

export async function maybeSpawnKiwix(zimPaths: string[]): Promise<void> {
  if (state.current === 'starting' || state.current === 'ready') return
  if (!isKiwixInstalled()) {
    // Archives are installed but the ZIM engine itself isn't. This used to be a
    // silent no-op that left state stuck at 'idle' forever with no diagnostic trail.
    // Surface it loudly so a missing/incomplete install is visible in logs instead
    // of only discovered when a user opens a reader and gets a dead page.
    if (zimPaths.length > 0) {
      logger.warn(`[kiwix] ${zimPaths.length} archive(s) installed but the ZIM engine isn't, reinstall from Admin -> Features`)
    }
    return
  }
  const valid = zimPaths.filter(existsSync)
  if (valid.length === 0) return

  try {
    const r = await fetch(`${kiwixUrl()}/catalog/v2/entries`, { signal: AbortSignal.timeout(2_000) })
    if (r.ok) { lastZimPaths = valid; markReady(); return }  // adopted after hot-reload — remember paths for respawn
  } catch { /* not running */ }

  spawnKiwix(valid)
}

// Boot-time self-heal: verify the spawn attempt above actually reached 'ready' after
// its own startup window, and make one more attempt if not (covers state getting
// stuck at 'idle'/'failed' with no supervisor yet to catch it - the post-ready
// liveness probe only starts once markReady() has fired once). Call once at boot,
// well after maybeSpawnKiwix's own 60s health-poll deadline would have elapsed.
export function scheduleKiwixBootHeal(zimPaths: string[]): void {
  setTimeout(() => {
    if (state.current === 'ready') return
    const valid = zimPaths.filter(existsSync)
    if (valid.length === 0) return
    logger.warn(`[kiwix] not ready 90s after boot (state=${state.current}${state.error ? `, ${state.error}` : ''}), retrying`)
    state.current = 'idle'  // clear a stale 'failed'/'starting' so maybeSpawnKiwix doesn't short-circuit
    void maybeSpawnKiwix(valid)
  }, 90_000)
}

// ── Health poll ───────────────────────────────────────────────────────────────

function startHealthPoll(): void {
  clearPoll()
  const deadline = Date.now() + 60_000

  async function poll() {
    if (state.current !== 'starting') return
    try {
      const r = await fetch(`${kiwixUrl()}/catalog/v2/entries`, {
        signal: AbortSignal.timeout(3_000),
      })
      if (r.ok) { markReady(); return }
    } catch { /* not up yet */ }

    if (Date.now() >= deadline) {
      markFailed('ZIM server did not start within 60 seconds')
      return
    }
    pollTimer = setTimeout(poll, 2_000)
  }
  pollTimer = setTimeout(poll, 1_000)
}

import { join, basename } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rm, copyFile } from 'node:fs/promises'
import { exec, execSync, execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import type { ChildProcess } from 'node:child_process'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)
import { dataDir, downloadUrl } from '@/lib/download'
import { IS_WIN, extractZip, findFileInTree } from '@/lib/platform'
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
const KIWIX_TOOLS_VERSION = '3.7.0'
const BIN_DIR             = join(dataDir, 'bin')
const KIWIX_SERVE_BIN     = join(BIN_DIR, IS_WIN ? 'kiwix-serve.exe' : 'kiwix-serve')
const KIWIX_MANAGE_BIN    = join(BIN_DIR, IS_WIN ? 'kiwix-manage.exe' : 'kiwix-manage')
const KIWIX_LIBRARY_XML   = join(kiwixZimDir, 'library.xml')

function kiwixToolsUrl(): string {
  // kiwix publishes win-x86_64 only; it runs on ARM Windows under emulation.
  return `https://download.kiwix.org/release/kiwix-tools/kiwix-tools_win-x86_64-${KIWIX_TOOLS_VERSION}.zip`
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

// Download + extract the static kiwix-tools bundle (Windows only).
async function installKiwixServeWindows(onStatus: (msg: string) => void, signal?: AbortSignal): Promise<void> {
  const url = kiwixToolsUrl()
  const archive = join(BIN_DIR, 'kiwix-tools.zip')
  const extractDir = join(BIN_DIR, '_kiwix_extract')
  try {
    await mkdir(BIN_DIR, { recursive: true })
    onStatus('Downloading kiwix-serve…')
    // Shared downloader: resume (.part) + retries + stall detection + size verification.
    await downloadUrl(url, archive, () => {}, signal, { minBytes: 1_000_000 })

    onStatus('Extracting kiwix-serve…')
    await rm(extractDir, { recursive: true, force: true })
    await mkdir(extractDir, { recursive: true })
    extractZip(archive, extractDir, 120_000)

    // kiwix-tools static builds are self-contained executables — copy the two we use.
    const serveSrc  = await findFileInTree(extractDir, 'kiwix-serve.exe')
    const manageSrc = await findFileInTree(extractDir, 'kiwix-manage.exe')
    if (!serveSrc)  throw new Error('kiwix-serve.exe not found in archive')
    await copyFile(serveSrc, KIWIX_SERVE_BIN)
    if (manageSrc) await copyFile(manageSrc, KIWIX_MANAGE_BIN)

    if (!isKiwixInstalled()) throw new Error('kiwix-serve missing after extraction')
    onStatus('kiwix-serve installed')
  } finally {
    await rm(archive, { force: true }).catch(() => {})
    await rm(extractDir, { recursive: true, force: true }).catch(() => {})
  }
}

// ── Validate a ZIM without libzim (Windows): kiwix-manage opens it or it's bad ───
export async function validateZimWindows(zimPath: string): Promise<boolean> {
  if (!existsSync(KIWIX_MANAGE_BIN)) return true  // can't check → don't block the download
  const tmpLib = join(kiwixZimDir, `_validate_${Date.now()}.xml`)
  try {
    await execFileAsync(KIWIX_MANAGE_BIN, [tmpLib, 'add', zimPath], { timeout: 30_000 })
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

export function getKiwixState(): KiwixState { return state.current }
export function getKiwixError(): string      { return state.error }
export function kiwixUrl(): string           { return `http://127.0.0.1:${KIWIX_PORT}` }

function markReady()              { state.current = 'ready'; state.error = ''; clearPoll() }
function markFailed(msg: string)  { state.current = 'failed'; state.error = msg; clearPoll() }
function clearPoll()              { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null } }

// ── Spawn ─────────────────────────────────────────────────────────────────────

export function spawnKiwix(zimPaths: string[]): void {
  if (state.current === 'starting' || state.current === 'ready') return
  if (!isKiwixInstalled()) return

  const validZims = zimPaths.filter(existsSync)
  if (validZims.length === 0) return

  if (IS_WIN) {
    // Mark starting synchronously; library build + spawn are async.
    state.current = 'starting'
    state.error   = ''
    void spawnKiwixServe(validZims).catch((err) => markFailed(String(err)))
    return
  }

  const child = spawn('bun', [ZIM_SERVER_SCRIPT, ...validZims], {
    cwd: BACKEND_DIR,
    detached: true,
    stdio: 'ignore',
  })
  kiwixProc = child
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
    try { await execFileAsync(KIWIX_MANAGE_BIN, [KIWIX_LIBRARY_XML, 'add', zim], { timeout: 30_000 }) }
    catch (err) { logger.warn(`[kiwix] kiwix-manage add failed for ${zim}: ${err}`) }
  }
  winBookNames = parseLibrary(KIWIX_LIBRARY_XML)

  const child = spawn(KIWIX_SERVE_BIN, ['--port', String(KIWIX_PORT), '--address', '127.0.0.1', '--library', KIWIX_LIBRARY_XML], {
    cwd: BACKEND_DIR,
    detached: true,
    stdio: 'ignore',
  })
  kiwixProc = child
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
  if (!isKiwixInstalled()) return
  const valid = zimPaths.filter(existsSync)
  if (valid.length === 0) return

  try {
    const r = await fetch(`${kiwixUrl()}/catalog/v2/entries`, { signal: AbortSignal.timeout(2_000) })
    if (r.ok) { markReady(); return }
  } catch { /* not running */ }

  spawnKiwix(valid)
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

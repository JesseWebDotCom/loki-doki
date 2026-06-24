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
import { existsSync, writeFileSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { execSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { dataDir } from '@/lib/download'
import { ensurePython } from '@/lib/python'
import { IS_WIN } from '@/lib/platform'
import { logger } from '@/lib/logger'
import { getAppSetting, setAppSetting } from '@/lib/settings'

export const SEARXNG_PORT = 8091
export const SEARXNG_DIR   = join(dataDir, 'searxng')          // shallow git checkout
export const SEARXNG_VENV  = join(dataDir, 'searxng-venv')
const SETTINGS_FILE = join(dataDir, 'searxng-settings.yml')
const SECRET_FILE   = join(dataDir, 'searxng-secret')          // generated once, persisted
const PID_FILE      = join(dataDir, 'searxng.pid')
const LOG_FILE      = join(dataDir, 'searxng.log')
const RING_MAX      = 500

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

function markReady(): void { state.current = 'ready'; state.error = ''; if (pollTimer) { clearTimeout(pollTimer); pollTimer = null } }
function markError(msg: string): void {
  state.current = 'failed'; state.error = msg
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }
  logger.warn(`[searxng] ${msg}`)
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
  const yaml = `# Generated by loki-doki — do not edit; regenerated on each launch.
use_default_settings: true
general:
  instance_name: "loki-doki"
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
    const child = spawn(cmd, args, { cwd: opts.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
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
      onStatus('Cloning SearXNG…')
      await run('git', ['clone', '--depth', '1', SEARXNG_REPO, SEARXNG_DIR], { signal, onStatus })
    }

    if (!existsSync(venvBin('python'))) {
      onStatus('Creating Python virtualenv…')
      await run(python, ['-m', 'venv', SEARXNG_VENV], { signal, onStatus })
    }

    onStatus('Upgrading pip…')
    await run(venvBin('python'), ['-m', 'pip', 'install', '--upgrade', 'pip'], { signal, onStatus })

    onStatus('Installing SearXNG dependencies (this can take a few minutes)…')
    await run(venvBin('python'), ['-m', 'pip', 'install', '-r', join(SEARXNG_DIR, 'requirements.txt')], { signal, onStatus })

    writeSettings()
    onStatus('SearXNG installed.')
    state.current = 'idle'  // ready to spawn
  } catch (err) {
    markError(`install failed: ${err instanceof Error ? err.message : String(err)}`)
    throw err
  }
}

// ── spawn / lifecycle (mirrors comfyui) ─────────────────────────────────────────

export function spawnSearXNG(): void {
  if (state.current === 'starting' || state.current === 'ready') return
  if (!isSearXNGInstalled()) return
  writeSettings()  // refresh so config/port changes always take effect

  const python = venvBin('python')
  const env = { ...process.env, SEARXNG_SETTINGS_PATH: SETTINGS_FILE }

  let child: ChildProcess
  if (IS_WIN) {
    // No shell redirect; logs uncaptured on Windows (matches comfyui).
    child = spawn(python, ['-m', 'searx.webapp'], { cwd: SEARXNG_DIR, detached: true, stdio: 'ignore', env })
  } else {
    // `exec` so child.pid IS the Python PID; file redirect avoids EPIPE on hot-reload.
    const shellCmd = `exec "$SX_PY" -m searx.webapp >> "$SX_LOG" 2>&1`
    child = spawn('sh', ['-c', shellCmd], {
      cwd: SEARXNG_DIR, detached: true, stdio: 'ignore',
      env: { ...env, SX_PY: python, SX_LOG: LOG_FILE },
    })
    startLogTail(true)
  }

  if (child.pid !== undefined) { try { writeFileSync(PID_FILE, String(child.pid)) } catch { /* non-fatal */ } }
  child.unref()

  state.current = 'starting'
  state.error   = ''
  startHealthPoll()
}

// Kill the running SearXNG by listening port (Unix) or PID file (Windows). Used by
// restart and the backend shutdown handler so the sidecar never lingers.
export function stopSearXNG(): void {
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

function execGit(args: string[]): string {
  return execSync(`git ${args.map(a => `"${a}"`).join(' ')}`, { cwd: SEARXNG_DIR, encoding: 'utf8', timeout: 60_000 }).trim()
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

    const before = (() => { try { return execGit(['rev-parse', 'HEAD']) } catch { return '' } })()
    const branch = (() => { try { return execGit(['rev-parse', '--abbrev-ref', 'HEAD']) } catch { return 'master' } })()
    logger.info(`[searxng] checking for updates (branch ${branch})…`)
    // Shallow checkout → fetch the tip and hard-reset (a normal `pull` can't fast-forward
    // a depth-1 clone). Use the async run() helper so the event loop stays unblocked
    // during the network fetch — execSync here would stall health probes for up to 60s.
    await run('git', ['fetch', '--depth', '1', 'origin', branch], { cwd: SEARXNG_DIR })
    await run('git', ['reset', '--hard', 'FETCH_HEAD'], { cwd: SEARXNG_DIR })
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

export interface SearxResult { title: string; snippet: string; url: string }

/**
 * Query the local SearXNG JSON API. Returns up to `limit` results, or [] when the
 * service isn't ready or the request fails (never throws) — so webSearch can fall
 * through to its keyless scrapers. Results are already merged/deduped across engines
 * by SearXNG and returned in its relevance order.
 */
export async function searxngSearch(query: string, limit = 5, timeoutMs = 6000): Promise<SearxResult[]> {
  if (state.current !== 'ready') return []
  const q = query.trim()
  if (!q) return []
  try {
    const url = `${searxngUrl()}/search?q=${encodeURIComponent(q)}&format=json&safesearch=0`
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return []
    const data = await res.json() as { results?: Array<{ title?: string; content?: string; url?: string }> }
    return (data.results ?? [])
      .filter(r => r.url && r.title)
      .slice(0, limit)
      .map(r => ({ title: r.title!, snippet: r.content ?? '', url: r.url! }))
  } catch { return [] }
}

export interface SearxImage { title: string; imageUrl: string; thumbnailUrl: string; source: string; width: number | null; height: number | null }

/**
 * Image search via the local SearXNG JSON API (categories=images). Returns up to `limit`
 * images ordered by SearXNG's relevance, largest-first within ties. [] when not ready or on
 * failure — never throws. Used to source backdrop/wallpaper art keylessly.
 */
export async function searxngImageSearch(query: string, limit = 8, timeoutMs = 7000): Promise<SearxImage[]> {
  if (state.current !== 'ready') return []
  const q = query.trim()
  if (!q) return []
  try {
    const url = `${searxngUrl()}/search?q=${encodeURIComponent(q)}&format=json&categories=images&safesearch=1`
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

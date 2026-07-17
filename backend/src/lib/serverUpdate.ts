// Server self-management: version info, update checks, the fast-forward-only
// self-update pipeline, and deliberate restart. The operator launches the app
// through run.ps1 / run.sh, whose supervise loop restarts the backend whenever
// the process exits — so "restart" here is simply: stop sidecars, flush the
// progress stream, process.exit(0).
//
// Update pipeline (never `reset --hard` — the server checkout is respected):
//   dirty check → git fetch → merge --ff-only @{u} → bun install (both
//   workspaces) → staged frontend build (dist-staging, swapped in only on
//   success) → stop sidecars → exit. A failed build leaves the running app and
//   its dist intact. Launcher stamp files (.loki-install-stamp /
//   .loki-build-stamp) are re-touched so the next manual launch doesn't redo
//   the work (run.ps1 compares them by mtime against pulled sources).
//
// Progress uses the boot-singleton pattern (routes/system.ts): events are
// buffered and replayed to (re)connecting SSE clients, so a page refresh or a
// second admin mid-update still sees the full run.

import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { rename, rm, writeFile } from 'node:fs/promises'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ensureGit, gitBin } from '@/lib/git'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { stopSidecarsForExit } from '@/lib/gracefulExit'
import { emitNotification } from '@/lib/notify'
import { logger } from '@/lib/logger'

const execFileAsync = promisify(execFile)

// Backend always runs with cwd = backend/ (both `bun run start` and dev) — the
// same convention the static serve of ../frontend/dist in index.ts relies on.
const REPO_ROOT = resolve(process.cwd(), '..')
const BACKEND_DIR = join(REPO_ROOT, 'backend')
const FRONTEND_DIR = join(REPO_ROOT, 'frontend')

// Git can refuse to touch a repo owned by another user ("dubious ownership") —
// the same lesson as lib/searxng.ts. safe.directory wants forward slashes.
function gitSafe(): string[] {
  return ['-c', `safe.directory=${REPO_ROOT.replace(/\\/g, '/')}`]
}

// ── settings ──────────────────────────────────────────────────────────────────

export type UpdateCheckMode = 'off' | 'notify' | 'auto'

export interface UpdateSettings {
  mode: UpdateCheckMode
  intervalHours: number
}

const SETTINGS_DEFAULTS: UpdateSettings = { mode: 'notify', intervalHours: 6 }

let _settingsCache: UpdateSettings | null = null

export async function getUpdateSettings(): Promise<UpdateSettings> {
  if (_settingsCache) return _settingsCache
  const [mode, hours] = await Promise.all([
    getAppSetting('server.update_check_mode'),
    getAppSetting('server.update_check_interval_hours'),
  ])
  _settingsCache = {
    mode: (mode as UpdateCheckMode) ?? SETTINGS_DEFAULTS.mode,
    intervalHours: Number(hours ?? SETTINGS_DEFAULTS.intervalHours),
  }
  return _settingsCache
}

export async function setUpdateSettings(patch: Partial<UpdateSettings>): Promise<UpdateSettings> {
  if (patch.mode !== undefined) await setAppSetting('server.update_check_mode', patch.mode)
  if (patch.intervalHours !== undefined) await setAppSetting('server.update_check_interval_hours', patch.intervalHours)
  _settingsCache = null
  return getUpdateSettings()
}

// ── singleton state ───────────────────────────────────────────────────────────

export type ServerPhase = 'idle' | 'checking' | 'updating' | 'restarting'

type StreamEvent = { event: string; data: string }

const state = {
  phase: 'idle' as ServerPhase,
  events: [] as StreamEvent[],
  subscribers: new Set<() => void>(),
  behind: null as number | null,
  remoteShort: null as string | null,
  lastCheckedAt: null as number | null,
  lastCheckLoaded: false,
}

function broadcast(event: string, data: unknown): void {
  state.events.push({ event, data: JSON.stringify(data) })
  for (const sub of state.subscribers) sub()
}

/**
 * The current run's buffered events. Consumers pull from this array (it only
 * grows during a run; startUpdate swaps in a fresh one) and use
 * onUpdateEvent() as a wake-up signal — SSE writes must be awaited in order,
 * which a push callback can't guarantee.
 */
export function getUpdateEvents(): StreamEvent[] {
  return state.events
}

/** Signal-only subscription: fires after each broadcast. Returns unsubscribe. */
export function onUpdateEvent(fn: () => void): () => void {
  state.subscribers.add(fn)
  return () => state.subscribers.delete(fn)
}

export function getPhase(): ServerPhase {
  return state.phase
}

// ── git helpers ───────────────────────────────────────────────────────────────

export function isGitCheckout(): boolean {
  return existsSync(join(REPO_ROOT, '.git'))
}

async function capture(args: string[], timeoutMs = 30_000): Promise<string> {
  const { stdout } = await execFileAsync(gitBin(), [...gitSafe(), ...args], {
    cwd: REPO_ROOT,
    timeout: timeoutMs,
    windowsHide: true,
  })
  return stdout.trim()
}

export interface VersionInfo {
  shortHash: string
  subject: string
  date: string
  branch: string
}

/** Current HEAD commit + branch; null when not a usable checkout. */
export async function getVersionInfo(): Promise<VersionInfo | null> {
  if (!isGitCheckout()) return null
  try {
    await ensureGit()
    const [line, branch] = await Promise.all([
      capture(['log', '-1', '--format=%h\x1f%s\x1f%cI']),
      capture(['rev-parse', '--abbrev-ref', 'HEAD']),
    ])
    const [shortHash, subject, date] = line.split('\x1f')
    if (!shortHash) return null
    return { shortHash, subject: subject ?? '', date: date ?? '', branch }
  } catch (err) {
    logger.warn(`[server-update] version lookup failed: ${err instanceof Error ? err.message : err}`)
    return null
  }
}

async function loadLastCheck(): Promise<void> {
  if (state.lastCheckLoaded) return
  state.lastCheckLoaded = true
  const v = await getAppSetting('server.update_last_check').catch(() => null)
  if (typeof v === 'number') state.lastCheckedAt = v
}

export interface CheckResult {
  behind: number
  remoteShort: string
}

/**
 * git fetch + count commits behind upstream. Returns null instead of throwing
 * (offline, no upstream, detached HEAD, not a checkout) so callers can treat
 * "unknown" and "up to date" distinctly.
 */
export async function checkForUpdates(): Promise<CheckResult | null> {
  if (!isGitCheckout()) return null
  try {
    const git = await ensureGit()
    await execFileAsync(git, [...gitSafe(), 'fetch', 'origin'], {
      cwd: REPO_ROOT,
      timeout: 180_000,
      windowsHide: true,
    })
    const behind = Number.parseInt(await capture(['rev-list', '--count', 'HEAD..@{u}']), 10)
    const remoteShort = await capture(['rev-parse', '--short', '@{u}'])
    state.behind = Number.isFinite(behind) ? behind : 0
    state.remoteShort = remoteShort
    state.lastCheckedAt = Date.now()
    await setAppSetting('server.update_last_check', state.lastCheckedAt)
    return { behind: state.behind, remoteShort }
  } catch (err) {
    logger.warn(`[server-update] update check failed: ${err instanceof Error ? err.message : err}`)
    return null
  }
}

/** Manual "Check for updates" with the phase guard. Null = busy or failed. */
export async function runManualCheck(): Promise<CheckResult | null> {
  if (state.phase !== 'idle') return null
  state.phase = 'checking'
  try {
    return await checkForUpdates()
  } finally {
    if (state.phase === 'checking') state.phase = 'idle'
  }
}

export interface ServerStatus {
  gitCheckout: boolean
  version: VersionInfo | null
  behind: number | null
  lastCheckedAt: number | null
  phase: ServerPhase
  settings: UpdateSettings
  devMode: boolean
}

export async function getServerStatus(): Promise<ServerStatus> {
  await loadLastCheck()
  const [version, settings] = await Promise.all([getVersionInfo(), getUpdateSettings()])
  return {
    gitCheckout: isGitCheckout() && version !== null,
    version,
    behind: state.behind,
    lastCheckedAt: state.lastCheckedAt,
    phase: state.phase,
    settings,
    devMode: process.env.NODE_ENV === 'development',
  }
}

// ── restart / shutdown ────────────────────────────────────────────────────────

/** Claim the restart phase; false when a check/update/restart is in flight. */
export function tryBeginRestart(): boolean {
  if (state.phase !== 'idle') return false
  state.phase = 'restarting'
  return true
}

// The launcher's supervise loop restarts the backend on ANY exit — that's what
// makes restart work. A real shutdown therefore needs a side channel: the
// backend drops this sentinel before exiting, and the supervise loop (run.ps1 /
// run.sh) sees it, deletes it, and tears down instead of restarting.
const SHUTDOWN_SENTINEL = join(REPO_ROOT, 'data', 'shutdown-requested')

export async function writeShutdownSentinel(): Promise<void> {
  await writeFile(SHUTDOWN_SENTINEL, new Date().toISOString())
}

/**
 * A stale sentinel (launcher died before consuming it, or an old launcher that
 * predates the check) would turn the NEXT restart into a shutdown — clear it at
 * boot; if this process is starting, nobody wants it stopped.
 */
export function clearStaleShutdownSentinel(): void {
  rm(SHUTDOWN_SENTINEL, { force: true }).catch(() => {})
}

// ── subprocess runner (line-streamed; adapted from lib/esphome.ts run) ────────

interface RunOpts {
  cwd?: string
  onLine?: (line: string) => void
  timeoutMs?: number
}

function run(cmd: string, args: string[], opts: RunOpts = {}): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env },
      // detached → own process group, so timeout can kill the whole tree
      // (vite/tsc grandchildren) instead of orphaning them.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let killTimer: ReturnType<typeof setTimeout> | null = null
    const signalTree = (sig: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, sig)
        else child.kill(sig)
      } catch { /* already dead */ }
    }
    const terminate = () => {
      signalTree('SIGTERM')
      if (!killTimer) killTimer = setTimeout(() => signalTree('SIGKILL'), 4000)
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    if (opts.timeoutMs) timer = setTimeout(terminate, opts.timeoutMs)

    // Long quiet phases (bundling, dependency resolution) emit nothing — tick
    // so the progress log doesn't look hung.
    let lastOut = Date.now()
    const heartbeat = setInterval(() => {
      if (Date.now() - lastOut >= 20_000) {
        lastOut = Date.now()
        try { opts.onLine?.('(still working…)') } catch { /* ignore */ }
      }
    }, 5000)

    // Keep a tail of output; the actionable failure is usually a few lines
    // above the final generic exit line.
    const tail: string[] = []
    const onData = (b: Buffer) => {
      for (const line of b.toString().split('\n')) {
        const s = line.trimEnd()
        if (!s) continue
        lastOut = Date.now()
        tail.push(s)
        if (tail.length > 20) tail.shift()
        opts.onLine?.(s)
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      clearInterval(heartbeat)
    }
    child.on('error', (err) => {
      cleanup()
      rejectPromise(err)
    })
    child.on('exit', (code) => {
      cleanup()
      if (code === 0) return resolvePromise()
      const meaningful = [...tail].reverse().find((l) => /error|fatal|fail|cannot|denied/i.test(l))
      rejectPromise(new Error(meaningful || tail[tail.length - 1] || `${cmd} exited ${code}`))
    })
  })
}

// Windows can transiently refuse to rename a directory whose files hold open
// handles (the backend is serving dist while we swap it) — retry briefly.
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      return await rename(from, to)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (i >= 10 || !['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(code)) throw err
      await new Promise((r) => setTimeout(r, 300))
    }
  }
}

/** Touch a launcher stamp so run.ps1/run.sh mtime comparisons see fresh work. */
async function touchStamp(path: string): Promise<void> {
  await writeFile(path, '').catch(() => { /* stamp is an optimization, not correctness */ })
}

// ── update pipeline ───────────────────────────────────────────────────────────

/** Kick off the update pipeline; false when another operation is in flight. */
export function startUpdate(): boolean {
  if (state.phase !== 'idle') return false
  state.phase = 'updating'
  state.events = []
  void runUpdatePipeline()
  return true
}

type StepStatus = 'run' | 'ok' | 'fail' | 'skip'

async function runUpdatePipeline(): Promise<void> {
  const step = (key: string, label: string, status: StepStatus, detail?: string) =>
    broadcast('step', { key, label, status, detail })
  const onLine = (line: string) => broadcast('log', { line })
  let merged = false

  try {
    const git = await ensureGit()

    step('inspect', 'Checking the working tree', 'run')
    const dirty = await capture(['status', '--porcelain'])
    if (dirty) {
      step('inspect', 'Checking the working tree', 'fail')
      throw new Error(
        'The server checkout has local changes, so updating could lose work. Resolve them on the server (commit, stash, or revert), then try again.',
      )
    }
    step('inspect', 'Checking the working tree', 'ok')

    step('fetch', 'Fetching the latest code', 'run')
    await run(git, [...gitSafe(), 'fetch', 'origin'], { cwd: REPO_ROOT, onLine, timeoutMs: 300_000 })
    const behind = Number.parseInt(await capture(['rev-list', '--count', 'HEAD..@{u}']), 10) || 0
    state.behind = behind
    state.remoteShort = await capture(['rev-parse', '--short', '@{u}'])
    state.lastCheckedAt = Date.now()
    await setAppSetting('server.update_last_check', state.lastCheckedAt)
    if (behind === 0) {
      step('fetch', 'Fetching the latest code', 'ok', 'Already up to date')
      broadcast('done', { upToDate: true })
      state.phase = 'idle'
      return
    }
    step('fetch', 'Fetching the latest code', 'ok', `${behind} commit${behind === 1 ? '' : 's'} to apply`)

    // Snapshot the database before any code changes, so a bad update (or a schema
    // migration in the new version) is recoverable from Admin → Storage → Backups.
    // A failed snapshot aborts the update: the safety net is the whole point.
    step('backup', 'Snapshotting the database', 'run')
    const { runBackup } = await import('@/lib/backup')
    const snapshot = await runBackup('pre-update', { includeFiles: false })
    if (!snapshot.ok) {
      step('backup', 'Snapshotting the database', 'fail')
      throw new Error(`Pre-update backup failed, so the update was not applied: ${snapshot.error}`)
    }
    step('backup', 'Snapshotting the database', 'ok', snapshot.dbFileName)

    const beforeShort = await capture(['rev-parse', '--short', 'HEAD'])
    step('merge', 'Applying the update', 'run')
    await run(git, [...gitSafe(), 'merge', '--ff-only', '@{u}'], { cwd: REPO_ROOT, onLine })
    merged = true
    const afterShort = await capture(['rev-parse', '--short', 'HEAD'])
    // Warn when the launcher scripts changed: the running supervise loop is
    // old code until the operator relaunches manually.
    const changedFiles = await capture(['diff', '--name-only', `${beforeShort}..HEAD`]).catch(() => '')
    const launcherChanged = /^run(-dev)?\.(ps1|sh)$/m.test(changedFiles)
    step('merge', 'Applying the update', 'ok', `${beforeShort} → ${afterShort}`)

    for (const [key, dir, label] of [
      ['deps-backend', BACKEND_DIR, 'Refreshing backend dependencies'],
      ['deps-frontend', FRONTEND_DIR, 'Refreshing frontend dependencies'],
    ] as const) {
      step(key, label, 'run')
      // process.execPath = the running Bun binary; safer than resolving 'bun'
      // from PATH (the scheduled/console environment may differ).
      await run(process.execPath, ['install'], { cwd: dir, onLine, timeoutMs: 600_000 })
      await touchStamp(join(dir, 'node_modules', '.loki-install-stamp'))
      step(key, label, 'ok')
    }

    if (process.env.NODE_ENV === 'development') {
      step('build', 'Rebuilding the app', 'skip', 'Dev mode serves the UI through Vite; no bundle to build')
    } else {
      step('build', 'Rebuilding the app', 'run')
      await buildFrontendStaged(onLine)
      step('build', 'Rebuilding the app', 'ok')
    }

    step('restart', 'Restarting the server', 'run')
    state.phase = 'restarting'
    await emitNotification({
      type: 'system',
      userId: null,
      title: 'Server updated',
      body: `Updated ${beforeShort} → ${afterShort} (${behind} commit${behind === 1 ? '' : 's'}). Restarting now.${launcherChanged ? ' Note: the launcher script changed, so relaunch run.ps1 manually when convenient to pick it up.' : ''}`,
      url: '/admin/system/server',
      dedupeKey: `server_update_applied:${afterShort}`,
    })
    await stopSidecarsForExit()
    broadcast('done', { willRestart: true, version: afterShort, launcherChanged })
    // Let the SSE buffer flush to clients, then exit; the launcher's supervise
    // loop starts the new code (same choreography as routes/adminUninstall.ts).
    setTimeout(() => process.exit(0), 1_500)
  } catch (err) {
    const base = err instanceof Error ? err.message : String(err)
    const message = merged
      ? `The code was updated but a later step failed: ${base} The server is still running the previous version. Fix the issue and run the update again, or restart to boot the new backend with the old UI bundle.`
      : base
    logger.warn(`[server-update] update failed: ${base}`)
    await rm(join(FRONTEND_DIR, 'dist-staging'), { recursive: true, force: true }).catch(() => {})
    broadcast('error', { message })
    state.phase = 'idle'
  }
}

// Build into dist-staging and swap it in only on success — a failed build must
// leave the served dist untouched. Mirrors the frontend `build` script
// (prebuild asset copies + tsc -b + vite build) as explicit steps so the
// --outDir flag deterministically reaches vite.
async function buildFrontendStaged(onLine: (line: string) => void): Promise<void> {
  const dist = join(FRONTEND_DIR, 'dist')
  const staging = join(FRONTEND_DIR, 'dist-staging')
  const old = join(FRONTEND_DIR, 'dist-old')
  await rm(staging, { recursive: true, force: true })

  await run(process.execPath, ['run', 'prebuild'], { cwd: FRONTEND_DIR, onLine, timeoutMs: 120_000 })
  await run(process.execPath, ['x', 'tsc', '-b'], { cwd: FRONTEND_DIR, onLine, timeoutMs: 600_000 })
  await run(process.execPath, ['x', 'vite', 'build', '--outDir', 'dist-staging', '--emptyOutDir'], {
    cwd: FRONTEND_DIR,
    onLine,
    timeoutMs: 900_000,
  })
  if (!existsSync(join(staging, 'index.html'))) {
    throw new Error('The build finished but produced no index.html — not swapping it in.')
  }

  await rm(old, { recursive: true, force: true })
  if (existsSync(dist)) await renameWithRetry(dist, old)
  try {
    await renameWithRetry(staging, dist)
  } catch (err) {
    // Put the old bundle back so the app keeps serving something.
    await renameWithRetry(old, dist).catch(() => {})
    throw err
  }
  // Stamp AFTER the swap so it's newer than every pulled source file.
  await touchStamp(join(dist, '.loki-build-stamp'))
  void rm(old, { recursive: true, force: true }).catch(() => {})
}

// ── background update-check poller ───────────────────────────────────────────

const POLL_WAKE_MS = 15 * 60_000

let _timer: ReturnType<typeof setInterval> | null = null
let _polling = false

async function pollOnce(): Promise<void> {
  if (state.phase !== 'idle') return
  if (!isGitCheckout()) return
  const settings = await getUpdateSettings()
  if (settings.mode === 'off') return
  await loadLastCheck()
  const intervalMs = Math.max(1, settings.intervalHours) * 3_600_000
  if (state.lastCheckedAt && Date.now() - state.lastCheckedAt < intervalMs) return

  const res = await checkForUpdates()
  if (!res || res.behind === 0) return

  if (settings.mode === 'auto') {
    logger.info(`[server-update] auto mode: ${res.behind} commit(s) behind — starting update`)
    startUpdate()
    return
  }
  await emitNotification({
    type: 'system',
    userId: null,
    title: 'Server update available',
    body: `${res.behind} new commit${res.behind === 1 ? '' : 's'} ready to install. Open Admin, then System, then Server to apply the update.`,
    url: '/admin/system/server',
    dedupeKey: `server_update_available:${res.remoteShort}`,
  })
}

export function startUpdateCheckPoller(): void {
  if (_timer) return
  _timer = setInterval(() => {
    if (_polling) return
    _polling = true
    pollOnce()
      .catch((err) => logger.warn(`[server-update] poll failed: ${err instanceof Error ? err.message : err}`))
      .finally(() => { _polling = false })
  }, POLL_WAKE_MS)
  logger.info('[server-update] update-check poller started')
}

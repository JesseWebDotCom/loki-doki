// yt-dlp binary manager + auto-updater.
//
// YouTube changes its player/signature/throttling constantly, so a stale yt-dlp is the
// single most common cause of downloads and stream resolution silently breaking. The
// rest of the app shells out via `ytDlpBin()` instead of a hardcoded `'yt-dlp'`, and
// this module keeps that binary fresh:
//
//   1. A managed copy under data/bin/ is always preferred and self-updates via `-U`.
//   2. Otherwise a system install on PATH is used and updated via `-U` when possible.
//   3. If neither exists — or a PATH install can't self-update (pip/brew/apt builds
//      reject `-U`) — we download the standalone release into data/bin/ so that future
//      updates always work. This also self-heals a missing dependency, matching how the
//      rest of the app auto-provisions Ollama, sd.cpp, kiwix, etc.
//
// Checks are throttled (daily at boot, forced weekly) and entirely best-effort: any
// failure logs a warning and leaves the previous binary in place.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, statSync } from 'node:fs'
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dataDir } from '@/lib/download'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { logger } from '@/lib/logger'

const execFileAsync = promisify(execFile)

const IS_WIN = process.platform === 'win32'
const BIN_NAME = IS_WIN ? 'yt-dlp.exe' : 'yt-dlp'
const BIN_DIR = join(dataDir, 'bin')
const MANAGED_PATH = join(BIN_DIR, BIN_NAME)
// yt-dlp's pure-Python zipapp: on macOS/Linux with a modern Python we run this behind a tiny
// wrapper at MANAGED_PATH (see provisionZipapp). It starts in ~0.3s vs ~8s for the
// self-contained PyInstaller onefile, which cold-unpacks 30+MB on EVERY invocation.
const MANAGED_PYZ = join(BIN_DIR, 'yt-dlp.pyz')
const ZIPAPP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp'
const COOKIES_DIR = join(dataDir, 'youtube')
const COOKIES_PATH = join(COOKIES_DIR, 'cookies.txt')
const COOKIES_UPLOADED_KEY = 'youtube.cookies_uploaded_at'

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000        // re-check at most once a day at boot
const UPDATE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000   // forced refresh cadence while running
const CHECKED_KEY = 'youtube.ytdlp_checked_at'
const VERSION_KEY = 'youtube.ytdlp_version'

// The fully self-contained release asset for this platform (no Python required, and it
// supports `-U` self-updates — unlike the pip zipapp).
function releaseUrl(): string {
  const base = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'
  if (IS_WIN) return `${base}/yt-dlp.exe`
  if (process.platform === 'darwin') return `${base}/yt-dlp_macos`
  return `${base}/yt-dlp_linux`
}

// The binary every other module shells out to. ensureYtDlp() (boot) verifies and promotes
// as needed; read synchronously by the spawn call sites. The DEFAULT must already prefer an
// existing managed copy: bun --hot re-evaluates this module on any backend file change,
// wiping the boot-time promotion — with a bare 'yt-dlp' default (not on PATH here), every
// download/save after a hot reload failed with uv_spawn ENOENT until the next full restart
// (confirmed live 2026-07-06: 20 saves failed in one burst mid-dev-session).
let resolvedBin = existsSync(MANAGED_PATH) ? MANAGED_PATH : 'yt-dlp'
export function ytDlpBin(): string { return resolvedBin }

// Bound concurrent yt-dlp subprocesses spawned by synchronous request paths (stream
// resolution, format probing) and by the videos-hub background cache warmer (feed.ts,
// TikTok creator profiles) so a burst can't fork-bomb the host — each process holds a
// multi-MB buffer and a network connection. The durable download queue handles exports
// separately and isn't gated here. Raised from 3: the warmer alone fans out to a dozen-
// plus creators, and at 3 slots that serialized into enough waves (each paying a cold
// PyInstaller start) to leave the videos hub home page taking 30-60s to show content.
//
// Two classes share the pool. INTERACTIVE work (a member clicking play → stream resolve,
// the clipper resolving a pasted link, a direct creator-profile visit) can use every slot.
// BACKGROUND work (the videos poller warming dozens of TikTok browse/creator caches) is
// capped to MAX_CONCURRENT - RESERVED so a warm burst can never hold all six slots and
// stall an interactive resolve — the exact failure that made a Vimeo click wait until
// TikTok's cache warm finished. When a slot frees, interactive waiters are always served
// before background ones.
const MAX_CONCURRENT = 6
const RESERVED_INTERACTIVE = 2
const MAX_BACKGROUND = MAX_CONCURRENT - RESERVED_INTERACTIVE

let active = 0
let activeBackground = 0
interface SlotWaiter { grant: () => void; background: boolean }
const waiters: SlotWaiter[] = []

function slotFree(background: boolean): boolean {
  if (active >= MAX_CONCURRENT) return false
  if (background && activeBackground >= MAX_BACKGROUND) return false
  return true
}

// Dispatch as many queued waiters as capacity allows, interactive first so a background
// warm never jumps ahead of a user-facing resolve.
function pumpSlots(): void {
  for (const wantBackground of [false, true]) {
    let i: number
    while ((i = waiters.findIndex((w) => w.background === wantBackground && slotFree(w.background))) !== -1) {
      const [w] = waiters.splice(i, 1)
      active++
      if (w!.background) activeBackground++
      w!.grant()
    }
  }
}

export async function withYtDlpSlot<T>(fn: () => Promise<T>, opts?: { background?: boolean }): Promise<T> {
  const background = opts?.background ?? false
  // Always queue (even when a slot is free) so ordering + priority run through one path.
  await new Promise<void>((resolve) => { waiters.push({ grant: resolve, background }); pumpSlots() })
  try {
    return await fn()
  } finally {
    active--
    if (background) activeBackground--
    pumpSlots()
  }
}

// Probe `--version`. The managed binary is a self-contained PyInstaller bundle whose
// FIRST cold start (right after a download or a reboot, under heavy boot load) can take
// many seconds while it unpacks — so use a generous timeout and an optional retry before
// giving up. A false negative here used to trigger a needless full re-download.
async function versionOf(bin: string, attempts = 1): Promise<string | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 30_000, windowsHide: true })
      const v = stdout.trim()
      if (v) return v
    } catch { /* slow cold start or transient failure — retry */ }
  }
  return null
}

// A present managed binary is only "corrupt" if it's implausibly small (an interrupted
// write). A real binary that merely failed to answer --version in time is NOT corrupt
// and must not be re-downloaded.
function looksCorrupt(path: string): boolean {
  try { return statSync(path).size < 1_000_000 } catch { return true }
}

async function selfUpdate(bin: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(bin, ['-U'], { timeout: 180_000, windowsHide: true })
    const line = stdout.trim().split('\n').filter(Boolean).pop() ?? ''
    logger.info(`[yt-dlp] update check (${bin}): ${line || 'up to date'}`)
    return true
  } catch (err) {
    // pip/brew/apt installs reject `-U` ("not installed by yt-dlp"). Best-effort only.
    logger.warn(`[yt-dlp] '-U' self-update unavailable for ${bin}: ${err}`)
    return false
  }
}

async function downloadManaged(): Promise<boolean> {
  try {
    await mkdir(BIN_DIR, { recursive: true })
    const res = await fetch(releaseUrl(), { redirect: 'follow', signal: AbortSignal.timeout(180_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength < 1_000_000) throw new Error(`suspiciously small download (${buf.byteLength} bytes)`)

    // Write to a temp name then rename so a crash mid-download never leaves a partial
    // binary in place.
    const part = `${MANAGED_PATH}.part`
    await writeFile(part, buf)
    if (!IS_WIN) await chmod(part, 0o755)
    await rename(part, MANAGED_PATH)

    resolvedBin = MANAGED_PATH
    logger.info(`[yt-dlp] installed managed binary → ${MANAGED_PATH}`)
    return true
  } catch (err) {
    logger.warn(`[yt-dlp] managed download failed: ${err}`)
    return false
  }
}

// yt-dlp's recent releases need Python >= 3.10. Probe common absolute interpreter paths
// (never a bare `python3` — a subprocess PATH may differ from ours) and return the first
// modern one, for the zipapp wrapper. Empty on Windows, where we keep the .exe onefile.
async function resolveModernPython(): Promise<string | null> {
  if (IS_WIN) return null
  const candidates = [
    '/opt/homebrew/bin/python3', '/opt/homebrew/bin/python3.13', '/opt/homebrew/bin/python3.12',
    '/opt/homebrew/bin/python3.11', '/usr/local/bin/python3', '/usr/bin/python3',
  ]
  for (const py of candidates) {
    if (!existsSync(py)) continue
    try {
      const { stdout } = await execFileAsync(py, ['-c', 'import sys;print("%d.%d"%sys.version_info[:2])'], { timeout: 10_000 })
      const [maj, min] = stdout.trim().split('.').map(Number)
      if ((maj ?? 0) > 3 || ((maj ?? 0) === 3 && (min ?? 0) >= 10)) return py
    } catch { /* not runnable / too old — try the next */ }
  }
  return null
}

function shQuote(s: string): string { return `'${s.replace(/'/g, `'\\''`)}'` }

/** True once MANAGED_PATH is our tiny zipapp wrapper (not the 30+MB onefile). */
function isWrapperInstalled(): boolean {
  try { return existsSync(MANAGED_PYZ) && statSync(MANAGED_PATH).size < 1_000_000 } catch { return false }
}

/** Download the zipapp and write a shell wrapper at MANAGED_PATH that execs it via `python`,
 *  so every spawn(ytDlpBin(), args) call site is unchanged. Replaces any onefile in place. */
async function provisionZipapp(python: string): Promise<boolean> {
  try {
    await mkdir(BIN_DIR, { recursive: true })
    const res = await fetch(ZIPAPP_URL, { redirect: 'follow', signal: AbortSignal.timeout(120_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength < 1_000_000) throw new Error(`suspiciously small download (${buf.byteLength} bytes)`)

    const pyzPart = `${MANAGED_PYZ}.part`
    await writeFile(pyzPart, buf)
    await rename(pyzPart, MANAGED_PYZ)

    const wrapper = `#!/bin/sh\nexec ${shQuote(python)} ${shQuote(MANAGED_PYZ)} "$@"\n`
    const wPart = `${MANAGED_PATH}.part`
    await writeFile(wPart, wrapper)
    await chmod(wPart, 0o755)
    await rename(wPart, MANAGED_PATH)   // atomically replaces a prior onefile/wrapper

    resolvedBin = MANAGED_PATH
    logger.info(`[yt-dlp] installed fast zipapp via ${python} → ${MANAGED_PATH}`)
    return true
  } catch (err) {
    logger.warn(`[yt-dlp] zipapp provision failed: ${err}`)
    return false
  }
}

// The onefile decision tree — the fallback used when no modern Python is available for the
// (much faster) zipapp. `due` is precomputed by ensureYtDlp; this only sets resolvedBin.
async function ensureOnefileMode(due: boolean): Promise<void> {
  if (existsSync(MANAGED_PATH)) {
    // A managed copy exists — prefer it, but only COMMIT once it's verified to run.
    if (await versionOf(MANAGED_PATH, 2)) {
      resolvedBin = MANAGED_PATH
      if (due) await selfUpdate(MANAGED_PATH)
    } else if (looksCorrupt(MANAGED_PATH)) {
      // Genuinely broken (partial/tiny write — including a stale zipapp wrapper whose Python
      // vanished) → re-provision the onefile; fall back to PATH.
      logger.warn('[yt-dlp] managed binary corrupt (too small) — re-downloading')
      if (!(await downloadManaged()) && (await versionOf('yt-dlp'))) resolvedBin = 'yt-dlp'
    } else if (await versionOf('yt-dlp')) {
      resolvedBin = 'yt-dlp'
      logger.warn('[yt-dlp] managed binary version probe timed out — falling back to PATH yt-dlp')
    } else {
      resolvedBin = MANAGED_PATH
      logger.warn('[yt-dlp] managed binary present; version probe timed out and no PATH fallback — keeping it')
    }
  } else if (await versionOf('yt-dlp')) {
    resolvedBin = 'yt-dlp'
    if (due) {
      const updated = await selfUpdate('yt-dlp')
      if (!updated) await downloadManaged()
    }
  } else {
    await downloadManaged()
  }
}

/** Resolve the binary to use and, when due, update it. Never throws. Prefers the fast
 *  pure-Python zipapp (behind a wrapper) when a modern Python exists; else the onefile. */
export async function ensureYtDlp(force = false): Promise<void> {
  try {
    const last = (await getAppSetting(CHECKED_KEY)) as number | null
    const due = force || !last || Date.now() - last > CHECK_INTERVAL_MS

    const python = await resolveModernPython()
    if (python) {
      // Already on the zipapp wrapper and it runs → keep it; refresh the pyz when due.
      if (isWrapperInstalled() && (await versionOf(MANAGED_PATH, 2))) {
        resolvedBin = MANAGED_PATH
        if (due) await provisionZipapp(python)
      } else if (!(await provisionZipapp(python))) {
        // Building the zipapp failed (e.g. offline) — fall back to the onefile path.
        await ensureOnefileMode(due)
      }
    } else {
      await ensureOnefileMode(due)
    }

    const v = await versionOf(resolvedBin, 2)
    if (v) {
      await setAppSetting(VERSION_KEY, v)
      logger.info(`[yt-dlp] active binary: ${resolvedBin} (version ${v})`)
    }
    await setAppSetting(CHECKED_KEY, Date.now())
  } catch (err) {
    logger.warn(`[yt-dlp] ensure failed: ${err}`)
  }
}

export interface YtDlpStatus {
  binary: string
  managed: boolean
  version: string | null
  checkedAt: number | null   // epoch ms of the last check, or null if never
}

/** Current binary + last-known version/check time, for the admin panel. */
export async function getYtDlpStatus(): Promise<YtDlpStatus> {
  const version = (await getAppSetting(VERSION_KEY)) as string | null
  const checkedAt = (await getAppSetting(CHECKED_KEY)) as number | null
  return { binary: resolvedBin, managed: resolvedBin === MANAGED_PATH, version: version ?? null, checkedAt: checkedAt ?? null }
}

// Admin-uploaded cookies.txt (Netscape format), used for downloads/exports/transcripts
// that hit an age-gated or members-only video. Deliberately NOT applied to stream.ts's
// live-playback resolve fallback — that path runs on every household member's normal
// viewing, and forcing a single personal YouTube session onto shared traffic risks that
// account getting flagged for anomalous concurrent-session behavior.
export function ytDlpAuthArgs(): string[] {
  return existsSync(COOKIES_PATH) ? ['--cookies', COOKIES_PATH] : []
}

export async function saveCookiesFile(buf: Buffer): Promise<void> {
  await mkdir(COOKIES_DIR, { recursive: true })
  const part = `${COOKIES_PATH}.part`
  await writeFile(part, buf)
  await rename(part, COOKIES_PATH)
  await setAppSetting(COOKIES_UPLOADED_KEY, Date.now())
}

export async function clearCookiesFile(): Promise<void> {
  try { await unlink(COOKIES_PATH) } catch { /* already gone */ }
  await setAppSetting(COOKIES_UPLOADED_KEY, null)
}

export async function getCookiesStatus(): Promise<{ present: boolean; uploadedAt: number | null }> {
  const uploadedAt = (await getAppSetting(COOKIES_UPLOADED_KEY)) as number | null
  return { present: existsSync(COOKIES_PATH), uploadedAt: uploadedAt ?? null }
}

let _timer: ReturnType<typeof setInterval> | null = null

/** Boot hook: resolve + (throttled) update now, then refresh weekly. */
export function startYtdlpAutoUpdate(): void {
  void ensureYtDlp()
  if (_timer) return
  _timer = setInterval(() => { void ensureYtDlp(true) }, UPDATE_INTERVAL_MS)
}

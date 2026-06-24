// aria2c resolver + ZIM downloader.
//
// Large ZIM archives (Wikipedia 12 GB, Stack Overflow 50 GB, TED 82 GB) used to download as a
// single fetch() stream from one Kiwix mirror — one TCP flow to one (often distant, throttled)
// server, which is why they crawled for 12+ hours. aria2c fed an on-disk Metalink (.meta4)
// opens up to 16 segments spread across ALL of Kiwix's mirrors simultaneously, saturating the
// local link instead, and brings resume + multi-mirror failover + checksum verification for free.
//
// Resolution mirrors ensureFfmpeg(): prefer aria2c on PATH, then a managed copy, then acquire
// one (Windows: official static build; macOS/Linux: the system package manager, best-effort).
// It NEVER throws — when no aria2c can be found the caller falls back to a plain single-stream
// resumable fetch, so library downloads still work (just slower) on a host without aria2.

import { existsSync } from 'node:fs'
import { mkdir, rm, readdir, chmod, copyFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn, execFile, exec } from 'node:child_process'
import { promisify } from 'node:util'
import { dataDir } from '@/lib/download'
import type { DownloadProgress } from '@/lib/download'
import { IS_WIN, extractZip } from '@/lib/platform'
import { logger } from '@/lib/logger'

const execFileAsync = promisify(execFile)
const execAsync = promisify(exec)

const BIN_DIR = join(dataDir, 'bin')
const MANAGED_PATH = join(BIN_DIR, IS_WIN ? 'aria2c.exe' : 'aria2c')

// Official aria2 releases ship a Windows static build only (no macOS/Linux binaries), so those
// platforms resolve via PATH or the system package manager.
const ARIA2_WIN_URL = 'https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip'

const SYSTEM_CANDIDATES = IS_WIN
  ? []
  : ['/opt/homebrew/bin/aria2c', '/usr/local/bin/aria2c', '/usr/bin/aria2c']

async function works(bin: string): Promise<boolean> {
  try { await execFileAsync(bin, ['--version'], { timeout: 8_000 }); return true } catch { return false }
}

async function findFile(dir: string, name: string): Promise<string | null> {
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()!
    let entries
    try { entries = await readdir(d, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.name === name) return p
    }
  }
  return null
}

async function downloadWindowsBuild(): Promise<boolean> {
  const archive = join(BIN_DIR, 'aria2-dl.zip')
  const extractDir = join(BIN_DIR, '_aria2_extract')
  try {
    await mkdir(BIN_DIR, { recursive: true })
    logger.info(`[aria2] downloading static build from ${ARIA2_WIN_URL}`)
    const res = await fetch(ARIA2_WIN_URL, { redirect: 'follow', signal: AbortSignal.timeout(120_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength < 500_000) throw new Error(`suspiciously small download (${buf.byteLength} bytes)`)
    await writeFile(archive, buf)
    await rm(extractDir, { recursive: true, force: true })
    await mkdir(extractDir, { recursive: true })
    extractZip(archive, extractDir, 120_000)
    const found = await findFile(extractDir, 'aria2c.exe')
    if (!found) throw new Error('aria2c.exe not found inside archive')
    await copyFile(found, MANAGED_PATH)
    logger.info(`[aria2] installed managed binary → ${MANAGED_PATH}`)
    return true
  } catch (err) {
    logger.warn(`[aria2] managed download failed: ${err}`)
    return false
  } finally {
    await rm(archive, { force: true }).catch(() => {})
    await rm(extractDir, { recursive: true, force: true }).catch(() => {})
  }
}

// macOS/Linux: best-effort install via the system package manager (same convention as
// installTesseract). Quietly fails → the caller falls back to single-stream.
async function installViaPackageManager(): Promise<boolean> {
  try {
    if (process.platform === 'darwin') {
      if (!(existsSync('/opt/homebrew/bin/brew') || existsSync('/usr/local/bin/brew'))) return false
      logger.info('[aria2] installing via Homebrew…')
      await execAsync('brew install aria2', { timeout: 180_000 })
      return true
    }
    if (existsSync('/usr/bin/apt-get')) {
      logger.info('[aria2] installing via apt-get…')
      await execAsync('apt-get install -y aria2', { timeout: 180_000 })
      return true
    }
  } catch (err) {
    logger.warn(`[aria2] package-manager install failed: ${err}`)
  }
  return false
}

let resolvePromise: Promise<string | null> | null = null

/**
 * Resolve a usable aria2c and return its path, or null if none is available. Prefers PATH,
 * then a managed copy, then acquires one. Concurrent callers share one resolution; a failed
 * resolution is not cached, so a later download attempt can retry the acquisition.
 */
export function ensureAria2(): Promise<string | null> {
  if (resolvePromise) return resolvePromise
  resolvePromise = (async () => {
    if (existsSync(MANAGED_PATH) && (await works(MANAGED_PATH))) return MANAGED_PATH
    if (await works('aria2c')) return 'aria2c'
    for (const c of SYSTEM_CANDIDATES) if (existsSync(c) && (await works(c))) return c
    if (IS_WIN) return (await downloadWindowsBuild()) ? MANAGED_PATH : null
    if (await installViaPackageManager()) {
      if (await works('aria2c')) return 'aria2c'
      for (const c of SYSTEM_CANDIDATES) if (existsSync(c) && (await works(c))) return c
    }
    return null
  })()
  resolvePromise.then((bin) => { if (!bin) resolvePromise = null }).catch(() => { resolvePromise = null })
  return resolvePromise
}

// ── Progress parsing ────────────────────────────────────────────────────────────
// aria2's console readout (with --summary-interval=1) looks like:
//   [#2089b0 400.0MiB/3.6GiB(10%) CN:8 DL:11MiB ETA:4m48s]
// Sizes use binary units (KiB/MiB/GiB…). DL is bytes/sec; ETA is a compact duration.

function parseSize(raw: string): number {
  const m = raw.replace(/\s/g, '').match(/^([\d.]+)([KMGTP]?)i?B$/i)
  if (!m?.[1]) return 0
  const mult: Record<string, number> = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 }
  return Math.round(parseFloat(m[1]) * (mult[(m[2] ?? '').toUpperCase()] ?? 1))
}

function parseEta(raw: string): number {
  let sec = 0
  const unit: Record<string, number> = { d: 86400, h: 3600, m: 60, s: 1 }
  for (const m of raw.matchAll(/(\d+)([dhms])/g)) sec += Number(m[1]) * (unit[m[2] ?? ''] ?? 0)
  return sec
}

/**
 * Download a ZIM via aria2c using an on-disk Metalink. We pass --metalink-file (NOT a streamed
 * URL) deliberately: aria2's in-memory metalink parser aborts above 5 MiB, and a 50 GB ZIM's
 * .meta4 (with piece hashes) exceeds that — passing it as a file sidesteps the limit.
 *
 * aria2 writes the file straight to `destDir/fileName` (resuming via its .aria2 control file)
 * and verifies piece hashes from the metalink as it goes. Rejects on non-zero exit; treats an
 * abort as a cancellation. `totalBytes` (from the catalog) seeds progress before aria2's first
 * readout so the UI never shows a blank bar.
 */
export async function downloadZimWithAria2(
  bin: string,
  meta4Path: string,
  destDir: string,
  fileName: string,
  totalBytes: number,
  onProgress: (p: DownloadProgress) => void,
  signal: AbortSignal,
): Promise<void> {
  await mkdir(destDir, { recursive: true })
  const args = [
    '--metalink-file', meta4Path,
    '--dir', destDir,
    '--continue=true',
    '--max-connection-per-server=16',
    '--split=16',
    '--min-split-size=1M',
    '--max-tries=0',          // retry forever; the job-level stall watchdog bounds a dead mirror
    '--retry-wait=10',
    '--max-file-not-found=5',
    '--connect-timeout=30',
    '--timeout=60',
    '--summary-interval=1',
    '--console-log-level=warn',
    '--auto-file-renaming=false',
    '--allow-overwrite=true',
    '--file-allocation=none',  // don't pre-allocate 80 GB up front (can stall on some filesystems)
  ]

  return new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { cwd: destDir, stdio: ['ignore', 'pipe', 'pipe'] })
    const onAbort = () => { try { child.kill('SIGTERM') } catch { /* already dead */ } }
    signal.addEventListener('abort', onAbort, { once: true })

    const tail: string[] = []
    const handle = (buf: Buffer) => {
      const text = buf.toString()
      for (const line of text.split(/[\r\n]+/)) {
        const sizeM = line.match(/([\d.]+\s*[KMGTP]?i?B)\/([\d.]+\s*[KMGTP]?i?B)\((\d+)%\)/)
        if (sizeM?.[1] && sizeM[2]) {
          const completed = parseSize(sizeM[1])
          const total = parseSize(sizeM[2]) || totalBytes
          const dlM = line.match(/DL:\s*([\d.]+\s*[KMGTP]?i?B)/)
          const speedBps = dlM?.[1] ? parseSize(dlM[1]) : 0
          const etaM = line.match(/ETA:\s*([0-9dhms]+)/)
          const etaSeconds = etaM?.[1] ? parseEta(etaM[1]) : (speedBps > 0 ? (total - completed) / speedBps : 0)
          onProgress({ completed, total, speedBps, etaSeconds })
        }
      }
      const trimmed = text.trim()
      if (trimmed) { tail.push(trimmed); if (tail.length > 20) tail.shift() }
    }
    child.stdout?.on('data', handle)
    child.stderr?.on('data', handle)

    child.on('error', (err) => { signal.removeEventListener('abort', onAbort); reject(err) })
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort)
      if (signal.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return }
      if (code === 0) { resolve(); return }
      reject(new Error(`aria2c exited with code ${code}\n${tail.slice(-6).join('\n')}`))
    })
  })
}

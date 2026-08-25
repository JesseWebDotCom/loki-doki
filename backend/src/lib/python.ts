// Python resolver with on-demand auto-download (for the optional ComfyUI image stack).
//
// ComfyUI needs a real Python ≥3.10 to build its venv. We don't bundle it — we resolve
// one: prefer a suitable interpreter already on the system, else a managed copy under
// data/bin, else download a relocatable build from python-build-standalone (the same
// project Astral's `uv` uses). Unlike a single binary, Python needs its whole install
// tree, so the managed copy is a directory. Lazy: only downloads when image gen installs.

import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dataDir, downloadUrl } from '@/lib/download'
import { IS_WIN, extractArchive } from '@/lib/platform'
import { logger } from '@/lib/logger'

const execFileAsync = promisify(execFile)

const BIN_DIR = join(dataDir, 'bin')
const MANAGED_DIR = join(BIN_DIR, 'python-standalone')  // holds the extracted `python/` tree
// python-build-standalone's install_only layout: python/python.exe (win) | python/bin/python3 (unix)
const MANAGED_PY = IS_WIN
  ? join(MANAGED_DIR, 'python', 'python.exe')
  : join(MANAGED_DIR, 'python', 'bin', 'python3')

let resolvedBin = ''
let resolvePromise: Promise<string | null> | null = null

export function pythonBin(): string | null { return resolvedBin || null }

// python-build-standalone target triple for this platform/arch.
function triple(): string {
  const arm = process.arch === 'arm64'
  if (IS_WIN) return arm ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
  if (process.platform === 'darwin') return arm ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  return arm ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu'
}

// Returns the Python minor version (3.x) if the interpreter runs and is ≥3.10, else null.
async function suitableMinor(bin: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(bin, ['-c', 'import sys;print(sys.version_info.major,sys.version_info.minor)'], { timeout: 10_000, windowsHide: true })
    const parts = stdout.trim().split(/\s+/).map(Number)
    const maj = parts[0], min = parts[1]
    return maj === 3 && min !== undefined && min >= 10 ? min : null
  } catch { return null }
}

// Existing system interpreters worth trying before downloading.
function systemCandidates(): string[] {
  if (IS_WIN) return ['python', 'python3']
  return [
    '/opt/homebrew/bin/python3.13', '/opt/homebrew/bin/python3.12', '/opt/homebrew/bin/python3.11', '/opt/homebrew/bin/python3.10',
    '/usr/local/bin/python3.13', '/usr/local/bin/python3.12', '/usr/local/bin/python3.11', '/usr/local/bin/python3.10',
    'python3',
  ]
}

// Discover an install_only asset URL from the latest python-build-standalone release.
// Prefer CPython 3.12 (broadest torch/ComfyUI wheel coverage), else any.
async function discoverUrl(): Promise<string | null> {
  try {
    const res = await fetch('https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest', {
      headers: { 'User-Agent': 'maipai-home', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json() as { assets?: { name: string; browser_download_url: string }[] }
    const assets = json.assets ?? []
    const t = triple()
    const ok = (a: { name: string }) => a.name.includes(t) && a.name.endsWith('install_only.tar.gz')
    const pick = assets.find((a) => ok(a) && /cpython-3\.12\./.test(a.name)) ?? assets.find(ok)
    return pick?.browser_download_url ?? null
  } catch (err) {
    logger.warn(`[python] release discovery failed: ${err}`)
    return null
  }
}

// python-build-standalone publishes a `<asset>.sha256` sidecar for every release
// asset. Best-effort: if unreachable, install proceeds unverified.
async function officialSha256(assetUrl: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${assetUrl}.sha256`, { redirect: 'follow', signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return undefined
    const hex = (await res.text()).trim().split(/\s+/)[0]
    return /^[a-f0-9]{64}$/i.test(hex ?? '') ? hex : undefined
  } catch { return undefined }
}

async function downloadManaged(): Promise<boolean> {
  const url = await discoverUrl()
  if (!url) return false
  const archive = join(BIN_DIR, 'python-dl.tar.gz')
  try {
    await mkdir(BIN_DIR, { recursive: true })
    logger.info(`[python] downloading standalone build from ${url}`)
    // Rolling "latest" release — drop any stale leftover archive; the shared downloader
    // brings resume (.part) + retries + stall detection + checksum verification.
    await rm(archive, { force: true })
    const expectedSha256 = await officialSha256(url)
    await downloadUrl(url, archive, () => {}, undefined, { minBytes: 5_000_000, expectedSha256 })

    // Relocatable tree — extract the whole `python/` dir into the managed location.
    await rm(MANAGED_DIR, { recursive: true, force: true })
    await extractArchive(archive, MANAGED_DIR, 300_000)

    if (!existsSync(MANAGED_PY) || (await suitableMinor(MANAGED_PY)) === null) {
      throw new Error('python interpreter missing or unusable after extraction')
    }
    resolvedBin = MANAGED_PY
    logger.info(`[python] installed managed interpreter → ${MANAGED_PY}`)
    return true
  } catch (err) {
    logger.warn(`[python] managed download failed: ${err}`)
    return false
  } finally {
    await rm(archive, { force: true }).catch(() => {})
  }
}

/**
 * Resolve a Python ≥3.10 to seed the ComfyUI venv. Prefers an existing system interpreter,
 * then a managed copy, then downloads a relocatable build. Returns the interpreter path, or
 * null if none could be obtained (caller surfaces a clear error). Concurrent callers share.
 */
export function ensurePython(): Promise<string | null> {
  if (resolvePromise) return resolvePromise
  resolvePromise = (async () => {
    if (existsSync(MANAGED_PY) && (await suitableMinor(MANAGED_PY)) !== null) { resolvedBin = MANAGED_PY; return resolvedBin }
    for (const c of systemCandidates()) {
      // Skip bare names that don't resolve; check absolute paths exist first to avoid noise.
      if (c.includes('/') && !existsSync(c)) continue
      if ((await suitableMinor(c)) !== null) { resolvedBin = c; return resolvedBin }
    }
    if (await downloadManaged()) return resolvedBin
    return null
  })()
  resolvePromise.then((bin) => { if (!bin) resolvePromise = null }).catch(() => { resolvePromise = null })
  return resolvePromise
}

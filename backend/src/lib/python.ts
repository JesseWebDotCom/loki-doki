// Python resolver with on-demand auto-download (for the optional ComfyUI image stack).
//
// ComfyUI needs a real Python ≥3.10 to build its venv. We don't bundle it — we resolve
// one: prefer a suitable interpreter already on the system, else a managed copy under
// data/bin, else download a relocatable build from python-build-standalone (the same
// project Astral's `uv` uses). Unlike a single binary, Python needs its whole install
// tree, so the managed copy is a directory. Lazy: only downloads when image gen installs.

import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dataDir } from '@/lib/download'
import { IS_WIN } from '@/lib/platform'
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
    const { stdout } = await execFileAsync(bin, ['-c', 'import sys;print(sys.version_info.major,sys.version_info.minor)'], { timeout: 10_000 })
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
      headers: { 'User-Agent': 'loki-doki', Accept: 'application/vnd.github+json' },
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

async function downloadManaged(): Promise<boolean> {
  const url = await discoverUrl()
  if (!url) return false
  const archive = join(BIN_DIR, 'python-dl.tar.gz')
  try {
    await mkdir(BIN_DIR, { recursive: true })
    logger.info(`[python] downloading standalone build from ${url}`)
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(600_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength < 5_000_000) throw new Error(`suspiciously small download (${buf.byteLength} bytes)`)
    await writeFile(archive, buf)

    // Relocatable tree — extract the whole `python/` dir into the managed location.
    await rm(MANAGED_DIR, { recursive: true, force: true })
    await mkdir(MANAGED_DIR, { recursive: true })
    await execFileAsync('tar', ['-xf', archive, '-C', MANAGED_DIR], { timeout: 300_000 })  // bsdtar (Win10+/mac) + GNU tar handle .gz

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

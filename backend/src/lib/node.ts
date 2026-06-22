// Node.js resolver with on-demand auto-download.
//
// The voice sidecar (scripts/voice-server.ts) must run under Node, not Bun —
// onnxruntime-node's native addon segfaults under Bun. It also runs a .ts file directly,
// which needs Node ≥22.18 / ≥23.6 (unflagged type stripping). So we resolve a TS-capable
// Node: prefer a recent one on PATH, else a managed copy under data/bin, else download the
// official standalone build. We don't bundle it. Lazy: only downloads when voice runs.

import { existsSync } from 'node:fs'
import { mkdir, rm, readdir, chmod, copyFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dataDir } from '@/lib/download'
import { IS_WIN, extractZip } from '@/lib/platform'
import { logger } from '@/lib/logger'

const execFileAsync = promisify(execFile)

// Pinned LTS: ships unflagged `.ts` execution and has onnxruntime-node prebuilds. The
// binary stays available on nodejs.org/dist permanently, so a pin never rots.
const NODE_VERSION = 'v22.18.0'
const BIN_NAME = IS_WIN ? 'node.exe' : 'node'
const BIN_DIR = join(dataDir, 'bin')
const MANAGED_PATH = join(BIN_DIR, BIN_NAME)

let resolvedBin = 'node'
let resolvePromise: Promise<string> | null = null

export function nodeBin(): string { return resolvedBin }

function nodeArch(): string { return process.arch === 'arm64' ? 'arm64' : 'x64' }

function release(): { url: string; kind: 'zip' | 'tar' } {
  const a = nodeArch()
  if (IS_WIN) return { url: `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-win-${a}.zip`, kind: 'zip' }
  if (process.platform === 'darwin') return { url: `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-darwin-${a}.tar.gz`, kind: 'tar' }
  return { url: `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-${a}.tar.xz`, kind: 'tar' }
}

// Running a .ts entrypoint without flags needs Node ≥22.18 (or ≥23.6).
function tsCapable(version: string): boolean {
  const m = version.match(/^v?(\d+)\.(\d+)\./)
  if (!m) return false
  const major = Number(m[1]), minor = Number(m[2])
  if (major > 23) return true
  if (major === 23) return minor >= 6
  if (major === 22) return minor >= 18
  return false
}

async function versionOf(bin: string): Promise<string | null> {
  try { const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 10_000 }); return stdout.trim() || null } catch { return null }
}

// The archive nests the binary (win: node-*/node.exe; unix: node-*/bin/node) — walk to it.
async function findBinary(dir: string): Promise<string | null> {
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()!
    let entries
    try { entries = await readdir(d, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.name === BIN_NAME) return p
    }
  }
  return null
}

async function downloadManaged(): Promise<boolean> {
  const { url, kind } = release()
  const archive = join(BIN_DIR, kind === 'zip' ? 'node-dl.zip' : 'node-dl.tar')
  const extractDir = join(BIN_DIR, '_node_extract')
  try {
    await mkdir(BIN_DIR, { recursive: true })
    logger.info(`[node] downloading ${NODE_VERSION} from ${url}`)
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength < 5_000_000) throw new Error(`suspiciously small download (${buf.byteLength} bytes)`)
    await writeFile(archive, buf)

    await rm(extractDir, { recursive: true, force: true })
    await mkdir(extractDir, { recursive: true })
    if (kind === 'zip') extractZip(archive, extractDir, 180_000)
    else await execFileAsync('tar', ['-xf', archive, '-C', extractDir], { timeout: 180_000 })  // handles .gz and .xz

    const found = await findBinary(extractDir)
    if (!found) throw new Error('node binary not found inside archive')
    await copyFile(found, MANAGED_PATH)
    if (!IS_WIN) await chmod(MANAGED_PATH, 0o755)

    resolvedBin = MANAGED_PATH
    logger.info(`[node] installed managed binary → ${MANAGED_PATH}`)
    return true
  } catch (err) {
    logger.warn(`[node] managed download failed: ${err}`)
    return false
  } finally {
    await rm(archive, { force: true }).catch(() => {})
    await rm(extractDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Resolve a TS-capable Node and return its path. Prefers a recent one on PATH, then a
 * managed copy, then downloads one. Never throws — falls back to the bare 'node' name.
 * Concurrent callers share one resolution.
 */
export function ensureNode(): Promise<string> {
  if (resolvePromise) return resolvePromise
  resolvePromise = (async () => {
    if (existsSync(MANAGED_PATH)) {
      const v = await versionOf(MANAGED_PATH)
      if (v && tsCapable(v)) { resolvedBin = MANAGED_PATH; return resolvedBin }
    }
    const sys = await versionOf('node')
    if (sys && tsCapable(sys)) { resolvedBin = 'node'; return resolvedBin }
    await downloadManaged()
    return resolvedBin
  })()
  // Allow a later retry if this attempt didn't land a usable binary.
  resolvePromise.then((bin) => { if (bin === 'node' && !existsSync(MANAGED_PATH)) resolvePromise = null }).catch(() => { resolvePromise = null })
  return resolvePromise
}

// vtracer binary manager + raster→SVG tracing.
//
// The image generator is diffusion-based, so every output is raster PNG/WebP. To offer an
// "SVG (vector)" output we generate the PNG as usual and then trace it into scalable vector
// paths with vtracer (https://github.com/visioncortex/vtracer) — a standalone Rust CLI.
//
// vtracer ships prebuilt static binaries per platform as .tar.gz/.zip archives, so unlike
// yt-dlp's raw-binary release this manager also extracts the binary out of the archive
// before promoting it into data/bin/. Everything else mirrors the ytdlp.ts pattern: a
// managed copy under data/bin/ is preferred, provisioning is atomic (.part → rename), and
// resolution self-heals a missing dependency at boot / via the install registry.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { dataDir } from '@/lib/download'
import { logger } from '@/lib/logger'

const execFileAsync = promisify(execFile)

const IS_WIN = process.platform === 'win32'
const BIN_NAME = IS_WIN ? 'vtracer.exe' : 'vtracer'
const BIN_DIR = join(dataDir, 'bin')
const MANAGED_PATH = join(BIN_DIR, BIN_NAME)

// Pinned to a known-good release so the download URL is stable and reproducible.
const VTRACER_VERSION = '0.6.4'

// visioncortex/vtracer release assets, keyed by `${platform}-${arch}`.
const ASSETS: Record<string, string> = {
  'darwin-arm64': 'vtracer-aarch64-apple-darwin.tar.gz',
  'darwin-x64':   'vtracer-x86_64-apple-darwin.tar.gz',
  'linux-x64':    'vtracer-x86_64-unknown-linux-musl.tar.gz',
  'linux-arm64':  'vtracer-aarch64-unknown-linux-musl.tar.gz',
  'win32-x64':    'vtracer-x86_64-pc-windows-msvc.zip',
}

function assetName(): string | null {
  return ASSETS[`${process.platform}-${process.arch}`] ?? null
}

function releaseUrl(asset: string): string {
  return `https://github.com/visioncortex/vtracer/releases/download/${VTRACER_VERSION}/${asset}`
}

// The binary the generation pipeline shells out to. Defaults to a bare 'vtracer' (a system
// install on PATH), promoted to the managed copy once resolved. Read synchronously by
// traceToSvg — safe because it only ever moves 'vtracer' → an absolute path.
let resolvedBin = 'vtracer'
export function vtracerBin(): string { return resolvedBin }

/** True once a managed binary is present on disk (used by the install registry). */
export function isVtracerInstalled(): boolean {
  return existsSync(MANAGED_PATH) || existsSync(join(BIN_DIR, 'vtracer')) || existsSync(join(BIN_DIR, 'vtracer.exe'))
}

async function versionOf(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 30_000 })
    return stdout.trim() || null
  } catch {
    return null
  }
}

// Find the extracted vtracer binary anywhere under `dir` (archives may nest it in a folder).
async function findBinary(dir: string): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      const nested = await findBinary(full)
      if (nested) return nested
    } else if (e.name === 'vtracer' || e.name === 'vtracer.exe') {
      return full
    }
  }
  return null
}

/** Download the release archive, extract the binary, and promote it into data/bin/. */
async function downloadManaged(onStatus?: (msg: string) => void, signal?: AbortSignal): Promise<void> {
  const asset = assetName()
  if (!asset) throw new Error(`no vtracer prebuilt binary for ${process.platform}-${process.arch}`)

  await mkdir(BIN_DIR, { recursive: true })
  const workDir = join(BIN_DIR, `vtracer-extract-${randomUUID()}`)
  const archivePath = join(BIN_DIR, `${asset}.part`)

  try {
    onStatus?.('Downloading Vector Tracer…')
    const res = await fetch(releaseUrl(asset), { redirect: 'follow', signal: signal ?? AbortSignal.timeout(180_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength < 100_000) throw new Error(`suspiciously small download (${buf.byteLength} bytes)`)
    await writeFile(archivePath, buf)

    onStatus?.('Extracting Vector Tracer…')
    await mkdir(workDir, { recursive: true })
    if (asset.endsWith('.zip')) {
      await execFileAsync('unzip', ['-o', archivePath, '-d', workDir], { timeout: 120_000 })
    } else {
      await execFileAsync('tar', ['-xzf', archivePath, '-C', workDir], { timeout: 120_000 })
    }

    const extracted = await findBinary(workDir)
    if (!extracted) throw new Error('vtracer binary not found inside release archive')

    // Atomic promote: copy into a .part then rename so a crash never leaves a partial binary.
    const part = `${MANAGED_PATH}.part`
    await writeFile(part, await readFile(extracted))
    if (!IS_WIN) await chmod(part, 0o755)
    await rename(part, MANAGED_PATH)

    resolvedBin = MANAGED_PATH
    logger.info(`[vtracer] installed managed binary → ${MANAGED_PATH}`)
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
    await rm(archivePath, { force: true }).catch(() => {})
  }
}

/**
 * Resolve (and if needed provision) the vtracer binary. Throws on failure so the install
 * registry can leave the component un-recorded and retry; boot callers swallow the error.
 */
export async function ensureVtracer(onStatus?: (msg: string) => void, signal?: AbortSignal): Promise<void> {
  // A present managed copy that answers --version wins.
  if (existsSync(MANAGED_PATH)) {
    if (await versionOf(MANAGED_PATH)) {
      resolvedBin = MANAGED_PATH
      return
    }
    // Present but broken/partial — re-provision.
    logger.warn('[vtracer] managed binary present but not runnable — re-downloading')
  } else if (await versionOf('vtracer')) {
    // A system install is on PATH — use it, no download needed.
    resolvedBin = 'vtracer'
    return
  }
  await downloadManaged(onStatus, signal)
}

export interface TraceOptions {
  /** vtracer --color_precision (1-8): fewer bits = flatter, more posterized. Default 6. */
  colorPrecision?: number
  /** vtracer --filter_speckle (px): discard blobs smaller than this. Default 4. */
  filterSpeckle?: number
}

const DEFAULT_TRACE: Required<TraceOptions> = { colorPrecision: 6, filterSpeckle: 4 }

/**
 * Trace a raster PNG buffer into an SVG. vtracer reads/writes files (not stdin/stdout), so
 * we round-trip through scratch temp files. Throws if the binary is missing or fails — the
 * caller (image generation) is expected to fall back to the raster artifact.
 */
export async function traceToSvg(pngBuf: Buffer, opts: TraceOptions = {}): Promise<Buffer> {
  const { colorPrecision, filterSpeckle } = { ...DEFAULT_TRACE, ...opts }
  const tmpDir = join(dataDir, 'tmp')
  await mkdir(tmpDir, { recursive: true })
  const id = randomUUID()
  const inPath = join(tmpDir, `trace-${id}.png`)
  const outPath = join(tmpDir, `trace-${id}.svg`)

  try {
    await writeFile(inPath, pngBuf)
    await execFileAsync(
      vtracerBin(),
      [
        '--input', inPath,
        '--output', outPath,
        '--colormode', 'color',
        '--mode', 'spline',
        '--color_precision', String(Math.max(1, Math.min(8, Math.round(colorPrecision)))),
        '--filter_speckle', String(Math.max(0, Math.round(filterSpeckle))),
      ],
      { timeout: 120_000 },
    )
    return await readFile(outPath)
  } finally {
    await rm(inPath, { force: true }).catch(() => {})
    await rm(outPath, { force: true }).catch(() => {})
  }
}

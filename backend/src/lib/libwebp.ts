// libwebp CLI resolver — supplies `anim_dump` (composites an animated WebP into full-canvas
// PNG frames) and `webpmux` (reads per-frame durations). These are the ONLY way to turn an
// animated WebP into something ffmpeg can consume: ffmpeg's native webp decoder does not
// support animation (it errors with "unspecified size" / decodes zero frames), so animated
// WebP → video / gif goes through these tools first, then ffmpeg assembles the output.
//
// Strategy mirrors lib/ffmpeg.ts / lib/vips.ts: prefer a copy already on PATH, else a managed
// copy under data/bin, else download Google's official self-contained release bundle for this
// platform. Prebuilt bundles only exist for a few OS/arch pairs — where none does (e.g. linux
// arm64) and PATH has nothing, libwebpAvailable() stays false and the caller surfaces a clean
// "can't convert animated WebP on this host" error. Everything else (gif/video decode, all
// encoding) is handled by ffmpeg and does not depend on this module.

import { existsSync } from 'node:fs'
import { mkdir, rm, chmod } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dataDir, downloadUrl } from '@/lib/download'
import { IS_WIN, IS_MAC, extractArchive, findFileInTree } from '@/lib/platform'
import { logger } from '@/lib/logger'

const execFileAsync = promisify(execFile)

const EXE = IS_WIN ? '.exe' : ''
const BIN_DIR = join(dataDir, 'bin')
const INSTALL_DIR = join(BIN_DIR, 'libwebp')

// Pinned release. GitHub/Google embed the version in the asset name, so there's no stable
// "latest" URL — bump this to move versions.
const VER = '1.5.0'

let animDumpPath = `anim_dump${EXE}`
let webpmuxPath = `webpmux${EXE}`
let available = false
let resolvePromise: Promise<boolean> | null = null

/** Resolved path to `anim_dump` (valid once ensureLibwebp() reports true). */
export function animDumpBin(): string { return animDumpPath }
/** Resolved path to `webpmux`. */
export function webpmuxBin(): string { return webpmuxPath }
/** True once ensureLibwebp() has located a working libwebp toolset. */
export function libwebpAvailable(): boolean { return available }

/** Official self-contained bundle for this platform, or null if Google publishes none. */
function assetUrl(): { url: string; ext: '.zip' | '.tar.gz' } | null {
  const base = `https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-${VER}`
  if (IS_WIN) return process.arch === 'x64' ? { url: `${base}-windows-x64.zip`, ext: '.zip' } : null
  if (IS_MAC) return { url: `${base}-mac-${process.arch === 'arm64' ? 'arm64' : 'x86_64'}.tar.gz`, ext: '.tar.gz' }
  // linux: only an x86-64 build is published.
  if (process.arch === 'x64') return { url: `${base}-linux-x86-64.tar.gz`, ext: '.tar.gz' }
  return null
}

/** Does `bin` run from PATH? A tool that prints usage and exits non-zero still "exists" —
 *  only ENOENT means not-found. */
async function onPath(bin: string): Promise<boolean> {
  try { await execFileAsync(bin, [], { timeout: 8_000, windowsHide: true }); return true }
  catch (e: unknown) { return (e as { code?: string })?.code !== 'ENOENT' }
}

function pointAt(animDump: string): void {
  animDumpPath = animDump
  const mux = join(dirname(animDump), `webpmux${EXE}`)
  webpmuxPath = existsSync(mux) ? mux : `webpmux${EXE}`
}

async function downloadManaged(): Promise<boolean> {
  const asset = assetUrl()
  if (!asset) { logger.warn(`[libwebp] no prebuilt bundle for ${process.platform}/${process.arch}`); return false }
  const archive = join(BIN_DIR, `libwebp-dl${asset.ext}`)
  try {
    await mkdir(BIN_DIR, { recursive: true })
    await rm(INSTALL_DIR, { recursive: true, force: true })
    await mkdir(INSTALL_DIR, { recursive: true })
    logger.info(`[libwebp] downloading ${asset.url}`)
    // Shared downloader: resume (.part) + retries + stall detection + size floor.
    await downloadUrl(asset.url, archive, () => {}, undefined, { minBytes: 200_000 })
    await extractArchive(archive, INSTALL_DIR, 180_000)

    const found = await findFileInTree(INSTALL_DIR, `anim_dump${EXE}`)
    if (!found) throw new Error('anim_dump not found inside bundle')
    if (!IS_WIN) { try { await chmod(found, 0o755) } catch { /* best-effort */ } }
    pointAt(found)
    logger.info(`[libwebp] installed managed build → ${found}`)
    return true
  } catch (err) {
    logger.warn(`[libwebp] managed download failed: ${err}`)
    return false
  } finally {
    await rm(archive, { force: true }).catch(() => {})
  }
}

/**
 * Resolve the libwebp toolset. Prefers a managed copy, then PATH, then downloads the official
 * bundle. Never throws; returns (and caches) whether a working toolset was found. Concurrent
 * callers share one resolution; a failed attempt is retryable.
 */
export function ensureLibwebp(): Promise<boolean> {
  if (resolvePromise) return resolvePromise
  resolvePromise = (async () => {
    const managed = await findFileInTree(INSTALL_DIR, `anim_dump${EXE}`).catch(() => null)
    if (managed && existsSync(managed)) { pointAt(managed); available = true; return true }
    if (await onPath(`anim_dump${EXE}`)) { animDumpPath = `anim_dump${EXE}`; webpmuxPath = `webpmux${EXE}`; available = true; return true }
    if (await downloadManaged()) { available = true; return true }
    available = false
    logger.info('[libwebp] not available — animated WebP input conversion unsupported on this host')
    return false
  })()
  resolvePromise.then((ok) => { if (!ok) resolvePromise = null }).catch(() => { resolvePromise = null })
  return resolvePromise
}

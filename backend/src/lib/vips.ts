// vips (libvips CLI) resolver — the *preferred* image-conversion engine when present.
//
// Unlike ffmpeg, libvips is NOT distributed as a single relocatable binary on
// macOS/Linux (the `vips` CLI needs its sibling shared libraries), so we can't
// universally auto-download it the way lib/ffmpeg.ts does. Strategy:
//   - prefer `vips` already on PATH (Homebrew/apt installs land here),
//   - else a managed copy under data/bin,
//   - else, on Windows only, download the official self-contained "web" build
//     (which bundles its DLLs) from the libvips project.
// When none resolve, vipsAvailable() stays false and the converter falls back to
// ffmpeg for raster images — so the feature always works; vips is an upgrade
// (faster, plus AVIF/HEIC) when the host provides it.

import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dataDir, downloadUrl } from '@/lib/download'
import { IS_WIN, extractZip, findFileInTree } from '@/lib/platform'
import { logger } from '@/lib/logger'

const execFileAsync = promisify(execFile)

const BIN_NAME = IS_WIN ? 'vips.exe' : 'vips'
const BIN_DIR = join(dataDir, 'bin')
const MANAGED_PATH = join(BIN_DIR, BIN_NAME)

let resolvedBin = 'vips'
let available = false
let resolvePromise: Promise<string> | null = null

export function vipsBin(): string { return resolvedBin }
/** True once ensureVips() has located a working vips. Drives engine selection. */
export function vipsAvailable(): boolean { return available }

// Official self-contained Windows build (ships vips.exe + all DLLs under vips-dev-*/bin).
// Pinned: GitHub release assets embed the version in their name, so there's no stable
// "latest" asset URL. Best-effort — failure just leaves vips unavailable on Windows.
const WIN_BUILD_URL = 'https://github.com/libvips/build-win64-mxe/releases/download/v8.16.0/vips-dev-w64-web-8.16.0.zip'

async function works(bin: string): Promise<boolean> {
  try { await execFileAsync(bin, ['--version'], { timeout: 10_000, windowsHide: true }); return true } catch { return false }
}

async function downloadManagedWindows(): Promise<boolean> {
  const archive = join(BIN_DIR, 'vips-dl.zip')
  // Keep the whole bundle — the .exe depends on its sibling DLLs, so we run it in place.
  const installDir = join(BIN_DIR, 'vips-win')
  try {
    await mkdir(BIN_DIR, { recursive: true })
    logger.info(`[vips] downloading Windows build from ${WIN_BUILD_URL}`)
    // Shared downloader: resume (.part) + retries + stall detection + size verification.
    await downloadUrl(WIN_BUILD_URL, archive, () => {}, undefined, { minBytes: 1_000_000 })

    await rm(installDir, { recursive: true, force: true })
    await mkdir(installDir, { recursive: true })
    await extractZip(archive, installDir, 180_000)

    const found = await findFileInTree(installDir, BIN_NAME)
    if (!found) throw new Error('vips.exe not found inside archive')
    if (await works(found)) {
      resolvedBin = found
      logger.info(`[vips] installed managed Windows build → ${found}`)
      return true
    }
    return false
  } catch (err) {
    logger.warn(`[vips] managed download failed: ${err}`)
    return false
  } finally {
    await rm(archive, { force: true }).catch(() => {})
  }
}

/**
 * Resolve a usable vips and return its path. Prefers a managed copy, then PATH, then
 * (Windows only) downloads the official bundle. Never throws. Sets vipsAvailable().
 * Concurrent callers share one resolution.
 */
export function ensureVips(): Promise<string> {
  if (resolvePromise) return resolvePromise
  resolvePromise = (async () => {
    if (existsSync(MANAGED_PATH) && (await works(MANAGED_PATH))) { resolvedBin = MANAGED_PATH; available = true; return resolvedBin }
    if (await works('vips')) { resolvedBin = 'vips'; available = true; return resolvedBin }
    if (IS_WIN && (await downloadManagedWindows())) { available = true; return resolvedBin }
    available = false
    logger.info('[vips] not available — raster image conversion will use ffmpeg')
    return resolvedBin
  })()
  // Allow a later retry if this attempt didn't land a working binary.
  resolvePromise.then(() => { if (!available) resolvePromise = null }).catch(() => { resolvePromise = null })
  return resolvePromise
}

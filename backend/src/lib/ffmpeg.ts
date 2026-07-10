// ffmpeg resolver with on-demand auto-download.
//
// We don't bundle ffmpeg — we resolve it at runtime: prefer one already on PATH, else a
// managed copy under data/bin, else download a self-contained static build for this
// platform (the same approach used for yt-dlp, the maps JRE, and pmtiles). Lazy: nothing
// downloads until a feature that needs ffmpeg (podcast export) actually runs.

import { existsSync } from 'node:fs'
import { mkdir, rm, chmod, copyFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { setPriority, constants as osConstants } from 'node:os'
import { promisify } from 'node:util'
import { dataDir, downloadUrl } from '@/lib/download'
import { IS_WIN, extractArchive, findFileInTree } from '@/lib/platform'
import { logger } from '@/lib/logger'

const execFileAsync = promisify(execFile)

const BIN_NAME = IS_WIN ? 'ffmpeg.exe' : 'ffmpeg'
const PROBE_NAME = IS_WIN ? 'ffprobe.exe' : 'ffprobe'
const BIN_DIR = join(dataDir, 'bin')
const MANAGED_PATH = join(BIN_DIR, BIN_NAME)

// Default to PATH; ensureFfmpeg() promotes this to the managed copy when needed.
let resolvedBin = 'ffmpeg'
let resolvePromise: Promise<string> | null = null

export function ffmpegBin(): string { return resolvedBin }

/**
 * Directory to hand tools like yt-dlp via --ffmpeg-location, or null when ffmpeg is on
 * PATH (so they find it themselves). Returns the managed bin/ dir once we've downloaded.
 */
export function ffmpegLocation(): string | null {
  return resolvedBin === MANAGED_PATH ? BIN_DIR : null
}

/** ffprobe path: the managed copy if we downloaded one, else PATH. */
export function ffprobeBin(): string {
  const managed = join(BIN_DIR, PROBE_NAME)
  return existsSync(managed) ? managed : 'ffprobe'
}

// Self-contained static builds. BtbN publishes a rolling "latest" for Windows/Linux;
// evermeet.cx publishes notarized macOS builds. Both ship a single relocatable binary.
function release(): { url: string; kind: 'zip' | 'tar' } {
  if (IS_WIN) return { url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip', kind: 'zip' }
  if (process.platform === 'darwin') return { url: 'https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip', kind: 'zip' }
  return { url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz', kind: 'tar' }
}

async function works(bin: string): Promise<boolean> {
  try { await execFileAsync(bin, ['-version'], { timeout: 10_000, windowsHide: true }); return true } catch { return false }
}

async function downloadManaged(): Promise<boolean> {
  const { url, kind } = release()
  const archive = join(BIN_DIR, kind === 'zip' ? 'ffmpeg-dl.zip' : 'ffmpeg-dl.tar.xz')
  const extractDir = join(BIN_DIR, '_ffmpeg_extract')
  try {
    await mkdir(BIN_DIR, { recursive: true })
    logger.info(`[ffmpeg] downloading static build from ${url}`)
    // Rolling "latest" URL — drop any stale complete archive; the shared downloader
    // brings resume (.part) + retries + stall detection + size verification.
    await rm(archive, { force: true })
    await downloadUrl(url, archive, () => {}, undefined, { minBytes: 1_000_000 })

    await rm(extractDir, { recursive: true, force: true })
    await extractArchive(archive, extractDir)

    const found = await findFileInTree(extractDir, BIN_NAME)
    if (!found) throw new Error('ffmpeg binary not found inside archive')
    await copyFile(found, MANAGED_PATH)
    if (!IS_WIN) await chmod(MANAGED_PATH, 0o755)
    if (!(await works(MANAGED_PATH))) throw new Error('downloaded ffmpeg failed its -version smoke test')

    // Grab the sibling ffprobe too when the build ships one (BtbN does; evermeet doesn't)
    // so yt-dlp gets a complete toolset via --ffmpeg-location.
    const probeSrc = join(dirname(found), PROBE_NAME)
    if (existsSync(probeSrc)) {
      try { await copyFile(probeSrc, join(BIN_DIR, PROBE_NAME)); if (!IS_WIN) await chmod(join(BIN_DIR, PROBE_NAME), 0o755) } catch { /* best-effort */ }
    }

    resolvedBin = MANAGED_PATH
    logger.info(`[ffmpeg] installed managed binary → ${MANAGED_PATH}`)
    return true
  } catch (err) {
    logger.warn(`[ffmpeg] managed download failed: ${err}`)
    return false
  } finally {
    await rm(archive, { force: true }).catch(() => {})
    await rm(extractDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Resolve a usable ffmpeg and return its path. Prefers PATH, then a managed copy, then
 * downloads one. Never throws — falls back to the bare 'ffmpeg' name so the caller's own
 * error surfaces if nothing is available. Concurrent callers share one resolution.
 */
export function ensureFfmpeg(): Promise<string> {
  if (resolvePromise) return resolvePromise
  resolvePromise = (async () => {
    if (existsSync(MANAGED_PATH) && (await works(MANAGED_PATH))) { resolvedBin = MANAGED_PATH; return resolvedBin }
    if (await works('ffmpeg')) { resolvedBin = 'ffmpeg'; return resolvedBin }
    await downloadManaged()
    return resolvedBin
  })()
  // Allow a later retry if this attempt didn't land a working binary.
  resolvePromise.then((bin) => { if (bin === 'ffmpeg' && !existsSync(MANAGED_PATH)) resolvePromise = null }).catch(() => { resolvePromise = null })
  return resolvePromise
}

/** Whether a given ffmpeg binary advertises an encoder (e.g. 'h264_nvenc') in `-encoders`.
 *  Not every static/PATH build is compiled with the same encoder set. Best-effort: a failed
 *  probe reports false so the caller falls back to a CPU encoder. */
export async function ffmpegHasEncoder(bin: string, encoder: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(bin, ['-hide_banner', '-encoders'], { timeout: 10_000, windowsHide: true })
    return new RegExp(`\\b${encoder}\\b`).test(stdout)
  } catch { return false }
}

// Force-download of an NVENC-capable build is a one-time resolution shared by concurrent callers.
let nvencPromise: Promise<string> | null = null

/**
 * Resolve an ffmpeg that can encode with NVENC (`h264_nvenc`) and return its path. A random
 * ffmpeg already on PATH may be built WITHOUT NVENC; our managed BtbN `*-gpl` static build ships
 * it (`--enable-nvenc`). So on a box with an NVIDIA GPU, if the currently resolved binary lacks
 * h264_nvenc we force-download the managed build and re-point to it. Returns the resolved path
 * regardless — the caller checks capability again and falls back to a CPU encoder if NVENC is
 * still unavailable (e.g. the managed fetch failed, or the driver is too old at encode time).
 */
export function ensureNvencFfmpeg(): Promise<string> {
  if (nvencPromise) return nvencPromise
  nvencPromise = (async () => {
    const bin = await ensureFfmpeg()
    if (await ffmpegHasEncoder(bin, 'h264_nvenc')) return bin
    logger.info('[ffmpeg] NVIDIA GPU present but current ffmpeg lacks h264_nvenc — fetching NVENC-capable managed build')
    await downloadManaged()  // BtbN gpl build enables NVENC; sets resolvedBin = MANAGED_PATH on success
    return resolvedBin
  })()
  // Let a later attempt retry if the managed fetch failed and we still lack NVENC.
  nvencPromise.then((bin) => ffmpegHasEncoder(bin, 'h264_nvenc')).then((ok) => { if (!ok) nvencPromise = null }).catch(() => { nvencPromise = null })
  return nvencPromise
}

// Force-download of a webp-capable build is a one-time resolution shared by concurrent callers.
let webpPromise: Promise<string> | null = null

/**
 * Resolve an ffmpeg that can encode WebP (`libwebp`) and return its path. Many PATH builds —
 * notably Homebrew's default `ffmpeg` — are compiled WITHOUT the libwebp encoder, so writing
 * `.webp` fails with "Default encoder for format webp is probably disabled / Encoder not found".
 * Our managed static builds (evermeet on macOS, BtbN `*-gpl` on Linux/Windows) ship libwebp.
 * Mirrors ensureNvencFfmpeg(): if the currently resolved binary lacks libwebp, force-download
 * the managed build and re-point to it. Returns the resolved path regardless — the caller checks
 * capability again and surfaces a clear error if libwebp is still unavailable (e.g. the managed
 * fetch failed while offline).
 */
export function ensureWebpFfmpeg(): Promise<string> {
  if (webpPromise) return webpPromise
  webpPromise = (async () => {
    const bin = await ensureFfmpeg()
    if (await ffmpegHasEncoder(bin, 'libwebp')) return bin
    logger.info('[ffmpeg] current ffmpeg lacks the libwebp encoder — fetching a webp-capable managed build')
    await downloadManaged()  // evermeet/BtbN builds ship libwebp; sets resolvedBin = MANAGED_PATH on success
    return resolvedBin
  })()
  // Let a later attempt retry if the managed fetch failed and we still lack libwebp.
  webpPromise.then((bin) => ffmpegHasEncoder(bin, 'libwebp')).then((ok) => { if (!ok) webpPromise = null }).catch(() => { webpPromise = null })
  return webpPromise
}

// ── Encode-job load throttling ────────────────────────────────────────────────
// An unbounded ffmpeg re-encode (software decode + filter graph) pins every core at
// turbo for the length of the job. On this hardware that sustained peak is what arms
// the laptop's hybrid AC+battery power path and has hard power-offed the machine
// (Kernel-Power 41, no WHEA; see gpu-power-guard.ps1). Heavy re-encode jobs
// (plex-cut, media-enhance) bound their parallelism and drop process priority so
// they finish a little slower instead of taking the box down.

/** Thread cap for heavy re-encode ffmpeg jobs (decode, filter graph, CPU encoder). */
export const ENCODE_THREADS = '4'

/** Drop a spawned encode process to below-normal priority, best-effort (a runtime
 *  without os.setPriority support just leaves it at normal). */
export function deprioritizeEncode(pid: number | undefined): void {
  if (!pid) return
  try { setPriority(pid, osConstants.priority.PRIORITY_BELOW_NORMAL) } catch { /* best-effort */ }
}

// Managed ncnn-Vulkan tools for the optional AI enhance tiers: RIFE (frame interpolation, for
// 60fps motion smoothing) and Real-CUGAN (learned upscaling, for detail). Same resolve-or-
// download-from-GitHub pattern as ffmpeg.ts / ytdlp.ts, but these ship as a FOLDER (the binary
// plus model directories that must sit beside it), so we extract the whole release under
// data/bin/<tool>/ and keep it intact rather than copying a lone binary out.
//
// Cross-platform by design: Windows/Linux builds use native Vulkan (fast on NVIDIA); the macOS
// build is a universal binary with MoltenVK bundled (runs on Apple Silicon). Lazy + best-effort:
// nothing downloads until an AI-enhance job actually runs, and a failed provision returns null so
// the caller can fall back to the real-time ffmpeg clarity pass (or fail the job cleanly).

import { existsSync, statSync } from 'node:fs'
import { mkdir, rm, chmod } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { dataDir, downloadUrl } from '@/lib/download'
import { IS_WIN, extractArchive, findFileInTree } from '@/lib/platform'
import { logger } from '@/lib/logger'

const BIN_DIR = join(dataDir, 'bin')

interface NcnnSpec {
  key: string                                              // subdir under bin/, e.g. 'rife'
  exe: string                                              // executable base name (no .exe)
  urls: { win32: string; darwin: string; linux: string }  // per-platform release zips
  /** The model subdirectory (shipped inside the release) this app uses by default. */
  model: string
}

// Pinned to nihui's official releases (universal macOS binary; native Vulkan on win/linux).
const RIFE: NcnnSpec = {
  key: 'rife',
  exe: 'rife-ncnn-vulkan',
  model: 'rife-v4.6',   // latest general model: best quality + arbitrary time-step
  urls: {
    win32:  'https://github.com/nihui/rife-ncnn-vulkan/releases/download/20221029/rife-ncnn-vulkan-20221029-windows.zip',
    darwin: 'https://github.com/nihui/rife-ncnn-vulkan/releases/download/20221029/rife-ncnn-vulkan-20221029-macos.zip',
    linux:  'https://github.com/nihui/rife-ncnn-vulkan/releases/download/20221029/rife-ncnn-vulkan-20221029-ubuntu.zip',
  },
}
const REALCUGAN: NcnnSpec = {
  key: 'realcugan',
  exe: 'realcugan-ncnn-vulkan',
  model: 'models-pro',  // photo-oriented (natural on live action, not the anime-leaning 'se')
  urls: {
    win32:  'https://github.com/nihui/realcugan-ncnn-vulkan/releases/download/20220728/realcugan-ncnn-vulkan-20220728-windows.zip',
    darwin: 'https://github.com/nihui/realcugan-ncnn-vulkan/releases/download/20220728/realcugan-ncnn-vulkan-20220728-macos.zip',
    linux:  'https://github.com/nihui/realcugan-ncnn-vulkan/releases/download/20220728/realcugan-ncnn-vulkan-20220728-ubuntu.zip',
  },
}

function exeName(spec: NcnnSpec): string { return IS_WIN ? `${spec.exe}.exe` : spec.exe }
function releaseUrl(spec: NcnnSpec): string {
  const p = process.platform
  return p === 'win32' ? spec.urls.win32 : p === 'darwin' ? spec.urls.darwin : spec.urls.linux
}

// Resolved binary path per tool + in-flight de-dup so concurrent jobs share one download.
const resolved = new Map<string, string>()
const resolving = new Map<string, Promise<string | null>>()

async function provision(spec: NcnnSpec): Promise<string | null> {
  const cached = resolved.get(spec.key)
  if (cached && existsSync(cached)) return cached

  const dir = join(BIN_DIR, spec.key)
  // Already extracted from a previous run? Find the binary in the tree and adopt it.
  if (existsSync(dir)) {
    const found = await findFileInTree(dir, exeName(spec)).catch(() => null)
    if (found && statSync(found).size > 100_000) {
      if (!IS_WIN) await chmod(found, 0o755).catch(() => {})
      resolved.set(spec.key, found)
      return found
    }
  }

  const url = releaseUrl(spec)
  const archive = join(BIN_DIR, `${spec.key}-dl.zip`)
  try {
    await mkdir(dir, { recursive: true })
    logger.info(`[ncnn] downloading ${spec.key} from ${url}`)
    await rm(archive, { force: true })
    await downloadUrl(url, archive, () => {}, undefined, { minBytes: 1_000_000 })
    await extractArchive(archive, dir)
    const bin = await findFileInTree(dir, exeName(spec))
    if (!bin) throw new Error(`${spec.exe} not found inside archive`)
    if (!IS_WIN) await chmod(bin, 0o755)
    resolved.set(spec.key, bin)
    logger.info(`[ncnn] installed ${spec.key} → ${bin}`)
    return bin
  } catch (err) {
    logger.warn(`[ncnn] provision ${spec.key} failed: ${err}`)
    return null
  } finally {
    await rm(archive, { force: true }).catch(() => {})
  }
}

function ensure(spec: NcnnSpec): Promise<string | null> {
  const inFlight = resolving.get(spec.key)
  if (inFlight) return inFlight
  const p = provision(spec).finally(() => { resolving.delete(spec.key) })
  resolving.set(spec.key, p)
  return p
}

/** A resolved ncnn tool: the executable path and the absolute path to its default model dir. */
export interface NcnnTool { bin: string; modelDir: string }

async function resolveTool(spec: NcnnSpec): Promise<NcnnTool | null> {
  const bin = await ensure(spec)
  if (!bin) return null
  return { bin, modelDir: join(dirname(bin), spec.model) }
}

/** RIFE frame-interpolation tool (downloads on first use). Null if provisioning failed. */
export function ensureRife(): Promise<NcnnTool | null> { return resolveTool(RIFE) }

/** Real-CUGAN upscaling tool (downloads on first use). Null if provisioning failed. */
export function ensureRealcugan(): Promise<NcnnTool | null> { return resolveTool(REALCUGAN) }

/** Whether a tool is already installed on disk (no download), for admin/status surfaces. */
export function ncnnInstalled(): { rife: boolean; realcugan: boolean } {
  const present = (spec: NcnnSpec) => {
    const cached = resolved.get(spec.key)
    if (cached && existsSync(cached)) return true
    return existsSync(join(BIN_DIR, spec.key))
  }
  return { rife: present(RIFE), realcugan: present(REALCUGAN) }
}

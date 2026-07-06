// RIFE frame-interpolation pass: retimes a video to a higher frame rate for smoother motion
// (the "TV motion smoothing" effect), using the managed rife-ncnn-vulkan tool on the GPU.
// Source-agnostic path-in/path-out, mirroring enhance.ts. Pipeline:
//   1. ffmpeg extracts the source frames to a temp dir (PNG sequence)
//   2. rife-ncnn-vulkan interpolates them on the GPU to the target frame count
//   3. ffmpeg reassembles at the target fps and muxes the original audio back in
//
// GPU-bound and cross-platform (native Vulkan on Windows/NVIDIA, MoltenVK on macOS). Honors
// `signal` for cancellation and reports coarse progress (extract → interpolate → encode).

import { spawn } from 'node:child_process'
import { mkdir, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureFfmpeg, ffprobeBin } from '@/lib/ffmpeg'
import { contentTmpDir } from '@/lib/content/store'
import { ensureRife } from './ncnn'
import { resolveVideoEncoder } from './encoder'
import { logger } from '@/lib/logger'

export type InterpolateProgress = (fraction: number, note: string) => void

/** Run a child process to completion, honoring abort. Rejects with a tail of stderr on failure. */
function run(bin: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let err = ''
    child.stderr?.on('data', (d) => { err += d.toString(); if (err.length > 64_000) err = err.slice(-32_000) })
    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(e) })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return reject(new Error('cancelled'))
      if (code === 0) return resolve()
      reject(new Error(`${bin.split('/').pop()} exited ${code}: ${err.trim().split('\n').slice(-4).join(' | ')}`))
    })
  })
}

/** Source frame rate from ffprobe's r_frame_rate ("30000/1001" → 29.97). Falls back to 30. */
async function probeFps(inputPath: string): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(ffprobeBin(), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', inputPath], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let out = ''
    p.stdout?.on('data', (c: Buffer) => { out += c.toString() })
    p.on('close', () => {
      const parts = out.trim().split('/').map(Number)
      const n = parts[0] ?? 0
      const d = parts[1] ?? 1
      const fps = d ? n / d : n
      resolve(Number.isFinite(fps) && fps > 0 ? fps : 30)
    })
    p.on('error', () => resolve(30))
  })
}

async function countFrames(dir: string): Promise<number> {
  return (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.png')).length
}

/**
 * Interpolate `inputPath` → `outputPath` at `targetFps` (default 60) via RIFE. Returns false
 * (without throwing) if the RIFE tool couldn't be provisioned, so the caller can fall back to
 * the original. Throws only on a genuine processing failure.
 */
export async function interpolateVideo(
  inputPath: string,
  outputPath: string,
  opts: { targetFps?: number; signal?: AbortSignal; onProgress?: InterpolateProgress } = {},
): Promise<boolean> {
  const { targetFps = 60, signal, onProgress } = opts
  const rife = await ensureRife()
  if (!rife) { logger.warn('[interpolate] RIFE tool unavailable — skipping'); return false }
  const ffmpeg = await ensureFfmpeg()

  const work = join(await contentTmpDir(), `rife-${Date.now()}`)
  const framesIn = join(work, 'in')
  const framesOut = join(work, 'out')
  await mkdir(framesIn, { recursive: true })
  await mkdir(framesOut, { recursive: true })

  try {
    // 1. Extract source frames.
    onProgress?.(0.02, 'Preparing frames…')
    const fps = await probeFps(inputPath)
    await run(ffmpeg, ['-y', '-i', inputPath, '-vsync', '0', join(framesIn, '%08d.png')], signal)
    const nIn = await countFrames(framesIn)
    if (nIn === 0) throw new Error('no frames extracted')
    const nOut = Math.max(nIn, Math.round((nIn * targetFps) / fps))

    // 2. Interpolate on the GPU. Poll the output dir for coarse progress while it runs.
    onProgress?.(0.1, 'Smoothing motion…')
    const rifeArgs = ['-i', framesIn, '-o', framesOut, '-m', rife.modelDir, '-n', String(nOut), '-f', '%08d.png']
    const proc = run(rife.bin, rifeArgs, signal)
    const poll = setInterval(() => {
      void countFrames(framesOut).then((done) => {
        if (nOut > 0) onProgress?.(0.1 + 0.8 * Math.min(1, done / nOut), 'Smoothing motion…')
      })
    }, 1000)
    try { await proc } finally { clearInterval(poll) }

    // 3. Reassemble at the target fps, muxing the original audio back (optional stream).
    onProgress?.(0.92, 'Encoding…')
    const enc = await resolveVideoEncoder()
    await run(ffmpeg, [
      '-y',
      '-framerate', String(targetFps), '-i', join(framesOut, '%08d.png'),
      '-i', inputPath,
      '-map', '0:v:0', '-map', '1:a:0?',
      '-c:v', enc.codec, ...enc.args,
      '-c:a', 'copy',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      '-shortest', outputPath,
    ], signal)
    onProgress?.(1, 'Done')
    logger.info(`[interpolate] ${inputPath} → ${outputPath} (${fps.toFixed(2)}→${targetFps}fps, ${nIn}→${nOut} frames)`)
    return true
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

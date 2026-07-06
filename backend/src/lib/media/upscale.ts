// Real-CUGAN AI-upscale pass: a manual, opt-in "AI enhance" that reconstructs fine detail
// (hair, texture) a plain sharpen can't. Source-agnostic path-in/path-out, mirroring enhance.ts.
// Pipeline:
//   1. ffmpeg extracts the source frames
//   2. realcugan-ncnn-vulkan (models-pro, photo-oriented) upscales them 2× on the GPU
//   3. ffmpeg scales the AI frames back to source resolution, BLENDS them over the original at a
//      light `strength` (so it reads natural, not the anime-GAN look), applies the house clarity
//      recipe, and muxes the original audio back
//
// This is NEVER auto-run — it's frame-by-frame and slow (~7s/4K frame), so the caller gates it to
// low-res / short sources. Returns false (no throw) if the tool can't be provisioned.

import { spawn } from 'node:child_process'
import { mkdir, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureFfmpeg, ffprobeBin } from '@/lib/ffmpeg'
import { contentTmpDir } from '@/lib/content/store'
import { ensureRealcugan } from './ncnn'
import { enhanceFilterChain } from './enhance'
import { resolveVideoEncoder } from './encoder'
import { logger } from '@/lib/logger'

export type UpscaleProgress = (fraction: number, note: string) => void

function run(bin: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
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

async function countFrames(dir: string): Promise<number> {
  return (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.png')).length
}

/** Source video height (px), for the caller's low-res gating. 0 if it can't be read. */
export async function probeHeight(inputPath: string): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(ffprobeBin(), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'csv=p=0', inputPath], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    p.stdout?.on('data', (c: Buffer) => { out += c.toString() })
    p.on('close', () => { const h = parseInt(out.trim(), 10); resolve(Number.isFinite(h) ? h : 0) })
    p.on('error', () => resolve(0))
  })
}

/**
 * AI-upscale `inputPath` → `outputPath` (same resolution out), blending the Real-CUGAN result over
 * the original at `strength` (0..1, default 0.12) then applying the clarity recipe. Returns false
 * (no throw) if the CUGAN tool couldn't be provisioned, so the caller can fall back.
 */
export async function upscaleVideo(
  inputPath: string,
  outputPath: string,
  opts: { strength?: number; signal?: AbortSignal; onProgress?: UpscaleProgress } = {},
): Promise<boolean> {
  const { strength = 0.12, signal, onProgress } = opts
  const cugan = await ensureRealcugan()
  if (!cugan) { logger.warn('[upscale] Real-CUGAN tool unavailable — skipping'); return false }
  const ffmpeg = await ensureFfmpeg()
  const s = Math.max(0, Math.min(1, strength))

  const work = join(await contentTmpDir(), `cugan-${Date.now()}`)
  const framesIn = join(work, 'in')
  const framesAi = join(work, 'ai')
  await mkdir(framesIn, { recursive: true })
  await mkdir(framesAi, { recursive: true })

  try {
    // 1. Extract source frames.
    onProgress?.(0.02, 'Preparing frames…')
    await run(ffmpeg, ['-y', '-i', inputPath, '-vsync', '0', join(framesIn, '%08d.png')], signal)
    const nIn = await countFrames(framesIn)
    if (nIn === 0) throw new Error('no frames extracted')

    // 2. Real-CUGAN 2× on the GPU (tiled to bound VRAM/unified-memory on large frames).
    onProgress?.(0.1, 'Reconstructing detail…')
    const proc = run(cugan.bin, ['-i', framesIn, '-o', framesAi, '-s', '2', '-n', '0', '-m', cugan.modelDir, '-t', '256'], signal)
    const poll = setInterval(() => {
      void countFrames(framesAi).then((done) => {
        if (nIn > 0) onProgress?.(0.1 + 0.8 * Math.min(1, done / nIn), 'Reconstructing detail…')
      })
    }, 1000)
    try { await proc } finally { clearInterval(poll) }

    // 3. Scale AI frames back to source res via scale2ref (no need to know WxH), blend over the
    //    original at `s`, apply the house clarity recipe, and mux the original audio.
    onProgress?.(0.92, 'Encoding…')
    const enc = await resolveVideoEncoder()
    const blend = `[1:v][0:v]scale2ref=flags=bicubic[ai][base];[base][ai]blend=all_expr='A*${(1 - s).toFixed(3)}+B*${s.toFixed(3)}',${enhanceFilterChain()}[v]`
    await run(ffmpeg, [
      '-y',
      '-i', join(framesIn, '%08d.png'),
      '-i', join(framesAi, '%08d.png'),
      '-i', inputPath,
      '-filter_complex', blend,
      '-map', '[v]', '-map', '2:a:0?',
      '-c:v', enc.codec, ...enc.args,
      '-c:a', 'copy',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      '-shortest', outputPath,
    ], signal)
    onProgress?.(1, 'Done')
    logger.info(`[upscale] ${inputPath} → ${outputPath} (CUGAN pro @ ${Math.round(s * 100)}% + clarity, ${nIn} frames)`)
    return true
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

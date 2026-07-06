// Unified media-enhance dispatcher for the manual "Enhance" feature (images AND video). One entry
// point the route calls; it routes to the right worker by media type + mode:
//   video: clarity → enhance.ts | ai-upscale → upscale.ts | interpolate → interpolate.ts
//   image: clarity → one ffmpeg clarity pass | ai-upscale → Real-CUGAN 2× + clarity
// Interpolation is video-only (a still has no motion). Returns false (no throw) when a required
// AI tool couldn't be provisioned, so the caller can surface a clean error.

import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureFfmpeg } from '@/lib/ffmpeg'
import { contentTmpDir } from '@/lib/content/store'
import { ensureRealcugan } from './ncnn'
import { enhanceVideo, enhanceFilterChain } from './enhance'
import { upscaleVideo } from './upscale'
import { interpolateVideo } from './interpolate'
import { logger } from '@/lib/logger'

export type EnhanceMode = 'clarity' | 'ai-upscale' | 'interpolate'
export type EnhanceProgress = (fraction: number, note?: string) => void

export interface EnhanceMediaOpts {
  mode: EnhanceMode
  isImage: boolean
  /** ai-upscale (video): blend strength 0..1 of the Real-CUGAN result over the original. */
  strength?: number
  /** interpolate (video): target frame rate. */
  targetFps?: number
  signal?: AbortSignal
  onProgress?: EnhanceProgress
}

function run(bin: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let err = ''
    child.stderr?.on('data', (d) => { err += d.toString(); if (err.length > 32_000) err = err.slice(-16_000) })
    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(e) })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return reject(new Error('cancelled'))
      if (code === 0) return resolve()
      reject(new Error(`${bin.split('/').pop()} exited ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`))
    })
  })
}

/** Still-image enhance: 'clarity' = one ffmpeg pass; 'ai-upscale' = Real-CUGAN 2× then clarity. */
async function enhanceStill(inputPath: string, outputPath: string, mode: 'clarity' | 'ai-upscale', signal?: AbortSignal, onProgress?: EnhanceProgress): Promise<boolean> {
  const ffmpeg = await ensureFfmpeg()
  if (mode === 'clarity') {
    onProgress?.(0.3, 'Enhancing…')
    await run(ffmpeg, ['-y', '-i', inputPath, '-vf', enhanceFilterChain(), '-frames:v', '1', outputPath], signal)
    onProgress?.(1, 'Done')
    logger.info(`[enhanceMedia] image clarity ${inputPath} → ${outputPath}`)
    return true
  }
  const cugan = await ensureRealcugan()
  if (!cugan) { logger.warn('[enhanceMedia] Real-CUGAN unavailable — skipping'); return false }
  const upscaled = join(await contentTmpDir(), `cugan-img-${Date.now()}.png`)
  try {
    onProgress?.(0.2, 'Reconstructing detail…')
    await run(cugan.bin, ['-i', inputPath, '-o', upscaled, '-s', '2', '-n', '0', '-m', cugan.modelDir, '-t', '256'], signal)
    onProgress?.(0.8, 'Finishing…')
    await run(ffmpeg, ['-y', '-i', upscaled, '-vf', enhanceFilterChain(), '-frames:v', '1', outputPath], signal)
    onProgress?.(1, 'Done')
    logger.info(`[enhanceMedia] image ai-upscale (CUGAN pro 2× + clarity) ${inputPath} → ${outputPath}`)
    return true
  } finally {
    await rm(upscaled, { force: true }).catch(() => {})
  }
}

/**
 * Enhance a media file `inputPath` → `outputPath`. Dispatches by `isImage` + `mode`. Returns false
 * (no throw) when a required AI tool couldn't be provisioned. Throws on a genuine processing error
 * (or if 'interpolate' is requested for an image — it's video-only).
 */
export async function enhanceMedia(inputPath: string, outputPath: string, opts: EnhanceMediaOpts): Promise<boolean> {
  const { mode, isImage, strength = 0.12, targetFps = 60, signal, onProgress } = opts

  if (isImage) {
    if (mode === 'interpolate') throw new Error('Frame interpolation is only available for video.')
    return enhanceStill(inputPath, outputPath, mode, signal, onProgress)
  }

  if (mode === 'clarity') {
    await enhanceVideo(inputPath, outputPath, signal, (f, eta) => onProgress?.(f, eta ? `~${eta}s left` : undefined))
    return true
  }
  if (mode === 'ai-upscale') {
    return upscaleVideo(inputPath, outputPath, { strength, signal, onProgress: (f, note) => onProgress?.(f, note) })
  }
  return interpolateVideo(inputPath, outputPath, { targetFps, signal, onProgress: (f, note) => onProgress?.(f, note) })
}

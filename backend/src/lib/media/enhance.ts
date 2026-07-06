// Reusable video "enhance" pass: a light denoise → sharpen re-encode that makes an
// already-compressed download (YouTube, TikTok, etc.) look crisper than the source. Source-
// agnostic — operates on plain input/output paths so any pipeline (the media-enhance job now,
// the plex-cut pass or clipper later) can reuse it. No upscaling in v1: same resolution in/out.
//
// The spawn / rolling-stderr / SIGKILL-on-abort / output-size-validation contract mirrors
// cutVideo (lib/plex/cut/videoCut.ts).

import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { ensureFfmpeg } from '@/lib/ffmpeg'
import { resolveVideoEncoder, CPU_ENCODER, type VideoEncoder } from './encoder'
import { logger } from '@/lib/logger'

/** Conservative denoise→sharpen filter chain, tuned light for web video (over-smoothing/over-
 *  sharpening looks worse than the compression it fixes). hqdn3d params are
 *  luma_spatial:chroma_spatial:luma_temporal:chroma_temporal. Single source of truth so other
 *  ffmpeg passes can fold the same filters into one combined graph. No `scale` — v1 is same-res. */
export function enhanceFilterChain(): string {
  return 'hqdn3d=2:1:2:1,unsharp=5:5:0.8:3:3:0.4'
}

function tailStderr(buf: string, lines = 8): string {
  return buf.trim().split('\n').slice(-lines).join(' | ')
}

async function runEncode(inputPath: string, outputPath: string, enc: VideoEncoder, signal?: AbortSignal): Promise<void> {
  const bin = await ensureFfmpeg()
  const args = [
    '-y', '-i', inputPath,
    '-vf', enhanceFilterChain(),
    '-c:v', enc.codec, ...enc.args,
    '-c:a', 'copy',   // only the video is touched
    outputPath,
  ]

  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (d) => { err += d.toString(); if (err.length > 64_000) err = err.slice(-32_000) })
    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(e) })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return reject(new Error('cancelled'))
      if (code === 0) return resolve()
      reject(new Error(`ffmpeg enhance exited ${code}: ${tailStderr(err)}`))
    })
  })

  const s = await stat(outputPath).catch(() => null)
  if (!s || s.size === 0) throw new Error('ffmpeg enhance produced no output')
}

/**
 * Re-encode `inputPath` → `outputPath` applying the denoise+sharpen chain. Prefers a hardware
 * encoder for speed; if a hardware encode fails (e.g. NVENC init error from a too-old driver or a
 * busy GPU) it retries once on CPU libx264. Honors `signal` for cancellation.
 */
export async function enhanceVideo(inputPath: string, outputPath: string, signal?: AbortSignal): Promise<void> {
  const enc = await resolveVideoEncoder()
  try {
    await runEncode(inputPath, outputPath, enc, signal)
    logger.info(`[enhance] wrote ${outputPath} via ${enc.codec}`)
  } catch (err) {
    if (signal?.aborted) throw err
    if (!enc.hw) throw err   // already the CPU encoder — nothing better to fall back to
    logger.warn(`[enhance] hardware encode (${enc.codec}) failed, retrying on CPU libx264: ${err}`)
    await runEncode(inputPath, outputPath, CPU_ENCODER, signal)
    logger.info(`[enhance] wrote ${outputPath} via ${CPU_ENCODER.codec} (hardware fallback)`)
  }
}

// Reusable video "enhance" pass: a light "clarity" re-encode (adaptive sharpen + gentle vibrance)
// that makes an already-compressed download (YouTube, TikTok, etc.) look crisper than the source.
// Source-agnostic — operates on plain input/output paths so any pipeline (the media-enhance job
// now, the plex-cut pass or clipper later) can reuse it. No upscaling: same resolution in/out.
//
// The spawn / rolling-stderr / SIGKILL-on-abort / output-size-validation contract mirrors
// cutVideo (lib/plex/cut/videoCut.ts). Encode progress is parsed from ffmpeg's `-progress`
// stream (out_time + speed) so the job can report a live percentage + ETA.

import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { ensureFfmpeg, ffprobeBin, ENCODE_THREADS, deprioritizeEncode } from '@/lib/ffmpeg'
import { resolveVideoEncoder, CPU_ENCODER, type VideoEncoder } from './encoder'
import { logger } from '@/lib/logger'

/** Lean "clarity" filter chain: contrast-adaptive sharpen (CAS, halo-free) + a light edge-detail
 *  unsharp + a gentle vibrance lift. Deliberately NO denoise/deblock: modern codecs (VP9/H.264/
 *  H.265) already deblock in-loop, and denoising a clean source smears the fine detail we want to
 *  keep (e.g. individual hairs). CAS is held to its ~0.5 sweet spot so it reads natural, not
 *  over-sharpened. Single source of truth so other ffmpeg passes can fold the same filters into
 *  one combined graph. No `scale` — same-res in/out. */
export function enhanceFilterChain(): string {
  return 'cas=0.5,unsharp=5:5:0.6:3:3:0.25,vibrance=intensity=0.15'
}

/** Progress reported during an enhance re-encode: fraction 0..1 and a rough ETA in seconds. */
export type EnhanceProgress = (fraction: number, etaSeconds: number) => void

function tailStderr(buf: string, lines = 8): string {
  return buf.trim().split('\n').slice(-lines).join(' | ')
}

/** Source duration in seconds via ffprobe (for the progress fraction). 0 if it can't be read. */
async function probeDurationSec(inputPath: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(ffprobeBin(), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', inputPath], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let out = ''
    proc.stdout?.on('data', (c: Buffer) => { out += c.toString() })
    proc.on('close', () => { const n = parseFloat(out.trim()); resolve(Number.isFinite(n) && n > 0 ? n : 0) })
    proc.on('error', () => resolve(0))
  })
}

async function runEncode(inputPath: string, outputPath: string, enc: VideoEncoder, signal?: AbortSignal, durationSec = 0, onProgress?: EnhanceProgress): Promise<void> {
  const bin = await ensureFfmpeg()
  // Thread caps + below-normal priority: same rationale as cutVideo (see
  // deprioritizeEncode in lib/ffmpeg.ts), a full-length re-encode must not pin
  // every core at turbo on this box.
  const args = [
    '-y', '-nostats', '-progress', 'pipe:1',   // machine-readable progress on stdout
    '-threads', ENCODE_THREADS, '-i', inputPath,
    '-filter_threads', ENCODE_THREADS,
    '-vf', enhanceFilterChain(),
    '-c:v', enc.codec, ...enc.args,
    '-c:a', 'copy',   // only the video is touched
    '-threads', ENCODE_THREADS,
    outputPath,
  ]

  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    deprioritizeEncode(child.pid)
    let err = ''
    child.stderr?.on('data', (d) => { err += d.toString(); if (err.length > 64_000) err = err.slice(-32_000) })

    // Parse ffmpeg -progress: key=value lines, one block per update ending in `progress=…`.
    let progBuf = ''
    let outTimeUs = 0
    let speed = 0
    child.stdout?.on('data', (d: Buffer) => {
      if (!durationSec || !onProgress) return
      progBuf += d.toString()
      const nl = progBuf.lastIndexOf('\n')
      if (nl < 0) return
      const lines = progBuf.slice(0, nl).split('\n')
      progBuf = progBuf.slice(nl + 1)
      for (const line of lines) {
        if (line.startsWith('out_time_us=')) { const n = Number(line.slice(12)); if (Number.isFinite(n)) outTimeUs = n }
        else if (line.startsWith('speed=')) { const s = parseFloat(line.slice(6)); if (Number.isFinite(s)) speed = s }
        else if (line.startsWith('progress=')) {
          const sec = outTimeUs / 1e6
          const fraction = Math.max(0, Math.min(1, sec / durationSec))
          const eta = speed > 0 ? Math.max(0, Math.round((durationSec - sec) / speed)) : 0
          onProgress(fraction, eta)
        }
      }
    })

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
 * busy GPU) it retries once on CPU libx265. Honors `signal` for cancellation and, when
 * `onProgress` is given, reports a live fraction + ETA parsed from ffmpeg.
 */
export async function enhanceVideo(inputPath: string, outputPath: string, signal?: AbortSignal, onProgress?: EnhanceProgress): Promise<void> {
  const enc = await resolveVideoEncoder()
  const durationSec = onProgress ? await probeDurationSec(inputPath) : 0
  try {
    await runEncode(inputPath, outputPath, enc, signal, durationSec, onProgress)
    logger.info(`[enhance] wrote ${outputPath} via ${enc.codec}`)
  } catch (err) {
    if (signal?.aborted) throw err
    if (!enc.hw) throw err   // already the CPU encoder — nothing better to fall back to
    logger.warn(`[enhance] hardware encode (${enc.codec}) failed, retrying on CPU ${CPU_ENCODER.codec}: ${err}`)
    await runEncode(inputPath, outputPath, CPU_ENCODER, signal, durationSec, onProgress)
    logger.info(`[enhance] wrote ${outputPath} via ${CPU_ENCODER.codec} (hardware fallback)`)
  }
}

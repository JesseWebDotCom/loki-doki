// ffmpeg engine — the guaranteed workhorse. Handles raster images, audio, and video.
// Reuses the existing runtime resolver (lib/ffmpeg.ts) which is already downloaded for
// YouTube/podcast, so no new binary management here.

import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { ensureFfmpeg } from '@/lib/ffmpeg'
import type { Engine, EngineRunArgs } from '../types'
import { IMAGE, AUDIO, VIDEO } from '../formats'

// ffmpeg reads/writes all of these via extension inference. We exclude svg (ffmpeg can't
// rasterize it) — vips covers that when present.
const FF_IMAGE = IMAGE.filter((f) => f !== 'svg')

function ext(s: string): string { return s.toLowerCase() }

function tailStderr(buf: string, lines = 6): string {
  return buf.trim().split('\n').slice(-lines).join('\n')
}

export const ffmpegEngine: Engine = {
  name: 'ffmpeg',

  // Always available — ensureFfmpeg() resolves or downloads a static build, never throws.
  async available(): Promise<boolean> {
    await ensureFfmpeg()
    return true
  },

  supports(inExt: string, outExt: string): boolean {
    const i = ext(inExt), o = ext(outExt)
    if (FF_IMAGE.includes(i) && FF_IMAGE.includes(o)) return true
    if (AUDIO.includes(i) && AUDIO.includes(o)) return true
    if (VIDEO.includes(i) && VIDEO.includes(o)) return true
    return false
  },

  async run({ inPath, outPath, outExt, family, quality, signal }: EngineRunArgs): Promise<void> {
    const bin = await ensureFfmpeg()
    const o = ext(outExt)

    // -y overwrite; per-family quality/codec hints kept conservative for broad compatibility.
    const args = ['-y', '-i', inPath]
    if (family === 'image') {
      // Map a 1–100 quality to ffmpeg's per-encoder scale where it helps.
      if ((o === 'jpg' || o === 'jpeg') && quality) args.push('-q:v', String(Math.max(2, Math.round(31 - (quality / 100) * 29))))
      if (o === 'webp' && quality) args.push('-quality', String(quality))
      args.push('-frames:v', '1') // single still even from animated/multi-frame inputs
    } else if (family === 'audio') {
      if (quality && (o === 'mp3')) args.push('-q:a', String(Math.max(0, Math.round(9 - (quality / 100) * 9))))
    }
    // video: rely on ffmpeg's sensible default encoders per container.
    args.push(outPath)

    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
      let err = ''
      child.stderr.on('data', (d) => { err += d.toString(); if (err.length > 64_000) err = err.slice(-32_000) })
      const onAbort = () => child.kill('SIGKILL')
      signal?.addEventListener('abort', onAbort, { once: true })
      child.on('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(e) })
      child.on('close', (code) => {
        signal?.removeEventListener('abort', onAbort)
        if (signal?.aborted) return reject(new Error('cancelled'))
        if (code === 0) resolve()
        else reject(new Error(`ffmpeg exited ${code}: ${tailStderr(err)}`))
      })
    })

    // ffmpeg returns 0 even when it writes nothing in some odd cases — assert output exists.
    const s = await stat(outPath).catch(() => null)
    if (!s || s.size === 0) throw new Error('ffmpeg produced no output')
  },
}

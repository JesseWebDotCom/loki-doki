// vips engine — preferred for raster images when libvips is present (faster than ffmpeg,
// adds AVIF/HEIC + SVG rasterization). Optional: available() reflects host detection.

import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { ensureVips, vipsBin, vipsAvailable } from '@/lib/vips'
import type { Engine, EngineRunArgs } from '../types'
import { VIPS_IN, VIPS_OUT } from '../formats'

function ext(s: string): string { return s.toLowerCase() }

function tailStderr(buf: string, lines = 6): string {
  return buf.trim().split('\n').slice(-lines).join('\n')
}

export const vipsEngine: Engine = {
  name: 'vips',

  async available(): Promise<boolean> {
    await ensureVips()
    return vipsAvailable()
  },

  supports(inExt: string, outExt: string): boolean {
    return VIPS_IN.includes(ext(inExt)) && VIPS_OUT.includes(ext(outExt))
  },

  async run({ inPath, outPath, outExt, quality, signal }: EngineRunArgs): Promise<void> {
    const bin = vipsBin()
    const o = ext(outExt)

    // `vips copy in out` infers format from the output extension. Quality is passed via
    // libvips' bracket save-options syntax on the output target, e.g. out.jpg[Q=85].
    let target = outPath
    if (quality && (o === 'jpg' || o === 'jpeg' || o === 'webp' || o === 'avif' || o === 'heic' || o === 'heif')) {
      target = `${outPath}[Q=${quality}]`
    }

    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, ['copy', inPath, target], { stdio: ['ignore', 'ignore', 'pipe'] })
      let err = ''
      child.stderr.on('data', (d) => { err += d.toString(); if (err.length > 64_000) err = err.slice(-32_000) })
      const onAbort = () => child.kill('SIGKILL')
      signal?.addEventListener('abort', onAbort, { once: true })
      child.on('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(e) })
      child.on('close', (code) => {
        signal?.removeEventListener('abort', onAbort)
        if (signal?.aborted) return reject(new Error('cancelled'))
        if (code === 0) resolve()
        else reject(new Error(`vips exited ${code}: ${tailStderr(err)}`))
      })
    })

    const s = await stat(outPath).catch(() => null)
    if (!s || s.size === 0) throw new Error('vips produced no output')
  },
}

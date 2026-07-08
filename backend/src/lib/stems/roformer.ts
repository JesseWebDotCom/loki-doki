// RoFormer guitar separation (becruily Mel-Band RoFormer) — a cleaner guitar stem than
// Demucs. Runs the `melband-roformer-infer` CLI in its isolated venv against a folder holding
// just the source, then returns the produced guitar WAV. Best-effort: returns null on any
// failure so the caller falls back to Demucs' guitar.

import { spawn } from 'node:child_process'
import { mkdir, rm, readdir, cp } from 'node:fs/promises'
import { join } from 'node:path'
import { roformerInferBin, ROFORMER_CKPT, ROFORMER_CONFIG, isRoformerGuitarInstalled } from './pyenv'
import type { DownloadProgress } from '@/lib/download'
import { logger } from '@/lib/logger'

/** Separate the guitar from `sourceWav` using the RoFormer model. `workDir` is scratch space.
 *  Returns the path to the guitar WAV, or null if RoFormer is unavailable / produced nothing. */
export async function separateGuitarRoformer(
  sourceWav: string,
  workDir: string,
  signal?: AbortSignal,
  onProgress?: (pct: number) => void,
): Promise<string | null> {
  if (!isRoformerGuitarInstalled()) return null
  const inDir = join(workDir, 'rf-in')
  const outDir = join(workDir, 'rf-out')
  try {
    await rm(inDir, { recursive: true, force: true })
    await rm(outDir, { recursive: true, force: true })
    await mkdir(inDir, { recursive: true })
    await mkdir(outDir, { recursive: true })
    await cp(sourceWav, join(inDir, 'source.wav'))

    await new Promise<void>((resolve, reject) => {
      const child = spawn(roformerInferBin(), [
        '--config_path', ROFORMER_CONFIG,
        '--model_path', ROFORMER_CKPT,
        '--input_folder', inDir,
        '--store_dir', outDir,
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let err = ''
      const scan = (b: Buffer) => {
        const s = b.toString(); err += s; if (err.length > 16_000) err = err.slice(-8_000)
        const m = s.match(/(\d+)%/g); const tail = m?.[m.length - 1]
        if (tail && onProgress) { const p = tail.match(/(\d+)%/); if (p) onProgress(Number(p[1])) }
      }
      child.stdout?.on('data', scan)
      child.stderr?.on('data', scan)
      const onAbort = () => child.kill('SIGKILL')
      signal?.addEventListener('abort', onAbort, { once: true })
      child.on('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(e) })
      child.on('close', (code) => {
        signal?.removeEventListener('abort', onAbort)
        if (signal?.aborted) return reject(new Error('cancelled'))
        code === 0 ? resolve() : reject(new Error(`roformer exited ${code}: ${err.trim().split('\n').slice(-2).join(' | ')}`))
      })
    })

    // The model writes one WAV per stem; grab the one that is the guitar (not the residual).
    const files = await readdir(outDir)
    const guitar = files.find((f) => /guitar/i.test(f) && f.toLowerCase().endsWith('.wav'))
    if (!guitar) { logger.warn('[roformer] no guitar output found'); return null }
    return join(outDir, guitar)
  } catch (err) {
    logger.warn(`[roformer] guitar separation failed, using Demucs guitar: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

export type { DownloadProgress }

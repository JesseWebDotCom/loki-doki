// stem-separate job runner: split a Music Studio track into the requested stems with Demucs,
// upgrading the GUITAR stem with the RoFormer guitar model when it's installed (falls back to
// Demucs' guitar otherwise). Supports presets (2/4/6-stem) and a custom subset of
// {vocals, drums, bass, guitar, piano, other}. Output is MP3 320 under the track's own dir
// (music/studio/<id>/stems/<name>.mp3). Runs in the download-queue compute lane.

import { spawn } from 'node:child_process'
import { mkdir, rename, rm, readdir, cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { musicStudioTracks } from '@/db/schema'
import { resolveUserPath } from '@/lib/storage/paths'
import { ensureFfmpeg } from '@/lib/ffmpeg'
import { stemVenvPython, isStemAudioInstalled, isRoformerGuitarInstalled } from './pyenv'
import { separateGuitarRoformer } from './roformer'
import type { DownloadProgress } from '@/lib/download'
import { logger } from '@/lib/logger'

export interface StemSeparateJobPayload {
  studioTrackId: string
  model?: string          // preset: '2-stem' | '4-stem' | '6-stem'
  stems?: string[]        // custom subset of ALL6 (takes precedence over model)
  enhancedGuitar?: boolean // use the RoFormer guitar model (default true when installed)
}

const ALL6 = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'] as const
type Stem6 = typeof ALL6[number]

interface Plan { demucsModel: string; twoStems: boolean; stems: string[] }

/** Turn a payload into a concrete separation plan. */
function planFor(payload: StemSeparateJobPayload): Plan {
  const custom = (payload.stems ?? []).filter((s): s is Stem6 => (ALL6 as readonly string[]).includes(s))
  if (custom.length) {
    const needs6 = custom.some((s) => s === 'guitar' || s === 'piano')
    return { demucsModel: needs6 ? 'htdemucs_6s' : 'htdemucs', twoStems: false, stems: [...new Set(custom)] }
  }
  switch (payload.model) {
    case '2-stem': return { demucsModel: 'htdemucs', twoStems: true, stems: ['vocals', 'no_vocals'] }
    case '6-stem': return { demucsModel: 'htdemucs_6s', twoStems: false, stems: [...ALL6] }
    default:       return { demucsModel: 'htdemucs', twoStems: false, stems: ['vocals', 'drums', 'bass', 'other'] }
  }
}

/** Spawn demucs, parse its tqdm `NN%` into onPct. Rejects on non-zero exit. */
function runDemucs(python: string, args: string[], signal: AbortSignal | undefined, onPct?: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-m', 'demucs', ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let err = ''
    const scan = (buf: Buffer) => {
      const s = buf.toString(); err += s; if (err.length > 32_000) err = err.slice(-16_000)
      const m = s.match(/(\d+)%\|/g); const tail = m?.[m.length - 1]
      if (tail && onPct) { const last = tail.match(/(\d+)%/); if (last) onPct(Number(last[1])) }
    }
    child.stdout?.on('data', scan)
    child.stderr?.on('data', scan)
    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(e) })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return reject(new Error('cancelled'))
      code === 0 ? resolve() : reject(new Error(`demucs exited ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`))
    })
  })
}

/** Transcode a WAV to MP3 320 at outPath. */
function wavToMp3(ff: string, input: string, outPath: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ff, ['-y', '-i', input, '-c:a', 'libmp3lame', '-b:a', '320k', outPath], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let err = ''
    child.stderr?.on('data', (d: Buffer) => { err += d.toString(); if (err.length > 8_000) err = err.slice(-4_000) })
    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(e) })
    child.on('close', (code) => { signal?.removeEventListener('abort', onAbort); code === 0 ? resolve() : reject(new Error(`mp3 encode exited ${code}: ${err.trim().split('\n').slice(-1)}`)) })
  })
}

async function place(srcMp3: string, destMp3: string): Promise<void> {
  await rm(destMp3, { force: true })
  try { await rename(srcMp3, destMp3) }
  catch (e) { if ((e as NodeJS.ErrnoException)?.code === 'EXDEV') { await cp(srcMp3, destMp3); await rm(srcMp3, { force: true }) } else throw e }
}

export async function runSeparateJob(
  payload: StemSeparateJobPayload,
  signal?: AbortSignal,
  onProgress?: (p: DownloadProgress & { note?: string }) => void,
): Promise<void> {
  const { studioTrackId } = payload
  const [row] = await db.select().from(musicStudioTracks).where(eq(musicStudioTracks.id, studioTrackId)).limit(1)
  if (!row) { logger.info(`[separate] studio track ${studioTrackId} gone — skipping`); return }
  if (!row.sourceRelPath) { logger.info(`[separate] studio track ${studioTrackId} has no source — skipping`); return }
  if (!isStemAudioInstalled()) throw new Error('stem-audio runtime not installed')

  const plan = planFor(payload)
  const modelLabel = payload.stems?.length ? 'custom' : (payload.model ?? '4-stem')
  await db.update(musicStudioTracks)
    .set({ stemStatus: 'separating', stemModel: modelLabel, stemError: null, updatedAt: new Date() })
    .where(eq(musicStudioTracks.id, studioTrackId))
  const report = (pct: number, note = 'Separating…') => onProgress?.({ completed: Math.max(1, Math.min(99, pct)), total: 100, speedBps: 0, etaSeconds: 0, note })
  report(1)

  const input = await resolveUserPath(row.sourceRelPath)
  const trackDir = dirname(row.sourceRelPath)
  const demucsOut = await resolveUserPath(join(trackDir, '.demucs'))
  const stemsDir = await resolveUserPath(join(trackDir, 'stems'))
  const inputStem = 'source'   // demucs derives the subfolder from source.wav

  try {
    await rm(demucsOut, { recursive: true, force: true })
    await mkdir(demucsOut, { recursive: true })
    await mkdir(stemsDir, { recursive: true })
    const ff = await ensureFfmpeg()

    const demucsArgs = plan.twoStems
      ? ['-n', plan.demucsModel, '--two-stems=vocals', '--mp3', '--mp3-bitrate', '320', '-o', demucsOut, input]
      : ['-n', plan.demucsModel, '--mp3', '--mp3-bitrate', '320', '-o', demucsOut, input]
    // Demucs is the bulk of the work → map its 0-100 onto 0-85, leaving room for RoFormer.
    await runDemucs(stemVenvPython(), demucsArgs, signal, (pct) => report(Math.round(pct * 0.85)))

    const producedDir = join(demucsOut, plan.demucsModel, inputStem)
    const produced = existsSync(producedDir) ? await readdir(producedDir) : []
    const useRoformer = !plan.twoStems && plan.stems.includes('guitar') && isRoformerGuitarInstalled() && payload.enhancedGuitar !== false

    const ready: string[] = []
    for (const name of plan.stems) {
      if (name === 'guitar' && useRoformer) {
        report(88, 'Refining guitar…')
        const guitarWav = await separateGuitarRoformer(input, demucsOut, signal, (p) => report(85 + Math.round(p * 0.13), 'Refining guitar…'))
        if (guitarWav) {
          await wavToMp3(ff, guitarWav, join(stemsDir, 'guitar.mp3'), signal)
          ready.push('guitar'); continue
        }
        // fall through to Demucs guitar below
      }
      const src = produced.find((f) => f === `${name}.mp3`)
      if (!src) { logger.warn(`[separate] ${studioTrackId}: expected stem ${name}.mp3 missing`); continue }
      await place(join(producedDir, src), join(stemsDir, `${name}.mp3`))
      ready.push(name)
    }
    if (ready.length === 0) throw new Error('no stems produced')

    await db.update(musicStudioTracks).set({
      stemStatus: 'ready', stemModel: modelLabel, stemsJson: JSON.stringify(ready), stemError: null, updatedAt: new Date(),
    }).where(eq(musicStudioTracks.id, studioTrackId))
    onProgress?.({ completed: 100, total: 100, speedBps: 0, etaSeconds: 0, note: 'Stems ready' })
    logger.info(`[separate] ${studioTrackId}: ${ready.join(', ')} ready (${modelLabel}${useRoformer ? ' +roformer-guitar' : ''})`)
  } catch (err) {
    await db.update(musicStudioTracks)
      .set({ stemStatus: 'failed', stemError: String(err), updatedAt: new Date() })
      .where(eq(musicStudioTracks.id, studioTrackId))
    throw err
  } finally {
    await rm(demucsOut, { recursive: true, force: true }).catch(() => {})
  }
}

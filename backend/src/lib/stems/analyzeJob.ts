// audio-analyze job runner: tempo/beats/key/chords for a Music Studio track via the
// Essentia analyze.py script (data/stem-audio-venv). Fast (~10-25s/song), so it runs on
// demand when a track opens in the Studio and populates the analysis columns of
// music_studio_tracks. Best-effort: a failure marks the row failed and leaves the source
// intact; the mixer still works without analysis (just no metronome/chords/key).

import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { musicStudioTracks } from '@/db/schema'
import { resolveUserPath } from '@/lib/storage/paths'
import { stemVenvPython, ANALYZE_SCRIPT, ANALYZE_LIBROSA_SCRIPT, isStemAudioInstalled, isEssentiaAvailable, isAnalysisAvailable } from './pyenv'
import { dataDir } from '@/lib/download'
import { ensureFfmpeg } from '@/lib/ffmpeg'
import type { DownloadProgress } from '@/lib/download'
import { logger } from '@/lib/logger'
import { waitForInteractiveIdle } from '@/lib/activityGate'

const execFileAsync = promisify(execFile)

export interface AudioAnalyzeJobPayload { studioTrackId: string }

interface Manifest {
  durationSec?: number
  tempo?: { bpm?: number; confidence?: number }
  key?: { label?: string }
  beats?: Array<{ time: number; downbeat: boolean }>
  chords?: Array<{ startTime: number; endTime: number; label: string }>
}

/** Run the analyze script against `input`, returning parsed JSON. Rejects on non-zero exit. */
function runAnalyze(python: string, script: string, input: string, signal?: AbortSignal): Promise<Manifest> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script, input], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = '', err = ''
    child.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { err += d.toString(); if (err.length > 16_000) err = err.slice(-8_000) })
    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(e) })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return reject(new Error('cancelled'))
      if (code !== 0) return reject(new Error(`analyze.py exited ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`))
      try { resolve(JSON.parse(out) as Manifest) }
      catch (e) { reject(new Error(`analyze.py produced invalid JSON: ${e}`)) }
    })
  })
}

export async function runAnalyzeJob(
  payload: AudioAnalyzeJobPayload,
  signal?: AbortSignal,
  onProgress?: (p: DownloadProgress & { note?: string }) => void,
): Promise<void> {
  const { studioTrackId } = payload
  // Stems separation is a CPU/GPU-heavy Python job; yield to any live conversation
  // first so it never lags a reply. Bounded so it still runs on a busy box.
  await waitForInteractiveIdle({ quietMs: 1500, maxWaitMs: 30_000, label: 'stems-separate' })
  const [row] = await db.select().from(musicStudioTracks).where(eq(musicStudioTracks.id, studioTrackId)).limit(1)
  if (!row) { logger.info(`[analyze] studio track ${studioTrackId} gone — skipping`); return }
  if (!row.sourceRelPath) { logger.info(`[analyze] studio track ${studioTrackId} has no source — skipping`); return }
  if (!isStemAudioInstalled()) throw new Error('stem-audio runtime not installed')
  if (!isAnalysisAvailable()) {
    // Pre-v3 Windows installs (Demucs-only, no librosa yet) — boot reconcile upgrades
    // them in place. Park the track at 'none' (not 'failed': a platform/version gap,
    // not an error worth surfacing per-track) and move on.
    logger.info(`[analyze] no analysis runtime in this venv — skipping analysis for ${studioTrackId}`)
    await db.update(musicStudioTracks)
      .set({ analysisStatus: 'none', updatedAt: new Date() })
      .where(eq(musicStudioTracks.id, studioTrackId))
    return
  }

  await db.update(musicStudioTracks)
    .set({ analysisStatus: 'analyzing', analysisError: null, updatedAt: new Date() })
    .where(eq(musicStudioTracks.id, studioTrackId))
  onProgress?.({ completed: 5, total: 100, speedBps: 0, etaSeconds: 0, note: 'Analysing…' })

  // essentia's MonoLoader decodes any container itself; the librosa fallback only
  // reliably reads what libsndfile covers (no m4a/aac), so feed it a mono 44.1 kHz
  // WAV transcode instead. The app's own ffmpeg does the conversion.
  const useEssentia = isEssentiaAvailable()
  let tempWav: string | null = null

  try {
    let input = await resolveUserPath(row.sourceRelPath)
    if (!useEssentia) {
      const ffmpeg = await ensureFfmpeg()
      const tmpDir = join(dataDir, 'tmp')
      await mkdir(tmpDir, { recursive: true })
      tempWav = join(tmpDir, `analyze-${studioTrackId}.wav`)
      await execFileAsync(ffmpeg, ['-y', '-i', input, '-vn', '-ac', '1', '-ar', '44100', '-f', 'wav', tempWav],
        { timeout: 5 * 60_000, windowsHide: true })
      input = tempWav
    }
    const m = await runAnalyze(stemVenvPython(), useEssentia ? ANALYZE_SCRIPT : ANALYZE_LIBROSA_SCRIPT, input, signal)
    await db.update(musicStudioTracks).set({
      analysisStatus: 'ready',
      analysisError: null,
      bpm: m.tempo?.bpm ?? null,
      keyLabel: m.key?.label ?? null,
      beatsJson: m.beats ? JSON.stringify(m.beats) : null,
      chordsJson: m.chords ? JSON.stringify(m.chords) : null,
      durationSec: m.durationSec ?? row.durationSec ?? null,
      updatedAt: new Date(),
    }).where(eq(musicStudioTracks.id, studioTrackId))
    onProgress?.({ completed: 100, total: 100, speedBps: 0, etaSeconds: 0, note: 'Analysis ready' })
    logger.info(`[analyze] ${studioTrackId}: ready (bpm ${m.tempo?.bpm ?? '?'}, key ${m.key?.label ?? '?'}, ${m.chords?.length ?? 0} chords)`)
  } catch (err) {
    await db.update(musicStudioTracks)
      .set({ analysisStatus: 'failed', analysisError: String(err), updatedAt: new Date() })
      .where(eq(musicStudioTracks.id, studioTrackId))
    throw err
  } finally {
    if (tempWav) await rm(tempWav, { force: true }).catch(() => {})
  }
}

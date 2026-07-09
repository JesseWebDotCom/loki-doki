// music-analyze job runner: ML music intelligence (sound embedding + mood/genre scalars)
// for one library track via library_analyze.py (data/stem-audio-venv, essentia-tensorflow).
// Low-priority compute-lane work — analysis converges opportunistically on everything the
// household actually plays/saves (completeAsset hook) plus admin backfills. Soft-fails when
// the audio isn't on disk (prefetch evicted) so the job queue never wedges on gone bytes.

import { spawn } from 'node:child_process'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { musicTrackFeatures } from '@/db/schema'
import { resolveAudioFile, parseTrackRef } from '@/lib/music/trackRef'
import { stemVenvPython, LIBRARY_ANALYZE_SCRIPT, MUSIC_INTEL_DIR, INTEL_MODEL_VERSION, isMusicIntelReady } from './pyenv'
import { scanAudioFile } from '@/lib/music/audioScan'
import type { DownloadProgress } from '@/lib/download'
import { logger } from '@/lib/logger'

export interface LibraryAnalyzePayload { ref: string; title?: string; artist?: string; source?: string }

interface IntelManifest {
  durationSec?: number
  bpm?: number | null
  keyLabel?: string | null
  energy?: number
  valence?: number
  danceability?: number
  aggressiveness?: number
  acousticness?: number
  tags?: string[]
  embedding?: number[]
}

function runScript(input: string, signal?: AbortSignal): Promise<IntelManifest> {
  return new Promise((resolve, reject) => {
    const child = spawn(stemVenvPython(), [LIBRARY_ANALYZE_SCRIPT, input, MUSIC_INTEL_DIR], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    let out = '', err = ''
    child.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { err += d.toString(); if (err.length > 16_000) err = err.slice(-8_000) })
    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(e) })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return reject(new Error('cancelled'))
      if (code !== 0) return reject(new Error(`library_analyze.py exited ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`))
      try { resolve(JSON.parse(out) as IntelManifest) }
      catch (e) { reject(new Error(`library_analyze.py produced invalid JSON: ${e}`)) }
    })
  })
}

/** True when this ref already has features at the current model version. */
export async function hasFreshFeatures(ref: string): Promise<boolean> {
  const [row] = await db.select({ status: musicTrackFeatures.status, modelVersion: musicTrackFeatures.modelVersion })
    .from(musicTrackFeatures).where(eq(musicTrackFeatures.ref, ref)).limit(1)
  return row?.status === 'ready' && row.modelVersion === INTEL_MODEL_VERSION
}

export async function runLibraryAnalyzeJob(
  payload: LibraryAnalyzePayload,
  signal?: AbortSignal,
  onProgress?: (p: DownloadProgress & { note?: string }) => void,
): Promise<void> {
  const { ref, title, artist } = payload
  if (!isMusicIntelReady()) throw new Error('music-intelligence runtime not installed')
  if (await hasFreshFeatures(ref)) return

  const absPath = await resolveAudioFile(ref)
  if (!absPath) {
    // Not on disk (never saved / prefetch evicted) — a soft skip, not a failure: the
    // completeAsset hook will re-enqueue next time the audio lands.
    logger.info(`[music-intel] ${ref}: audio not on disk — skipping`)
    return
  }

  onProgress?.({ completed: 10, total: 100, speedBps: 0, etaSeconds: 0, note: 'Analysing sound…' })
  const now = new Date()
  const source = payload.source ?? parseTrackRef(ref).source
  try {
    const m = await runScript(absPath, signal)
    const emb = Array.isArray(m.embedding) && m.embedding.length ? new Float32Array(m.embedding) : null
    await db.insert(musicTrackFeatures).values({
      ref, source, title: title ?? null, artist: artist ?? null,
      durationSec: m.durationSec ?? null, bpm: m.bpm ?? null, keyLabel: m.keyLabel ?? null,
      energy: m.energy ?? null, valence: m.valence ?? null, danceability: m.danceability ?? null,
      aggressiveness: m.aggressiveness ?? null, acousticness: m.acousticness ?? null,
      tagsJson: m.tags ? JSON.stringify(m.tags) : null,
      embedding: emb ? Buffer.from(emb.buffer, emb.byteOffset, emb.byteLength) : null,
      modelVersion: INTEL_MODEL_VERSION, status: 'ready', error: null, analyzedAt: now,
    }).onConflictDoUpdate({
      target: musicTrackFeatures.ref,
      set: {
        source, title: title ?? null, artist: artist ?? null,
        durationSec: m.durationSec ?? null, bpm: m.bpm ?? null, keyLabel: m.keyLabel ?? null,
        energy: m.energy ?? null, valence: m.valence ?? null, danceability: m.danceability ?? null,
        aggressiveness: m.aggressiveness ?? null, acousticness: m.acousticness ?? null,
        tagsJson: m.tags ? JSON.stringify(m.tags) : null,
        embedding: emb ? Buffer.from(emb.buffer, emb.byteOffset, emb.byteLength) : null,
        modelVersion: INTEL_MODEL_VERSION, status: 'ready', error: null, analyzedAt: now,
      },
    })
    // Invalidate the in-memory embedding cache so similarity sees the new row.
    void import('@/lib/music/similarity').then((s) => s.invalidateSimilarityCache()).catch(() => {})
    // Piggyback the cheap ffmpeg facts (loudness/waveform) if this ref was never scanned.
    void scanAudioFileIfMissing(ref, absPath)
    onProgress?.({ completed: 100, total: 100, speedBps: 0, etaSeconds: 0, note: 'Sound profile ready' })
    logger.info(`[music-intel] ${ref}: ready (${m.tags?.slice(0, 3).join(', ') ?? 'no tags'})`)
  } catch (err) {
    await db.insert(musicTrackFeatures).values({
      ref, source, title: title ?? null, artist: artist ?? null,
      modelVersion: INTEL_MODEL_VERSION, status: 'failed', error: String(err).slice(0, 500), analyzedAt: now,
    }).onConflictDoUpdate({
      target: musicTrackFeatures.ref,
      set: { status: 'failed', error: String(err).slice(0, 500), modelVersion: INTEL_MODEL_VERSION, analyzedAt: now },
    })
    throw err
  }
}

async function scanAudioFileIfMissing(ref: string, absPath: string): Promise<void> {
  try {
    const { musicTrackAudio } = await import('@/db/schema')
    const [row] = await db.select({ ref: musicTrackAudio.ref }).from(musicTrackAudio).where(eq(musicTrackAudio.ref, ref)).limit(1)
    if (!row) await scanAudioFile(ref, absPath)
  } catch { /* best-effort */ }
}

// Whisper transcription of podcast episodes as a background job (download-jobs type
// 'podcast-transcribe', compute lane). Pipeline: resolve the episode's audio (local
// generated file → downloaded shared blob → stream the remote enclosure to a temp
// file) → ffmpeg-decode it into 16 kHz mono WAV chunks → the voice sidecar's
// timestamped Whisper mode per chunk → canonical segments in podcast_transcripts.
// Never runs inside a request handler; the episode page polls the transcript status.

import { createWriteStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { downloadJobs, mediaAssets, podcastEpisodes, podcastTranscripts } from '@/db/schema'
import { acquireRead, blobAbsPath, contentTmpDir, releaseRead } from '@/lib/content/store'
import { ensureFfmpeg } from '@/lib/ffmpeg'
import { resolveUserPath } from '@/lib/storage/paths'
import { safeFetch } from '@/lib/ssrfGuard'
import { transcribeWav, transcribeWavTimed } from '@/lib/whisper'
import { whisperUrl } from '@/lib/voice/config'
import { maybeSpawnVoiceServer } from '@/lib/voiceServer'
import { mergeSegments, saveTranscript, setTranscriptStatus, type TranscriptSegment } from '@/lib/podcast/transcripts'
import type { DownloadProgress } from '@/lib/download'
import { logger } from '@/lib/logger'

export interface PodcastTranscribePayload { episodeId: string }

// 5-minute decode chunks keep each sidecar request bounded (~9.6 MB of WAV) while the
// sidecar's own 30s/5s chunking supplies fine-grained timestamps inside each one.
const CHUNK_SEC = 300
// Fallback chunk length when the running sidecar predates the timestamped mode and can
// only transcribe Whisper's native 30s window per call.
const PLAIN_CHUNK_SEC = 30
// A decoded chunk at/below the bare WAV header size means we ran past the end.
const MIN_WAV_BYTES = 1024
const MAX_EPISODE_SECONDS = 6 * 60 * 60

export const transcribeJobRefId = (episodeId: string) =>
  JSON.stringify({ episodeId } satisfies PodcastTranscribePayload)

/** The bundled voice sidecar answers /health; a plain whisper-server 404s it but answers
 *  its root. Either response proves something is listening and able to take /inference. */
async function sttReachable(): Promise<boolean> {
  try {
    const base = await whisperUrl()
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2500) })
    if (res.ok) return true
  } catch { /* fall through to the root probe */ }
  try {
    const base = await whisperUrl()
    const res = await fetch(`${base}/`, { signal: AbortSignal.timeout(2500) })
    return res.ok || res.status === 400 || res.status === 404
  } catch {
    return false
  }
}

/** Queue a Whisper transcription for an episode (idempotent: an in-flight job is
 *  reused; a finished/failed one is reset). Marks the transcript row pending. */
export async function enqueueEpisodeTranscription(episodeId: string, requestedBy: string | null): Promise<void> {
  const [episode] = await db.select({
    id: podcastEpisodes.id, title: podcastEpisodes.title,
    audioRelPath: podcastEpisodes.audioRelPath, enclosureUrl: podcastEpisodes.enclosureUrl,
    assetId: podcastEpisodes.assetId, durationSec: podcastEpisodes.durationSec,
  }).from(podcastEpisodes).where(eq(podcastEpisodes.id, episodeId)).limit(1)
  if (!episode) throw new Error('Unknown episode')

  // A ready transcript never gets silently re-run (processing/pending just reuses the
  // job). Checked BEFORE the audio guard: when there is already a transcript there is
  // nothing to do, and whether the audio is still reachable is beside the point.
  const [existing] = await db.select({ status: podcastTranscripts.status }).from(podcastTranscripts)
    .where(eq(podcastTranscripts.episodeId, episodeId)).limit(1)
  if (existing?.status === 'ready') return

  if (!episode.audioRelPath && !episode.enclosureUrl && !episode.assetId) throw new Error('Episode has no audio to transcribe')
  if ((episode.durationSec ?? 0) > MAX_EPISODE_SECONDS) throw new Error('Episode is too long to transcribe')

  await setTranscriptStatus(episodeId, 'pending', { source: 'whisper', requestedBy })

  const refId = transcribeJobRefId(episodeId)
  const now = new Date()
  const [job] = await db.select().from(downloadJobs)
    .where(and(eq(downloadJobs.type, 'podcast-transcribe'), eq(downloadJobs.refId, refId))).limit(1)
  if (job) {
    if (job.status === 'failed' || job.status === 'cancelled' || job.status === 'completed') {
      await db.update(downloadJobs)
        .set({ status: 'pending', attempts: 0, nextEligibleAt: null, lastError: null, progress: null, updatedAt: now })
        .where(eq(downloadJobs.id, job.id))
    }
  } else {
    await db.insert(downloadJobs).values({
      id: crypto.randomUUID(), type: 'podcast-transcribe', refId, variantKey: null,
      domain: 'podcast', sizeClass: 'small', label: `Transcribe: ${episode.title.slice(0, 100)}`,
      priority: 70, status: 'pending', attempts: 0, maxAttempts: 2,
      nextEligibleAt: null, lastError: null, progress: null, createdAt: now, updatedAt: now,
    })
  }
  // The scheduler's 5s tick picks it up (same contract as podcast-download).
}

/** Terminal-failure/cancel hook so the transcript row never sits on 'processing'. */
export async function failPodcastTranscribeByJobRefId(refId: string, error: string): Promise<void> {
  let episodeId: string
  try { episodeId = (JSON.parse(refId) as PodcastTranscribePayload).episodeId } catch { return }
  const [row] = await db.select({ status: podcastTranscripts.status }).from(podcastTranscripts)
    .where(eq(podcastTranscripts.episodeId, episodeId)).limit(1)
  if (!row || row.status === 'ready') return
  await setTranscriptStatus(episodeId, 'failed', { error: error.slice(0, 300) })
}

/** Resolve a local audio path for the episode, downloading the enclosure to a temp
 *  file when no local copy exists. `cleanup` MUST run when the caller is done. */
async function resolveAudioPath(episode: {
  id: string
  audioRelPath: string | null
  assetId: string | null
  enclosureUrl: string | null
}, signal: AbortSignal): Promise<{ absPath: string; cleanup: () => Promise<void> }> {
  // 1. Generated episode: per-user mp3.
  if (episode.audioRelPath) {
    return { absPath: await resolveUserPath(episode.audioRelPath), cleanup: async () => {} }
  }
  // 2. Downloaded RSS episode: shared blob (read-pinned so GC can't unlink mid-decode).
  if (episode.assetId) {
    const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, episode.assetId))
    if (asset?.status === 'ready' && asset.blobHash) {
      const absPath = await blobAbsPath(asset.blobHash)
      acquireRead(asset.blobHash)
      return { absPath, cleanup: async () => releaseRead(asset.blobHash!) }
    }
  }
  // 3. Remote RSS episode: stream the enclosure to a temp file.
  if (!episode.enclosureUrl) throw new Error('Episode has no audio source')
  const tmpPath = join(await contentTmpDir(), `podcast-stt-${episode.id}-${Date.now()}`)
  const res = await safeFetch(episode.enclosureUrl, {
    headers: { 'User-Agent': 'LokiDoki/3.0 podcast', Accept: '*/*', 'Accept-Encoding': 'identity' },
  }, { timeoutMs: 30_000, maxRedirects: 8 })
  if (!res.ok || !res.body) {
    res.body?.cancel().catch(() => {})
    throw new Error(`Enclosure responded ${res.status}`)
  }
  const out = createWriteStream(tmpPath)
  const reader = res.body.getReader()
  try {
    for (;;) {
      if (signal.aborted) throw new Error('Aborted')
      const { done, value } = await reader.read()
      if (done) break
      await new Promise<void>((resolve, reject) => out.write(value, err => err ? reject(err) : resolve()))
    }
  } catch (err) {
    await new Promise<void>(resolve => out.end(() => resolve()))
    await unlink(tmpPath).catch(() => {})
    throw err
  } finally {
    reader.releaseLock?.()
  }
  await new Promise<void>(resolve => out.end(() => resolve()))
  return { absPath: tmpPath, cleanup: async () => { await unlink(tmpPath).catch(() => {}) } }
}

/** Decode [offsetSec, offsetSec+chunkSec) of any audio file into 16 kHz mono WAV bytes. */
async function decodeChunkWav(ffmpeg: string, srcPath: string, offsetSec: number, chunkSec: number, signal: AbortSignal): Promise<Uint8Array> {
  const proc = Bun.spawn([
    ffmpeg, '-v', 'error',
    '-ss', String(offsetSec), '-t', String(chunkSec),
    '-i', srcPath,
    '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1',
  ], { stdout: 'pipe', stderr: 'pipe' })
  const onAbort = () => proc.kill()
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const [bytes, code] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      proc.exited,
    ])
    if (code !== 0) {
      const err = await new Response(proc.stderr).text().catch(() => '')
      throw new Error(`ffmpeg decode failed (code ${code}): ${err.slice(0, 200)}`)
    }
    return new Uint8Array(bytes)
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** The job runner. Chunks the audio, transcribes each chunk through the sidecar's
 *  timestamped mode (falling back to native-window chunks on old sidecars), offsets
 *  the timestamps, and lands the canonical transcript. */
export async function runPodcastTranscribeJob(
  payload: PodcastTranscribePayload,
  onProgress: (p: DownloadProgress & { note?: string }) => void,
  signal: AbortSignal,
): Promise<void> {
  const { episodeId } = payload
  const [episode] = await db.select({
    id: podcastEpisodes.id, title: podcastEpisodes.title, durationSec: podcastEpisodes.durationSec,
    audioRelPath: podcastEpisodes.audioRelPath, assetId: podcastEpisodes.assetId,
    enclosureUrl: podcastEpisodes.enclosureUrl,
  }).from(podcastEpisodes).where(eq(podcastEpisodes.id, episodeId)).limit(1)
  if (!episode) throw new Error(`Unknown episode ${episodeId}`)

  // Someone else's run may have landed it between enqueue and pickup.
  const [existing] = await db.select({ status: podcastTranscripts.status }).from(podcastTranscripts)
    .where(eq(podcastTranscripts.episodeId, episodeId)).limit(1)
  if (existing?.status === 'ready') return

  await setTranscriptStatus(episodeId, 'processing', { source: 'whisper' })

  // The Whisper sidecar cold-starts in the background; give it a bounded window to
  // come up before the first chunk (model load can take a minute on first run).
  await maybeSpawnVoiceServer().catch(() => {})
  const deadline = Date.now() + 120_000
  while (!(await sttReachable())) {
    if (signal.aborted) throw new Error('Aborted')
    if (Date.now() > deadline) throw new Error('Voice server (Whisper) is not reachable')
    await new Promise(r => setTimeout(r, 3000))
  }

  const ffmpeg = await ensureFfmpeg()
  const emit = (doneSec: number, totalSec: number, note: string) =>
    onProgress({ completed: Math.round(doneSec), total: Math.max(Math.round(totalSec), 1), speedBps: 0, etaSeconds: 0, note })

  const { absPath, cleanup } = await resolveAudioPath(episode, signal)
  try {
    const totalSec = episode.durationSec && episode.durationSec > 0 ? episode.durationSec : 0
    const allSegments: TranscriptSegment[] = []
    let chunkSec = CHUNK_SEC
    let timedMode = true
    let offset = 0

    for (;;) {
      if (signal.aborted) throw new Error('Aborted')
      if (offset > MAX_EPISODE_SECONDS) break
      emit(offset, totalSec || offset + chunkSec, totalSec
        ? `Transcribing ${Math.min(Math.round((offset / totalSec) * 100), 99)}%`
        : `Transcribing minute ${Math.round(offset / 60)}`)

      const wav = await decodeChunkWav(ffmpeg, absPath, offset, chunkSec, signal)
      if (wav.byteLength <= MIN_WAV_BYTES) break  // past the end of the audio

      if (timedMode) {
        const { text, segments } = await transcribeWavTimed(wav)
        if (segments === null) {
          // Old sidecar: only the native 30s window per call is usable. Re-run this
          // span in 30s slices so nothing already decoded is wasted or skipped.
          logger.warn('[podcast-transcribe] sidecar has no timestamped mode; falling back to 30s chunks')
          timedMode = false
          chunkSec = PLAIN_CHUNK_SEC
          if (text.trim()) {
            allSegments.push({ startSec: offset, endSec: offset + PLAIN_CHUNK_SEC, text: text.trim() })
            offset += PLAIN_CHUNK_SEC
          }
          continue
        }
        for (const s of segments) {
          allSegments.push({ startSec: offset + s.start, endSec: offset + s.end, text: s.text })
        }
      } else {
        const text = await transcribeWav(wav)
        if (text.trim()) {
          allSegments.push({ startSec: offset, endSec: offset + chunkSec, text: text.trim() })
        }
      }
      offset += chunkSec
    }

    if (!allSegments.length) throw new Error('No speech detected in the episode audio')
    const segments = mergeSegments(allSegments)
    await saveTranscript(episodeId, 'whisper', 'whisper', segments)
    emit(totalSec || offset, totalSec || offset, 'Transcript ready')
    logger.info(`[podcast-transcribe] "${episode.title}": ${segments.length} segments (${Math.round(offset / 60)} min)`)

    // AI insights are cheap to chain once the transcript exists: pre-listen summary,
    // takeaways, and auto-chapters when the episode has none. Best-effort.
    const { generateEpisodeInsights } = await import('@/lib/podcast/ai')
    generateEpisodeInsights(episodeId).catch(err =>
      logger.warn(`[podcast-transcribe] auto insights failed for ${episodeId}: ${err}`))

    // Ad scan chains the same way, but only when someone actually has skip-ads on
    // for this show (the gate lives in maybeEnqueueAdScanForEpisode). Best-effort.
    const { maybeEnqueueAdScanForEpisode } = await import('@/lib/podcast/adScan')
    maybeEnqueueAdScanForEpisode(episodeId).catch(err =>
      logger.warn(`[podcast-transcribe] auto ad scan failed for ${episodeId}: ${err}`))
  } catch (err) {
    // Retries re-enter through the scheduler; the terminal-failure hook flips the row
    // to 'failed'. Reset to 'pending' here so the UI shows "queued" between attempts.
    await setTranscriptStatus(episodeId, 'pending', { error: String(err).slice(0, 300) }).catch(() => {})
    throw err
  } finally {
    await cleanup()
  }
}

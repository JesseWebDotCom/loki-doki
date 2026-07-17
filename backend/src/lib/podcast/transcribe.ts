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
import { resolveUserPath } from '@/lib/storage/paths'
import { safeFetch } from '@/lib/ssrfGuard'
import { transcribeAudioFile } from '@/lib/audio/whisperTranscribe'
import { saveTranscript, setTranscriptStatus } from '@/lib/podcast/transcripts'
import type { DownloadProgress } from '@/lib/download'
import { logger } from '@/lib/logger'

export interface PodcastTranscribePayload { episodeId: string }

const MAX_EPISODE_SECONDS = 6 * 60 * 60

export const transcribeJobRefId = (episodeId: string) =>
  JSON.stringify({ episodeId } satisfies PodcastTranscribePayload)

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

/** The job runner. Resolves the episode's audio, transcribes it through the shared
 *  Whisper pipeline (see lib/audio/whisperTranscribe.ts), and lands the canonical
 *  transcript. */
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

  const { absPath, cleanup } = await resolveAudioPath(episode, signal)
  try {
    const totalSec = episode.durationSec && episode.durationSec > 0 ? episode.durationSec : 0
    const segments = await transcribeAudioFile(absPath, {
      maxSeconds: MAX_EPISODE_SECONDS,
      durationSec: totalSec,
      signal,
      onProgress: (doneSec, totalSecOut, note) =>
        onProgress({ completed: Math.round(doneSec), total: Math.max(Math.round(totalSecOut), 1), speedBps: 0, etaSeconds: 0, note }),
    })

    await saveTranscript(episodeId, 'whisper', 'whisper', segments)
    logger.info(`[podcast-transcribe] "${episode.title}": ${segments.length} segments`)

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

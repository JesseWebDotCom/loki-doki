// Local transcript generation for videos whose platform ships no captions (or whose
// captions failed to resolve) — the video-watch-page analog of the podcast "Transcribe"
// button. Background job (download-jobs type 'video-transcribe', compute lane): pull the
// video's audio (yt-dlp, audio-only — no video bytes) and run it through the exact same
// Whisper pipeline podcasts use (lib/audio/whisperTranscribe.ts), landing the result in
// video_transcripts. Once ready, Ask-the-video and the semantic index pick it up the same
// way they already pick up platform-provided captions (see askVideo.ts / semanticIndex.ts).

import { spawn } from 'node:child_process'
import { unlink, readdir } from 'node:fs/promises'
import { dirname, basename, join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { downloadJobs, videoTranscripts } from '@/db/schema'
import { contentTmpDir } from '@/lib/content/store'
import { ytDlpBin, withYtDlpSlot } from '@/lib/ytdlp'
import { transcribeAudioFile } from '@/lib/audio/whisperTranscribe'
import { getProvider } from '@/lib/videos/registry'
import { ensureVideoIndexed } from '@/lib/videos/semanticIndex'
import type { DownloadProgress } from '@/lib/download'
import { logger } from '@/lib/logger'

export interface VideoTranscribePayload { source: string; videoId: string; url: string | null }

const MAX_VIDEO_SECONDS = 6 * 60 * 60

export const videoTranscribeJobRefId = (source: string, videoId: string, url: string) =>
  JSON.stringify({ source, videoId, url } satisfies VideoTranscribePayload)

async function getRow(source: string, videoId: string) {
  const [row] = await db.select().from(videoTranscripts)
    .where(and(eq(videoTranscripts.source, source), eq(videoTranscripts.videoId, videoId))).limit(1)
  return row ?? null
}

async function setStatus(
  source: string, videoId: string, status: 'pending' | 'processing' | 'ready' | 'failed',
  opts: { error?: string | null; requestedBy?: string | null; segmentsJson?: string; segmentCount?: number } = {},
): Promise<void> {
  const now = new Date()
  await db.insert(videoTranscripts).values({
    id: crypto.randomUUID(), source, videoId, status,
    error: opts.error ?? null, requestedBy: opts.requestedBy ?? null,
    segmentsJson: opts.segmentsJson ?? null, segmentCount: opts.segmentCount ?? null,
    createdAt: now, updatedAt: now,
  }).onConflictDoUpdate({
    target: [videoTranscripts.source, videoTranscripts.videoId],
    set: {
      status, error: opts.error ?? null,
      ...(opts.requestedBy !== undefined ? { requestedBy: opts.requestedBy ?? null } : {}),
      ...(opts.segmentsJson !== undefined ? { segmentsJson: opts.segmentsJson, segmentCount: opts.segmentCount ?? null } : {}),
      updatedAt: now,
    },
  })
}

/** True when this (source, videoId) already has a ready, locally-generated transcript. */
export async function hasGeneratedTranscript(source: string, videoId: string): Promise<boolean> {
  const row = await getRow(source, videoId)
  return row?.status === 'ready'
}

/** The generated transcript as VTT-cue-shaped `{start, text}` windows — the same shape
 *  `chunkCues()` (semanticIndex.ts) already consumes for platform captions, so callers
 *  can treat a Whisper-generated transcript identically to a platform one. */
export async function getGeneratedTranscriptCues(source: string, videoId: string): Promise<{ start: number; text: string }[] | null> {
  const row = await getRow(source, videoId)
  if (row?.status !== 'ready' || !row.segmentsJson) return null
  try {
    const segments = JSON.parse(row.segmentsJson) as Array<{ startSec: number; text: string }>
    return segments.map((s) => ({ start: s.startSec, text: s.text }))
  } catch {
    return null
  }
}

/** Queue local transcription for a video (idempotent: an in-flight job is reused; a
 *  finished/failed one is reset). Marks the transcript row pending. Pass an
 *  OPPORTUNISTIC_PRIORITY `priority` for proactive passes nobody is waiting on, so the
 *  idle gate holds the Whisper run until the system is quiet. */
export async function enqueueVideoTranscription(
  source: string, videoId: string, url: string | null, durationSec: number | null, requestedBy: string | null,
  opts: { priority?: number } = {},
): Promise<void> {
  const existing = await getRow(source, videoId)
  if (existing?.status === 'ready') return
  if (!url) throw new Error('This video has no page URL to fetch audio from')
  if ((durationSec ?? 0) > MAX_VIDEO_SECONDS) throw new Error('Video is too long to transcribe')

  await setStatus(source, videoId, 'pending', { requestedBy })

  const refId = videoTranscribeJobRefId(source, videoId, url)
  const now = new Date()
  const [job] = await db.select().from(downloadJobs)
    .where(and(eq(downloadJobs.type, 'video-transcribe'), eq(downloadJobs.refId, refId))).limit(1)
  if (job) {
    if (job.status === 'failed' || job.status === 'cancelled' || job.status === 'completed') {
      await db.update(downloadJobs)
        .set({ status: 'pending', attempts: 0, nextEligibleAt: null, lastError: null, progress: null, updatedAt: now })
        .where(eq(downloadJobs.id, job.id))
    }
  } else {
    await db.insert(downloadJobs).values({
      id: crypto.randomUUID(), type: 'video-transcribe', refId, variantKey: null,
      domain: source === 'youtube' ? 'youtube' : source === 'reddit' ? 'reddit' : source === 'tiktok' ? 'tiktok' : source === 'vimeo' ? 'vimeo' : 'local',
      sizeClass: 'small', label: `Transcribe: ${videoId}`,
      priority: opts.priority ?? 70, status: 'pending', attempts: 0, maxAttempts: 2,
      nextEligibleAt: null, lastError: null, progress: null, createdAt: now, updatedAt: now,
    })
  }
  // The scheduler's 5s tick picks it up (same contract as podcast-transcribe).
}

/** Terminal-failure/cancel hook so the transcript row never sits on 'processing'. */
export async function failVideoTranscribeByJobRefId(refId: string, error: string): Promise<void> {
  let payload: { source: string; videoId: string }
  try { payload = JSON.parse(refId) } catch { return }
  const row = await getRow(payload.source, payload.videoId)
  if (!row || row.status === 'ready') return
  await setStatus(payload.source, payload.videoId, 'failed', { error: error.slice(0, 300) })
}

/** Pull audio-only (no video bytes) via yt-dlp to a temp file. Works for every source
 *  yt-dlp already supports downloads for — the same binary the caption-only fetch
 *  (resolveVideoVtt) and offline saves already use, just without --skip-download and
 *  restricted to the smallest usable audio format. */
async function fetchAudioOnly(url: string, source: string, videoId: string, signal: AbortSignal): Promise<{ absPath: string; cleanup: () => Promise<void> }> {
  const tmpDir = await contentTmpDir()
  const stem = `video-stt-${source}-${videoId}-${Date.now()}`.replace(/[^\w.-]/g, '_')
  const outTemplate = join(tmpDir, `${stem}.%(ext)s`)

  await withYtDlpSlot(() => new Promise<void>((resolve, reject) => {
    const proc = spawn(ytDlpBin(), [
      '-f', 'bestaudio/best',
      '--no-playlist', '--quiet',
      '-o', outTemplate,
      url,
    ], { stdio: 'ignore', windowsHide: true })
    const onAbort = () => proc.kill()
    signal.addEventListener('abort', onAbort, { once: true })
    proc.on('close', (code) => {
      signal.removeEventListener('abort', onAbort)
      code === 0 ? resolve() : reject(new Error(`yt-dlp audio fetch exited ${code}`))
    })
    proc.on('error', (err) => { signal.removeEventListener('abort', onAbort); reject(err) })
  }), { background: true })

  const files = await readdir(dirname(outTemplate)).catch(() => [] as string[])
  const match = files.find((f) => f.startsWith(stem))
  if (!match) throw new Error('yt-dlp did not produce an audio file')
  const absPath = join(dirname(outTemplate), match)
  return { absPath, cleanup: async () => { await unlink(absPath).catch(() => {}) } }
}

/** The job runner. Fetches audio-only, transcribes it through the shared Whisper
 *  pipeline, and lands the canonical transcript — then kicks the semantic indexer so
 *  the video becomes Ask-able / search-findable without waiting for the next check. */
export async function runVideoTranscribeJob(
  payload: VideoTranscribePayload,
  onProgress: (p: DownloadProgress & { note?: string }) => void,
  signal: AbortSignal,
): Promise<void> {
  const { source, videoId, url } = payload
  const existing = await getRow(source, videoId)
  if (existing?.status === 'ready') return
  if (!url) throw new Error('This video has no page URL to fetch audio from')

  await setStatus(source, videoId, 'processing')

  const { absPath, cleanup } = await fetchAudioOnly(url, source, videoId, signal)
  try {
    const segments = await transcribeAudioFile(absPath, {
      maxSeconds: MAX_VIDEO_SECONDS,
      signal,
      onProgress: (doneSec, totalSec, note) =>
        onProgress({ completed: Math.round(doneSec), total: Math.max(Math.round(totalSec), 1), speedBps: 0, etaSeconds: 0, note }),
    })

    await setStatus(source, videoId, 'ready', { segmentsJson: JSON.stringify(segments), segmentCount: segments.length })
    logger.info(`[video-transcribe] ${source}:${videoId}: ${segments.length} segments`)

    // Best-effort: fold the fresh transcript into the semantic index right away so Ask
    // and "find the video where..." both see it immediately rather than on next visit.
    const provider = getProvider(source)
    const item = provider ? await provider.getItem(videoId, '').catch(() => null) : null
    ensureVideoIndexed(source, videoId, {
      title: item?.title, creatorName: item?.creator?.name, description: item?.description, url,
      userId: '', userFirstName: '',
    })
  } catch (err) {
    await setStatus(source, videoId, 'pending', { error: String(err).slice(0, 300) }).catch(() => {})
    throw err
  } finally {
    await cleanup()
  }
}

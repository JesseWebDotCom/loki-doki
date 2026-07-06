// Live-from-start DVR: record an in-progress YouTube livestream via yt-dlp's
// --live-from-start, landing it as a normal offline asset when done. Mirrors
// lib/music/radioRecord.ts's "stop keeps the partial, cancel still tries to keep it"
// design — a side-channel process map for graceful stop, NOT the downloadJobs queue's
// generic cancelJob() (that path is instant-DB-write-then-abort, which races a runner
// that's still trying to gracefully finalize; radio-record deliberately avoids it too).

import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { eq, and } from 'drizzle-orm'
import { db } from '@/db'
import { mediaAssets, ytDownloads, downloadJobs } from '@/db/schema'
import { withLock, putBlobFromFile, contentTmpDir } from '@/lib/content/store'
import { getContentTypeStorageLocationId } from '@/lib/storage/contentRoots'
import { getOrCreateAsset, assetSatisfies, assetLockKey, assetVariantKey, assetFormat, markAssetDownloading, completeAsset, type Kind } from '@/lib/youtube/assets'
import { ytDlpBin, ytDlpAuthArgs, withYtDlpSlot } from '@/lib/ytdlp'
import { probeHeight } from '@/lib/youtube/download'
import { ensureFfmpeg, ffmpegLocation } from '@/lib/ffmpeg'
import type { DownloadProgress } from '@/lib/download'
import { logger } from '@/lib/logger'

const execFileAsync = promisify(execFile)
const YT_WATCH_BASE = 'https://www.youtube.com/watch?v='

// Below this, a "recording" isn't worth keeping — treat it like a failed start.
const MIN_KEEP_SEC = 15

export interface YtLiveRecordPayload { assetId: string }

/** Authoritative live check (yt-dlp -J) right before a recording starts — the cheap
 *  InnerTube-backed isLive on ItPlayerMeta can be stale by the time the button is clicked. */
export async function getLiveStatus(videoId: string): Promise<{ isLive: boolean; liveStatus: string | null }> {
  return withYtDlpSlot(async () => {
    try {
      const { stdout } = await execFileAsync(ytDlpBin(),
        ['-J', '--no-warnings', '--no-playlist', ...ytDlpAuthArgs(), `${YT_WATCH_BASE}${videoId}`],
        { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 })
      const info = JSON.parse(stdout) as { is_live?: boolean; live_status?: string }
      return { isLive: !!info.is_live || info.live_status === 'is_live', liveStatus: info.live_status ?? null }
    } catch {
      return { isLive: false, liveStatus: null }
    }
  })
}

// Active yt-dlp processes by videoId — lets the stop route finalize gracefully
// ("stop and keep") instead of going through the queue's generic cancelJob (which discards).
const active = new Map<string, { proc: ChildProcess; requestedStop: boolean }>()

export function isLiveRecordingActive(videoId: string): boolean {
  return active.has(videoId)
}

/** Graceful stop-and-keep: SIGINT is yt-dlp's own clean-shutdown signal for a live download —
 *  it stops pulling new fragments and runs its normal postprocessing (remux) on what it has.
 *  The runner then goes through its normal finish path, so the job completes rather than fails. */
export function stopLiveRecording(videoId: string): boolean {
  const entry = active.get(videoId)
  if (!entry) return false
  entry.requestedStop = true
  try { entry.proc.kill('SIGINT') } catch { /* already gone */ }
  setTimeout(() => {
    if (active.has(videoId)) { try { entry.proc.kill('SIGKILL') } catch { /* gone */ } }
  }, 30_000)
  return true
}

/** Coalesced enqueue of a live-record job for an asset — parallels assets.ts's
 *  enqueueAssetJob but for the 'yt-live-record' type/domain (its own concurrency lane so an
 *  hours-long recording never starves ordinary Save/Export jobs for the household). */
async function enqueueLiveRecordJob(asset: typeof mediaAssets.$inferSelect, label: string): Promise<void> {
  // Video-only in v1 (see startLiveRecording) — hardcode rather than pass asset.kind, which is
  // typed broader than assets.ts's Kind to cover the unrelated 'ebook' media-asset kind.
  const vk = assetVariantKey(asset.sourceId, 'video', asset.format)
  const now = new Date()
  const [existing] = await db.select({ id: downloadJobs.id, status: downloadJobs.status }).from(downloadJobs)
    .where(and(eq(downloadJobs.type, 'yt-live-record'), eq(downloadJobs.variantKey, vk))).limit(1)
  if (existing) {
    if (existing.status === 'pending' || existing.status === 'running') return  // already recording/queued
    await db.update(downloadJobs)
      .set({ status: 'pending', attempts: 0, nextEligibleAt: null, lastError: null, progress: null, updatedAt: now })
      .where(eq(downloadJobs.id, existing.id))
    return
  }
  await db.insert(downloadJobs).values({
    id: crypto.randomUUID(), type: 'yt-live-record', refId: JSON.stringify({ assetId: asset.id } satisfies YtLiveRecordPayload),
    variantKey: vk, domain: 'youtube-live', sizeClass: 'large', label,
    status: 'pending', priority: 20, attempts: 0, maxAttempts: 2,
    nextEligibleAt: null, lastError: null, progress: null, createdAt: now, updatedAt: now,
  })
}

/** Start (or join, if already recording/ready) a live-from-start capture for a video.
 *  video-only in v1. Mirrors automation.ts's enqueueVideoSave shape, but dispatches to the
 *  'yt-live-record' job type instead of 'yt-media'. */
export async function startLiveRecording(opts: { userId: string; videoId: string; title: string }): Promise<{ status: 'queued' | 'already-saved' | 'in-progress'; id: string }> {
  const { userId, videoId, title } = opts
  const kind: Kind = 'video'
  const format = assetFormat(kind)

  return withLock(assetLockKey(videoId, kind, format), async () => {
    const now = new Date()
    const asset = await getOrCreateAsset(videoId, kind, format)

    const [existing] = await db.select({ id: ytDownloads.id }).from(ytDownloads)
      .where(and(eq(ytDownloads.userId, userId), eq(ytDownloads.videoId, videoId), eq(ytDownloads.kind, kind)))
      .limit(1)
    const refId = existing?.id ?? crypto.randomUUID()
    if (!existing) {
      await db.insert(ytDownloads).values({
        id: refId, userId, videoId, title, kind, maxHeight: null, assetId: asset.id,
        status: 'pending', createdAt: now, updatedAt: now,
      })
    } else {
      await db.update(ytDownloads).set({ status: 'pending', error: null, assetId: asset.id, updatedAt: now })
        .where(eq(ytDownloads.id, refId))
    }

    if (assetSatisfies(asset, kind, null)) {
      await db.update(ytDownloads).set({ status: 'ready', sizeBytes: asset.sizeBytes, error: null, updatedAt: now })
        .where(eq(ytDownloads.id, refId))
      return { status: 'already-saved', id: refId }
    }

    const wasActive = asset.status === 'downloading'
    await enqueueLiveRecordJob(asset, `Record live "${title || videoId}"`)
    return { status: wasActive ? 'in-progress' : 'queued', id: refId }
  })
}

function fmtClock(sec: number): string {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export async function runYtLiveRecordJob(
  payload: YtLiveRecordPayload,
  onProgress: (p: DownloadProgress & { note?: string }) => void,
  signal: AbortSignal,
): Promise<void> {
  const { assetId } = payload
  const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId)).limit(1)
  if (!asset) return   // asset was deleted (all refs released) before the job ran
  const videoId = asset.sourceId

  const [anyRef] = await db.select({ id: ytDownloads.id }).from(ytDownloads).where(eq(ytDownloads.assetId, assetId)).limit(1)
  if (!anyRef) return

  await withLock(assetLockKey(videoId, 'video', asset.format), () => markAssetDownloading(assetId))

  await ensureFfmpeg()
  const ffLoc = ffmpegLocation()
  const url = `${YT_WATCH_BASE}${videoId}`

  const tmpDir = await contentTmpDir()
  const stem = `${assetId}.live`
  const outputTemplate = join(tmpDir, `${stem}.%(ext)s`)
  const absPath = join(tmpDir, `${stem}.mp4`)

  const args = [
    '--live-from-start',
    '-f', 'bestvideo+bestaudio/best',
    '--merge-output-format', 'mp4',
    '--hls-use-mpegts',
    '--wait-for-video', '30',
    '--no-warnings',
    '--newline',
    '--output', outputTemplate,
    '--no-playlist',
    ...ytDlpAuthArgs(),
    url,
  ]
  if (ffLoc) args.push('--ffmpeg-location', ffLoc)

  const entry = { proc: spawn(ytDlpBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] }), requestedStop: false }
  active.set(videoId, entry)

  let errTail = ''
  entry.proc.stderr?.on('data', (chunk: Buffer) => { errTail = (errTail + chunk.toString()).slice(-4096) })

  const startedAt = Date.now()
  const progressTimer = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000)
    onProgress({ completed: elapsed, total: 0, speedBps: 0, etaSeconds: 0, note: `Recording live — ${fmtClock(elapsed)}` })
  }, 2_000)

  // A queue-driven abort (shutdown, or a job admin cancels from the download queue UI) gets the
  // same graceful treatment as a user-initiated Stop: yt-dlp finishes its current fragment and
  // remuxes rather than losing everything to a hard kill, since hours of capture are at stake.
  const onAbort = () => {
    try { entry.proc.kill('SIGINT') } catch { /* gone */ }
    setTimeout(() => { try { entry.proc.kill('SIGKILL') } catch { /* gone */ } }, 30_000)
  }
  signal.addEventListener('abort', onAbort, { once: true })

  await new Promise<void>(resolve => {
    entry.proc.on('close', () => resolve())
    entry.proc.on('error', () => resolve())
  })

  clearInterval(progressTimer)
  signal.removeEventListener('abort', onAbort)
  active.delete(videoId)

  const elapsedSec = Math.round((Date.now() - startedAt) / 1000)
  const captured = existsSync(absPath)

  if (!captured || elapsedSec < MIN_KEEP_SEC) {
    const tail = errTail.trim().split('\n').filter(Boolean).slice(-3).join(' | ').slice(-500)
    throw new Error(`Live recording produced no usable video${tail ? `: ${tail}` : ''}`)
  }

  const actualHeight = await probeHeight(absPath)
  const storageLocationId = await getContentTypeStorageLocationId('youtube')
  const { hash, sizeBytes } = await putBlobFromFile(absPath, { mime: 'video/mp4', storageLocationId })
  await withLock(assetLockKey(videoId, 'video', asset.format), () => completeAsset(assetId, hash, actualHeight, sizeBytes))
  logger.info(`[youtube-live] recorded ${videoId} — ${fmtClock(elapsedSec)} kept`)
}

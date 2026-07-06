// Clipper download runner — spawns yt-dlp for a single user's save of any yt-dlp-supported
// URL, mirroring lib/youtube/download.ts's runYtMediaJob shape. Unlike YouTube's shared
// media_assets rendition (one asset fans out to every user who saved the same videoId), each
// clips row is a personal save with its own 1:1 media_assets row (sourceType='clip',
// sourceId=clips.id) — there's no cross-user dedup to coordinate, so no assets.ts-style
// fan-out/refcount machinery is needed here.

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { clips, mediaAssets } from '@/db/schema'
import { withLock, putBlobFromFile, contentTmpDir, markBlobLive } from '@/lib/content/store'
import { ytDlpBin } from '@/lib/ytdlp'
import { ensureFfmpeg, ffmpegLocation } from '@/lib/ffmpeg'
import type { DownloadProgress } from '@/lib/download'

export interface ClipDownloadJobPayload {
  clipId: string
  url: string
  kind: 'audio' | 'video'
}

const AUDIO_FORMAT = 'mp3'

function parseProgress(line: string): Partial<DownloadProgress> | null {
  // yt-dlp progress line: [download]  42.3% of  123.45MiB at   1.23MiB/s ETA 00:12
  const m = line.match(/\[download\]\s+([\d.]+)%.*?at\s+([\d.]+)([\w/]+)\s+ETA\s+(\d+):(\d+)/)
  if (!m) return null
  const pct = parseFloat(m[1]!)
  const min = parseInt(m[4]!, 10)
  const sec = parseInt(m[5]!, 10)
  return { completed: pct, total: 100, speedBps: 0, etaSeconds: min * 60 + sec }
}

async function runYtDlpDownload(args: string[], onProgress: (p: DownloadProgress & { note?: string }) => void, kind: 'audio' | 'video', signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ytDlpBin(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let killTimer: ReturnType<typeof setTimeout> | null = null
    // Drain stderr, keeping only a small rolling tail — an unread pipe fills (~64KB) and
    // blocks yt-dlp on a chatty failure.
    let errTail = ''
    proc.stderr?.on('data', (chunk: Buffer) => { errTail = (errTail + chunk.toString()).slice(-4096) })
    signal.addEventListener('abort', () => {
      proc.kill('SIGTERM')
      killTimer = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* gone */ } }, 5_000)
      reject(new Error('Aborted'))
    }, { once: true })
    proc.stdout?.on('data', (chunk: Buffer) => {
      const progress = parseProgress(chunk.toString())
      if (progress) onProgress({ ...progress, note: `Downloading ${kind}…` } as DownloadProgress & { note?: string })
    })
    proc.on('close', (code) => {
      if (killTimer) clearTimeout(killTimer)
      if (code === 0) resolve()
      else {
        const tail = errTail.trim().split('\n').slice(-3).join(' | ').slice(-500)
        reject(new Error(`yt-dlp exited with code ${code}${tail ? `: ${tail}` : ''}`))
      }
    })
    proc.on('error', reject)
  })
}

/** Create/refresh this clip's 1:1 media_assets row and mark it (and the clip) ready. Call
 *  inside withLock — mirrors lib/youtube/assets.ts's completeAsset, minus the multi-ref
 *  fan-out (a clip has exactly one referrer: itself). */
async function completeClipAsset(clipId: string, kind: 'audio' | 'video', format: string, hash: string, sizeBytes: number): Promise<void> {
  const now = new Date()
  const [existing] = await db.select().from(mediaAssets)
    .where(and(eq(mediaAssets.sourceType, 'clip'), eq(mediaAssets.sourceId, clipId), eq(mediaAssets.kind, kind), eq(mediaAssets.format, format)))
    .limit(1)

  const assetId = existing?.id ?? crypto.randomUUID()
  await markBlobLive(hash)
  if (existing) {
    await db.update(mediaAssets).set({ blobHash: hash, sizeBytes, status: 'ready', error: null, updatedAt: now }).where(eq(mediaAssets.id, assetId))
  } else {
    await db.insert(mediaAssets).values({
      id: assetId, sourceType: 'clip', sourceId: clipId, kind, format,
      height: null, blobHash: hash, status: 'ready', sizeBytes, error: null,
      createdAt: now, updatedAt: now,
    })
  }
  await db.update(clips).set({ status: 'ready', assetId, sizeBytes, error: null, updatedAt: now }).where(eq(clips.id, clipId))
}

/** Download one clip into the shared content store and mark it ready. Called from
 *  downloadJobs.ts runJob() dispatch (case 'clip_download'). */
export async function runClipDownloadJob(
  payload: ClipDownloadJobPayload,
  onProgress: (p: DownloadProgress & { note?: string }) => void,
  signal: AbortSignal,
): Promise<void> {
  const { clipId, url, kind } = payload
  await db.update(clips).set({ status: 'downloading', updatedAt: new Date() }).where(eq(clips.id, clipId))

  try {
    await ensureFfmpeg()
    const ffLoc = ffmpegLocation()

    // Stage into the content tmp dir (same filesystem as the blob store → cheap rename on put).
    const tmpDir = await contentTmpDir()
    const stem = `clip-${clipId}`
    const outputTemplate = join(tmpDir, `${stem}.%(ext)s`)

    const args: string[] = kind === 'audio'
      ? ['-x', '--audio-format', AUDIO_FORMAT, '--audio-quality', '0', '--socket-timeout', '30',
         '--output', outputTemplate, '--no-playlist', url]
      : ['-f', 'bestvideo+bestaudio/best', '-S', 'res,vcodec:h264,acodec:m4a', '--merge-output-format', 'mp4',
         '--socket-timeout', '30', '--output', outputTemplate, '--no-playlist', url]
    if (ffLoc) args.push('--ffmpeg-location', ffLoc)

    await runYtDlpDownload(args, onProgress, kind, signal)

    const format = kind === 'audio' ? AUDIO_FORMAT : 'mp4'
    const absPath = join(tmpDir, `${stem}.${format}`)
    const mime = kind === 'audio' ? 'audio/mpeg' : 'video/mp4'

    const { hash, sizeBytes } = await putBlobFromFile(absPath, { mime })
    await withLock(`clip-asset:${clipId}`, () => completeClipAsset(clipId, kind, format, hash, sizeBytes))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await db.update(clips).set({ status: 'failed', error: message.slice(0, 500), updatedAt: new Date() }).where(eq(clips.id, clipId))
    throw err
  }
}

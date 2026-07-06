// Multi-source video download runner (job type 'video-media'). Unlike clips (personal,
// 1:1 assets), saves share ONE media_assets rendition per (source, videoId, kind, format):
// the job is coalesced by that key and completion fans out to every user's video_saves row
// waiting on it — same store-once model as lib/youtube/assets.ts, minus quality variants.
//
// Two fetch methods (provider.downloadSpec):
//   ytdlp — spawn yt-dlp on a page URL (TikTok/Vimeo/most sites)
//   hls   — ffmpeg remux of an HLS manifest (reddit's v.redd.it: yt-dlp needs account
//           auth there, but the media CDN itself doesn't)

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { and, eq, ne, inArray } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { db } from '@/db'
import { mediaAssets, videoSaves } from '@/db/schema'
import { withLock, putBlobFromFile, contentTmpDir, markBlobLive } from '@/lib/content/store'
import { ytDlpBin } from '@/lib/ytdlp'
import { ensureFfmpeg, ffmpegBin, ffmpegLocation } from '@/lib/ffmpeg'
import { getProvider } from '@/lib/videos/registry'
import type { DownloadProgress } from '@/lib/download'
import type { GenericVideoSource } from '@/lib/videos/types'

export interface VideoMediaJobPayload {
  source: GenericVideoSource
  videoId: string
  kind: 'audio' | 'video'
  maxHeight?: number | null
}

const AUDIO_FORMAT = 'mp3'

function parseYtDlpProgress(line: string): Partial<DownloadProgress> | null {
  const m = line.match(/\[download\]\s+([\d.]+)%.*?ETA\s+(\d+):(\d+)/)
  if (!m) return null
  return { completed: parseFloat(m[1]!), total: 100, speedBps: 0, etaSeconds: parseInt(m[2]!, 10) * 60 + parseInt(m[3]!, 10) }
}

function runProcess(bin: string, args: string[], onLine: (line: string) => void, signal: AbortSignal, label: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let killTimer: ReturnType<typeof setTimeout> | null = null
    let errTail = ''
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      errTail = (errTail + text).slice(-4096)
      onLine(text)
    })
    proc.stdout?.on('data', (chunk: Buffer) => onLine(chunk.toString()))
    signal.addEventListener('abort', () => {
      proc.kill('SIGTERM')
      killTimer = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* gone */ } }, 5_000)
      reject(new Error('Aborted'))
    }, { once: true })
    proc.on('close', (code) => {
      if (killTimer) clearTimeout(killTimer)
      if (code === 0) resolve()
      else reject(new Error(`${label} exited with code ${code}${errTail ? `: ${errTail.trim().split('\n').slice(-2).join(' | ').slice(-400)}` : ''}`))
    })
    proc.on('error', reject)
  })
}

/** Upsert the shared asset row + flip every waiting save ref for this rendition. */
async function completeVideoAsset(
  payload: VideoMediaJobPayload, format: string, hash: string, sizeBytes: number,
): Promise<void> {
  const { source, videoId, kind } = payload
  const now = new Date()
  await markBlobLive(hash)

  const [existing] = await db.select().from(mediaAssets)
    .where(and(eq(mediaAssets.sourceType, source), eq(mediaAssets.sourceId, videoId), eq(mediaAssets.kind, kind), eq(mediaAssets.format, format)))
    .limit(1)
  const assetId = existing?.id ?? randomUUID()
  if (existing) {
    await db.update(mediaAssets).set({ blobHash: hash, sizeBytes, status: 'ready', error: null, updatedAt: now }).where(eq(mediaAssets.id, assetId))
  } else {
    await db.insert(mediaAssets).values({
      id: assetId, sourceType: source, sourceId: videoId, kind, format,
      height: payload.maxHeight ?? null, blobHash: hash, status: 'ready', sizeBytes, error: null,
      createdAt: now, updatedAt: now,
    })
  }
  await db.update(videoSaves)
    .set({ status: 'ready', assetId, sizeBytes, error: null, updatedAt: now })
    .where(and(eq(videoSaves.source, source), eq(videoSaves.videoId, videoId), eq(videoSaves.kind, kind), ne(videoSaves.status, 'ready')))
}

export async function runVideoMediaJob(
  payload: VideoMediaJobPayload,
  onProgress: (p: DownloadProgress & { note?: string }) => void,
  signal: AbortSignal,
): Promise<void> {
  const { source, videoId, kind } = payload
  const provider = getProvider(source)
  if (!provider) throw new Error(`unknown source ${source}`)

  await db.update(videoSaves).set({ status: 'downloading', updatedAt: new Date() })
    .where(and(eq(videoSaves.source, source), eq(videoSaves.videoId, videoId), eq(videoSaves.kind, kind), inArray(videoSaves.status, ['pending', 'failed'])))

  const spec = await provider.downloadSpec(videoId, kind, payload.maxHeight)
  await ensureFfmpeg()

  const tmpDir = await contentTmpDir()
  const stem = `video-${source}-${videoId}-${kind}`
  const format = kind === 'audio' ? AUDIO_FORMAT : 'mp4'
  const outPath = join(tmpDir, `${stem}.${format}`)

  if (spec.method === 'hls') {
    // Remux the manifest (best variant) straight to mp4; -c copy keeps it cheap.
    onProgress({ completed: 0, total: 100, speedBps: 0, etaSeconds: 0, note: 'Fetching stream…' })
    const args = ['-y', '-loglevel', 'warning', '-i', spec.url,
      ...(kind === 'audio' ? ['-vn', '-acodec', 'libmp3lame', '-q:a', '2'] : ['-c', 'copy', '-movflags', '+faststart', '-bsf:a', 'aac_adtstoasc']),
      outPath]
    await runProcess(ffmpegBin(), args, () => {}, signal, 'ffmpeg')
  } else {
    const outputTemplate = join(tmpDir, `${stem}.%(ext)s`)
    const heightCap = kind === 'video' && payload.maxHeight ? `[height<=${payload.maxHeight}]` : ''
    const args: string[] = kind === 'audio'
      ? ['-x', '--audio-format', AUDIO_FORMAT, '--audio-quality', '0', '--socket-timeout', '30',
         '--output', outputTemplate, '--no-playlist', ...(spec.ytdlpArgs ?? []), spec.url]
      : ['-f', `bestvideo${heightCap}+bestaudio/best${heightCap}/best`, '-S', 'res,vcodec:h264,acodec:m4a',
         '--merge-output-format', 'mp4', '--socket-timeout', '30',
         '--output', outputTemplate, '--no-playlist', ...(spec.ytdlpArgs ?? []), spec.url]
    const ffLoc = ffmpegLocation()
    if (ffLoc) args.push('--ffmpeg-location', ffLoc)
    await runProcess(ytDlpBin(), args, (line) => {
      const p = parseYtDlpProgress(line)
      if (p) onProgress({ ...p, note: `Downloading ${kind}…` } as DownloadProgress & { note?: string })
    }, signal, 'yt-dlp')
  }

  const mime = kind === 'audio' ? 'audio/mpeg' : 'video/mp4'
  const { hash, sizeBytes } = await putBlobFromFile(outPath, { mime })
  await withLock(`video-asset:${source}:${videoId}:${kind}`, () => completeVideoAsset(payload, format, hash, sizeBytes))
}

/** Flip waiting save refs to failed when the job exhausts its attempts (terminal hook). */
export async function failVideoSavesByJobRefId(refId: string, error: string): Promise<void> {
  const payload = JSON.parse(refId) as VideoMediaJobPayload
  await db.update(videoSaves)
    .set({ status: 'failed', error: error.slice(0, 500), updatedAt: new Date() })
    .where(and(eq(videoSaves.source, payload.source), eq(videoSaves.videoId, payload.videoId), eq(videoSaves.kind, payload.kind), ne(videoSaves.status, 'ready')))
}

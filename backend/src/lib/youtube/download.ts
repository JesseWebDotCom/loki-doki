// yt-dlp download runner — spawns yt-dlp for audio or video downloads and
// transcript fetches, streams progress, and writes files to the user's data folder.

import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '@/db'
import { ytDownloads, ytVideos } from '@/db/schema'
import { eq, and, isNull, or } from 'drizzle-orm'
import { userPath, toRelativePath, resolveUserPath } from '@/lib/storage/paths'
import { ensureSummary, ensureSavedVideoMeta } from '@/lib/youtube/summarize'
import { ytDlpBin } from '@/lib/youtube/ytdlp'
import { ensureFfmpeg, ffmpegLocation, ffprobeBin } from '@/lib/ffmpeg'
import type { DownloadProgress } from '@/lib/download'

const YT_WATCH_BASE = 'https://www.youtube.com/watch?v='

/** Probe a video file's pixel height with ffprobe (for the quality badge). */
async function probeHeight(absPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn(ffprobeBin(), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'csv=p=0', absPath], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    proc.on('close', () => { const h = parseInt(out.trim(), 10); resolve(Number.isFinite(h) && h > 0 ? h : null) })
    proc.on('error', () => resolve(null))
  })
}

/** One-time backfill: probe + store the real resolution for ready video saves that
 *  predate the maxHeight column (so their cards show "1080p" instead of "Video"). */
const _backfilling = new Set<string>()
export async function backfillSavedHeights(userId: string): Promise<void> {
  const rows = await db.select({ id: ytDownloads.id, relPath: ytDownloads.relPath })
    .from(ytDownloads)
    .where(and(eq(ytDownloads.userId, userId), eq(ytDownloads.kind, 'video'), eq(ytDownloads.status, 'ready'), isNull(ytDownloads.maxHeight)))
  for (const r of rows) {
    if (!r.relPath || _backfilling.has(r.id)) continue
    _backfilling.add(r.id)
    try {
      const h = await probeHeight(await resolveUserPath(r.relPath))
      if (h) await db.update(ytDownloads).set({ maxHeight: h }).where(eq(ytDownloads.id, r.id))
    } catch { /* best-effort */ } finally { _backfilling.delete(r.id) }
  }
}

/** One-time backfill: resolve + warm the channel avatar for ready saves that predate the
 *  channel_thumb column (so their Offline cards show real logos instead of a letter). */
const _thumbBackfilling = new Set<string>()
export async function backfillSavedChannelThumbs(userId: string): Promise<void> {
  const rows = await db.select({ videoId: ytDownloads.videoId, title: ytDownloads.title })
    .from(ytDownloads)
    .leftJoin(ytVideos, eq(ytVideos.videoId, ytDownloads.videoId))
    .where(and(eq(ytDownloads.userId, userId), eq(ytDownloads.status, 'ready'),
      or(isNull(ytVideos.videoId), isNull(ytVideos.channelThumb))))
  for (const r of rows) {
    if (_thumbBackfilling.has(r.videoId)) continue
    _thumbBackfilling.add(r.videoId)
    try { await ensureSavedVideoMeta(r.videoId, r.title) }
    catch { /* best-effort */ } finally { _thumbBackfilling.delete(r.videoId) }
  }
}

export interface YtMediaJobPayload {
  videoId: string
  videoTitle: string
  userId: string
  userFirstName: string
  kind: 'audio' | 'video'
  /** Ceiling on video height for Save (ignored for audio). Defaults to 1080 if absent. */
  maxHeight?: number
  /** Audio container for `kind: 'audio'` saves. Defaults to 'm4a'. */
  audioFormat?: 'm4a' | 'mp3'
  downloadRowId: string
}

function parseProgress(line: string): Partial<DownloadProgress> | null {
  // yt-dlp progress line: [download]  42.3% of  123.45MiB at   1.23MiB/s ETA 00:12
  const m = line.match(/\[download\]\s+([\d.]+)%.*?at\s+([\d.]+)([\w/]+)\s+ETA\s+(\d+):(\d+)/)
  if (!m) return null
  const pct = parseFloat(m[1]!)
  const min = parseInt(m[4]!, 10)
  const sec = parseInt(m[5]!, 10)
  return {
    completed: pct,
    total: 100,
    speedBps: 0,
    etaSeconds: min * 60 + sec,
  }
}

/** Run a yt-dlp download job. Called from downloadJobs.ts runJob() dispatch. */
export async function runYtMediaJob(
  payload: YtMediaJobPayload,
  onProgress: (p: DownloadProgress & { note?: string }) => void,
  signal: AbortSignal,
): Promise<void> {
  const { videoId, videoTitle, userId, userFirstName, kind, downloadRowId } = payload
  const maxHeight = payload.maxHeight ?? 1080
  const audioFormat = payload.audioFormat === 'mp3' ? 'mp3' : 'm4a'

  const category = kind === 'audio' ? 'youtube/audio' : 'youtube/video'
  const outDir = await userPath(userId, userFirstName, category as any)
  await mkdir(outDir, { recursive: true })

  const url = `${YT_WATCH_BASE}${videoId}`
  const outputTemplate = join(outDir, `${videoId}.%(ext)s`)

  // Cap Save resolution at the user's effective height, maximizing resolution within
  // the cap regardless of codec — do NOT hard-filter [ext=mp4] on the video stream, or
  // a VP9/AV1-only 1080p tier gets skipped in favour of a lower mp4 tier (the classic
  // "asked for 1080p, got 960p" downgrade). -S then prefers h264/mp4 for playback
  // compatibility *when available at the chosen resolution*; --merge-output-format mp4
  // remuxes the result into an .mp4 container either way.
  const videoFormat =
    `bestvideo[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]/best`
  const formatSort = `res,vcodec:h264,acodec:m4a`

  const args: string[] = kind === 'audio'
    ? ['-x', '--audio-format', audioFormat, '--audio-quality', '0',
       '--socket-timeout', '30',
       '--output', outputTemplate, '--no-playlist', url]
    : ['-f', videoFormat, '-S', formatSort,
       '--merge-output-format', 'mp4',
       '--socket-timeout', '30',
       '--output', outputTemplate, '--no-playlist', url]

  // Both audio extraction (-x) and video merge need ffmpeg — resolve/auto-download it and
  // point yt-dlp at our managed copy when it isn't already on PATH.
  await ensureFfmpeg()
  const ffLoc = ffmpegLocation()
  if (ffLoc) args.push('--ffmpeg-location', ffLoc)

  // Mark as downloading
  await db.update(ytDownloads)
    .set({ status: 'downloading', updatedAt: new Date() })
    .where(eq(ytDownloads.id, downloadRowId))

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ytDlpBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] })

    // Escalate to SIGKILL if yt-dlp ignores SIGTERM (e.g. wedged in a stuck socket
    // read) so a cancel/shutdown can't leave the process hanging around.
    let killTimer: ReturnType<typeof setTimeout> | null = null
    signal.addEventListener('abort', () => {
      proc.kill('SIGTERM')
      killTimer = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* gone */ } }, 5_000)
      reject(new Error('Aborted'))
    }, { once: true })

    proc.stdout?.on('data', (chunk: Buffer) => {
      const line = chunk.toString()
      const progress = parseProgress(line)
      if (progress) onProgress({ ...progress, note: `Downloading ${kind}…` } as any)
    })

    proc.on('close', (code) => {
      if (killTimer) clearTimeout(killTimer)
      if (code === 0) resolve()
      else reject(new Error(`yt-dlp exited with code ${code}`))
    })
    proc.on('error', reject)
  })

  // Determine actual file path (yt-dlp may pick ext)
  const ext = kind === 'audio' ? audioFormat : 'mp4'
  const absPath = join(outDir, `${videoId}.${ext}`)
  const relPath = await toRelativePath(absPath)

  const { statSync } = await import('node:fs')
  let sizeBytes: number | null = null
  try { sizeBytes = statSync(absPath).size } catch { /* file may have different ext */ }

  // Record the actual saved resolution (probed) for the quality badge; fall back to the target.
  const actualHeight = kind === 'video' ? (await probeHeight(absPath)) ?? maxHeight : null

  await db.update(ytDownloads)
    .set({ status: 'ready', relPath, sizeBytes, maxHeight: actualHeight, updatedAt: new Date() })
    .where(eq(ytDownloads.id, downloadRowId))

  // Enrich in the background (non-blocking, best-effort): fetch captions, then cache the
  // description + an AI summary onto the yt_videos row so the offline Description and
  // Summary tabs are populated without the user ever clicking "Summarize".
  void fetchTranscript(videoId, userId, userFirstName, downloadRowId)
    .then(() => ensureSavedVideoMeta(videoId, videoTitle))
    .then(() => ensureSummary(videoId, userId, userFirstName))
    .catch(() => { /* enrichment is best-effort */ })
}

// ── Export to device (any format → a file the browser downloads) ─────────────────

export interface YtExportJobPayload {
  exportId: string
  videoId: string
  userId: string
  userFirstName: string
  /** yt-dlp -f selector (video/muxed). Mutually exclusive with audioFormat. */
  format?: string
  /** When set, extract audio in this format (e.g. 'mp3', 'm4a') via -x. */
  audioFormat?: string
}

/** Where a finished export lands; the route globs this dir for `${exportId}.*`. */
export async function exportsDir(userId: string, userFirstName: string): Promise<string> {
  return userPath(userId, userFirstName, 'youtube/exports' as any)
}

/**
 * Run a one-off export: fetch a video in the requested format into the user's exports
 * folder so the route can stream it to the browser as a file download. Unlike Save, this
 * is uncapped — the caller may pass any yt-dlp format string.
 */
export async function runYtExportJob(
  payload: YtExportJobPayload,
  onProgress: (p: DownloadProgress & { note?: string }) => void,
  signal: AbortSignal,
): Promise<void> {
  const { exportId, videoId, userId, userFirstName, format, audioFormat } = payload

  const outDir = await exportsDir(userId, userFirstName)
  await mkdir(outDir, { recursive: true })

  const url = `${YT_WATCH_BASE}${videoId}`
  const outputTemplate = join(outDir, `${exportId}.%(ext)s`)

  const args: string[] = audioFormat
    ? ['-x', '--audio-format', audioFormat, '--audio-quality', '0',
       '--socket-timeout', '30',
       '--output', outputTemplate, '--no-playlist', url]
    : ['-f', format && format.trim() ? format.trim() : 'best',
       '--merge-output-format', 'mp4',
       '--socket-timeout', '30',
       '--output', outputTemplate, '--no-playlist', url]

  await ensureFfmpeg()
  const ffLoc = ffmpegLocation()
  if (ffLoc) args.push('--ffmpeg-location', ffLoc)

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ytDlpBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let killTimer: ReturnType<typeof setTimeout> | null = null
    signal.addEventListener('abort', () => {
      proc.kill('SIGTERM')
      killTimer = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* gone */ } }, 5_000)
      reject(new Error('Aborted'))
    }, { once: true })
    proc.stdout?.on('data', (chunk: Buffer) => {
      const progress = parseProgress(chunk.toString())
      if (progress) onProgress({ ...progress, note: 'Preparing download…' } as any)
    })
    proc.on('close', (code) => { if (killTimer) clearTimeout(killTimer); code === 0 ? resolve() : reject(new Error(`yt-dlp exited with code ${code}`)) })
    proc.on('error', reject)
  })
}

/**
 * Ensure an English transcript VTT exists for a video, fetching ONLY the
 * captions (`--skip-download`, no media) if it isn't already on disk. Returns
 * the absolute path to the .vtt, or null if the video has no captions.
 *
 * Used both by the download flow and by summarize-on-demand, so summarizing
 * never requires downloading the actual video.
 */
export async function ensureTranscript(
  videoId: string,
  userId: string,
  userFirstName: string,
): Promise<string | null> {
  const outDir = await userPath(userId, userFirstName, 'youtube/transcripts' as any)
  const absPath = join(outDir, `${videoId}.en.vtt`)
  if (existsSync(absPath)) return absPath

  await mkdir(outDir, { recursive: true })
  const url = `${YT_WATCH_BASE}${videoId}`
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ytDlpBin(), [
        '--write-auto-subs', '--write-subs',
        '--sub-lang', 'en',
        '--sub-format', 'vtt',
        '--skip-download',
        '--output', join(outDir, `${videoId}.%(ext)s`),
        '--no-playlist',
        '--quiet',
        url,
      ], { stdio: 'ignore' })
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`code ${code}`)))
      proc.on('error', reject)
    })
  } catch { /* transcript is optional */ }

  return existsSync(absPath) ? absPath : null
}

async function fetchTranscript(
  videoId: string,
  userId: string,
  userFirstName: string,
  downloadRowId: string,
): Promise<void> {
  const absPath = await ensureTranscript(videoId, userId, userFirstName)
  if (!absPath) return
  const relPath = await toRelativePath(absPath)
  await db.update(ytDownloads)
    .set({ transcriptRelPath: relPath, updatedAt: new Date() })
    .where(eq(ytDownloads.id, downloadRowId))
}

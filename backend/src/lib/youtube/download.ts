// yt-dlp download runner — spawns yt-dlp for audio or video downloads and
// transcript fetches, streams progress, and writes files to the user's data folder.

import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '@/db'
import { ytDownloads, ytVideos, mediaAssets, users } from '@/db/schema'
import { eq, and, isNull, or } from 'drizzle-orm'
import { userPath, toRelativePath, resolveUserPath } from '@/lib/storage/paths'
import { withLock, putBlobFromFile, contentTmpDir } from '@/lib/content/store'
import { desiredHeight, markAssetDownloading, completeAsset, assetLockKey } from '@/lib/youtube/assets'
import { ensureSummary, ensureSavedVideoMeta } from '@/lib/youtube/summarize'
import { ytDlpBin } from '@/lib/ytdlp'
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
  /** The shared media asset this job downloads (one blob serves every user who referenced it). */
  assetId: string
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

/** Download one media asset into the shared content store and fan it out to every user who
 *  referenced it. Called from downloadJobs.ts runJob() dispatch. The asset's target height is
 *  recomputed from its live refs (store-the-max), and we loop a bounded number of times so a
 *  ref that widened the request mid-download still gets the higher tier. */
export async function runYtMediaJob(
  payload: YtMediaJobPayload,
  onProgress: (p: DownloadProgress & { note?: string }) => void,
  signal: AbortSignal,
): Promise<void> {
  const { assetId } = payload
  const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId)).limit(1)
  if (!asset) return   // asset was deleted (all refs released) before the job ran
  const { sourceId: videoId, kind } = asset
  const audioFormat = asset.format === 'mp3' ? 'mp3' : 'm4a'

  // No live refs left → nothing to download; let GC reclaim the orphan asset.
  const [anyRef] = await db.select({ id: ytDownloads.id }).from(ytDownloads).where(eq(ytDownloads.assetId, assetId)).limit(1)
  if (!anyRef) return

  await withLock(assetLockKey(videoId, kind, asset.format), () => markAssetDownloading(assetId))

  await ensureFfmpeg()
  const ffLoc = ffmpegLocation()
  const url = `${YT_WATCH_BASE}${videoId}`

  for (let attempt = 0; attempt < 3; attempt++) {
    const target = (await desiredHeight(assetId, kind)) ?? 1080

    // Stage into the content tmp dir (same filesystem as the blob store → cheap rename on put).
    const tmpDir = await contentTmpDir()
    const stem = `${assetId}.${attempt}`
    const outputTemplate = join(tmpDir, `${stem}.%(ext)s`)

    // Maximize resolution within the cap regardless of codec — do NOT hard-filter [ext=mp4]
    // on the video stream, or a VP9/AV1-only tier gets skipped for a lower mp4 tier (the
    // classic "asked for 1080p, got 960p" downgrade). -S then prefers h264/mp4 when available
    // at the chosen resolution; --merge-output-format mp4 remuxes either way.
    const videoFormat = `bestvideo[height<=${target}]+bestaudio/best[height<=${target}]/best`
    const args: string[] = kind === 'audio'
      ? ['-x', '--audio-format', audioFormat, '--audio-quality', '0', '--socket-timeout', '30',
         '--output', outputTemplate, '--no-playlist', url]
      : ['-f', videoFormat, '-S', 'res,vcodec:h264,acodec:m4a', '--merge-output-format', 'mp4',
         '--socket-timeout', '30', '--output', outputTemplate, '--no-playlist', url]
    if (ffLoc) args.push('--ffmpeg-location', ffLoc)

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ytDlpBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let killTimer: ReturnType<typeof setTimeout> | null = null
      // Drain stderr, keeping only a small rolling tail. Without a data handler the OS pipe
      // buffer (~64KB) fills on a chatty failure and yt-dlp blocks on write — hanging forever.
      let errTail = ''
      proc.stderr?.on('data', (chunk: Buffer) => { errTail = (errTail + chunk.toString()).slice(-4096) })
      signal.addEventListener('abort', () => {
        proc.kill('SIGTERM')
        killTimer = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* gone */ } }, 5_000)
        reject(new Error('Aborted'))
      }, { once: true })
      proc.stdout?.on('data', (chunk: Buffer) => {
        const progress = parseProgress(chunk.toString())
        if (progress) onProgress({ ...progress, note: `Downloading ${kind}…` } as any)
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

    const ext = kind === 'audio' ? audioFormat : 'mp4'
    const absPath = join(tmpDir, `${stem}.${ext}`)
    const actualHeight = kind === 'video' ? (await probeHeight(absPath)) : null
    const mime = kind === 'audio' ? (audioFormat === 'mp3' ? 'audio/mpeg' : 'audio/mp4') : 'video/mp4'

    // Hash + move into the blob store OUTSIDE the lock (slow), then swap + fan out INSIDE it.
    const { hash, sizeBytes } = await putBlobFromFile(absPath, { mime })
    const { needsHigher } = await withLock(assetLockKey(videoId, kind, asset.format),
      () => completeAsset(assetId, hash, actualHeight, sizeBytes))

    if (!needsHigher) break
    // A ref widened the request mid-download — loop to fetch the taller tier (bounded above).
  }

  // Enrich in the background (best-effort): captions for a representative user + a shared
  // summary/description cached onto the yt_videos row. Transcripts stay per-user for v1.
  void enrichSavedAsset(assetId, videoId).catch(() => { /* enrichment is best-effort */ })
}

/** Best-effort post-download enrichment: cache a transcript for one referencing user and the
 *  shared description/summary onto the yt_videos row. */
async function enrichSavedAsset(assetId: string, videoId: string): Promise<void> {
  const [ref] = await db.select({ id: ytDownloads.id, userId: ytDownloads.userId, title: ytDownloads.title })
    .from(ytDownloads).where(eq(ytDownloads.assetId, assetId)).limit(1)
  if (!ref) return
  const [u] = await db.select({ firstName: users.firstName }).from(users).where(eq(users.id, ref.userId)).limit(1)
  const firstName = u?.firstName ?? 'user'
  await fetchTranscript(videoId, ref.userId, firstName, ref.id)
    .then(() => ensureSavedVideoMeta(videoId, ref.title))
    .then(() => ensureSummary(videoId, ref.userId, firstName))
    .catch(() => { /* best-effort */ })
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
    // Drain stderr with a small rolling tail — an unread pipe fills (~64KB) and blocks yt-dlp.
    let errTail = ''
    proc.stderr?.on('data', (chunk: Buffer) => { errTail = (errTail + chunk.toString()).slice(-4096) })
    signal.addEventListener('abort', () => {
      proc.kill('SIGTERM')
      killTimer = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* gone */ } }, 5_000)
      reject(new Error('Aborted'))
    }, { once: true })
    proc.stdout?.on('data', (chunk: Buffer) => {
      const progress = parseProgress(chunk.toString())
      if (progress) onProgress({ ...progress, note: 'Preparing download…' } as any)
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

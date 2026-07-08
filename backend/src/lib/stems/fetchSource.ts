// studio-source job runner: turn a song PICKED FROM THE MUSIC APP into a Studio source
// file. Resolves the pick to a YouTube videoId, then obtains audio the cheapest way:
//   1. if the user already saved it offline → transcode that on-disk blob (no download)
//   2. else yt-dlp -x extracts the audio
// Either way the result is normalized to music/studio/<id>/source.wav (same shape the
// upload path produces), then analysis is enqueued. Network lane (domain 'youtube').

import { spawn } from 'node:child_process'
import { mkdir, rm, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { musicStudioTracks, users, ytDownloads } from '@/db/schema'
import { userPath, resolveUserPath, toRelativePath } from '@/lib/storage/paths'
import { ensureFfmpeg, ffmpegLocation } from '@/lib/ffmpeg'
import { ytDlpBin, ytDlpAuthArgs } from '@/lib/ytdlp'
import { resolveRefBlob } from '@/lib/youtube/assets'
import { resolveTrack } from '@/lib/music/resolve'
import { fetchBestCover } from './cover'
import { isStemAudioInstalled } from './pyenv'
import { enqueueAudioAnalyze } from '@/lib/downloadJobs'
import type { DownloadProgress } from '@/lib/download'
import { logger } from '@/lib/logger'

const YT_WATCH_BASE = 'https://www.youtube.com/watch?v='

export interface StudioSourceJobPayload {
  studioTrackId: string
  videoId?: string | null
  mbid?: string | null
  albumMbid?: string | null    // release-group MBID → Cover Art Archive thumbnail
  albumTitle?: string | null   // for the iTunes / web-search cover fallback
  title: string
  artist?: string | null
  durationSec?: number | null
}

/** Transcode any audio file to 44.1k stereo 16-bit WAV (the Studio source format). */
function ffmpegFileToWav(ff: string, input: string, outPath: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ff, ['-y', '-i', input, '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', outPath], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let err = ''
    child.stderr?.on('data', (d: Buffer) => { err += d.toString(); if (err.length > 16_000) err = err.slice(-8_000) })
    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(e) })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return reject(new Error('cancelled'))
      code === 0 ? resolve() : reject(new Error(`ffmpeg transcode exited ${code}: ${err.trim().split('\n').slice(-2).join(' | ')}`))
    })
  })
}

/** yt-dlp -x extract the audio for a videoId straight to `<dir>/source.wav`. */
async function extractAudioWav(videoId: string, dir: string, signal: AbortSignal | undefined, onProgress?: (p: DownloadProgress & { note?: string }) => void): Promise<string> {
  await ensureFfmpeg()
  const url = `${YT_WATCH_BASE}${videoId}`
  const args = ['-x', '--audio-format', 'wav', '--audio-quality', '0', '--socket-timeout', '30',
    '--output', join(dir, 'source.%(ext)s'), '--no-playlist', url]
  const ffLoc = ffmpegLocation()
  if (ffLoc) args.push('--ffmpeg-location', ffLoc)
  args.push(...ytDlpAuthArgs())

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ytDlpBin(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let errTail = ''
    proc.stderr?.on('data', (c: Buffer) => { errTail = (errTail + c.toString()).slice(-4096) })
    proc.stdout?.on('data', () => onProgress?.({ completed: 30, total: 100, speedBps: 0, etaSeconds: 0, note: 'Fetching audio…' }))
    const onAbort = () => { try { proc.kill('SIGKILL') } catch { /* gone */ } }
    signal?.addEventListener('abort', onAbort, { once: true })
    proc.on('error', (e) => { signal?.removeEventListener('abort', onAbort); reject(e) })
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return reject(new Error('cancelled'))
      if (code === 0) return resolve()
      reject(new Error(`yt-dlp exited ${code}: ${errTail.trim().split('\n').slice(-2).join(' | ')}`))
    })
  })
  return join(dir, 'source.wav')
}

export async function runStudioSourceJob(
  payload: StudioSourceJobPayload,
  signal?: AbortSignal,
  onProgress?: (p: DownloadProgress & { note?: string }) => void,
): Promise<void> {
  const { studioTrackId } = payload
  const [row] = await db.select().from(musicStudioTracks).where(eq(musicStudioTracks.id, studioTrackId)).limit(1)
  if (!row) { logger.info(`[studio-source] track ${studioTrackId} gone — skipping`); return }

  await db.update(musicStudioTracks).set({ sourceStatus: 'fetching', sourceError: null, updatedAt: new Date() }).where(eq(musicStudioTracks.id, studioTrackId))
  onProgress?.({ completed: 5, total: 100, speedBps: 0, etaSeconds: 0, note: 'Finding audio…' })

  try {
    // 1. Resolve to a playable videoId.
    let videoId = payload.videoId ?? null
    if (!videoId) {
      const resolved = await resolveTrack({ mbid: payload.mbid, title: payload.title, artist: payload.artist ?? '', durationSec: payload.durationSec ?? null })
      videoId = resolved?.videoId ?? null
    }
    if (!videoId) throw new Error('could not find a playable source for this song')

    const [u] = await db.select({ firstName: users.firstName }).from(users).where(eq(users.id, row.userId)).limit(1)
    const sourceWav = await userPath(row.userId, u?.firstName ?? 'user', 'music', 'studio', studioTrackId, 'source.wav')
    await mkdir(dirname(sourceWav), { recursive: true })
    const ff = await ensureFfmpeg()

    // 2. Reuse a saved-offline copy if the user already has one (no re-download).
    let done = false
    const [saved] = await db.select({ assetId: ytDownloads.assetId, status: ytDownloads.status, relPath: ytDownloads.relPath })
      .from(ytDownloads)
      .where(and(eq(ytDownloads.userId, row.userId), eq(ytDownloads.videoId, videoId), eq(ytDownloads.kind, 'audio'), eq(ytDownloads.status, 'ready')))
      .limit(1)
    if (saved) {
      const blob = await resolveRefBlob({ assetId: saved.assetId, status: saved.status })
      const src = blob?.absPath ?? (saved.relPath ? await resolveUserPath(saved.relPath).catch(() => null) : null)
      if (src) {
        onProgress?.({ completed: 40, total: 100, speedBps: 0, etaSeconds: 0, note: 'Using your saved copy…' })
        await ffmpegFileToWav(ff, src, sourceWav, signal)
        done = true
      }
    }

    // 3. Otherwise extract with yt-dlp.
    if (!done) {
      await extractAudioWav(videoId, dirname(sourceWav), signal, onProgress)
    }

    const s = await stat(sourceWav).catch(() => null)
    if (!s || s.size === 0) throw new Error('no audio was produced')

    // Cover art via the full chain (CAA → iTunes → web search), best-effort.
    let coverRel: string | null = null
    {
      const coverPath = join(dirname(sourceWav), 'cover.jpg')
      const got = await fetchBestCover(
        { albumMbid: payload.albumMbid, artist: payload.artist, album: payload.albumTitle, title: payload.title },
        coverPath, signal,
      )
      if (got) coverRel = await toRelativePath(coverPath)
    }

    const rel = await toRelativePath(sourceWav)
    const wantAnalysis = isStemAudioInstalled()
    await db.update(musicStudioTracks).set({
      sourceRelPath: rel, sourceStatus: 'ready', sourceError: null,
      coverRelPath: coverRel ?? row.coverRelPath ?? null,
      durationSec: payload.durationSec ?? row.durationSec ?? null,
      analysisStatus: wantAnalysis ? 'pending' : 'none',
      updatedAt: new Date(),
    }).where(eq(musicStudioTracks.id, studioTrackId))
    onProgress?.({ completed: 100, total: 100, speedBps: 0, etaSeconds: 0, note: 'Ready' })

    if (wantAnalysis) await enqueueAudioAnalyze(studioTrackId, `Analyse ${row.title}`)
    logger.info(`[studio-source] ${studioTrackId}: source ready (${videoId})`)
  } catch (err) {
    await db.update(musicStudioTracks).set({ sourceStatus: 'failed', sourceError: String(err), updatedAt: new Date() }).where(eq(musicStudioTracks.id, studioTrackId))
    throw err
  }
}

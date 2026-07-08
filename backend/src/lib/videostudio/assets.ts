// Media bin for the Create studio: one merged listing over everything the user can cut
// (YouTube offline downloads, Clipper saves, hub source saves, and studio-owned items),
// plus upload ingest into media_assets(sourceType='studio') and derived thumbnails.

import { mkdir, writeFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { clips, mediaAssets, studioMedia, videoSaves, ytDownloads, ytVideos } from '@/db/schema'
import { blobAbsPath, contentTmpDir, markBlobLive, putBlobFromFile, withLock } from '@/lib/content/store'
import { ensureFfmpeg, ffmpegBin } from '@/lib/ffmpeg'
import { probeMedia } from '@/lib/videostudio/probe'
import { resolveUserPath } from '@/lib/storage/paths'

export interface BinItem {
  assetId: string
  title: string
  kind: 'video' | 'audio' | 'image'
  durationSec: number | null
  origin: 'youtube' | 'clip' | 'reddit' | 'tiktok' | 'vimeo' | 'upload' | 'recording' | 'generated' | 'export'
  thumbUrl: string | null
  createdAt: number
  /** Studio-owned items only: the studio_media row id (share toggle target). */
  mediaId?: string
  /** Studio-owned videos only: epoch ms when shared with the household, null = private. */
  sharedAt?: number | null
}

/** Everything in the user's libraries that's ready to edit, newest first. */
export async function listBin(userId: string): Promise<BinItem[]> {
  const [yt, clipRows, saves, studio] = await Promise.all([
    db.select({
      assetId: ytDownloads.assetId, title: ytDownloads.title, kind: ytDownloads.kind,
      videoId: ytDownloads.videoId, createdAt: ytDownloads.createdAt,
    }).from(ytDownloads)
      .where(and(eq(ytDownloads.userId, userId), eq(ytDownloads.status, 'ready'), eq(ytDownloads.origin, 'youtube')))
      .orderBy(desc(ytDownloads.createdAt)).limit(200),
    db.select().from(clips)
      .where(and(eq(clips.userId, userId), eq(clips.status, 'ready')))
      .orderBy(desc(clips.createdAt)).limit(200),
    db.select().from(videoSaves)
      .where(and(eq(videoSaves.userId, userId), eq(videoSaves.status, 'ready')))
      .orderBy(desc(videoSaves.createdAt)).limit(200),
    db.select().from(studioMedia)
      .where(and(eq(studioMedia.userId, userId), eq(studioMedia.status, 'ready')))
      .orderBy(desc(studioMedia.createdAt)).limit(200),
  ])

  const items: BinItem[] = []
  const ytDurations = new Map<string, number | null>()
  if (yt.length) {
    const vids = await db.select({ videoId: ytVideos.videoId, durationSec: ytVideos.durationSec })
      .from(ytVideos).where(inArray(ytVideos.videoId, yt.map((r) => r.videoId)))
    for (const v of vids) ytDurations.set(v.videoId, v.durationSec)
  }
  for (const r of yt) {
    if (!r.assetId) continue
    items.push({
      assetId: r.assetId, title: r.title, kind: r.kind === 'audio' ? 'audio' : 'video',
      durationSec: ytDurations.get(r.videoId) ?? null, origin: 'youtube',
      thumbUrl: `/api/youtube/img?url=${encodeURIComponent(`https://i.ytimg.com/vi/${r.videoId}/mqdefault.jpg`)}`,
      createdAt: r.createdAt.getTime(),
    })
  }
  for (const r of clipRows) {
    if (!r.assetId) continue
    items.push({
      assetId: r.assetId, title: r.title || 'Clip', kind: r.kind === 'audio' ? 'audio' : 'video',
      durationSec: r.durationSeconds, origin: 'clip', thumbUrl: r.thumbnailUrl,
      createdAt: r.createdAt.getTime(),
    })
  }
  for (const r of saves) {
    if (!r.assetId) continue
    items.push({
      assetId: r.assetId, title: r.title, kind: r.kind === 'audio' ? 'audio' : 'video',
      durationSec: r.durationSec, origin: r.source, thumbUrl: r.thumbnailUrl,
      createdAt: r.createdAt.getTime(),
    })
  }
  for (const r of studio) {
    if (!r.assetId) continue
    items.push({
      assetId: r.assetId, title: r.title || r.origin, kind: r.kind,
      durationSec: r.durationSec, origin: r.origin,
      thumbUrl: `/api/videos/studio/media/${r.assetId}/thumb`,
      createdAt: r.createdAt.getTime(),
      mediaId: r.id, sharedAt: r.sharedAt ? r.sharedAt.getTime() : null,
    })
  }
  return items.sort((a, b) => b.createdAt - a.createdAt)
}

/** True when this user may read the asset (has any library/bin ref to it). */
export async function userOwnsAsset(userId: string, assetId: string): Promise<boolean> {
  const [a, b, c, d] = await Promise.all([
    db.select({ id: ytDownloads.id }).from(ytDownloads).where(and(eq(ytDownloads.userId, userId), eq(ytDownloads.assetId, assetId))).limit(1),
    db.select({ id: clips.id }).from(clips).where(and(eq(clips.userId, userId), eq(clips.assetId, assetId))).limit(1),
    db.select({ id: videoSaves.id }).from(videoSaves).where(and(eq(videoSaves.userId, userId), eq(videoSaves.assetId, assetId))).limit(1),
    db.select({ id: studioMedia.id }).from(studioMedia).where(and(eq(studioMedia.userId, userId), eq(studioMedia.assetId, assetId))).limit(1),
  ])
  return !!(a[0] ?? b[0] ?? c[0] ?? d[0])
}

export async function assetBlobPath(assetId: string): Promise<{ path: string; format: string } | null> {
  const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId)).limit(1)
  if (!asset?.blobHash || asset.status !== 'ready') return null
  const path = await blobAbsPath(asset.blobHash)
  if (!existsSync(path)) return null
  return { path, format: asset.format }
}

const UPLOAD_EXT = /\.(mp4|mov|m4v|webm|mkv|mp3|m4a|wav|aac|png|jpg|jpeg)$/i
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024

function kindForExt(name: string): 'video' | 'audio' | 'image' {
  if (/\.(mp3|m4a|wav|aac)$/i.test(name)) return 'audio'
  if (/\.(png|jpg|jpeg)$/i.test(name)) return 'image'
  return 'video'
}

/** Ingest an uploaded file into the bin: stage → probe → blob → studio_media row. */
export async function ingestUpload(userId: string, fileName: string, bytes: Uint8Array): Promise<{ id: string }> {
  if (!UPLOAD_EXT.test(fileName)) throw new Error('Unsupported format. Video: mp4/mov/m4v/webm/mkv · audio: mp3/m4a/wav/aac · image: png/jpg')
  const kind = kindForExt(fileName)
  const id = randomUUID()
  const now = new Date()
  await db.insert(studioMedia).values({
    id, userId, origin: 'upload', title: fileName.replace(/\.[^.]+$/, ''), kind,
    assetId: null, status: 'processing', durationSec: null, width: null, height: null,
    sourceMeta: null, error: null, createdAt: now, updatedAt: now,
  })

  try {
    const tmpDir = await contentTmpDir()
    const ext = fileName.split('.').pop()!.toLowerCase()
    const staged = join(tmpDir, `studio-upload-${id}.${ext}`)
    await writeFile(staged, bytes)

    const probe = kind === 'image' ? null : await probeMedia(staged)
    const mime = kind === 'audio' ? 'audio/mp4' : kind === 'image' ? 'image/jpeg' : 'video/mp4'
    const { hash, sizeBytes } = await putBlobFromFile(staged, { mime })

    await withLock(`studio-media:${id}`, async () => {
      const ts = new Date()
      await markBlobLive(hash)
      const assetId = randomUUID()
      await db.insert(mediaAssets).values({
        id: assetId, sourceType: 'studio', sourceId: id, kind: kind === 'image' ? 'video' : kind, format: ext,
        height: probe?.height ?? null, blobHash: hash, status: 'ready', sizeBytes, error: null,
        createdAt: ts, updatedAt: ts,
      })
      await db.update(studioMedia).set({
        status: 'ready', assetId, durationSec: probe?.durationSec ?? null,
        width: probe?.width ?? null, height: probe?.height ?? null, updatedAt: ts,
      }).where(eq(studioMedia.id, id))
    })
    if (kind === 'video') {
      // Place into the owner's My Videos Plex library (no-op without a ready section).
      const { enqueueMinePlacement } = await import('@/lib/videostudio/plexExport')
      void enqueueMinePlacement(id).catch(() => {})
    }
    return { id }
  } catch (err) {
    await db.update(studioMedia).set({ status: 'failed', error: String(err).slice(0, 500), updatedAt: new Date() }).where(eq(studioMedia.id, id))
    throw err
  }
}

// ── Derived thumbnails: disk cache keyed by asset id (regenerable, not blob-store data) ──

async function derivedDir(): Promise<string> {
  const dir = await resolveUserPath(join('content', 'derived', 'studio'))
  await mkdir(dir, { recursive: true })
  return dir
}

export async function assetThumbPath(assetId: string): Promise<string | null> {
  const src = await assetBlobPath(assetId)
  if (!src) return null
  const dir = await derivedDir()
  const out = join(dir, `${assetId}.thumb.jpg`)
  if (existsSync(out)) return out
  await ensureFfmpeg()
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegBin(), ['-y', '-loglevel', 'error', '-ss', '1', '-i', src.path, '-vframes', '1', '-vf', 'scale=320:-2', out],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let err = ''
    proc.stderr?.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-1024) })
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `thumb ffmpeg exited ${code}`))))
    proc.on('error', reject)
  }).catch(async () => { await unlink(out).catch(() => {}) })
  return existsSync(out) ? out : null
}

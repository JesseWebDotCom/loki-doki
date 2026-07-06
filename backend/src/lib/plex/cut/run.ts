// plex-cut job runner: produces (once, coalesced across every user who wants this exact
// category set) a derived, SponsorBlock-trimmed media_assets rendition — never mutates the
// original, which stays shared/untouched for in-app playback and for anyone whose enabled
// categories differ (see project plan §5 for why replace-in-place was rejected).

import { eq, and } from 'drizzle-orm'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { db } from '@/db'
import { mediaAssets, ytPlexEpisodes } from '@/db/schema'
import { blobAbsPath, putBlobFromFile, markBlobLive, contentTmpDir } from '@/lib/content/store'
import { getContentTypeStorageLocationId } from '@/lib/storage/contentRoots'
import { getSkipSegments } from '@/lib/youtube/sponsorblock'
import { computeKeepRanges, cutVideo, probeDurationSec } from './videoCut'
import { logger } from '@/lib/logger'

export interface PlexCutJobPayload {
  videoId: string
  cutSetHash: string
  enabledCategories: Record<string, boolean>
}

export function plexCutFormat(cutSetHash: string): string {
  return `mp4:plexcut:${cutSetHash}`
}

export async function runPlexCutJob(payload: PlexCutJobPayload, signal?: AbortSignal): Promise<void> {
  const { videoId, cutSetHash, enabledCategories } = payload
  const format = plexCutFormat(cutSetHash)

  const [originalAsset] = await db.select().from(mediaAssets)
    .where(and(eq(mediaAssets.sourceType, 'youtube'), eq(mediaAssets.sourceId, videoId), eq(mediaAssets.kind, 'video'), eq(mediaAssets.status, 'ready')))
  if (!originalAsset?.blobHash) throw new Error(`plex-cut: original video asset for ${videoId} is not ready`)

  const now = new Date()
  let [asset] = await db.select().from(mediaAssets)
    .where(and(eq(mediaAssets.sourceType, 'youtube'), eq(mediaAssets.sourceId, videoId), eq(mediaAssets.kind, 'video'), eq(mediaAssets.format, format)))
  if (!asset) {
    await db.insert(mediaAssets).values({
      id: crypto.randomUUID(), sourceType: 'youtube', sourceId: videoId, kind: 'video', format,
      status: 'downloading', createdAt: now, updatedAt: now,
    }).onConflictDoNothing()
    ;[asset] = await db.select().from(mediaAssets)
      .where(and(eq(mediaAssets.sourceType, 'youtube'), eq(mediaAssets.sourceId, videoId), eq(mediaAssets.kind, 'video'), eq(mediaAssets.format, format)))
  }
  if (!asset) throw new Error(`plex-cut: could not create/find asset row for ${videoId}:${format}`)
  if (asset.status === 'ready') { await fanOutReady(videoId, cutSetHash); return } // a coalesced job already finished this

  const segments = await getSkipSegments(videoId)
  const cutRanges = segments.filter(s => enabledCategories[s.category] === true)
  const sourceAbsPath = await blobAbsPath(originalAsset.blobHash)
  const durationSec = (await probeDurationSec(sourceAbsPath)) ?? 0
  const keepRanges = computeKeepRanges(cutRanges, durationSec)

  const tmpDir = await contentTmpDir()
  const outPath = join(tmpDir, `plexcut-${videoId}-${cutSetHash}-${Date.now()}.mp4`)
  try {
    await cutVideo(sourceAbsPath, outPath, keepRanges, signal)
    const storageLocationId = await getContentTypeStorageLocationId('youtube')
    const put = await putBlobFromFile(outPath, { mime: 'video/mp4', storageLocationId })
    await markBlobLive(put.hash)
    await db.update(mediaAssets).set({ blobHash: put.hash, sizeBytes: put.sizeBytes, status: 'ready', error: null, updatedAt: new Date() })
      .where(eq(mediaAssets.id, asset.id))
    logger.info(`[plex-cut] ${videoId} (${cutSetHash}): kept ${keepRanges.length} range(s) of ${cutRanges.length} cut`)
  } catch (err) {
    await db.update(mediaAssets).set({ status: 'failed', error: String(err), updatedAt: new Date() }).where(eq(mediaAssets.id, asset.id))
    throw err
  } finally {
    await rm(outPath, { force: true }).catch(() => {})
  }

  await fanOutReady(videoId, cutSetHash)
}

/** Every yt_plex_episodes row that was waiting (status='cutting') on this exact
 *  (videoId, cutSetHash) can now be placed — re-run their sync so it picks up the
 *  now-ready cut asset instead of stalling forever in 'cutting'. */
async function fanOutReady(videoId: string, cutSetHash: string): Promise<void> {
  const waiting = await db.select({ userId: ytPlexEpisodes.userId }).from(ytPlexEpisodes)
    .where(and(eq(ytPlexEpisodes.videoId, videoId), eq(ytPlexEpisodes.cutCategoriesHash, cutSetHash), eq(ytPlexEpisodes.status, 'cutting')))
  const { enqueuePlexSync } = await import('@/lib/downloadJobs')
  for (const w of waiting) void enqueuePlexSync(w.userId, videoId, 'add').catch(() => {})
}

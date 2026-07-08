// "Download all" for a curated yt_playlists playlist — a thin orchestration layer over
// the existing per-video Save pipelines (enqueueVideoSave for YouTube, enqueueVideoMedia for
// every other source), not a new download engine. Reusing those means per-video dedup/
// coalescing/asset-sharing all come for free: two users downloading overlapping playlists
// (or overlapping a playlist and their own saves) share the same underlying assets.

import { randomUUID } from 'node:crypto'
import { eq, and, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { ytPlaylists, ytPlaylistVideos, ytPlaylistDownloadBatches, ytDownloads, videoSaves, users } from '@/db/schema'
import { enqueueVideoSave } from '@/lib/youtube/automation'
import { enqueueVideoMedia } from '@/lib/downloadJobs'
import { getProvider } from '@/lib/videos/registry'

export interface StartBatchOpts {
  userId: string
  playlistId: string
  kind: 'audio' | 'video'
  maxHeight: number | null
}

export async function startPlaylistDownloadBatch(opts: StartBatchOpts): Promise<{ batchId: string; videoCount: number }> {
  const { userId, playlistId, kind, maxHeight } = opts

  const [playlist] = await db.select().from(ytPlaylists).where(eq(ytPlaylists.id, playlistId)).limit(1)
  if (!playlist) throw new Error('Playlist not found')
  if (playlist.userId !== userId && playlist.visibility !== 'shared') throw new Error('Playlist not available')

  // Mine entries are Studio bin content — already sitting on this server, nothing to
  // download. 'link' saves aren't wired into the hub download pipeline yet (pre-existing
  // gap). Everything else routes through its own source's save pipeline below.
  const allVideos = await db.select().from(ytPlaylistVideos).where(eq(ytPlaylistVideos.playlistId, playlistId))
  if (!allVideos.length) throw new Error('Playlist is empty')
  const videos = allVideos.filter(v => v.videoSource !== 'mine' && v.videoSource !== 'link')
  if (!videos.length) throw new Error('This playlist has nothing downloadable yet')

  const [u] = await db.select({ firstName: users.firstName }).from(users).where(eq(users.id, userId)).limit(1)
  const firstName = u?.firstName ?? 'user'

  const batchId = crypto.randomUUID()
  const now = new Date()
  const videoIds = videos.map(v => v.videoId)
  await db.insert(ytPlaylistDownloadBatches).values({
    id: batchId, userId, playlistId, label: playlist.name, kind, maxHeight,
    videoIds: JSON.stringify(videoIds), status: 'running', createdAt: now, updatedAt: now,
  })

  // Enqueue every video's save through its own source's pipeline. Fire-and-forget from the
  // caller's perspective — progress is polled via getPlaylistDownloadBatchStatus, which reads
  // ytDownloads/videoSaves directly rather than tracking per-video state on the batch row.
  for (const v of videos) {
    if (v.videoSource === 'youtube') {
      await enqueueVideoSave({ userId, videoId: v.videoId, title: v.title, kind, maxHeight, firstName }).catch(() => {})
      continue
    }
    // 'mine' has nothing to download (already local); 'link' saves aren't wired into
    // enqueueVideoMedia yet (pre-existing gap, tracked separately from this playlist work).
    if (v.videoSource === 'mine' || v.videoSource === 'link') continue
    const provider = getProvider(v.videoSource)
    if (!provider || !provider.capabilities.downloadKinds.includes(kind)) continue
    const item = await provider.getItem(v.videoId).catch(() => null)
    if (!item) continue
    await db.insert(videoSaves).values({
      id: randomUUID(), userId, source: v.videoSource, videoId: item.id, title: item.title, kind,
      status: 'pending', assetId: null, sizeBytes: null, maxHeight,
      thumbnailUrl: item.thumbnailUrl ?? null, creatorName: item.creator?.name ?? null,
      durationSec: item.durationSec ?? null, sourceUrl: item.url, auto: false,
      isAdult: !!item.isAdult, error: null, createdAt: now, updatedAt: now,
    }).onConflictDoUpdate({
      target: [videoSaves.userId, videoSaves.source, videoSaves.videoId, videoSaves.kind],
      set: { status: 'pending', error: null, updatedAt: now },
    })
    await enqueueVideoMedia({ source: v.videoSource, videoId: item.id, kind, maxHeight }, `${provider.label}: ${item.title}`).catch(() => {})
  }

  return { batchId, videoCount: videos.length }
}

export interface BatchVideoStatus {
  videoId: string
  title: string
  status: 'pending' | 'downloading' | 'ready' | 'failed' | 'not-started'
}

export interface BatchStatus {
  batchId: string
  label: string
  kind: 'audio' | 'video'
  createdAt: number
  total: number
  ready: number
  downloading: number
  pending: number
  failed: number
  videos: BatchVideoStatus[]
}

export async function getPlaylistDownloadBatchStatus(batchId: string, userId: string): Promise<BatchStatus | null> {
  const [batch] = await db.select().from(ytPlaylistDownloadBatches)
    .where(and(eq(ytPlaylistDownloadBatches.id, batchId), eq(ytPlaylistDownloadBatches.userId, userId))).limit(1)
  if (!batch) return null

  const videoIds: string[] = JSON.parse(batch.videoIds)
  const playlistVideos = batch.playlistId
    ? await db.select({ videoId: ytPlaylistVideos.videoId, title: ytPlaylistVideos.title })
        .from(ytPlaylistVideos).where(eq(ytPlaylistVideos.playlistId, batch.playlistId))
    : []
  const titleByVideoId = new Map(playlistVideos.map(v => [v.videoId, v.title]))

  // Each video's status lives in whichever table its source's save pipeline uses — YouTube's
  // yt_downloads, or every other source's video_saves.
  const ytRows = videoIds.length
    ? await db.select({ videoId: ytDownloads.videoId, status: ytDownloads.status })
        .from(ytDownloads)
        .where(and(eq(ytDownloads.userId, userId), eq(ytDownloads.kind, batch.kind), inArray(ytDownloads.videoId, videoIds)))
    : []
  const hubRows = videoIds.length
    ? await db.select({ videoId: videoSaves.videoId, status: videoSaves.status })
        .from(videoSaves)
        .where(and(eq(videoSaves.userId, userId), eq(videoSaves.kind, batch.kind), inArray(videoSaves.videoId, videoIds)))
    : []
  const statusByVideoId = new Map<string, string>()
  for (const r of ytRows) statusByVideoId.set(r.videoId, r.status)
  for (const r of hubRows) if (!statusByVideoId.has(r.videoId)) statusByVideoId.set(r.videoId, r.status)

  const videos: BatchVideoStatus[] = videoIds.map(videoId => ({
    videoId,
    title: titleByVideoId.get(videoId) ?? videoId,
    status: (statusByVideoId.get(videoId) as BatchVideoStatus['status'] | undefined) ?? 'not-started',
  }))

  const counts = { ready: 0, downloading: 0, pending: 0, failed: 0 }
  for (const v of videos) {
    if (v.status === 'ready') counts.ready++
    else if (v.status === 'downloading') counts.downloading++
    else if (v.status === 'failed') counts.failed++
    else counts.pending++
  }

  // Finalize the batch row once every video has settled into a terminal state.
  if (batch.status === 'running' && counts.pending === 0 && counts.downloading === 0) {
    const finalStatus = counts.failed > 0 ? 'completed_with_errors' : 'completed'
    await db.update(ytPlaylistDownloadBatches).set({ status: finalStatus, updatedAt: new Date() })
      .where(eq(ytPlaylistDownloadBatches.id, batchId))
  }

  return {
    batchId: batch.id, label: batch.label, kind: batch.kind, createdAt: batch.createdAt.getTime(),
    total: videoIds.length, ...counts, videos,
  }
}

// "Download all" for a curated yt_playlists playlist — a thin orchestration layer over
// the existing per-video Save pipeline (enqueueVideoSave), not a new download engine.
// Reusing that function means per-video dedup/coalescing/asset-sharing all come for free:
// two users downloading overlapping playlists share the same underlying assets.

import { eq, and, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { ytPlaylists, ytPlaylistVideos, ytPlaylistDownloadBatches, ytDownloads, users } from '@/db/schema'
import { enqueueVideoSave } from '@/lib/youtube/automation'

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

  const videos = await db.select().from(ytPlaylistVideos).where(eq(ytPlaylistVideos.playlistId, playlistId))
  if (!videos.length) throw new Error('Playlist is empty')

  const [u] = await db.select({ firstName: users.firstName }).from(users).where(eq(users.id, userId)).limit(1)
  const firstName = u?.firstName ?? 'user'

  const batchId = crypto.randomUUID()
  const now = new Date()
  const videoIds = videos.map(v => v.videoId)
  await db.insert(ytPlaylistDownloadBatches).values({
    id: batchId, userId, playlistId, label: playlist.name, kind, maxHeight,
    videoIds: JSON.stringify(videoIds), status: 'running', createdAt: now, updatedAt: now,
  })

  // Enqueue every video's save through the existing shared pipeline. Fire-and-forget from
  // the caller's perspective — progress is polled via getPlaylistDownloadBatchStatus, which
  // reads ytDownloads directly rather than tracking per-video state on the batch row.
  for (const v of videos) {
    await enqueueVideoSave({ userId, videoId: v.videoId, title: v.title, kind, maxHeight, firstName }).catch(() => {})
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

  const rows = videoIds.length
    ? await db.select({ videoId: ytDownloads.videoId, status: ytDownloads.status })
        .from(ytDownloads)
        .where(and(eq(ytDownloads.userId, userId), eq(ytDownloads.kind, batch.kind), inArray(ytDownloads.videoId, videoIds)))
    : []
  const statusByVideoId = new Map(rows.map(r => [r.videoId, r.status]))

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

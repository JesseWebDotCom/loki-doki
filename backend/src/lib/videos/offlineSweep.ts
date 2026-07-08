// Follow/subscription-level "remove once watched": deletes a creator's AUTO-saved offline
// copies once the app's own completed flag says the user fully watched them. This is the
// offline-rules counterpart to the Plex-library policy (plexLibrarySections.removeWatched,
// lib/plex/export/watchedSweep.ts) — both funnels end in the same idempotent delete +
// Plex-remove enqueue, so the two policies compose as a union: whichever sweep runs first
// wins and the other's pass is a no-op.
//
// Scope: auto rows only — the same scoping as the keep-N prune. A manual save is explicit
// "keep this" intent and is never reclaimed by automation.
//
// Runs from the generic feed poller's 15-minute tick (lib/videos/feed.ts), covering BOTH
// the generic video_saves family and YouTube's yt_downloads family (this file mirrors
// feed.ts's existing "generic infra that also mirrors youtube" role).

import { and, eq, inArray, lt } from 'drizzle-orm'
import { unlink } from 'node:fs/promises'
import { db } from '@/db'
import {
  videoFollows, videoItems, videoSaves, videoWatchState,
  ytSubscriptions, ytVideos, ytDownloads, ytWatchState,
} from '@/db/schema'
import { resolveUserPath } from '@/lib/storage/paths'
import { logger } from '@/lib/logger'

/** Double settle window: a video only counts as watched once its completed flag has been
 *  stable this long, AND the save row itself is at least this old. The former protects
 *  "just finished, might rewind"; the latter stops an offline backfill of an already-watched
 *  video from being deleted before (or right after) its download even completes. */
const WATCHED_SETTLE_MS = 60 * 60 * 1000

/** Videos this user fully played IN THE APP (completed flag), per source. When
 *  `completedBefore` is set, only completions older than it count (settle window). */
export async function appCompletedVideoIds(
  contentType: string, userId: string, videoIds: string[], completedBefore?: Date,
): Promise<Set<string>> {
  if (!videoIds.length) return new Set()
  if (contentType === 'youtube') {
    const rows = await db.select({ videoId: ytWatchState.videoId }).from(ytWatchState)
      .where(and(
        eq(ytWatchState.userId, userId), eq(ytWatchState.completed, true), inArray(ytWatchState.videoId, videoIds),
        ...(completedBefore ? [lt(ytWatchState.updatedAt, completedBefore)] : []),
      ))
    return new Set(rows.map(r => r.videoId))
  }
  const rows = await db.select({ videoId: videoWatchState.videoId }).from(videoWatchState)
    .where(and(
      eq(videoWatchState.userId, userId), eq(videoWatchState.source, contentType as 'reddit' | 'tiktok' | 'vimeo'),
      eq(videoWatchState.completed, true), inArray(videoWatchState.videoId, videoIds),
      ...(completedBefore ? [lt(videoWatchState.updatedAt, completedBefore)] : []),
    ))
  return new Set(rows.map(r => r.videoId))
}

/** Delete the user's offline save for a watched video (the whole point of removeWatched:
 *  reclaim the space). Mirrors the manual-unsave paths: per-user sidecar files, then the
 *  ref row; the shared asset/blob is reclaimed only once nobody references it. */
export async function deleteWatchedSave(
  contentType: string, userId: string, videoId: string, kind: 'audio' | 'video' = 'video',
): Promise<void> {
  if (contentType === 'youtube') {
    const rows = await db.select().from(ytDownloads)
      .where(and(eq(ytDownloads.userId, userId), eq(ytDownloads.videoId, videoId), eq(ytDownloads.kind, kind), eq(ytDownloads.prefetch, false)))
    if (!rows.length) return
    for (const r of rows) {
      if (r.transcriptRelPath) { try { await unlink(await resolveUserPath(r.transcriptRelPath)) } catch { /* already gone */ } }
      if (!r.assetId && r.relPath) { try { await unlink(await resolveUserPath(r.relPath)) } catch { /* already gone */ } }
    }
    await db.delete(ytDownloads).where(inArray(ytDownloads.id, rows.map(r => r.id)))
    const { releaseAssetsIfOrphaned } = await import('@/lib/youtube/assets')
    await releaseAssetsIfOrphaned(rows.map(r => r.assetId))
  } else {
    await db.delete(videoSaves)
      .where(and(eq(videoSaves.userId, userId), eq(videoSaves.source, contentType as 'reddit' | 'tiktok' | 'vimeo'), eq(videoSaves.videoId, videoId), eq(videoSaves.kind, kind)))
    // Orphaned assets/blobs are reclaimed by the content store's GC sweep.
  }
}

/** One sweep over every follow/subscription with removeWatched enabled. Per-policy
 *  best-effort — one bad creator never blocks the rest. */
export async function runOfflineWatchedSweep(): Promise<void> {
  const settleCutoff = new Date(Date.now() - WATCHED_SETTLE_MS)
  const { enqueuePlexSync } = await import('@/lib/downloadJobs')

  // ── YouTube subscriptions ──
  const subs = await db.select().from(ytSubscriptions).where(eq(ytSubscriptions.removeWatched, true))
  for (const sub of subs) {
    try {
      const kind: 'audio' | 'video' = sub.autoSaveKind === 'audio' ? 'audio' : 'video'
      const rows = await db.select({ videoId: ytDownloads.videoId, createdAt: ytDownloads.createdAt })
        .from(ytDownloads)
        .innerJoin(ytVideos, eq(ytVideos.videoId, ytDownloads.videoId))
        .where(and(
          eq(ytDownloads.userId, sub.userId), eq(ytDownloads.kind, kind),
          eq(ytDownloads.auto, true), eq(ytDownloads.status, 'ready'), eq(ytDownloads.prefetch, false),
          eq(ytVideos.subscriptionId, sub.id),
        ))
      const eligible = rows.filter(r => r.createdAt.getTime() < settleCutoff.getTime())
      if (!eligible.length) continue
      const watched = await appCompletedVideoIds('youtube', sub.userId, eligible.map(r => r.videoId), settleCutoff)
      for (const videoId of watched) {
        await deleteWatchedSave('youtube', sub.userId, videoId, kind)
        if (kind === 'video') void enqueuePlexSync(sub.userId, videoId, 'remove').catch(() => {})
      }
      if (watched.size) logger.info(`[videos-offline] remove-watched: reclaimed ${watched.size} video(s) for "${sub.title}" (user ${sub.userId})`)
    } catch (err) {
      logger.warn(`[videos-offline] watched sweep failed for yt sub ${sub.id}: ${err}`)
    }
  }

  // ── Generic follows ──
  const follows = await db.select().from(videoFollows).where(eq(videoFollows.removeWatched, true))
  for (const follow of follows) {
    try {
      const kind: 'audio' | 'video' = follow.autoSaveKind === 'audio' ? 'audio' : 'video'
      const rows = await db.select({ videoId: videoSaves.videoId, createdAt: videoSaves.createdAt })
        .from(videoSaves)
        .innerJoin(videoItems, and(eq(videoItems.source, videoSaves.source), eq(videoItems.externalId, videoSaves.videoId)))
        .where(and(
          eq(videoSaves.userId, follow.userId), eq(videoSaves.source, follow.source),
          eq(videoSaves.auto, true), eq(videoSaves.status, 'ready'), eq(videoSaves.kind, kind),
          eq(videoItems.followId, follow.id),
        ))
      const eligible = rows.filter(r => r.createdAt.getTime() < settleCutoff.getTime())
      if (!eligible.length) continue
      const watched = await appCompletedVideoIds(follow.source, follow.userId, eligible.map(r => r.videoId), settleCutoff)
      for (const videoId of watched) {
        await deleteWatchedSave(follow.source, follow.userId, videoId, kind)
        if (kind === 'video') void enqueuePlexSync(follow.userId, videoId, 'remove', follow.source).catch(() => {})
      }
      if (watched.size) logger.info(`[videos-offline] remove-watched: reclaimed ${watched.size} video(s) for "${follow.title}" (user ${follow.userId})`)
    } catch (err) {
      logger.warn(`[videos-offline] watched sweep failed for follow ${follow.id}: ${err}`)
    }
  }
}

// Remove-watched sweep (plex_library_sections.removeWatched) — the Plex-style
// "delete after watching": once an exported episode has been FULLY played (in Plex, or
// in the app), it's removed from the user's Plex tree AND its offline save is deleted.
// The shared blob survives as long as any other household user still references it
// (releaseAssetsIfOrphaned / the content store's GC sweep own that, same as every other
// save-deletion path).
//
// Runs from the existing 15-minute Plex sync pass (lib/plex/sync.ts). Never applies to
// 'mine' sections — a user's own Studio creations aren't downloads to reclaim.
//
// Plex-side watched detection: one section listing per swept library (episodes carry
// viewCount + their backing file path). Episodes are matched back to tracking rows by
// FILE BASENAME — safe because sections are per-user and the videoId is embedded in
// every stem (see paths.ts episodeFileNames). The learned ratingKey is persisted so
// later sweeps for already-matched rows don't depend on the path at all.

import { and, eq, ne } from 'drizzle-orm'
import { basename } from 'node:path'
import { db } from '@/db'
import { plexLibrarySections, ytPlexEpisodes, videoPlexEpisodes } from '@/db/schema'
import { getPlexConnection, sectionEpisodes } from '@/lib/plex/index'
import { appCompletedVideoIds, deleteWatchedSave } from '@/lib/videos/offlineSweep'
import { logger } from '@/lib/logger'

/** Skip episodes placed/updated more recently than this — a just-placed file may not be
 *  in Plex's index yet (its `file` field would be missing), and a user can't have
 *  meaningfully watched it in that window anyway. */
const PLACEMENT_SETTLE_MS = 30 * 60 * 1000

interface PlacedEpisode {
  id: string
  userId: string
  videoId: string
  relPath: string | null
  plexRatingKey: string | null
  updatedAt: Date
}

async function placedEpisodes(contentType: string, userId: string): Promise<PlacedEpisode[]> {
  if (contentType === 'youtube') {
    return db.select({
      id: ytPlexEpisodes.id, userId: ytPlexEpisodes.userId, videoId: ytPlexEpisodes.videoId,
      relPath: ytPlexEpisodes.relPath, plexRatingKey: ytPlexEpisodes.plexRatingKey, updatedAt: ytPlexEpisodes.updatedAt,
    }).from(ytPlexEpisodes)
      .where(and(eq(ytPlexEpisodes.userId, userId), eq(ytPlexEpisodes.status, 'ready')))
  }
  return db.select({
    id: videoPlexEpisodes.id, userId: videoPlexEpisodes.userId, videoId: videoPlexEpisodes.videoId,
    relPath: videoPlexEpisodes.relPath, plexRatingKey: videoPlexEpisodes.plexRatingKey, updatedAt: videoPlexEpisodes.updatedAt,
  }).from(videoPlexEpisodes)
    .where(and(eq(videoPlexEpisodes.userId, userId), eq(videoPlexEpisodes.source, contentType), eq(videoPlexEpisodes.status, 'ready')))
}

async function persistRatingKey(contentType: string, episodeId: string, ratingKey: string): Promise<void> {
  if (contentType === 'youtube') {
    await db.update(ytPlexEpisodes).set({ plexRatingKey: ratingKey }).where(eq(ytPlexEpisodes.id, episodeId))
  } else {
    await db.update(videoPlexEpisodes).set({ plexRatingKey: ratingKey }).where(eq(videoPlexEpisodes.id, episodeId))
  }
}

// appCompletedVideoIds + the watched-save delete now live in lib/videos/offlineSweep.ts,
// shared with the follow-level remove-once-watched policy (offline rules without Plex).

/** One sweep over every ready removeWatched section. Called from the 15-minute Plex sync
 *  pass; every failure is per-section best-effort (one bad section never blocks the rest). */
export async function runWatchedSweep(): Promise<void> {
  const sections = await db.select().from(plexLibrarySections)
    .where(and(eq(plexLibrarySections.status, 'ready'), eq(plexLibrarySections.removeWatched, true), ne(plexLibrarySections.contentType, 'mine')))
  if (!sections.length) return

  const conn = await getPlexConnection()
  const { enqueuePlexSync } = await import('@/lib/downloadJobs')

  for (const section of sections) {
    try {
      const placed = await placedEpisodes(section.contentType, section.userId)
      if (!placed.length) continue
      const settleCutoff = Date.now() - PLACEMENT_SETTLE_MS
      const eligible = placed.filter(ep => ep.updatedAt.getTime() < settleCutoff)
      if (!eligible.length) continue

      const watched = new Set<string>()   // videoIds

      // Plex-side: one listing per section; match by learned ratingKey first, basename second.
      if (conn && section.plexSectionKey) {
        const plexEps = await sectionEpisodes(conn, section.plexSectionKey)
        if (plexEps.length) {
          const byRatingKey = new Map(plexEps.map(e => [e.ratingKey, e]))
          const byBasename = new Map(plexEps.filter(e => e.file).map(e => [basename(e.file!), e]))
          for (const ep of eligible) {
            let match = ep.plexRatingKey ? byRatingKey.get(ep.plexRatingKey) : undefined
            if (!match && ep.relPath) {
              match = byBasename.get(basename(ep.relPath))
              if (match) await persistRatingKey(section.contentType, ep.id, match.ratingKey)
            }
            if (match && match.viewCount > 0) watched.add(ep.videoId)
          }
        }
      }

      // In-app side: the app's own completed flag counts as watched too.
      const appCompleted = await appCompletedVideoIds(section.contentType, section.userId, eligible.map(e => e.videoId))
      for (const id of appCompleted) watched.add(id)

      for (const ep of eligible) {
        if (!watched.has(ep.videoId)) continue
        await deleteWatchedSave(section.contentType, section.userId, ep.videoId, 'video')
        await enqueuePlexSync(section.userId, ep.videoId, 'remove', section.contentType).catch(() => {})
      }
      if (watched.size) {
        logger.info(`[plex-export] remove-watched: reclaimed ${watched.size} watched video(s) from user ${section.userId}'s ${section.contentType} library`)
      }
    } catch (err) {
      logger.warn(`[plex-export] watched sweep failed for user ${section.userId} ${section.contentType}: ${err}`)
    }
  }
}

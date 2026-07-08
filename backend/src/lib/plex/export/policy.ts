// Per-library sync-policy enforcement (plex_library_sections.syncMode/'recent'-N).
// The policy governs ONLY what's visible in the Plex tree: enforcement enqueues
// placement-only removals (plex-sync 'remove' never touches yt_downloads/video_saves/
// studio_media — see removeVideoFromPlex/removeGenericVideoFromPlex). Deleting actual
// downloads belongs to the other two mechanisms: channel keep-N auto-prune and the
// remove-watched sweep.
//
// "Newest" is ranked by (seasonYear desc, episodeNumber desc) — episodeNumber is
// MMDD-derived in both exporters, so the pair is a stored, date-sortable proxy for the
// publish date without needing publishedAt on the tracking rows.

import { eq, and } from 'drizzle-orm'
import { db } from '@/db'
import { ytPlexShows, ytPlexEpisodes, videoPlexShows, videoPlexEpisodes, type plexLibrarySections } from '@/db/schema'
import { DEFAULT_SYNC_RECENT_COUNT } from '@/lib/plex/export/contentTypes'
import { logger } from '@/lib/logger'

type Section = typeof plexLibrarySections.$inferSelect

interface EpisodeRank { videoId: string; seasonYear: number; episodeNumber: number }

function rankDesc(a: EpisodeRank, b: EpisodeRank): number {
  return b.seasonYear - a.seasonYear || b.episodeNumber - a.episodeNumber
}

/** The effective newest-N limit for a section, or null when the mode is 'all'. */
export function recentLimit(section: Pick<Section, 'syncMode' | 'syncRecentCount'>): number | null {
  if (section.syncMode !== 'recent') return null
  const n = section.syncRecentCount ?? DEFAULT_SYNC_RECENT_COUNT
  return n > 0 ? n : DEFAULT_SYNC_RECENT_COUNT
}

async function readyEpisodesForShow(table: 'youtube' | 'generic', showId: string): Promise<EpisodeRank[]> {
  if (table === 'youtube') {
    return db.select({ videoId: ytPlexEpisodes.videoId, seasonYear: ytPlexEpisodes.seasonYear, episodeNumber: ytPlexEpisodes.episodeNumber })
      .from(ytPlexEpisodes).where(and(eq(ytPlexEpisodes.showId, showId), eq(ytPlexEpisodes.status, 'ready')))
  }
  return db.select({ videoId: videoPlexEpisodes.videoId, seasonYear: videoPlexEpisodes.seasonYear, episodeNumber: videoPlexEpisodes.episodeNumber })
    .from(videoPlexEpisodes).where(and(eq(videoPlexEpisodes.showId, showId), eq(videoPlexEpisodes.status, 'ready')))
}

/** Pre-placement check: would this video rank inside the show's newest-N window? Placing
 *  a video that wouldn't just churns the tree (enforcement would remove it again) — and
 *  worse, a stray late 'add' job could resurrect a policy-trimmed episode. */
export async function wouldMakeRecentCut(
  section: Pick<Section, 'syncMode' | 'syncRecentCount'>,
  ref: { table: 'youtube' | 'generic'; showId: string; videoId: string; seasonYear: number; episodeNumber: number },
): Promise<boolean> {
  const limit = recentLimit(section)
  if (limit == null) return true
  const others = (await readyEpisodesForShow(ref.table, ref.showId)).filter(e => e.videoId !== ref.videoId)
  if (others.length < limit) return true
  const cutoff = others.sort(rankDesc)[limit - 1]!
  return rankDesc(ref, cutoff) < 0   // strictly newer than the Nth-newest
}

/** Trim every show (or one show) in a user's library down to its newest-N window by
 *  enqueuing placement-only removals. No-op for 'all' mode. Called after each successful
 *  placement and when an admin/user shrinks the window. */
export async function enforceLibraryPolicy(userId: string, contentType: string, showId?: string): Promise<void> {
  const { plexLibrarySections } = await import('@/db/schema')
  const [section] = await db.select().from(plexLibrarySections)
    .where(and(eq(plexLibrarySections.userId, userId), eq(plexLibrarySections.contentType, contentType)))
  if (!section || section.status !== 'ready') return
  const limit = recentLimit(section)
  if (limit == null) return

  const table = contentType === 'youtube' ? 'youtube' as const : 'generic' as const
  let showIds: string[]
  if (showId) {
    showIds = [showId]
  } else if (table === 'youtube') {
    showIds = (await db.select({ id: ytPlexShows.id }).from(ytPlexShows).where(eq(ytPlexShows.userId, userId))).map(r => r.id)
  } else {
    showIds = (await db.select({ id: videoPlexShows.id }).from(videoPlexShows)
      .where(and(eq(videoPlexShows.userId, userId), eq(videoPlexShows.source, contentType)))).map(r => r.id)
  }

  const { enqueuePlexSync } = await import('@/lib/downloadJobs')
  for (const id of showIds) {
    const excess = (await readyEpisodesForShow(table, id)).sort(rankDesc).slice(limit)
    for (const ep of excess) {
      await enqueuePlexSync(userId, ep.videoId, 'remove', contentType)
    }
    if (excess.length) logger.info(`[plex-export] policy trim: ${excess.length} episode(s) beyond newest-${limit} for show ${id} (${contentType})`)
  }
}

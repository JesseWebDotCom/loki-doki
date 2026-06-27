// Watched-state sync between the app's per-episode marks and the Plex server.
//
//   push  — marking an episode watched in the app scrobbles it on the server.
//   pull  — a periodic pass folds the server's watched state (for in-progress shows) back into
//           the app's marks, so the native "Continue Watching" reflects what was watched in Plex.
//
// Both directions need to bridge two id spaces: app episodes are TVMaze episode ids; Plex
// episodes are local server ratingKeys. We bridge via (season, number) using allLeaves().

import { db } from '@/db'
import { showWatchedEpisodes } from '@/db/schema'
import { logger } from '@/lib/logger'
import { cachedLookup } from '@/lib/lookupCache'
import { getShowDetails, getShowEpisodes } from '@/lib/shows/tvmaze'
import { findInPlex, allLeaves, onDeck, scrobble, unscrobble, type PlexConnection, type PlexLeaf } from './index'
import { resolveShowId } from './resolve'
import { getUserPlexConnection, isUserPlexLinked, listLinkedPlexUserIds } from './account'

const SIX_HOURS_MS = 6 * 60 * 60 * 1000

/** Map a TVMaze show id to its local Plex server ratingKey (GUID/title match). Cached 6h. */
async function plexShowRatingKey(conn: PlexConnection, tvmazeId: number): Promise<string | null> {
  return cachedLookup('plex-show-ratingkey', String(tvmazeId), SIX_HOURS_MS, async () => {
    const details = await getShowDetails(tvmazeId)
    if (!details) return null
    const match = await findInPlex(conn, {
      type: 'show',
      title: details.name,
      year: details.year ? Number(details.year) : null,
      imdb: details.externals.imdb,
      tvdb: details.externals.thetvdb,
    })
    return match.present ? match.ratingKey : null
  })
}

function leafKey(season: number, number: number | null): string {
  return `${season}:${number ?? ''}`
}

/** Find the Plex episode (leaf) matching a TVMaze episode by season+number. */
async function findPlexLeaf(conn: PlexConnection, tvmazeId: number, season: number, number: number | null): Promise<PlexLeaf | null> {
  const showKey = await plexShowRatingKey(conn, tvmazeId)
  if (!showKey) return null
  const leaves = await allLeaves(conn, showKey)
  return leaves.find((l) => leafKey(l.season, l.number) === leafKey(season, number)) ?? null
}

// ── push: app mark → server scrobble ─────────────────────────────────────────────

/** Scrobble (or un-scrobble) a Plex episode when its app watched mark is toggled. Best-effort. */
export async function mirrorEpisodeWatched(
  userId: string,
  tvmazeId: number,
  season: number,
  number: number | null,
  watched: boolean,
): Promise<void> {
  if (!(await isUserPlexLinked(userId))) return
  const conn = await getUserPlexConnection(userId)
  if (!conn) return
  try {
    const leaf = await findPlexLeaf(conn, tvmazeId, season, number)
    if (!leaf) return
    if (watched) await scrobble(conn, leaf.ratingKey)
    else await unscrobble(conn, leaf.ratingKey)
  } catch (err) {
    logger.warn(`[plex] scrobble sync failed (show ${tvmazeId} S${season}E${number}): ${err}`)
  }
}

// ── pull: server watched state → app marks ───────────────────────────────────────

/** Import watched episodes from in-progress Plex shows into each linked user's app marks. */
export async function pullPlexProgress(): Promise<void> {
  for (const userId of await listLinkedPlexUserIds()) {
    const conn = await getUserPlexConnection(userId)
    if (conn) await pullPlexProgressForUser(userId, conn)
  }
}

async function pullPlexProgressForUser(linked: string, conn: PlexConnection): Promise<void> {
  try {
    const deck = (await onDeck(conn, 30)).filter((i) => i.type === 'show' && i.ratingKey)
    const seenShows = new Set<string>()
    for (const item of deck) {
      if (seenShows.has(item.ratingKey)) continue
      seenShows.add(item.ratingKey)
      const tvmazeId = await resolveShowId(item.guids, item.title, item.year)
      if (!tvmazeId) continue
      const leaves = await allLeaves(conn, item.ratingKey)
      const watchedLeaves = leaves.filter((l) => l.viewCount > 0)
      if (!watchedLeaves.length) continue
      const episodes = await getShowEpisodes(tvmazeId)
      if (!episodes.length) continue
      const byKey = new Map(episodes.map((e) => [leafKey(e.season, e.number), e]))
      const now = new Date()
      for (const l of watchedLeaves) {
        const ep = byKey.get(leafKey(l.season, l.number))
        if (!ep) continue
        await db
          .insert(showWatchedEpisodes)
          .values({ id: crypto.randomUUID(), userId: linked, tvmazeId, episodeId: ep.id, season: ep.season, number: ep.number, watchedAt: now })
          .onConflictDoNothing()
      }
    }
  } catch (err) {
    logger.warn(`[plex] progress pull error: ${err}`)
  }
}


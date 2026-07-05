// Sync ytPlaylists / Watch-Later / Liked → native Plex Collections — a cross-cutting shelf
// tag applied to episodes that already live under their real channel-show. Deliberately
// never creates a duplicate show/season for a playlist: a video only ever lives in ONE
// physical place in the tree (see project plan for why).
//
// UNVERIFIED against a live server (same caveat as export/library.ts, no server available
// here). Two real assumptions that need confirming on first live test:
//   1. Plex has no direct "ratingKey for this file path" lookup — resolving a placed
//      episode's ratingKey means listing the whole section (`type=4`) and matching each
//      item's Media.Part.file against our own placed path. Fine for one user's own library
//      section (bounded size), but untested against real Plex JSON field names.
//   2. Collection tagging goes through the same generic multi-value-field edit endpoint
//      used for genre/writer/etc (`PUT /library/metadata/{ratingKey}` with
//      `collection[0].tag.tag=`) — a well-known community pattern, not something this
//      codebase has exercised before.

import { eq, and } from 'drizzle-orm'
import { db } from '@/db'
import { plexCollections, plexLibrarySections, ytPlaylists, ytPlaylistVideos, ytCollections, ytPlexEpisodes, users } from '@/db/schema'
import { getPlexConnection } from '@/lib/plex/index'
import { userContentRoot } from '@/lib/plex/export/library'
import { toPlexPath, joinUnderRoot, getContentTypeStorageLocationId } from '@/lib/storage/contentRoots'
import { logger } from '@/lib/logger'

const CONTENT_TYPE = 'youtube'
const TIMEOUT_MS = 15_000

interface CollectionSource {
  sourceType: 'playlist' | 'collection'
  sourceId: string
  title: string
  videoIds: string[]
}

async function loadSources(userId: string): Promise<CollectionSource[]> {
  const sources: CollectionSource[] = []
  const playlists = await db.select().from(ytPlaylists).where(eq(ytPlaylists.userId, userId))
  for (const p of playlists) {
    const vids = await db.select({ videoId: ytPlaylistVideos.videoId }).from(ytPlaylistVideos).where(eq(ytPlaylistVideos.playlistId, p.id))
    if (vids.length) sources.push({ sourceType: 'playlist', sourceId: p.id, title: p.name, videoIds: vids.map(v => v.videoId) })
  }
  for (const bucket of ['watch-later', 'liked'] as const) {
    const rows = await db.select({ videoId: ytCollections.videoId }).from(ytCollections)
      .where(and(eq(ytCollections.userId, userId), eq(ytCollections.collection, bucket)))
    if (rows.length) sources.push({
      sourceType: 'collection', sourceId: bucket,
      title: bucket === 'watch-later' ? 'Watch Later' : 'Liked', videoIds: rows.map(r => r.videoId),
    })
  }
  return sources
}

/** One listing of the whole section per sync pass (not per video) — this is a single
 *  user's own library section, a bounded size even for an active saver. */
async function loadSectionFileIndex(baseUrl: string, token: string, sectionKey: string): Promise<Map<string, string>> {
  const byFile = new Map<string, string>()
  try {
    const res = await fetch(`${baseUrl}/library/sections/${encodeURIComponent(sectionKey)}/all?type=4&X-Plex-Token=${encodeURIComponent(token)}`, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return byFile
    const data = await res.json().catch(() => null) as { MediaContainer?: { Metadata?: Array<{ ratingKey?: string; Media?: Array<{ Part?: Array<{ file?: string }> }> }> } } | null
    for (const m of data?.MediaContainer?.Metadata ?? []) {
      const file = m.Media?.[0]?.Part?.[0]?.file
      if (file && m.ratingKey) byFile.set(file, m.ratingKey)
    }
  } catch (err) {
    logger.warn(`[plex-export] collections: failed to index section ${sectionKey}: ${err}`)
  }
  return byFile
}

async function tagIntoCollection(baseUrl: string, token: string, ratingKey: string, collectionTitle: string): Promise<void> {
  const params = new URLSearchParams({
    'collection[0].tag.tag': collectionTitle, 'collection.locked': '1', type: '4', id: ratingKey, 'X-Plex-Token': token,
  })
  try {
    await fetch(`${baseUrl}/library/metadata/${encodeURIComponent(ratingKey)}?${params.toString()}`, {
      method: 'PUT', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    logger.warn(`[plex-export] collections: tag failed for ratingKey ${ratingKey}: ${err}`)
  }
}

/**
 * Sync every playlist/Watch-Later/Liked bucket this user has into Plex Collections, tagging
 * whichever member videos are already placed episodes (untouched/unplaced videos are simply
 * skipped this pass — they'll get tagged whenever this runs again after they land). Every
 * step is best-effort: one failed tag must never abort the rest.
 */
export async function syncCollectionsForUser(userId: string): Promise<void> {
  const [section] = await db.select().from(plexLibrarySections)
    .where(and(eq(plexLibrarySections.userId, userId), eq(plexLibrarySections.contentType, CONTENT_TYPE)))
  if (!section || section.status !== 'ready' || !section.plexSectionKey) return

  const conn = await getPlexConnection()
  if (!conn) return
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  if (!user) return

  const sources = await loadSources(userId)
  if (!sources.length) return

  const fileIndex = await loadSectionFileIndex(conn.baseUrl, conn.token, section.plexSectionKey)
  const contentTypeStorageLocationId = await getContentTypeStorageLocationId(CONTENT_TYPE)
  const root = await userContentRoot(CONTENT_TYPE, userId, user.firstName)

  for (const source of sources) {
    let tagged = 0
    for (const videoId of source.videoIds) {
      const [ep] = await db.select().from(ytPlexEpisodes)
        .where(and(eq(ytPlexEpisodes.userId, userId), eq(ytPlexEpisodes.videoId, videoId), eq(ytPlexEpisodes.status, 'ready')))
      if (!ep?.relPath) continue
      const plexPath = await toPlexPath(contentTypeStorageLocationId, joinUnderRoot(root, ep.relPath))
      const ratingKey = plexPath ? fileIndex.get(plexPath) : null
      if (!ratingKey) continue
      await tagIntoCollection(conn.baseUrl, conn.token, ratingKey, source.title)
      tagged++
    }
    if (tagged === 0) continue

    const now = new Date()
    const [existing] = await db.select().from(plexCollections)
      .where(and(eq(plexCollections.userId, userId), eq(plexCollections.contentType, CONTENT_TYPE), eq(plexCollections.sourceType, source.sourceType), eq(plexCollections.sourceId, source.sourceId)))
    if (existing) {
      await db.update(plexCollections).set({ plexCollectionTitle: source.title, lastSyncedAt: now, updatedAt: now }).where(eq(plexCollections.id, existing.id))
    } else {
      await db.insert(plexCollections).values({
        id: crypto.randomUUID(), userId, contentType: CONTENT_TYPE, sourceType: source.sourceType, sourceId: source.sourceId,
        plexCollectionTitle: source.title, lastSyncedAt: now, createdAt: now, updatedAt: now,
      })
    }
    logger.info(`[plex-export] collections: tagged ${tagged} video(s) into "${source.title}" for user ${userId}`)
  }
}

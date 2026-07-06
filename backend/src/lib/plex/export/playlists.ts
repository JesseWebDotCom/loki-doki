// Sync ytPlaylists / Watch-Later / Liked → native Plex PLAYLISTS — an ORDERED, sequential
// list with a real "Play All" experience, matching what a YouTube playlist actually is (a
// curated watch order). Originally built against Plex Collections (a thematic shelf tag,
// no ordering) before shipping; switched after reconsidering that a Collection loses the
// one thing that makes a playlist a playlist. Verified live (2026-07) against a real PMS:
//   • POST /playlists?type=video&smart=0&uri=server://{machineId}/com.plexapp.plugins.library
//         /library/metadata/{ratingKey1},{ratingKey2},... — creates a playlist with those
//         items in that order, returns its own ratingKey.
//   • PUT /playlists/{id}/items?uri=... (same uri shape) — appends more items.
//   • GET /playlists/{id}/items — lists current members incl. each item's playlistItemID
//         (a DIFFERENT id than the item's own ratingKey — needed for removal).
//   • DELETE /playlists/{id}/items/{playlistItemID} — removes one member.
//   • GET /playlists/{id} — 404 if the user deleted the playlist since we last synced it
//         (used to detect "recreate" vs "update" rather than trusting our own stale row).

import { eq, and } from 'drizzle-orm'
import { db } from '@/db'
import { plexCollections, plexLibrarySections, ytPlaylists, ytPlaylistVideos, ytCollections, ytPlexEpisodes, users } from '@/db/schema'
import { getPlexConnection, machineId, type PlexConnection } from '@/lib/plex/index'
import { userContentRoot } from '@/lib/plex/export/library'
import { toPlexPath, joinUnderRoot, getContentTypeStorageLocationId } from '@/lib/storage/contentRoots'
import { logger } from '@/lib/logger'

const CONTENT_TYPE = 'youtube'
const TIMEOUT_MS = 15_000

interface PlaylistSource {
  sourceType: 'playlist' | 'collection'
  sourceId: string
  title: string
  videoIds: string[] // in the source's own intended order
}

async function loadSources(userId: string): Promise<PlaylistSource[]> {
  const sources: PlaylistSource[] = []
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
    logger.warn(`[plex-export] playlists: failed to index section ${sectionKey}: ${err}`)
  }
  return byFile
}

function metadataUri(machineIdentifier: string, ratingKeys: string[]): string {
  return `server://${machineIdentifier}/com.plexapp.plugins.library/library/metadata/${ratingKeys.join(',')}`
}

async function playlistExists(conn: PlexConnection, playlistId: string): Promise<boolean> {
  try {
    const res = await fetch(`${conn.baseUrl}/playlists/${encodeURIComponent(playlistId)}?X-Plex-Token=${encodeURIComponent(conn.token)}`, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    return res.ok
  } catch { return false }
}

async function createPlaylist(conn: PlexConnection, machineIdentifier: string, title: string, ratingKeys: string[]): Promise<string | null> {
  const params = new URLSearchParams({ type: 'video', title, smart: '0', uri: metadataUri(machineIdentifier, ratingKeys), 'X-Plex-Token': conn.token })
  try {
    const res = await fetch(`${conn.baseUrl}/playlists?${params.toString()}`, { method: 'POST', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) return null
    const data = await res.json().catch(() => null) as { MediaContainer?: { Metadata?: Array<{ ratingKey?: string }> } } | null
    return data?.MediaContainer?.Metadata?.[0]?.ratingKey ?? null
  } catch (err) {
    logger.warn(`[plex-export] playlist create threw for "${title}": ${err}`)
    return null
  }
}

async function getPlaylistItems(conn: PlexConnection, playlistId: string): Promise<Array<{ ratingKey: string; playlistItemID: number }>> {
  try {
    const res = await fetch(`${conn.baseUrl}/playlists/${encodeURIComponent(playlistId)}/items?X-Plex-Token=${encodeURIComponent(conn.token)}`, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return []
    const data = await res.json().catch(() => null) as { MediaContainer?: { Metadata?: Array<{ ratingKey?: string; playlistItemID?: number }> } } | null
    return (data?.MediaContainer?.Metadata ?? [])
      .filter((m): m is { ratingKey: string; playlistItemID: number } => !!m.ratingKey && m.playlistItemID != null)
  } catch { return [] }
}

async function addToPlaylist(conn: PlexConnection, machineIdentifier: string, playlistId: string, ratingKeys: string[]): Promise<void> {
  try {
    await fetch(`${conn.baseUrl}/playlists/${encodeURIComponent(playlistId)}/items?uri=${encodeURIComponent(metadataUri(machineIdentifier, ratingKeys))}&X-Plex-Token=${encodeURIComponent(conn.token)}`, {
      method: 'PUT', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    logger.warn(`[plex-export] playlist add-items failed for ${playlistId}: ${err}`)
  }
}

async function removeFromPlaylist(conn: PlexConnection, playlistId: string, playlistItemID: number): Promise<void> {
  try {
    await fetch(`${conn.baseUrl}/playlists/${encodeURIComponent(playlistId)}/items/${playlistItemID}?X-Plex-Token=${encodeURIComponent(conn.token)}`, {
      method: 'DELETE', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    logger.warn(`[plex-export] playlist remove-item failed for ${playlistId}/${playlistItemID}: ${err}`)
  }
}

/**
 * Sync every playlist/Watch-Later/Liked bucket this user has into a real Plex Playlist,
 * containing whichever member videos are already placed episodes (unplaced videos are
 * simply skipped this pass — they'll join whenever this runs again after they land). Every
 * step is best-effort: one failed add/remove must never abort the rest. Ordering follows the
 * source's own order for a fresh create; membership sync on an existing playlist only adds/
 * removes (Plex has no cheap "replace items in order" call, and household-scale playlists
 * don't reorder often enough to justify the extra round-trips a full reorder would cost).
 */
export async function syncPlaylistsForUser(userId: string): Promise<void> {
  const [section] = await db.select().from(plexLibrarySections)
    .where(and(eq(plexLibrarySections.userId, userId), eq(plexLibrarySections.contentType, CONTENT_TYPE)))
  if (!section || section.status !== 'ready' || !section.plexSectionKey) return

  const conn = await getPlexConnection()
  if (!conn) return
  const mid = await machineId(conn)
  if (!mid) return
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  if (!user) return

  const sources = await loadSources(userId)
  if (!sources.length) return

  const fileIndex = await loadSectionFileIndex(conn.baseUrl, conn.token, section.plexSectionKey)
  const contentTypeStorageLocationId = await getContentTypeStorageLocationId(CONTENT_TYPE)
  const root = await userContentRoot(CONTENT_TYPE, userId, user.firstName)

  for (const source of sources) {
    const desiredRatingKeys: string[] = []
    for (const videoId of source.videoIds) {
      const [ep] = await db.select().from(ytPlexEpisodes)
        .where(and(eq(ytPlexEpisodes.userId, userId), eq(ytPlexEpisodes.videoId, videoId), eq(ytPlexEpisodes.status, 'ready')))
      if (!ep?.relPath) continue
      const plexPath = await toPlexPath(contentTypeStorageLocationId, joinUnderRoot(root, ep.relPath))
      const ratingKey = plexPath ? fileIndex.get(plexPath) : null
      if (ratingKey) desiredRatingKeys.push(ratingKey)
    }
    if (!desiredRatingKeys.length) continue

    const now = new Date()
    const [existing] = await db.select().from(plexCollections)
      .where(and(eq(plexCollections.userId, userId), eq(plexCollections.contentType, CONTENT_TYPE), eq(plexCollections.sourceType, source.sourceType), eq(plexCollections.sourceId, source.sourceId)))

    let playlistId = existing?.plexRatingKey ?? null
    if (playlistId && !(await playlistExists(conn, playlistId))) playlistId = null // user deleted it on the Plex side — recreate

    if (!playlistId) {
      playlistId = await createPlaylist(conn, mid, source.title, desiredRatingKeys)
      if (!playlistId) { logger.warn(`[plex-export] playlist create failed for "${source.title}" (user ${userId})`); continue }
    } else {
      const currentItems = await getPlaylistItems(conn, playlistId)
      const currentKeys = new Set(currentItems.map(i => i.ratingKey))
      const toAdd = desiredRatingKeys.filter(k => !currentKeys.has(k))
      if (toAdd.length) await addToPlaylist(conn, mid, playlistId, toAdd)
      const desiredSet = new Set(desiredRatingKeys)
      for (const item of currentItems) if (!desiredSet.has(item.ratingKey)) await removeFromPlaylist(conn, playlistId, item.playlistItemID)
    }

    if (existing) {
      await db.update(plexCollections).set({ plexCollectionTitle: source.title, plexRatingKey: playlistId, lastSyncedAt: now, updatedAt: now }).where(eq(plexCollections.id, existing.id))
    } else {
      await db.insert(plexCollections).values({
        id: crypto.randomUUID(), userId, contentType: CONTENT_TYPE, sourceType: source.sourceType, sourceId: source.sourceId,
        plexCollectionTitle: source.title, plexRatingKey: playlistId, lastSyncedAt: now, createdAt: now, updatedAt: now,
      })
    }
    logger.info(`[plex-export] playlist "${source.title}": ${desiredRatingKeys.length} member(s) synced for user ${userId}`)
  }
}

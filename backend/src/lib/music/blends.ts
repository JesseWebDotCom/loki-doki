// Family Blend - two or more household profiles' listening blended into one
// auto-refreshing SHARED playlist (Spotify Blend, at home). A blend row (music_blends)
// owns a normal music_playlists row (kind 'blend', visibility 'shared'), so it plays,
// clones, and appears to the family exactly like any shared playlist. Refreshed daily by
// the music intel job; the taste-match percent comes from the members' embedding
// centroids when the collection is analyzed, with an artist-overlap fallback.

import { and, eq, inArray } from 'drizzle-orm'
import { db, sqlite } from '@/db'
import { musicBlends, musicFavorites, musicPlaylists, musicPlaylistTracks, users } from '@/db/schema'
import { centroidOf } from '@/lib/music/similarity'
import { logger } from '@/lib/logger'

export interface BlendMemberInfo { id: string; name: string }
export interface BlendInfo {
  id: string
  name: string
  ownerId: string
  members: BlendMemberInfo[]
  playlistId: string
  matchPercent: number | null
  trackCount: number
  refreshedAt: number | null
}

const DAY = 86_400   // played_at is unix SECONDS
const POOL_PER_MEMBER = 80
const BLEND_LEN = 40
const MAX_PER_ARTIST = 3

interface PoolTrack { ref: string; title: string; artist: string | null; weight: number }

function memberPool(userId: string): PoolTrack[] {
  const since = Math.floor(Date.now() / 1000) - 90 * DAY
  const rows = sqlite.prepare(`
    SELECT video_id, MAX(title) AS title, MAX(artist) AS artist, COUNT(*) AS plays
    FROM music_history
    WHERE user_id = ? AND played_at >= ?
    GROUP BY video_id
    ORDER BY plays DESC
    LIMIT ?
  `).all(userId, since, POOL_PER_MEMBER) as Array<{ video_id: string; title: string; artist: string | null; plays: number }>
  return rows.filter(r => r.video_id && r.title)
    .map(r => ({ ref: r.video_id, title: r.title, artist: r.artist, weight: r.plays }))
}

async function favoriteBoost(userId: string, pool: PoolTrack[]): Promise<PoolTrack[]> {
  const favs = await db.select().from(musicFavorites)
    .where(and(eq(musicFavorites.userId, userId), eq(musicFavorites.kind, 'song')))
  const favSet = new Set(favs.map(f => f.refId))
  const have = new Set(pool.map(p => p.ref))
  const out = pool.map(p => favSet.has(p.ref) ? { ...p, weight: p.weight + 3 } : p)
  // Favorited songs that fell outside the recent window still belong in a blend.
  for (const f of favs) {
    if (have.has(f.refId) || !f.title) continue
    out.push({ ref: f.refId, title: f.title, artist: f.artist, weight: 3 })
  }
  return out.sort((a, b) => b.weight - a.weight).slice(0, POOL_PER_MEMBER)
}

const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const songKey = (t: PoolTrack) => {
  const title = normKey(t.title)
  if (!title) return t.ref
  const artist = normKey(t.artist ?? '')
  return artist ? `${artist}~${title}` : title
}

/** Round-robin interleave of the member pools, shared tracks (2+ pools) first, deduped by
 *  ref AND song identity, capped per artist so nobody's one favorite band takes over. */
function blendPools(pools: PoolTrack[][]): PoolTrack[] {
  const keyCounts = new Map<string, number>()
  for (const pool of pools) {
    const seen = new Set<string>()
    for (const t of pool) {
      const k = songKey(t)
      if (seen.has(k)) continue
      seen.add(k)
      keyCounts.set(k, (keyCounts.get(k) ?? 0) + 1)
    }
  }
  const out: PoolTrack[] = []
  const usedKeys = new Set<string>()
  const artistCounts = new Map<string, number>()
  const take = (t: PoolTrack): boolean => {
    const k = songKey(t)
    if (usedKeys.has(k)) return false
    const a = normKey(t.artist ?? '')
    if (a && (artistCounts.get(a) ?? 0) >= MAX_PER_ARTIST) return false
    usedKeys.add(k)
    if (a) artistCounts.set(a, (artistCounts.get(a) ?? 0) + 1)
    out.push(t)
    return true
  }
  // Common ground leads: every song loved by 2+ members.
  for (const pool of pools) {
    for (const t of pool) {
      if (out.length >= BLEND_LEN) return out
      if ((keyCounts.get(songKey(t)) ?? 0) >= 2) take(t)
    }
  }
  // Then round-robin so every member is represented evenly.
  const idx = pools.map(() => 0)
  let progressed = true
  while (out.length < BLEND_LEN && progressed) {
    progressed = false
    for (let m = 0; m < pools.length && out.length < BLEND_LEN; m++) {
      const pool = pools[m]!
      while (idx[m]! < pool.length) {
        const t = pool[idx[m]!]!
        idx[m]!++
        if (take(t)) { progressed = true; break }
      }
    }
  }
  return out
}

/** Taste match: mean pairwise cosine of member taste centroids (0..100). Falls back to
 *  the artist-overlap coefficient when the members' listening isn't analyzed enough. */
async function tasteMatch(pools: PoolTrack[][]): Promise<number | null> {
  const centroids: Float32Array[] = []
  for (const pool of pools) {
    const c = await centroidOf(pool.map(t => t.ref), 5)
    if (c) centroids.push(c)
  }
  if (centroids.length === pools.length && pools.length >= 2) {
    let sum = 0, n = 0
    for (let i = 0; i < centroids.length; i++) {
      for (let j = i + 1; j < centroids.length; j++) {
        let dot = 0
        for (let d = 0; d < centroids[i]!.length; d++) dot += centroids[i]![d]! * centroids[j]![d]!
        sum += dot; n++
      }
    }
    if (n) return Math.round(Math.max(0, Math.min(1, sum / n)) * 100)
  }
  // Fallback: overlap coefficient over each pair's artist sets.
  const artistSets = pools.map(p => new Set(p.map(t => normKey(t.artist ?? '')).filter(Boolean)))
  let sum = 0, n = 0
  for (let i = 0; i < artistSets.length; i++) {
    for (let j = i + 1; j < artistSets.length; j++) {
      const a = artistSets[i]!, b = artistSets[j]!
      const min = Math.min(a.size, b.size)
      if (!min) continue
      let inter = 0
      for (const x of a) if (b.has(x)) inter++
      sum += inter / min; n++
    }
  }
  return n ? Math.round((sum / n) * 100) : null
}

type BlendRow = typeof musicBlends.$inferSelect

export function parseMembers(row: BlendRow): string[] {
  try {
    const v = JSON.parse(row.memberIdsJson) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}

/** Rebuild a blend's playlist from its members' current listening. Deletes the blend if
 *  its playlist was removed out from under it. Returns the new track count (0 = thin). */
export async function refreshBlend(blend: BlendRow): Promise<number> {
  const memberIds = parseMembers(blend)
  const [playlist] = await db.select().from(musicPlaylists).where(eq(musicPlaylists.id, blend.playlistId))
  if (!playlist) {
    await db.delete(musicBlends).where(eq(musicBlends.id, blend.id))
    return 0
  }
  const pools: PoolTrack[][] = []
  for (const id of memberIds) pools.push(await favoriteBoost(id, memberPool(id)))
  const nonEmpty = pools.filter(p => p.length)
  const tracks = blendPools(nonEmpty.length ? nonEmpty : pools)
  const match = await tasteMatch(pools).catch(() => null)

  const now = new Date()
  if (tracks.length) {
    await db.delete(musicPlaylistTracks).where(eq(musicPlaylistTracks.playlistId, blend.playlistId))
    await db.insert(musicPlaylistTracks).values(tracks.map((t, i) => ({
      id: crypto.randomUUID(), playlistId: blend.playlistId, videoId: t.ref, title: t.title,
      artist: t.artist, mbid: null, durationSec: null, position: i, addedAt: now,
    })))
    await db.update(musicPlaylists).set({ updatedAt: now }).where(eq(musicPlaylists.id, blend.playlistId))
  }
  await db.update(musicBlends)
    .set({ matchPercent: match, refreshedAt: now, updatedAt: now })
    .where(eq(musicBlends.id, blend.id))
  return tracks.length
}

export async function createBlend(ownerId: string, memberIds: string[], name?: string): Promise<BlendInfo> {
  const ids = [...new Set([ownerId, ...memberIds])]
  const memberRows = await db.select({ id: users.id, firstName: users.firstName }).from(users)
    .where(inArray(users.id, ids))
  if (memberRows.length < 2) throw new Error('a blend needs at least two household members')
  const finalName = name?.trim() || `${memberRows.map(m => m.firstName).slice(0, 3).join(' + ')} Blend`

  const now = new Date()
  const playlistId = crypto.randomUUID()
  await db.insert(musicPlaylists).values({
    id: playlistId, userId: ownerId, name: finalName,
    description: `A blend of ${memberRows.map(m => m.firstName).join(', ')}. Refreshes daily.`,
    visibility: 'shared', kind: 'blend', createdAt: now, updatedAt: now,
  })
  const blendId = crypto.randomUUID()
  await db.insert(musicBlends).values({
    id: blendId, ownerId, name: finalName, memberIdsJson: JSON.stringify(memberRows.map(m => m.id)),
    playlistId, matchPercent: null, refreshedAt: null, createdAt: now, updatedAt: now,
  })
  const [row] = await db.select().from(musicBlends).where(eq(musicBlends.id, blendId))
  await refreshBlend(row!)
  return (await getBlendInfo(blendId))!
}

export async function deleteBlend(blendId: string): Promise<void> {
  const [row] = await db.select().from(musicBlends).where(eq(musicBlends.id, blendId))
  if (!row) return
  await db.delete(musicPlaylists).where(eq(musicPlaylists.id, row.playlistId))
  await db.delete(musicBlends).where(eq(musicBlends.id, blendId))
}

export async function getBlendInfo(blendId: string): Promise<BlendInfo | null> {
  const [row] = await db.select().from(musicBlends).where(eq(musicBlends.id, blendId))
  if (!row) return null
  const [info] = await serializeBlends([row])
  return info ?? null
}

export async function listBlends(): Promise<BlendInfo[]> {
  const rows = await db.select().from(musicBlends)
  return serializeBlends(rows)
}

async function serializeBlends(rows: BlendRow[]): Promise<BlendInfo[]> {
  if (!rows.length) return []
  const allMemberIds = [...new Set(rows.flatMap(parseMembers))]
  const nameRows = allMemberIds.length
    ? await db.select({ id: users.id, firstName: users.firstName }).from(users).where(inArray(users.id, allMemberIds))
    : []
  const nameById = new Map(nameRows.map(r => [r.id, r.firstName]))
  const counts = new Map<string, number>()
  const playlistIds = rows.map(r => r.playlistId)
  const trackRows = await db.select({ playlistId: musicPlaylistTracks.playlistId }).from(musicPlaylistTracks)
    .where(inArray(musicPlaylistTracks.playlistId, playlistIds))
  for (const t of trackRows) counts.set(t.playlistId, (counts.get(t.playlistId) ?? 0) + 1)
  return rows.map(r => ({
    id: r.id, name: r.name, ownerId: r.ownerId,
    members: parseMembers(r).map(id => ({ id, name: nameById.get(id) ?? 'Someone' })),
    playlistId: r.playlistId, matchPercent: r.matchPercent,
    trackCount: counts.get(r.playlistId) ?? 0,
    refreshedAt: r.refreshedAt ? r.refreshedAt.getTime() : null,
  }))
}

/** Daily-job entry: refresh every blend that hasn't been rebuilt in ~20h. */
export async function refreshStaleBlends(): Promise<void> {
  const rows = await db.select().from(musicBlends)
  for (const row of rows) {
    if (row.refreshedAt && Date.now() - row.refreshedAt.getTime() < 20 * 60 * 60 * 1000) continue
    try { await refreshBlend(row) } catch (err) {
      logger.debug(`[blends] refresh failed for ${row.id}: ${String(err)}`)
    }
  }
}

// Mixes For You - the user's recent listening clustered in embedding space (k-means over
// the 1280-d discogs-effnet embeddings) into 3-6 mixes, each padded out with sonic
// neighbors from the household collection and named from its dominant artist/genre tag.
// Computed by the daily music intel job (intelJobs.ts), cached in music_mixes, and served
// as a rail on the Music home. Cold start (too little analyzed listening) yields no mixes;
// the rail simply doesn't render.

import { and, eq } from 'drizzle-orm'
import { db, sqlite } from '@/db'
import { musicMixes, musicFavorites } from '@/db/schema'
import { getFeatureRow, nearestToVector, type FeatureRow } from '@/lib/music/similarity'
import { filterTracksForUser } from '@/lib/music/advisory'
import { logger } from '@/lib/logger'

export interface MixTrack { videoId: string; title: string; artist: string }
export interface Mix { id: string; key: string; name: string; subtitle: string | null; tracks: MixTrack[] }

const DAY = 86_400          // played_at is unix SECONDS (drizzle timestamp mode)
const HISTORY_DAYS = 90
const HISTORY_POOL = 250
const MIN_ANALYZED = 24     // clustered points needed before mixes are worth showing
const MIN_CLUSTER = 4
const MIX_TARGET = 24
const STALE_MS = 24 * 60 * 60 * 1000

interface HistoryRow { video_id: string; title: string; artist: string | null; plays: number }

function recentTop(userId: string): HistoryRow[] {
  const since = Math.floor(Date.now() / 1000) - HISTORY_DAYS * DAY
  return sqlite.prepare(`
    SELECT video_id, MAX(title) AS title, MAX(artist) AS artist, COUNT(*) AS plays
    FROM music_history
    WHERE user_id = ? AND played_at >= ?
    GROUP BY video_id
    ORDER BY plays DESC
    LIMIT ?
  `).all(userId, since, HISTORY_POOL) as HistoryRow[]
}

// ── k-means on the unit sphere (embeddings are L2-normalised, so cosine = dot) ────────

interface Point { row: FeatureRow; plays: number }

function kmeans(points: Point[], k: number, iterations = 12): number[] {
  const dim = points[0]!.row.embedding.length
  // Seed centroids from a spread of the most-played points (deterministic, stable mixes).
  const centroids: Float32Array[] = []
  const step = Math.max(1, Math.floor(points.length / k))
  for (let i = 0; i < k; i++) centroids.push(Float32Array.from(points[Math.min(i * step, points.length - 1)]!.row.embedding))

  const assign = new Array<number>(points.length).fill(0)
  for (let it = 0; it < iterations; it++) {
    let moved = false
    for (let p = 0; p < points.length; p++) {
      const emb = points[p]!.row.embedding
      let best = 0, bestDot = -Infinity
      for (let c = 0; c < k; c++) {
        let dot = 0
        const cen = centroids[c]!
        for (let d = 0; d < dim; d++) dot += emb[d]! * cen[d]!
        if (dot > bestDot) { bestDot = dot; best = c }
      }
      if (assign[p] !== best) { assign[p] = best; moved = true }
    }
    // Recompute centroids (renormalised mean).
    for (let c = 0; c < k; c++) {
      const sum = new Float32Array(dim)
      let n = 0
      for (let p = 0; p < points.length; p++) {
        if (assign[p] !== c) continue
        const emb = points[p]!.row.embedding
        for (let d = 0; d < dim; d++) sum[d]! += emb[d]!
        n++
      }
      if (!n) continue
      let normSq = 0
      for (let d = 0; d < dim; d++) normSq += sum[d]! * sum[d]!
      const norm = Math.sqrt(normSq)
      if (norm) for (let d = 0; d < dim; d++) centroids[c]![d] = sum[d]! / norm
    }
    if (!moved) break
  }
  return assign
}

function centroidOfCluster(members: Point[]): Float32Array | null {
  if (!members.length) return null
  const dim = members[0]!.row.embedding.length
  const c = new Float32Array(dim)
  for (const m of members) for (let d = 0; d < dim; d++) c[d]! += m.row.embedding[d]!
  let normSq = 0
  for (let d = 0; d < dim; d++) normSq += c[d]! * c[d]!
  const norm = Math.sqrt(normSq)
  if (!norm) return null
  for (let d = 0; d < dim; d++) c[d]! /= norm
  return c
}

// ── Naming: dominant artist, else dominant classifier tag ─────────────────────────────

const titleCase = (s: string) => s.replace(/\b[a-z]/g, ch => ch.toUpperCase())

function nameCluster(members: Point[], taken: Set<string>): { name: string; subtitle: string | null } {
  const artistPlays = new Map<string, { label: string; plays: number }>()
  const tagCounts = new Map<string, number>()
  let totalPlays = 0
  for (const m of members) {
    totalPlays += m.plays
    const a = (m.row.artist ?? '').trim()
    if (a) {
      const k = a.toLowerCase()
      const cur = artistPlays.get(k) ?? { label: a, plays: 0 }
      cur.plays += m.plays
      artistPlays.set(k, cur)
    }
    for (const t of m.row.tags) {
      const tag = t.replace(/^mood\//, '').toLowerCase()
      if (tag.length < 3) continue
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
    }
  }
  const topArtists = [...artistPlays.values()].sort((a, b) => b.plays - a.plays)
  const topTag = [...tagCounts.entries()].sort((a, b) => b[1] - a[1])[0]

  let name: string | null = null
  if (topArtists[0] && totalPlays > 0 && topArtists[0].plays / totalPlays >= 0.4) {
    name = `${topArtists[0].label} Mix`
  } else if (topTag && topTag[1] >= Math.max(2, members.length / 3)) {
    name = `${titleCase(topTag[0])} Mix`
  } else if (topArtists[0]) {
    name = `${topArtists[0].label} & Friends`
  }
  if (!name || taken.has(name.toLowerCase())) {
    let n = 1
    let candidate = name ?? 'Your Mix'
    while (taken.has(candidate.toLowerCase())) { n++; candidate = `${name ?? 'Your Mix'} ${n}` }
    name = candidate
  }
  taken.add(name.toLowerCase())
  const subtitle = topArtists.length
    ? topArtists.slice(0, 3).map(a => a.label).join(', ')
    : null
  return { name, subtitle }
}

// ── Compute + cache ───────────────────────────────────────────────────────────────────

export async function computeMixesForUser(userId: string): Promise<Mix[]> {
  const history = recentTop(userId)
  if (history.length < MIN_ANALYZED) return persistMixes(userId, [])

  // Favorites nudge cluster membership toward what they LOVE, not just what played.
  const favs = new Set((await db.select({ refId: musicFavorites.refId }).from(musicFavorites)
    .where(and(eq(musicFavorites.userId, userId), eq(musicFavorites.kind, 'song')))).map(f => f.refId))

  const points: Point[] = []
  const byRef = new Map<string, HistoryRow>()
  for (const h of history) {
    byRef.set(h.video_id, h)
    const row = await getFeatureRow(h.video_id)
    if (row) points.push({ row, plays: h.plays + (favs.has(h.video_id) ? 3 : 0) })
  }
  if (points.length < MIN_ANALYZED) return persistMixes(userId, [])

  const k = Math.max(3, Math.min(6, Math.floor(points.length / 12)))
  const assign = kmeans(points, k)
  const clusters: Point[][] = Array.from({ length: k }, () => [])
  for (let p = 0; p < points.length; p++) clusters[assign[p]!]!.push(points[p]!)

  const historyRefs = new Set(history.map(h => h.video_id))
  const usedAcrossMixes = new Set<string>()
  const taken = new Set<string>()
  const mixes: Mix[] = []

  for (const members of clusters.sort((a, b) => b.length - a.length)) {
    if (members.length < MIN_CLUSTER) continue
    const { name, subtitle } = nameCluster(members, taken)
    const ordered = [...members].sort((a, b) => b.plays - a.plays)
    const tracks: MixTrack[] = []
    for (const m of ordered) {
      if (usedAcrossMixes.has(m.row.ref)) continue
      usedAcrossMixes.add(m.row.ref)
      tracks.push({ videoId: m.row.ref, title: m.row.title ?? '', artist: m.row.artist ?? '' })
    }
    // Pad with sonic neighbors of the cluster centroid: fresh collection tracks that fit
    // the cluster's sound but weren't in the recent listening pool.
    if (tracks.length < MIX_TARGET) {
      const centroid = centroidOfCluster(members)
      if (centroid) {
        const near = await nearestToVector(centroid, MIX_TARGET * 2, {
          maxPerArtist: 3, excludeRefs: [...historyRefs, ...usedAcrossMixes],
        })
        for (const n of near) {
          if (tracks.length >= MIX_TARGET) break
          if (!(n.title || n.artist)) continue
          usedAcrossMixes.add(n.ref)
          tracks.push({ videoId: n.ref, title: n.title ?? '', artist: n.artist ?? '' })
        }
      }
    }
    if (tracks.length >= MIN_CLUSTER * 2) {
      mixes.push({ id: `mix-${mixes.length + 1}`, key: `mix-${mixes.length + 1}`, name, subtitle, tracks: tracks.slice(0, MIX_TARGET) })
    }
    if (mixes.length >= 6) break
  }

  return persistMixes(userId, mixes)
}

// An EMPTY result leaves no rows behind, so remember when it was computed in memory -
// otherwise every rail fetch on a cold-start install would re-run the whole compute.
const emptyComputedAt = new Map<string, number>()

async function persistMixes(userId: string, mixes: Mix[]): Promise<Mix[]> {
  const now = new Date()
  await db.delete(musicMixes).where(eq(musicMixes.userId, userId))
  for (const m of mixes) {
    await db.insert(musicMixes).values({
      id: crypto.randomUUID(), userId, key: m.key, name: m.name, subtitle: m.subtitle,
      tracksJson: JSON.stringify(m.tracks), computedAt: now,
    })
  }
  emptyComputedAt.set(userId, mixes.length ? 0 : Date.now())
  return mixes
}

// Concurrent-compute guard so a page load and the daily job never double-run per user.
const inFlight = new Map<string, Promise<Mix[]>>()

/** Serve the cached mixes; recompute (guarded) when stale or missing. Advisory-filtered. */
export async function getMixesForUser(userId: string): Promise<Mix[]> {
  const rows = await db.select().from(musicMixes).where(eq(musicMixes.userId, userId))
  let mixes: Mix[]
  const emptyFresh = !rows.length && Date.now() - (emptyComputedAt.get(userId) ?? 0) < STALE_MS
  if (emptyFresh) return []
  const fresh = rows.length && rows.every(r => Date.now() - r.computedAt.getTime() < STALE_MS)
  if (fresh) {
    mixes = rows.map(r => ({
      id: r.key, key: r.key, name: r.name, subtitle: r.subtitle,
      tracks: JSON.parse(r.tracksJson) as MixTrack[],
    }))
  } else {
    let p = inFlight.get(userId)
    if (!p) {
      p = computeMixesForUser(userId).finally(() => inFlight.delete(userId))
      inFlight.set(userId, p)
    }
    try {
      mixes = await p
    } catch (err) {
      logger.debug(`[mixes] compute failed for ${userId}: ${String(err)}`)
      mixes = rows.map(r => ({
        id: r.key, key: r.key, name: r.name, subtitle: r.subtitle,
        tracks: JSON.parse(r.tracksJson) as MixTrack[],
      }))
    }
  }
  for (const m of mixes) m.tracks = await filterTracksForUser(userId, m.tracks)
  return mixes.filter(m => m.tracks.length >= MIN_CLUSTER)
}

/** Daily-job entry: recompute only when the cache is stale (cheap no-op otherwise). */
export async function refreshMixesIfStale(userId: string): Promise<void> {
  const rows = await db.select({ computedAt: musicMixes.computedAt }).from(musicMixes)
    .where(eq(musicMixes.userId, userId)).limit(1)
  const fresh = rows[0] && Date.now() - rows[0].computedAt.getTime() < STALE_MS
  if (!fresh) await computeMixesForUser(userId)
}

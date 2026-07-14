// Music domain for the interest engine: the "Suggested for you" rail of NEW music beyond
// the owned library. Unlike the other domains this doesn't use the pool/profile machinery
// or text centroids — the essentia engine already owns in-library sound similarity, and
// rails.ts's 6h cache is the serving cache. What this adds is candidate sourcing (Deezer
// artist radio + charts), artist-affinity ranking fused from plays/favorites/ratings,
// hard exclusion of everything ever played/saved/rated, and dismiss/impression state.
// Candidates resolve to playable YouTube refs only after ranking (resolveTracks is the
// expensive step, so only the winners pay it).

import { and, eq } from 'drizzle-orm'
import { db, sqlite } from '@/db'
import { musicFavorites, musicRatings } from '@/db/schema'
import { deezerRadioTracks, deezerTopChart, type DeezerTrack } from '@/lib/music/deezer'
import { dropJunk } from '@/lib/music/junk'
import { norm, resolveTracks } from '@/lib/music/resolve'
import type { Rail } from '@/lib/music/rails'
import { logger } from '@/lib/logger'
import { getImpressions, recordShown } from './impressions'

const DOMAIN = 'music' as const
const RAIL_SIZE = 24
/** How many ranked candidates get a YouTube resolve attempt (some won't resolve). */
const RESOLVE_BUDGET = 36

/** Song identity across sources (same normalization as the station engine's dedup). */
export const songKey = (artist: string | null | undefined, title: string) => `${norm(artist ?? '')}~${norm(title)}`

interface ArtistAffinity {
  weight: Map<string, number>
  top: string[]
  known: Set<string>       // songKeys of everything played / favorited / rated
  lowArtists: Set<string>  // artists with a 1-2★ rating anywhere
}

async function loadAffinity(userId: string): Promise<ArtistAffinity> {
  // Play counts per artist + known songKeys, straight off music_history (same fusion
  // shape as buildPersonalQueue: plays weight 1, favorites +3, ratings on top).
  const hist = sqlite.prepare(`
    SELECT artist, title, COUNT(*) AS plays FROM music_history
    WHERE user_id = ? GROUP BY LOWER(COALESCE(artist,'')), LOWER(title)
  `).all(userId) as Array<{ artist: string | null; title: string; plays: number }>

  const [favs, ratings] = await Promise.all([
    db.select({ title: musicFavorites.title, artist: musicFavorites.artist }).from(musicFavorites)
      .where(and(eq(musicFavorites.userId, userId), eq(musicFavorites.kind, 'song'))),
    db.select({ title: musicRatings.title, artist: musicRatings.artist, stars: musicRatings.stars })
      .from(musicRatings).where(eq(musicRatings.userId, userId)),
  ])

  const weight = new Map<string, number>()
  const known = new Set<string>()
  const bump = (artist: string | null | undefined, by: number) => {
    const a = artist?.trim()
    if (!a) return
    weight.set(a.toLowerCase(), (weight.get(a.toLowerCase()) ?? 0) + by)
  }
  for (const h of hist) {
    if (h.title) known.add(songKey(h.artist, h.title))
    bump(h.artist, Math.min(h.plays, 10))
  }
  for (const f of favs) {
    if (f.title) known.add(songKey(f.artist, f.title))
    bump(f.artist, 3)
  }
  const lowArtists = new Set<string>()
  for (const r of ratings) {
    if (r.title) known.add(songKey(r.artist, r.title))
    if (r.stars >= 4) bump(r.artist, r.stars === 5 ? 2 : 1)
    if (r.stars <= 2) {
      bump(r.artist, -3)
      if (r.artist) lowArtists.add(r.artist.toLowerCase())
    }
  }

  const top = [...weight.entries()]
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([a]) => a)
  return { weight, top, known, lowArtists }
}

/** Build the Suggested rail (called inside rails.ts's 6h-cached computeRails). Returns
 *  null when the listener has too little history to model. */
export async function buildMusicSuggestedRail(userId: string): Promise<Rail | null> {
  const affinity = await loadAffinity(userId)
  if (affinity.top.length < 2) return null

  // Candidates: Deezer artist radio for the top affinity artists (editorially "sounds
  // like / adjacent to" that artist) + the global chart as backfill.
  const seedArtists = affinity.top.slice(0, 4)
  const [radios, chart] = await Promise.all([
    Promise.all(seedArtists.map((a) => deezerRadioTracks(a, 25).catch(() => [] as DeezerTrack[]))),
    deezerTopChart(25).catch(() => [] as DeezerTrack[]),
  ])

  interface Cand extends DeezerTrack {
    key: string
    score: number
  }
  const imps = await getImpressions(userId, DOMAIN)
  const seen = new Set<string>()
  const candidates: Cand[] = []
  const push = (t: DeezerTrack, base: number, order: number) => {
    if (!t.title || !t.artist) return
    const key = songKey(t.artist, t.title)
    const artistLc = t.artist.toLowerCase()
    if (seen.has(key) || affinity.known.has(key) || affinity.lowArtists.has(artistLc)) return
    if (imps.get(key)?.dismissedAt) return
    seen.add(key)
    // Artist affinity dominates; a same-artist hit ranks above adjacency, which ranks
    // above the chart. Deezer's own ordering breaks ties within a source.
    const aff = Math.min(1, (affinity.weight.get(artistLc) ?? 0) / 10)
    const shown = imps.get(key)?.shownCount ?? 0
    candidates.push({ ...t, key, score: (0.6 * aff + base - order * 0.004) / (1 + 0.5 * shown) })
  }
  radios.forEach((list) => dropJunk(list).forEach((t, i) => push(t, 0.35, i)))
  dropJunk(chart).forEach((t, i) => push(t, 0.15, i))
  if (!candidates.length) return null

  // Rank + per-artist diversity cap, then resolve only the winners to playable refs.
  candidates.sort((a, b) => b.score - a.score)
  const perArtist = new Map<string, number>()
  const picked: Cand[] = []
  for (const c of candidates) {
    const a = c.artist.toLowerCase()
    const n = perArtist.get(a) ?? 0
    if (n >= 2) continue
    perArtist.set(a, n + 1)
    picked.push(c)
    if (picked.length >= RESOLVE_BUDGET) break
  }

  const resolved = await resolveTracks(picked.map((c) => ({ title: c.title, artist: c.artist })), 8)
  const tracks = resolved
    .filter((t) => t.videoId && t.title)
    .slice(0, RAIL_SIZE)
    .map((t) => ({ videoId: t.videoId, title: t.title, artist: t.artist ?? '', ref: songKey(t.artist, t.title) }))
  if (!tracks.length) return null

  // Impressions once per computation (rails.ts caches the result 6h, so per-request
  // recording would inflate shown counts 100x).
  await recordShown(userId, DOMAIN, tracks.map((t) => ({ ref: t.ref, creatorName: t.artist, title: t.title })))
  logger.info({ userId, seeds: seedArtists.length, candidates: candidates.length, tracks: tracks.length }, 'interests: music suggested rail built')

  return {
    key: 'suggested',
    title: 'Suggested for you',
    subtitle: 'New music from artists you love and their neighbors',
    tracks,
  }
}

/** Serve-time dismissal filter for the cached Suggested rail: a "Not interested" takes
 *  effect immediately (and survives reloads) instead of waiting out rails.ts's 6h cache. */
export async function filterDismissedSuggestions<T extends { ref?: string }>(userId: string, tracks: T[]): Promise<T[]> {
  const imps = await getImpressions(userId, DOMAIN)
  return tracks.filter((t) => !t.ref || !imps.get(t.ref)?.dismissedAt)
}

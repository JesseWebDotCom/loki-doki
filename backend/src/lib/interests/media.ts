// Shows + Movies domains for the interest engine. Signals come from the watchlist
// (status-weighted) and per-episode watched marks (incl. Plex scrobbles); candidates from
// JustWatch similar-titles on engaged titles plus genre-filtered trending browse. Shows
// are TVMaze-id keyed; movies are keyed by normalized title (the app has no keyless movie
// id). Kid/teen tiers bake age-certification filters into candidate generation itself,
// so each tier builds its own pool variant (see pool.ts).

import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { mediaWatchlist, showWatchedEpisodes } from '@/db/schema'
import { getShowDetails, resolveShow, type ShowSummary } from '@/lib/shows/tvmaze'
import { getShowsForAge } from '@/lib/shows'
import { getMoviesForAge, type MovieSummary } from '@/lib/movies'
import { browsePopular, searchTitles, type JwTitle } from '@/lib/titles/justwatch'
import { lookupTitle, type TitleLookup } from '@/lib/titles/streaming'
import { videoPolicyFor, type MediaTier } from '@/lib/media/policyTier'
import { cachedLookup, THIRTY_DAYS_MS } from '@/lib/lookupCache'
import { logger } from '@/lib/logger'
import { buildAndSaveProfile } from './profile'
import { dismissedCreatorCounts, getImpressions } from './impressions'
import { rankCandidates } from './rank'
import { EMPTY_POOL_TTL_MS, recordServed, savePool, servePool } from './pool'
import type { Candidate, InterestSignal } from './types'

export type MediaKind = 'show' | 'movie'
const domainOf = (kind: MediaKind): 'shows' | 'movies' => (kind === 'show' ? 'shows' : 'movies')

const movieRef = (title: string) => title.trim().toLowerCase().replace(/\s+/g, ' ')

// Watchlist status is the strongest explicit signal we have (there are no personal
// ratings for shows/movies): completed > watching > want >> dropped.
const STATUS_ENGAGEMENT: Record<string, number> = { want: 0.6, watching: 0.9, completed: 1, dropped: 0.1 }

// JustWatch genre filter wants shortNames; TVMaze/JustWatch signals carry display names.
// Unmapped genres simply skip the genre-browse bucket.
const JW_GENRE_SHORT: Record<string, string> = {
  'action': 'act', 'adventure': 'act', 'action & adventure': 'act',
  'animation': 'ani', 'anime': 'ani',
  'comedy': 'cmy',
  'crime': 'crm',
  'documentary': 'doc',
  'drama': 'drm',
  'fantasy': 'fnt',
  'history': 'hst',
  'horror': 'hrr',
  'family': 'fml', 'children': 'fml', 'kids & family': 'fml',
  'music': 'msc', 'musical': 'msc', 'music & musical': 'msc',
  'romance': 'rma',
  'science-fiction': 'scf', 'science fiction': 'scf', 'sci-fi': 'scf',
  'sport': 'spt', 'sports': 'spt',
  'thriller': 'trl', 'mystery': 'trl', 'mystery & thriller': 'trl',
  'war': 'war', 'war & military': 'war',
  'western': 'wsn',
  'reality': 'rly', 'reality tv': 'rly',
}

// Same cert ladders as getShowsForAge/getMoviesForAge; kid ≈ age 8, teen ≈ age 14+.
const SHOW_CERTS: Record<Exclude<MediaTier, 'open'>, string[]> = {
  kid: ['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG'],
  teen: ['TV-Y7', 'TV-G', 'TV-PG', 'TV-14'],
}
const MOVIE_CERTS: Record<Exclude<MediaTier, 'open'>, string[]> = {
  kid: ['G', 'PG'],
  teen: ['G', 'PG', 'PG-13'],
}

/** JustWatch detail lookup, hard-cached: interest builds re-look-up the same engaged
 *  titles every cycle and their genres/similar lists barely change. */
function cachedTitleLookup(title: string, objectType: 'MOVIE' | 'SHOW'): Promise<TitleLookup | null> {
  return cachedLookup<TitleLookup | null>(
    'interests:jw-lookup',
    `${objectType}:${title.toLowerCase()}`,
    THIRTY_DAYS_MS,
    () => lookupTitle(title, objectType),
  )
}

// ── Signals ─────────────────────────────────────────────────────────────────────

export async function collectMediaSignals(userId: string, kind: MediaKind): Promise<InterestSignal[]> {
  const rows = await db
    .select({
      refId: mediaWatchlist.refId,
      title: mediaWatchlist.title,
      subtitle: mediaWatchlist.subtitle,
      status: mediaWatchlist.status,
      updatedAt: mediaWatchlist.updatedAt,
    })
    .from(mediaWatchlist)
    .where(and(eq(mediaWatchlist.userId, userId), eq(mediaWatchlist.mediaType, kind), isNull(mediaWatchlist.deletedAt)))

  const byRef = new Map<string, InterestSignal>()
  for (const r of rows) {
    const ref = kind === 'show' ? r.refId : movieRef(r.title)
    byRef.set(ref, {
      ref,
      title: r.title,
      creatorId: null,
      // For shows the watchlist subtitle is the network — a weak but real affinity signal.
      creatorName: kind === 'show' ? (r.subtitle?.trim() || null) : null,
      topics: [],
      engagement: STATUS_ENGAGEMENT[r.status] ?? 0.6,
      at: r.updatedAt.getTime(),
    })
  }

  if (kind === 'show') {
    // Episode watched marks (app + Plex scrobbles), grouped per show: watching 8+ episodes
    // is a full-strength signal even if the show never made the watchlist.
    const eps = await db
      .select({ tvmazeId: showWatchedEpisodes.tvmazeId, watchedAt: showWatchedEpisodes.watchedAt })
      .from(showWatchedEpisodes)
      .where(eq(showWatchedEpisodes.userId, userId))
    const grouped = new Map<number, { count: number; latest: number }>()
    for (const e of eps) {
      const g = grouped.get(e.tvmazeId) ?? { count: 0, latest: 0 }
      g.count += 1
      g.latest = Math.max(g.latest, e.watchedAt.getTime())
      grouped.set(e.tvmazeId, g)
    }
    for (const [tvmazeId, g] of grouped) {
      const ref = String(tvmazeId)
      const engagement = Math.min(1, g.count / 8)
      const existing = byRef.get(ref)
      if (existing) {
        existing.engagement = Math.max(existing.engagement, engagement)
        existing.at = Math.max(existing.at, g.latest)
      } else {
        const details = await getShowDetails(tvmazeId).catch(() => null)
        if (!details) continue
        byRef.set(ref, {
          ref,
          title: details.name,
          creatorId: null,
          creatorName: details.network,
          topics: details.genres,
          engagement,
          at: g.latest,
        })
      }
    }
  }

  // Genre topics for the most-engaged signals (bounded: one cached lookup per title).
  // Shows come from TVMaze details; movies from JustWatch search (the detail lookup has
  // no genre list, but search results do — both are cachedLookup-backed).
  const signals = [...byRef.values()].sort((a, b) => b.engagement - a.engagement)
  for (const s of signals.slice(0, 30)) {
    if (s.topics.length) continue
    if (kind === 'show') {
      const details = await getShowDetails(Number(s.ref)).catch(() => null)
      if (details) s.topics = details.genres
    } else {
      const results = await searchTitles(s.title, 'MOVIE', 4).catch(() => [] as JwTitle[])
      const hit = results.find((t) => movieRef(t.title) === s.ref) ?? results[0]
      if (hit) s.topics = hit.genres
    }
  }
  return signals
}

/** Live exclusion set: everything on the (non-deleted) watchlist + every show with any
 *  watched episode. A movie ref is its normalized title. */
async function watchedMediaRefs(userId: string, kind: MediaKind): Promise<Set<string>> {
  const refs = new Set<string>()
  const rows = await db
    .select({ refId: mediaWatchlist.refId, title: mediaWatchlist.title })
    .from(mediaWatchlist)
    .where(and(eq(mediaWatchlist.userId, userId), eq(mediaWatchlist.mediaType, kind), isNull(mediaWatchlist.deletedAt)))
  for (const r of rows) refs.add(kind === 'show' ? r.refId : movieRef(r.title))
  if (kind === 'show') {
    const eps = await db
      .select({ tvmazeId: showWatchedEpisodes.tvmazeId })
      .from(showWatchedEpisodes)
      .where(eq(showWatchedEpisodes.userId, userId))
    for (const e of eps) refs.add(String(e.tvmazeId))
  }
  return refs
}

// ── Candidates ──────────────────────────────────────────────────────────────────

const showToCandidate = (s: ShowSummary, bucket: Candidate['bucket']): Candidate => ({
  ref: String(s.id),
  title: s.name,
  creatorId: null,
  creatorName: s.network,
  topics: s.genres,
  publishedAt: null,
  bucket,
  payload: s,
})

const jwMovieToCandidate = (t: JwTitle, bucket: Candidate['bucket']): Candidate => ({
  ref: movieRef(t.title),
  title: t.title,
  creatorId: null,
  creatorName: null,
  topics: t.genres,
  publishedAt: null,
  bucket,
  payload: { title: t.title, year: t.year, poster: t.poster, genre: t.genres[0] ?? null } satisfies MovieSummary,
})

async function buildMediaPool(userId: string, kind: MediaKind, tier: MediaTier): Promise<void> {
  const domain = domainOf(kind)
  const signals = await collectMediaSignals(userId, kind)
  if (signals.length < 2) {
    await savePool(userId, domain, [], EMPTY_POOL_TTL_MS, tier)
    return
  }

  const dismissed = await dismissedCreatorCounts(userId, domain)
  const profile = await buildAndSaveProfile(userId, domain, signals, dismissed)

  const certs = tier === 'open' ? undefined : kind === 'show' ? SHOW_CERTS[tier] : MOVIE_CERTS[tier]
  const objectType = kind === 'show' ? 'SHOW' : 'MOVIE'

  // Similar titles from the most-engaged seeds. On a kid tier the similar list carries no
  // cert info, so the bucket is skipped entirely (unknown = drop); teen keeps it
  // (unknown = allow), mirroring the video policy's semantics.
  const similar: Candidate[] = []
  if (tier !== 'kid') {
    const seeds = signals.slice(0, 10)
    await Promise.all(
      seeds.map(async (s) => {
        const lookup = await cachedTitleLookup(s.title, objectType).catch(() => null)
        for (const t of lookup?.similarTitles ?? []) {
          if (t.objectType.toUpperCase() !== objectType) continue
          if (kind === 'show') {
            const resolved = await resolveShow(t.title, t.year).catch(() => null)
            if (resolved) similar.push(showToCandidate(resolved, 'similar'))
          } else {
            similar.push(
              jwMovieToCandidate(
                { title: t.title, year: t.year, objectType: 'MOVIE', summary: '', poster: t.posterUrl || null, justwatchUrl: null, genres: [] },
                'similar',
              ),
            )
          }
        }
      }),
    )
  }

  // Genre-filtered trending browse for the top profile genres + a plain trending backfill.
  const genreShorts = [
    ...new Set(
      profile.topics
        .map((t) => JW_GENRE_SHORT[t.text.toLowerCase()])
        .filter((g): g is string => Boolean(g)),
    ),
  ].slice(0, 3)
  const browses = await Promise.all([
    ...genreShorts.map((g) =>
      browsePopular({ objectType, sortBy: 'TRENDING', genres: [g], ageCertifications: certs, first: 20 }).catch(() => [] as JwTitle[]),
    ),
    browsePopular({ objectType, sortBy: 'TRENDING', ageCertifications: certs, first: 24 }).catch(() => [] as JwTitle[]),
    browsePopular({ objectType, sortBy: 'POPULAR', ageCertifications: certs, first: 24 }).catch(() => [] as JwTitle[]),
  ])
  const genreTitles = browses.slice(0, genreShorts.length).flat()
  const backfillTitles = browses.slice(genreShorts.length).flat()

  const candidates: Candidate[] = [...similar]
  if (kind === 'show') {
    // Resolve JustWatch titles to TVMaze so cards carry native ids/posters (detail pages
    // are TVMaze-keyed); unresolved titles drop, same as the home shelves.
    for (const [list, bucket] of [[genreTitles, 'topic-search'], [backfillTitles, 'trending']] as const) {
      for (const t of list) {
        const resolved = await resolveShow(t.title, t.year).catch(() => null)
        if (resolved) candidates.push({ ...showToCandidate(resolved, bucket), topics: t.genres.length ? t.genres : resolved.genres })
      }
    }
  } else {
    candidates.push(...genreTitles.map((t) => jwMovieToCandidate(t, 'topic-search')))
    candidates.push(...backfillTitles.map((t) => jwMovieToCandidate(t, 'trending')))
  }

  const watched = await watchedMediaRefs(userId, kind)
  const imps = await getImpressions(userId, domain)
  const seen = new Set<string>()
  const fresh = candidates.filter((c) => {
    if (seen.has(c.ref) || watched.has(c.ref) || imps.get(c.ref)?.dismissedAt) return false
    seen.add(c.ref)
    return true
  })

  const ranked = await rankCandidates(profile, fresh)
  await savePool(userId, domain, ranked, undefined, tier)
  logger.info(
    { userId, kind, tier, signals: signals.length, similar: similar.length, candidates: fresh.length },
    'interests: media pool built',
  )
}

// ── Serving ─────────────────────────────────────────────────────────────────────

export interface SuggestedShow extends ShowSummary {
  ref: string
}
export interface SuggestedMovie extends MovieSummary {
  ref: string
}

export async function serveMediaRail(
  userId: string,
  kind: MediaKind,
  target = 18,
): Promise<{ items: Array<SuggestedShow | SuggestedMovie>; building: boolean }> {
  const domain = domainOf(kind)
  const tier = (await videoPolicyFor(userId)).tier
  const watchedRefs = await watchedMediaRefs(userId, kind)
  const { entries, building } = await servePool(userId, domain, {
    limit: target,
    watchedRefs,
    build: () => buildMediaPool(userId, kind, tier),
    variant: tier,
    // Shows/movies have no per-item creator dedup concern beyond networks; 3 per network
    // keeps a Netflix-heavy pool from reading as one brand's rail.
    maxPerCreator: 3,
  })
  if (building || !entries.length) {
    // Thin history / first build: age-appropriate discovery for kids, nothing for open
    // tiers (the home pages already lead with Trending/Popular shelves).
    if (tier !== 'open') {
      const age = tier === 'kid' ? 8 : 14
      const items = kind === 'show' ? await getShowsForAge(age) : await getMoviesForAge(age)
      const fallback = items
        .map((it) =>
          kind === 'show'
            ? ({ ...(it as ShowSummary), ref: String((it as ShowSummary).id) } as SuggestedShow)
            : ({ ...(it as MovieSummary), ref: movieRef((it as MovieSummary).title) } as SuggestedMovie),
        )
        .filter((it) => !watchedRefs.has(it.ref))
        .slice(0, target)
      return { items: fallback, building }
    }
    return { items: [], building }
  }

  const served = entries.slice(0, target)
  await recordServed(userId, domain, served)
  const items = served.map((e) =>
    kind === 'show'
      ? ({ ...(e.payload as ShowSummary), ref: e.ref } as SuggestedShow)
      : ({ ...(e.payload as MovieSummary), ref: e.ref } as SuggestedMovie),
  )
  return { items, building: false }
}

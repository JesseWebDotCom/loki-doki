// Podcasts domain for the interest engine: recommends REAL directory shows (iTunes /
// PodcastIndex) from listening behavior. Signals are per-show listening (podcastWatchState
// rolled up through episodes) plus explicit subscriptions; AI-generated shows contribute
// their YouTube source-video titles as topic text (a listen to an AI recap of a channel
// feeds that channel's subjects into the centroid). Candidates come from genre charts +
// topic searches; already-subscribed shows and anything with listen history are excluded.

import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import {
  podcastEpisodes,
  podcastEpisodeSources,
  podcastShows,
  podcastSubscriptions,
  podcastWatchState,
  ytVideos,
} from '@/db/schema'
import { chartPodcasts, PODCAST_GENRES, searchPodcasts, type DirectoryResult } from '@/lib/podcast/directory'
import { filterDirectoryForUser } from '@/lib/podcast/policy'
import { logger } from '@/lib/logger'
import { buildAndSaveProfile } from './profile'
import { dismissedCreatorCounts, getImpressions } from './impressions'
import { rankCandidates } from './rank'
import { EMPTY_POOL_TTL_MS, recordServed, savePool, servePool } from './pool'
import type { Candidate, InterestSignal } from './types'

const DOMAIN = 'podcasts' as const

/** Stable identity for a directory show: feedUrl when known (chart rows may omit it), else
 *  the iTunes id, else the normalized title. Signals and candidates must agree on this. */
export const podcastRef = (r: { feedUrl?: string | null; itunesId?: number | null; title: string }): string =>
  r.feedUrl?.trim() || (r.itunesId ? `itunes:${r.itunesId}` : r.title.trim().toLowerCase().replace(/\s+/g, ' '))

const parseCategories = (raw: string | null): string[] => {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw) as unknown
    return Array.isArray(arr) ? arr.filter((c): c is string => typeof c === 'string') : []
  } catch {
    return []
  }
}

// ── Signals ─────────────────────────────────────────────────────────────────────

export async function collectPodcastSignals(userId: string): Promise<InterestSignal[]> {
  // Per-show listening rollup: mean completion across listened episodes, weighted up by
  // how many episodes were touched (3+ episodes ≈ full-strength engagement).
  const listens = await db
    .select({
      showId: podcastShows.id,
      source: podcastShows.source,
      title: podcastShows.name,
      author: podcastShows.author,
      feedUrl: podcastShows.feedUrl,
      categoriesJson: podcastShows.categoriesJson,
      positionSec: podcastWatchState.positionSec,
      completed: podcastWatchState.completed,
      durationSec: podcastEpisodes.durationSec,
      updatedAt: podcastWatchState.updatedAt,
    })
    .from(podcastWatchState)
    .innerJoin(podcastEpisodes, eq(podcastEpisodes.id, podcastWatchState.episodeId))
    .innerJoin(podcastShows, eq(podcastShows.id, podcastEpisodes.showId))
    .where(eq(podcastWatchState.userId, userId))

  interface Acc {
    show: (typeof listens)[number]
    sum: number
    n: number
    latest: number
  }
  const byShow = new Map<string, Acc>()
  for (const l of listens) {
    const completion = l.completed ? 1 : l.durationSec && l.durationSec > 0 ? Math.min(1, Math.max(0.05, l.positionSec / l.durationSec)) : 0.3
    const acc = byShow.get(l.showId) ?? { show: l, sum: 0, n: 0, latest: 0 }
    acc.sum += completion
    acc.n += 1
    acc.latest = Math.max(acc.latest, l.updatedAt.getTime())
    byShow.set(l.showId, acc)
  }

  const signals: InterestSignal[] = []
  const aiShowIds: string[] = []
  for (const acc of byShow.values()) {
    const s = acc.show
    const engagement = Math.min(1, (acc.sum / acc.n) * Math.min(1, acc.n / 3))
    if (s.source === 'rss') {
      signals.push({
        ref: podcastRef({ feedUrl: s.feedUrl, title: s.title }),
        title: s.title,
        creatorId: null,
        creatorName: s.author,
        topics: parseCategories(s.categoriesJson),
        engagement,
        at: acc.latest,
      })
    } else {
      // AI show: the show itself isn't a directory item, but what it recaps is a real
      // interest — its episodes' YouTube source titles become topic text below.
      aiShowIds.push(s.showId)
      signals.push({
        ref: `ai:${s.showId}`,
        title: s.title,
        creatorId: null,
        creatorName: null,
        topics: [],
        engagement: engagement * 0.7,
        at: acc.latest,
      })
    }
  }

  if (aiShowIds.length) {
    const sources = await db
      .select({ showId: podcastEpisodes.showId, title: ytVideos.title })
      .from(podcastEpisodeSources)
      .innerJoin(podcastEpisodes, eq(podcastEpisodes.id, podcastEpisodeSources.episodeId))
      .innerJoin(ytVideos, eq(ytVideos.videoId, podcastEpisodeSources.sourceId))
      .where(and(inArray(podcastEpisodes.showId, aiShowIds), eq(podcastEpisodeSources.sourceType, 'youtube')))
      .limit(60)
    const byShowTopics = new Map<string, string[]>()
    for (const s of sources) {
      const arr = byShowTopics.get(s.showId) ?? []
      if (s.title && arr.length < 8) arr.push(s.title)
      byShowTopics.set(s.showId, arr)
    }
    for (const sig of signals) {
      if (!sig.ref.startsWith('ai:')) continue
      sig.topics = byShowTopics.get(sig.ref.slice(3)) ?? []
    }
  }

  // Explicit subscriptions: full-strength interest even before any episode is played.
  const subs = await db
    .select({
      title: podcastShows.name,
      author: podcastShows.author,
      feedUrl: podcastShows.feedUrl,
      categoriesJson: podcastShows.categoriesJson,
      addedAt: podcastSubscriptions.addedAt,
    })
    .from(podcastSubscriptions)
    .innerJoin(podcastShows, eq(podcastShows.id, podcastSubscriptions.showId))
    .where(eq(podcastSubscriptions.userId, userId))
  for (const s of subs) {
    const ref = podcastRef({ feedUrl: s.feedUrl, title: s.title })
    if (signals.some((x) => x.ref === ref)) continue
    signals.push({
      ref,
      title: s.title,
      creatorId: null,
      creatorName: s.author,
      topics: parseCategories(s.categoriesJson),
      engagement: 1,
      at: s.addedAt.getTime(),
    })
  }
  return signals
}

/** Live exclusion set: every subscribed or listened-to show, all its identities (a chart
 *  row matches by itunesId while the local row matches by feedUrl). */
async function knownPodcastRefs(userId: string): Promise<Set<string>> {
  const refs = new Set<string>()
  const add = (r: { feedUrl: string | null; title: string }) => {
    if (r.feedUrl?.trim()) refs.add(r.feedUrl.trim())
    refs.add(r.title.trim().toLowerCase().replace(/\s+/g, ' '))
  }
  const subs = await db
    .select({ feedUrl: podcastShows.feedUrl, title: podcastShows.name })
    .from(podcastSubscriptions)
    .innerJoin(podcastShows, eq(podcastShows.id, podcastSubscriptions.showId))
    .where(eq(podcastSubscriptions.userId, userId))
  for (const s of subs) add(s)
  const listened = await db
    .selectDistinct({ feedUrl: podcastShows.feedUrl, title: podcastShows.name })
    .from(podcastWatchState)
    .innerJoin(podcastEpisodes, eq(podcastEpisodes.id, podcastWatchState.episodeId))
    .innerJoin(podcastShows, eq(podcastShows.id, podcastEpisodes.showId))
    .where(eq(podcastWatchState.userId, userId))
  for (const s of listened) add(s)
  return refs
}

// ── Candidates ──────────────────────────────────────────────────────────────────

const dirToCandidate = (r: DirectoryResult, bucket: Candidate['bucket'], topics: string[] = []): Candidate => ({
  ref: podcastRef(r),
  title: r.title,
  creatorId: null,
  creatorName: r.author,
  topics: topics.length ? topics : r.genre ? [r.genre] : [],
  publishedAt: null,
  bucket,
  payload: r,
})

async function buildPodcastPool(userId: string): Promise<void> {
  const signals = await collectPodcastSignals(userId)
  if (signals.length < 1) {
    await savePool(userId, DOMAIN, [], EMPTY_POOL_TTL_MS)
    return
  }

  const dismissed = await dismissedCreatorCounts(userId, DOMAIN)
  const profile = await buildAndSaveProfile(userId, DOMAIN, signals, dismissed)

  // Genre affinity → Apple chart genres (name match against the fixed taxonomy).
  const genreIds = [
    ...new Set(
      profile.topics
        .map((t) => PODCAST_GENRES.find((g) => g.name.toLowerCase() === t.text.toLowerCase())?.id)
        .filter((id): id is number => Boolean(id)),
    ),
  ].slice(0, 3)
  // Topic searches: non-genre topics (AI-show source titles, odd categories) hit the
  // directory's term search.
  const genreNames = new Set(PODCAST_GENRES.map((g) => g.name.toLowerCase()))
  const searchTopics = profile.topics.filter((t) => !genreNames.has(t.text.toLowerCase())).slice(0, 4)

  const [charts, searches, backfill] = await Promise.all([
    Promise.all(genreIds.map((id) => chartPodcasts(id, 25).catch(() => ({ results: [] as DirectoryResult[], provider: 'itunes' as const })))),
    Promise.all(
      searchTopics.map((t) =>
        searchPodcasts(t.text, 10)
          .then((results) => ({ topic: t.text, results }))
          .catch(() => ({ topic: t.text, results: [] as DirectoryResult[] })),
      ),
    ),
    chartPodcasts(null, 30).catch(() => ({ results: [] as DirectoryResult[], provider: 'itunes' as const })),
  ])

  const candidates: Candidate[] = [
    ...charts.flatMap((c) => c.results.map((r) => dirToCandidate(r, 'topic-search'))),
    ...searches.flatMap(({ topic, results }) => results.map((r) => dirToCandidate(r, 'topic-search', [topic]))),
    ...backfill.results.map((r) => dirToCandidate(r, 'trending')),
  ]

  const known = await knownPodcastRefs(userId)
  const imps = await getImpressions(userId, DOMAIN)
  const seen = new Set<string>()
  const fresh = candidates.filter((c) => {
    const titleKey = c.title.trim().toLowerCase().replace(/\s+/g, ' ')
    if (seen.has(c.ref) || known.has(c.ref) || known.has(titleKey) || imps.get(c.ref)?.dismissedAt) return false
    seen.add(c.ref)
    return true
  })

  const ranked = await rankCandidates(profile, fresh)
  await savePool(userId, DOMAIN, ranked)
  logger.info({ userId, signals: signals.length, genres: genreIds.length, candidates: fresh.length }, 'interests: podcast pool built')
}

// ── Serving ─────────────────────────────────────────────────────────────────────

export interface SuggestedPodcast extends DirectoryResult {
  ref: string
}

export async function servePodcastRail(userId: string, target = 12): Promise<{ items: SuggestedPodcast[]; building: boolean }> {
  const known = await knownPodcastRefs(userId)
  const { entries, building } = await servePool(userId, DOMAIN, {
    limit: target * 2,
    watchedRefs: known,
    build: () => buildPodcastPool(userId),
  })
  if (building || !entries.length) return { items: [], building }

  const byRef = new Map(entries.map((e) => [e.ref, e]))
  const kept = await filterDirectoryForUser(
    userId,
    entries.map((e) => ({ ...(e.payload as DirectoryResult), ref: e.ref })),
  )
  const served = kept.slice(0, target)
  await recordServed(userId, DOMAIN, served.map((s) => byRef.get(s.ref)!).filter(Boolean))
  return { items: served, building: false }
}

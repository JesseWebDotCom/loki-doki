// Videos domain for the interest engine: signals from YouTube + hub (reddit/tiktok/vimeo)
// watch history, candidates fanned out across InnerTube related/search/channel, hub
// provider related, and trending backfill. Replaces the old /recommended internals, which
// seeded only the newest 4-5 watches — this build samples seeds across the whole 90-day
// window (stratified by recency tertile) and adds interest-topic searches, so suggestions
// track what the user is INTO, not just what they watched last night.

import { and, desc, eq, gt } from 'drizzle-orm'
import { db } from '@/db'
import { users, videoFollows, videoItems, videoWatchState, ytSubscriptions, ytVideos, ytWatchState } from '@/db/schema'
import { enrichChannelThumbs, fetchPopular, fetchTrending } from '@/lib/youtube/discovery'
import {
  innertubeChannel,
  innertubeRelated,
  innertubeSearch,
  SEARCH_FILTERS,
  tryInnertube,
  type ItVideo,
} from '@/lib/youtube/innertube'
import { ensureRelatedTopics } from '@/lib/youtube/relatedTopics'
import { videoPolicyFor } from '@/lib/media/policyTier'
import { filterVideosForUser, filterYtItemsForUser } from '@/lib/videos/policy'
import { getEnabledSources, getProvider } from '@/lib/videos/registry'
import { logger } from '@/lib/logger'
import type { GenericVideoSource, VideoItem } from '@/lib/videos/types'
import { buildAndSaveProfile } from './profile'
import { dismissedCreatorCounts, getImpressions } from './impressions'
import { rankCandidates } from './rank'
import { EMPTY_POOL_TTL_MS, recordServed, savePool, servePool } from './pool'
import type { Candidate, InterestSignal, RankedCandidate } from './types'

const DOMAIN = 'videos' as const
const WINDOW_MS = 90 * 24 * 60 * 60 * 1000
const HUB_SOURCES: GenericVideoSource[] = ['reddit', 'tiktok', 'vimeo']

const ytRef = (videoId: string) => `youtube:${videoId}`
const clampEngagement = (completed: boolean, pos: number, dur: number | null) =>
  completed ? 1 : dur && dur > 0 ? Math.min(1, Math.max(0.05, pos / dur)) : 0.3

const parseTopics = (raw: string | null): string[] => {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw) as unknown
    return Array.isArray(arr) ? arr.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

// ── Signals ─────────────────────────────────────────────────────────────────────

export async function collectVideoSignals(userId: string): Promise<InterestSignal[]> {
  const cutoff = new Date(Date.now() - WINDOW_MS)

  // YouTube plays (origin='youtube' only — Music-station plays share the table but must
  // not shape video suggestions). Metadata joins from yt_videos.
  const yt = await db
    .select({
      videoId: ytWatchState.videoId,
      positionSec: ytWatchState.positionSec,
      completed: ytWatchState.completed,
      updatedAt: ytWatchState.updatedAt,
      title: ytVideos.title,
      author: ytVideos.author,
      channelId: ytVideos.channelId,
      durationSec: ytVideos.durationSec,
      relatedTopics: ytVideos.relatedTopics,
    })
    .from(ytWatchState)
    .innerJoin(ytVideos, eq(ytVideos.videoId, ytWatchState.videoId))
    .where(and(eq(ytWatchState.userId, userId), eq(ytWatchState.origin, 'youtube'), gt(ytWatchState.updatedAt, cutoff)))
    .orderBy(desc(ytWatchState.updatedAt))
    .limit(300)

  // Hub-source plays (reddit/tiktok/vimeo), metadata from video_items.
  const hub = await db
    .select({
      source: videoWatchState.source,
      videoId: videoWatchState.videoId,
      positionSec: videoWatchState.positionSec,
      completed: videoWatchState.completed,
      updatedAt: videoWatchState.updatedAt,
      title: videoItems.title,
      creatorId: videoItems.creatorId,
      creatorName: videoItems.creatorName,
      durationSec: videoItems.durationSec,
    })
    .from(videoWatchState)
    .innerJoin(
      videoItems,
      and(eq(videoItems.source, videoWatchState.source), eq(videoItems.externalId, videoWatchState.videoId)),
    )
    .where(and(eq(videoWatchState.userId, userId), gt(videoWatchState.updatedAt, cutoff)))
    .orderBy(desc(videoWatchState.updatedAt))
    .limit(100)

  const signals: InterestSignal[] = []
  for (const w of yt) {
    if (!w.title || w.title === w.videoId) continue
    signals.push({
      ref: ytRef(w.videoId),
      title: w.title,
      creatorId: w.channelId,
      creatorName: w.author || null,
      topics: parseTopics(w.relatedTopics),
      engagement: clampEngagement(w.completed, w.positionSec, w.durationSec),
      at: w.updatedAt.getTime(),
    })
  }
  for (const w of hub) {
    if (!w.title) continue
    signals.push({
      ref: `${w.source}:${w.videoId}`,
      title: w.title,
      creatorId: w.creatorId,
      creatorName: w.creatorName,
      topics: [],
      engagement: clampEngagement(w.completed, w.positionSec, w.durationSec),
      at: w.updatedAt.getTime(),
    })
  }
  return signals
}

/** Everything this user has EVER opened, both lineages, all origins — the live exclusion
 *  set. A song played in Music is still a video they've seen; suggesting it is a repeat. */
export async function watchedVideoRefs(userId: string): Promise<Set<string>> {
  const [yt, hub] = await Promise.all([
    db.select({ videoId: ytWatchState.videoId }).from(ytWatchState).where(eq(ytWatchState.userId, userId)),
    db
      .select({ source: videoWatchState.source, videoId: videoWatchState.videoId })
      .from(videoWatchState)
      .where(eq(videoWatchState.userId, userId)),
  ])
  const refs = new Set<string>()
  for (const w of yt) refs.add(ytRef(w.videoId))
  for (const w of hub) refs.add(`${w.source}:${w.videoId}`)
  return refs
}

// ── Candidate generation (background only) ──────────────────────────────────────

const itToCandidate = (v: ItVideo, bucket: Candidate['bucket'], topics: string[] = []): Candidate => ({
  ref: ytRef(v.videoId),
  title: v.title,
  creatorId: v.channelId,
  creatorName: v.author,
  topics,
  publishedAt: v.publishedAt ?? null,
  bucket,
  payload: v,
})

const hubToCandidate = (v: VideoItem, bucket: Candidate['bucket']): Candidate => ({
  ref: `${v.source}:${v.id}`,
  title: v.title,
  creatorId: v.creator?.id ?? null,
  creatorName: v.creator?.name ?? null,
  topics: [],
  publishedAt: v.publishedAt ?? null,
  bucket,
  payload: v,
})

/** Pick seeds across the recency window, not just the newest few: split the (already
 *  newest-first) signals into three tertiles and take the most-engaged from each, so a
 *  month-old interest still seeds the related fan-out. */
function stratifiedSeeds(ytSignals: InterestSignal[], perTertile: number, cap: number): string[] {
  const seeds: string[] = []
  const third = Math.ceil(ytSignals.length / 3) || 1
  for (let t = 0; t < 3; t++) {
    const slice = ytSignals.slice(t * third, (t + 1) * third)
    slice.sort((a, b) => b.engagement - a.engagement)
    for (const s of slice.slice(0, perTertile)) seeds.push(s.ref.slice('youtube:'.length))
  }
  return [...new Set(seeds)].slice(0, cap)
}

export async function buildVideoPool(userId: string): Promise<void> {
  const signals = await collectVideoSignals(userId)
  // Too thin to model — park an empty pool with a short TTL so the rail keeps serving
  // its fallback and re-checks soon (a new user's first watches shouldn't wait 6h).
  if (signals.length < 3) {
    await savePool(userId, DOMAIN, [], EMPTY_POOL_TTL_MS)
    return
  }

  // Topic backfill: relatedTopics are already cached for anything opened on the watch
  // page; extract for the top engaged videos still missing them (bounded LLM cost, the
  // result caches permanently on the yt_videos row).
  const ytSignals = signals.filter((s) => s.ref.startsWith('youtube:'))
  const missingTopics = [...ytSignals]
    .filter((s) => s.topics.length === 0)
    .sort((a, b) => b.engagement - a.engagement)
    .slice(0, 10)
  if (missingTopics.length) {
    const [u] = await db.select({ firstName: users.firstName }).from(users).where(eq(users.id, userId)).limit(1)
    const firstName = u?.firstName ?? 'user'
    for (const s of missingTopics) {
      s.topics = await ensureRelatedTopics(s.ref.slice('youtube:'.length), userId, firstName).catch(() => [])
    }
  }

  const dismissed = await dismissedCreatorCounts(userId, DOMAIN)
  const profile = await buildAndSaveProfile(userId, DOMAIN, signals, dismissed)
  const safe = (await videoPolicyFor(userId)).restrictedMode

  const subs = new Set(
    (
      await db
        .select({ externalId: ytSubscriptions.externalId })
        .from(ytSubscriptions)
        .where(and(eq(ytSubscriptions.userId, userId), eq(ytSubscriptions.kind, 'channel')))
    ).map((s) => s.externalId),
  )

  // Fan-out, all best-effort: a failing source degrades its bucket, never the build.
  const seeds = stratifiedSeeds(ytSignals, 3, 8)
  const topicQueries = profile.topics.slice(0, 6)
  const affinityChannels = profile.creators.filter((c) => c.id?.startsWith('UC') && !subs.has(c.id!)).slice(0, 4)

  const [relatedLists, topicLists, channelLists, popular, trending, hubRelated, followItems] = await Promise.all([
    Promise.all(
      seeds.map((id) => tryInnertube('interests related', () => innertubeRelated(id, 15, 8000, safe), [] as ItVideo[])),
    ),
    Promise.all(
      topicQueries.map((t) =>
        tryInnertube(
          'interests topic search',
          async () => (await innertubeSearch(t.text, 10, 0, 8000, 0, SEARCH_FILTERS.videos, safe)).videos,
          [] as ItVideo[],
        ).then((videos) => ({ query: t.text, videos })),
      ),
    ),
    Promise.all(
      affinityChannels.map((c) =>
        tryInnertube(
          'interests channel latest',
          async () => (await innertubeChannel(c.id!, undefined, 6, 8000, 'videos')).videos.slice(0, 5),
          [] as ItVideo[],
        ),
      ),
    ),
    fetchPopular(24).catch(() => [] as ItVideo[]),
    fetchTrending(24).catch(() => [] as ItVideo[]),
    collectHubRelated(signals),
    collectFollowItems(userId),
  ])

  const candidates: Candidate[] = [
    ...relatedLists.flat().map((v) => itToCandidate(v, 'related')),
    ...topicLists.flatMap(({ query, videos }) => videos.map((v) => itToCandidate(v, 'topic-search', [query]))),
    ...channelLists.flat().map((v) => itToCandidate(v, 'creator-latest')),
    ...hubRelated,
    ...followItems,
    ...popular.map((v) => itToCandidate(v, 'trending')),
    ...trending.map((v) => itToCandidate(v, 'trending')),
  ]

  // Dedupe by ref; drop already-watched and dismissed before paying for ranking.
  const watched = await watchedVideoRefs(userId)
  const imps = await getImpressions(userId, DOMAIN)
  const seen = new Set<string>()
  const fresh = candidates.filter((c) => {
    if (seen.has(c.ref) || watched.has(c.ref) || imps.get(c.ref)?.dismissedAt) return false
    seen.add(c.ref)
    return true
  })

  let ranked = await rankCandidates(profile, fresh)
  // Subscribed channels already own "Latest from your subscriptions" — nudge, don't ban.
  ranked = ranked
    .map((e): RankedCandidate => (e.creatorId && subs.has(e.creatorId) ? { ...e, score: e.score * 0.85 } : e))
    .sort((a, b) => b.score - a.score)

  await savePool(userId, DOMAIN, ranked)
  logger.info(
    {
      userId,
      signals: signals.length,
      seeds: seeds.length,
      topics: topicQueries.length,
      candidates: fresh.length,
      kept: Math.min(ranked.length, 150),
    },
    'interests: video pool built',
  )
}

/** Related items from hub providers that support it, seeded by the most-engaged watches. */
async function collectHubRelated(signals: InterestSignal[]): Promise<Candidate[]> {
  const enabled = await getEnabledSources()
  const out: Candidate[] = []
  await Promise.all(
    HUB_SOURCES.filter((s) => enabled.includes(s)).map(async (source) => {
      const provider = getProvider(source)
      if (!provider?.getRelated || !provider.capabilities.related) return
      const seeds = signals
        .filter((s) => s.ref.startsWith(`${source}:`))
        .sort((a, b) => b.engagement - a.engagement)
        .slice(0, 3)
      for (const seed of seeds) {
        const items = await provider.getRelated!(seed.ref.slice(source.length + 1)).catch(() => [] as VideoItem[])
        out.push(...items.map((v) => hubToCandidate(v, 'related')))
      }
    }),
  )
  return out
}

/** Recent uploads from followed hub creators (the poller keeps video_items fresh). */
async function collectFollowItems(userId: string): Promise<Candidate[]> {
  const rows = await db
    .select({
      source: videoItems.source,
      externalId: videoItems.externalId,
      title: videoItems.title,
      creatorId: videoItems.creatorId,
      creatorName: videoItems.creatorName,
      url: videoItems.url,
      thumbnailUrl: videoItems.thumbnailUrl,
      durationSec: videoItems.durationSec,
      viewsText: videoItems.viewsText,
      publishedAt: videoItems.publishedAt,
      isAdult: videoItems.isAdult,
    })
    .from(videoItems)
    .innerJoin(videoFollows, eq(videoFollows.id, videoItems.followId))
    .where(eq(videoFollows.userId, userId))
    .orderBy(desc(videoItems.publishedAt))
    .limit(20)
  return rows.map((r) =>
    hubToCandidate(
      {
        source: r.source,
        id: r.externalId,
        url: r.url ?? '',
        title: r.title,
        creator: r.creatorId || r.creatorName ? { id: r.creatorId ?? '', name: r.creatorName ?? '' } : null,
        thumbnailUrl: r.thumbnailUrl,
        durationSec: r.durationSec,
        publishedAt: r.publishedAt ? r.publishedAt.getTime() : null,
        viewsText: r.viewsText,
        isAdult: r.isAdult,
      },
      'creator-latest',
    ),
  )
}

// ── Serving ─────────────────────────────────────────────────────────────────────

const itToVideoItem = (v: ItVideo): VideoItem => ({
  source: 'youtube',
  id: v.videoId,
  url: `https://www.youtube.com/watch?v=${v.videoId}`,
  title: v.title,
  creator: v.channelId || v.author ? { id: v.channelId ?? '', name: v.author ?? '', avatarUrl: v.channelThumb } : null,
  thumbnailUrl: v.thumbnailUrl,
  durationSec: v.durationSec,
  publishedAt: v.publishedAt ?? null,
  publishedText: v.publishedText,
  viewsText: v.views,
})

/** YouTube-only slice for /api/youtube/recommended (native ItVideo response shape).
 *  building=true → caller serves its legacy fallback chain. */
export async function serveYtRecommended(
  userId: string,
  target = 24,
): Promise<{ videos: ItVideo[]; building: boolean }> {
  const watchedRefs = await watchedVideoRefs(userId)
  const { entries, building } = await servePool(userId, DOMAIN, {
    limit: target * 2,
    watchedRefs,
    build: () => buildVideoPool(userId),
    entryFilter: (e) => e.ref.startsWith('youtube:'),
  })
  if (building || !entries.length) return { videos: [], building }

  const byRef = new Map(entries.map((e) => [e.ref, e]))
  const kept = await filterYtItemsForUser(userId, entries.map((e) => e.payload as ItVideo))
  const served = kept.slice(0, target)
  await enrichChannelThumbs(served)
  await recordServed(userId, DOMAIN, served.map((v) => byRef.get(ytRef(v.videoId))!).filter(Boolean))
  return { videos: served, building: false }
}

/** Cross-source rail for /api/videos/suggested (hub VideoItem shape). No fallback —
 *  the hub home already shows Popular/Trending shelves; while building, the shelf hides. */
export async function serveVideosSuggested(
  userId: string,
  target = 18,
): Promise<{ items: VideoItem[]; building: boolean }> {
  const watchedRefs = await watchedVideoRefs(userId)
  const { entries, building } = await servePool(userId, DOMAIN, {
    limit: target * 2,
    watchedRefs,
    build: () => buildVideoPool(userId),
  })
  if (building || !entries.length) return { items: [], building }

  const withItems = entries.map((e) => ({
    entry: e,
    item: e.ref.startsWith('youtube:') ? itToVideoItem(e.payload as ItVideo) : (e.payload as VideoItem),
  }))
  const kept = await filterVideosForUser(userId, withItems.map((w) => w.item))
  const keptKeys = new Set(kept.map((i) => `${i.source}:${i.id}`))
  const served = withItems.filter((w) => keptKeys.has(`${w.item.source}:${w.item.id}`)).slice(0, target)
  await recordServed(userId, DOMAIN, served.map((w) => w.entry))
  return { items: served.map((w) => w.item), building: false }
}

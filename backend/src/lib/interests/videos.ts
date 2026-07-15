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

// Daily shows title their episodes with dates, and the topic extractor dutifully turns
// "The View Full Broadcast, July 10 2026" into the topic "July 10, 2026" — which, as a
// YouTube search, returns astrology/tarot/numerology date-spam (verified live). A topic
// that is mostly a date once the date parts are stripped is noise, not an interest.
const MONTH_RE = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i
const isDateTopic = (t: string): boolean => {
  if (!MONTH_RE.test(t)) return false
  const stripped = t
    .replace(/\b(19|20)\d{2}\b/g, '')
    .replace(new RegExp(MONTH_RE.source, 'gi'), '')
    .replace(/\b\d{1,2}(st|nd|rd|th)?\b/g, '')
    .replace(/[,.]/g, '')
    .trim()
  return stripped.split(/\s+/).filter(Boolean).length <= 2
}

const parseTopics = (raw: string | null): string[] => {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw) as unknown
    return Array.isArray(arr) ? arr.filter((t): t is string => typeof t === 'string' && !isDateTopic(t)) : []
  } catch {
    return []
  }
}

// Only the PRIMARY related-topic (index 0 — the subject the video is centered on) shapes the
// taste profile. The extractor deliberately also emits 1-3 "other subjects": an accessory
// shown, a product named in passing, the platform it runs on. Those enrich the watch page's
// Related shelves, but as interest search queries they drag the profile toward things the user
// never cared about — a one-line Delonghi mention in a smart-home tour becoming a coffee rail.
const primaryTopic = (raw: string | null): string[] => parseTopics(raw).slice(0, 1)

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
      topics: primaryTopic(w.relatedTopics),
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
      const topics = await ensureRelatedTopics(s.ref.slice('youtube:'.length), userId, firstName).catch(() => [])
      s.topics = topics.filter((t) => !isDateTopic(t)).slice(0, 1)
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
    // Channel-tab videos don't repeat their own channel's name/id — stamp the fetched
    // channel's identity so affinity scoring (and the card's byline) survive.
    ...channelLists.flatMap((videos, i) =>
      videos.map((v) => ({
        ...itToCandidate(v, 'creator-latest'),
        creatorId: v.channelId ?? affinityChannels[i]!.id,
        creatorName: v.author ?? affinityChannels[i]!.name,
      })),
    ),
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
  // Relevance gate: a candidate earns its slot through SOME positive signal — embedding
  // similarity to the taste centroids, a creator the user watches, or a topic they follow.
  // Kills keyword-collision search hits ("Hubble" the telescope matching "Hubble" the
  // gadget clock) and off-interest trending/news that used to coast in on bucket priors.
  // Unembeddable candidates (cos null) pass — unknown is not the same as dissimilar.
  const RELEVANCE_COS = 0.35
  // Hard-news gate: trending feeds are saturated with minutes-old crime/politics/breaking
  // uploads, and for anyone who watches ANY commentary the centroid sits close enough to
  // "news" that a murder headline clears the cosine floor (verified live: 0.48 for a
  // counterterrorism story). Embeddings can't separate "likes political commentary shows"
  // from "wants breaking crime news", so hard news needs the one signal that CAN: the
  // user actually watching that outlet (affinity threshold, uniform across buckets —
  // creator-latest candidates carry their channel's affinity after the stamping above).
  const NEWS_CHANNEL = /\b(news(hour)?|breaking|associated press|reuters|inside edition|sky news|bbc|cnn|msnbc|nbc|abc|cbs|fox news|newsmax|c-?span|telemundo|univision)\b/i
  // Two halves: word-bounded phrases, then patterns that end mid-word or at punctuation
  // (a trailing \b after "," or inside "assassination" never matches).
  const NEWS_TITLE =
    /\b(breaking(\s+news)?|murder(ed)?|shooting|shot (dead|by)|stabb(ed|ing)|kill(s|ed)? (man|woman|teen|child|officer|suspect)|(planned|plott?ed|tried) to kill|found dead|dead after|dies after|death toll|manhunt|crackdown|indict(ed|ment)|arraign|verdict|press conference)\b|\b(assassinat|(dead|dies)\s*[,:;])/i
  const isHardNews = (e: RankedCandidate) => NEWS_CHANNEL.test(e.creatorName ?? '') || NEWS_TITLE.test(e.title)
  // Age gate: platform "related" on low-traffic sources (Vimeo especially) surfaces
  // decade-old shorts. Nobody's "suggested for you" should lead with 14-year-old videos
  // unless they're from a creator the user actually watches.
  const MAX_AGE_MS = 6 * 365 * 24 * 60 * 60 * 1000
  const builtAt = Date.now()
  const gated = ranked.filter((e) => {
    const p = e.parts
    // A topic-search hit matches its own query by construction, so its `topic` part is
    // tautological — it can't independently vouch for relevance. Require real similarity
    // (cosine) or a watched creator instead; otherwise an off-taste result from a stray or
    // hallucinated interest topic (e.g. "Fable 5", the Claude model, misread as the Xbox
    // game) coasts past the gate on the very topic that spawned it.
    const topicVouch = e.bucket === 'topic-search' ? 0 : (p?.topic ?? 0)
    if (p && p.cos !== null && p.cos < RELEVANCE_COS && p.creator < 0.15 && topicVouch < 0.2) return false
    if (e.publishedAt && builtAt - e.publishedAt > MAX_AGE_MS && (p?.creator ?? 0) === 0) return false
    if (isHardNews(e) && (p?.creator ?? 0) < 0.15) return false
    return true
  })
  // Subscribed channels already own "Latest from your subscriptions" — nudge, don't ban.
  ranked = gated
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

/** Related items from hub providers that support it, seeded by the most-engaged watches.
 *  Seeding is proportional to how much the user actually uses a source: one stray Vimeo
 *  watch must not flood the pool with that platform's (often ancient) related graph. */
async function collectHubRelated(signals: InterestSignal[]): Promise<Candidate[]> {
  const enabled = await getEnabledSources()
  const out: Candidate[] = []
  await Promise.all(
    HUB_SOURCES.filter((s) => enabled.includes(s)).map(async (source) => {
      const provider = getProvider(source)
      if (!provider?.getRelated || !provider.capabilities.related) return
      const sourceSignals = signals
        .filter((s) => s.ref.startsWith(`${source}:`))
        .sort((a, b) => b.engagement - a.engagement)
      // A source the user touched once gets one seed; regular use earns a second.
      const seeds = sourceSignals.slice(0, sourceSignals.length >= 4 ? 2 : 1)
      const perSource: Candidate[] = []
      for (const seed of seeds) {
        const items = await provider.getRelated!(seed.ref.slice(source.length + 1)).catch(() => [] as VideoItem[])
        perSource.push(...items.map((v) => hubToCandidate(v, 'related')))
      }
      out.push(...perSource.slice(0, 15))
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
  // Same trending cap as the hub rail: backfill fills gaps, it doesn't take over as
  // rotation demotes the personalized picks.
  const trendingCap = Math.max(3, Math.floor(target / 3))
  let trendingServed = 0
  const served: ItVideo[] = []
  for (const v of kept) {
    if (byRef.get(ytRef(v.videoId))?.bucket === 'trending') {
      if (trendingServed >= trendingCap) continue
      trendingServed++
    }
    served.push(v)
    if (served.length >= target) break
  }
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
  // Per-source cap: hub sources add variety but must not crowd the rail — the user's
  // watch time is overwhelmingly on the primary source (YouTube), so cap each hub
  // source at 3 of the served slice. Trending backfill is likewise capped to a third:
  // it exists to fill gaps, and without a cap the rotation demotion (shown items sink)
  // gradually hands the whole rail to it.
  const perSource = new Map<string, number>()
  let trendingServed = 0
  const trendingCap = Math.max(3, Math.floor(target / 3))
  const served: typeof withItems = []
  for (const w of withItems) {
    if (!keptKeys.has(`${w.item.source}:${w.item.id}`)) continue
    if (w.entry.bucket === 'trending') {
      if (trendingServed >= trendingCap) continue
      trendingServed++
    }
    if (w.item.source !== 'youtube') {
      const n = perSource.get(w.item.source) ?? 0
      if (n >= 3) continue
      perSource.set(w.item.source, n + 1)
    }
    served.push(w)
    if (served.length >= target) break
  }
  await recordServed(userId, DOMAIN, served.map((w) => w.entry))
  return { items: served.map((w) => w.item), building: false }
}

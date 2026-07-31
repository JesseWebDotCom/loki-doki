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
import { getValidAccessToken } from '@/lib/youtube/account'
import { fetchHomeFeed } from '@/lib/youtube/tvClient'
import { videoPolicyFor } from '@/lib/media/policyTier'
import { filterVideosForUser, filterYtItemsForUser } from '@/lib/videos/policy'
import { getEnabledSources, getProvider } from '@/lib/videos/registry'
import { logger } from '@/lib/logger'
import type { GenericVideoSource, VideoItem } from '@/lib/videos/types'
import { buildAndSaveProfile, getProfileStale } from './profile'
import { dismissedCreatorCounts, getImpressions } from './impressions'
import { rankCandidates } from './rank'
import { EMPTY_POOL_TTL_MS, recordServed, savePool, servePool } from './pool'
import type { Candidate, InterestSignal, RankedCandidate } from './types'

const DOMAIN = 'videos' as const
// A full year of taste, not a quarter: interests from months back (that lego
// phase, the anime arc) still deserve fresh suggestions alongside last week's
// trailers. Era-bucketed seeding below keeps recency from dominating.
const WINDOW_MS = 365 * 24 * 60 * 60 * 1000
const HUB_SOURCES: GenericVideoSource[] = ['reddit', 'tiktok', 'vimeo']

const ytRef = (videoId: string) => `youtube:${videoId}`
// Watch SECONDS, not just completion fraction, shape the signal (YouTube's
// weighted-by-watch-time insight): finishing a 45-minute video says far more
// about taste than finishing a 40-second short. Capped at 30 minutes so one
// movie can't dominate; floor of 0.5 keeps shorts as real (weaker) signals.
const clampEngagement = (completed: boolean, pos: number, dur: number | null) => {
  const frac = completed ? 1 : dur && dur > 0 ? Math.min(1, Math.max(0.05, pos / dur)) : 0.3
  const watchSec = completed ? Math.min(dur ?? 600, 1800) : Math.min(pos, 1800)
  const timeFactor = 0.5 + 0.5 * Math.sqrt(watchSec / 1800)
  return frac * timeFactor
}

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
    .limit(600)

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

/** Pick seeds across ERAS of watch history rather than tertiles of a recency-sorted
 *  list (tertiles of a mostly-recent list are still mostly recent). Buckets: this
 *  week, this month, this quarter, and the rest of the year. Every era that has
 *  watches contributes its most-engaged seeds, so months-old interests keep
 *  earning fresh, similar-but-newer suggestions next to yesterday's watches. */
function stratifiedSeeds(ytSignals: InterestSignal[], perEra: number, cap: number): string[] {
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  const weekAgo = now - 7 * day
  const monthAgo = now - 30 * day
  const quarterAgo = now - 90 * day
  const buckets: [InterestSignal[], InterestSignal[], InterestSignal[], InterestSignal[]] = [[], [], [], []]
  for (const s of ytSignals) {
    const idx = s.at >= weekAgo ? 0 : s.at >= monthAgo ? 1 : s.at >= quarterAgo ? 2 : 3
    buckets[idx].push(s)
  }
  const seeds: string[] = []
  // Round-robin across eras (newest era first within each round) so the cap
  // never squeezes out the older buckets.
  const sorted = buckets.map((b) => [...b].sort((a, z) => z.engagement - a.engagement))
  for (let round = 0; round < perEra; round++) {
    for (const bucket of sorted) {
      const s = bucket[round]
      if (s) seeds.push(s.ref.slice('youtube:'.length))
    }
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
  const seeds = stratifiedSeeds(ytSignals, 3, 12)
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

  // The linked account's real YouTube home feed: Google's recommender as a
  // candidate source. Best-effort like everything else; no linked account or an
  // expired token simply contributes nothing.
  const homeFeed: ItVideo[] = await (async () => {
    const token = await getValidAccessToken(userId).catch(() => null)
    if (!token) return []
    const feed = await fetchHomeFeed(token, 50).catch(() => [])
    return feed.map((v) => ({
      videoId: v.videoId, title: v.title, author: v.author, channelId: v.channelId,
      channelThumb: null, thumbnailUrl: null, durationSec: v.durationSec,
      publishedText: null, views: null,
    }))
  })()

  // Seed titles let "why this" name the exact watch that earned the suggestion.
  const seedTitle = new Map(ytSignals.map((s) => [s.ref.slice('youtube:'.length), s.title]))
  const candidates: Candidate[] = [
    ...relatedLists.flatMap((videos, i) => {
      const from = seedTitle.get(seeds[i] ?? '') ?? ''
      return videos.map((v) => itToCandidate(v, 'related', from ? [from] : []))
    }),
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
    ...homeFeed.map((v) => itToCandidate(v, 'yt-home')),
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
/** Near-duplicate suppression: the same trailer reuploaded by two channels (same
 *  runtime within a few seconds, near-identical titles) should serve once, not
 *  twice (real feedback). Earlier entry wins - it ranked higher. */
function dedupeNearDuplicates(items: ItVideo[]): ItVideo[] {
  const normalize = (t: string) =>
    t.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2)
  const kept: ItVideo[] = []
  const keptMeta: Array<{ tokens: Set<string>; dur: number }> = []
  for (const v of items) {
    const tokens = new Set(normalize(v.title ?? ''))
    const dur = v.durationSec ?? -1
    const dupe = keptMeta.some((k) => {
      if (dur < 0 || k.dur < 0 || Math.abs(dur - k.dur) > 3) return false
      if (!tokens.size || !k.tokens.size) return false
      let overlap = 0
      for (const w of tokens) if (k.tokens.has(w)) overlap++
      return overlap / Math.min(tokens.size, k.tokens.size) >= 0.7
    })
    if (dupe) continue
    kept.push(v)
    keptMeta.push({ tokens, dur })
  }
  return kept
}

// ── Serve-time live layer ──────────────────────────────────────────────────────
// The mechanics that make YouTube's home feel alive (studied against real
// feeds, 2026-07-31), none user-specific:
//   1. HOT: the newest watches spawn multi-angle topic clusters (review /
//      explained / behind-the-scenes / reaction + related), so today's watch
//      reshapes today's feed.
//   2. BINGE: >=4 same-creator plays inside 36h graduates into that creator's
//      collections/compilations instead of a 31st single.
//   3. TOPICAL: generic trending only surfaces where it intersects the user's
//      topic/creator profile (the "Comic-Con week" effect).
//   4. COMPOSE: pages are slotted with format-diversity quotas (short/standard/
//      long), a per-creator cap, and evergreen anchor slots — not pure rank
//      order.
// The layer builds in the background (serve never blocks) and is cached per
// user; watched and policy filters always apply.

type Suggested = ItVideo & { why?: string }

interface LiveLayer { hot: Suggested[]; binge: Suggested[]; topical: Suggested[] }

const liveLayers = new Map<string, { key: string; at: number; layer: LiveLayer }>()
const liveBuilding = new Set<string>()
const LIVE_LAYER_TTL_MS = 20 * 60_000

const HOT_ANGLES = ['review', 'explained', 'behind the scenes']
const BINGE_SHAPES = ['best of', 'compilation', 'interview', 'live full']

/** Title → searchable topic: strip brackets/hashtags, keep the leading phrase. */
function titleTopic(title: string): string {
  return title
    .replace(/[[(].*?[\])]/g, ' ')
    .replace(/#\w+/g, ' ')
    .split(/[|•·]/)[0]!
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 6)
    .join(' ')
}

async function recentYtWatches(userId: string, limit: number) {
  return db
    .select({
      videoId: ytWatchState.videoId,
      updatedAt: ytWatchState.updatedAt,
      title: ytVideos.title,
      author: ytVideos.author,
      channelId: ytVideos.channelId,
      relatedTopics: ytVideos.relatedTopics,
    })
    .from(ytWatchState)
    .innerJoin(ytVideos, eq(ytVideos.videoId, ytWatchState.videoId))
    .where(and(eq(ytWatchState.userId, userId), eq(ytWatchState.origin, 'youtube')))
    .orderBy(desc(ytWatchState.updatedAt))
    .limit(limit)
}

async function buildLiveLayer(userId: string): Promise<void> {
  const recent = await recentYtWatches(userId, 40)
  const key = recent.slice(0, 2).map((w) => w.videoId).join(',')
  const watched = await watchedVideoRefs(userId)
  const taken = new Set<string>()
  const usable = (v: ItVideo) => !watched.has(ytRef(v.videoId)) && !taken.has(v.videoId)

  // 1. Hot clusters from the two newest watches.
  const hot: Suggested[] = []
  for (const w of recent.slice(0, 2)) {
    if (!w.title || w.title === w.videoId) continue
    const topic = primaryTopic(w.relatedTopics)[0] ?? titleTopic(w.title)
    if (!topic) continue
    const empty = { videos: [] as ItVideo[], channels: [], playlists: [], continuation: null }
    const [angleHits, related] = await Promise.all([
      Promise.all(HOT_ANGLES.map((angle) =>
        tryInnertube('live-hot', () => innertubeSearch(`${topic} ${angle}`, 6, 0, 8000, 0, SEARCH_FILTERS.videos), empty))),
      tryInnertube('live-hot-related', () => innertubeRelated(w.videoId, 10), [] as ItVideo[]),
    ])
    const pool = [...angleHits.flatMap((s) => s.videos), ...related].filter(usable)
    const seedWhy = `Because you just watched "${w.title.slice(0, 60)}"`
    for (const v of dedupeNearDuplicates(pool)) {
      if (taken.has(v.videoId)) continue
      taken.add(v.videoId)
      hot.push({ ...v, why: seedWhy })
    }
  }

  // 2. Binge graduation: a creator with >=4 plays in the last 36h.
  const binge: Suggested[] = []
  const cutoff = Date.now() - 36 * 60 * 60 * 1000
  const runs = new Map<string, number>()
  for (const w of recent) {
    if (!w.author || w.updatedAt.getTime() < cutoff) continue
    runs.set(w.author, (runs.get(w.author) ?? 0) + 1)
  }
  const [bingedCreator] = [...runs.entries()].filter(([, n]) => n >= 4).sort((a, b) => b[1] - a[1])
  if (bingedCreator) {
    const name = bingedCreator[0]
    const empty = { videos: [] as ItVideo[], channels: [], playlists: [], continuation: null }
    const hits = await Promise.all(BINGE_SHAPES.map((shape) =>
      tryInnertube('live-binge', () => innertubeSearch(`${name} ${shape}`, 5, 0, 8000, 0, SEARCH_FILTERS.videos), empty)))
    // Collections first: long-form before singles.
    const pool = dedupeNearDuplicates(hits.flatMap((s) => s.videos).filter(usable))
      .sort((a, b) => (b.durationSec ?? 0) - (a.durationSec ?? 0))
    for (const v of pool.slice(0, 8)) {
      taken.add(v.videoId)
      binge.push({ ...v, why: `You're on a ${name} run` })
    }
  }

  // 3. Trending ∩ the user's topic/creator profile.
  const topical: Suggested[] = []
  const { profile } = await getProfileStale(userId, DOMAIN)
  if (profile && (profile.topics.length || profile.creators.length)) {
    const trending = await fetchTrending(50)
    const topicWords = profile.topics.map((t) => ({
      words: t.text.toLowerCase().split(/\s+/).filter((w) => w.length > 3),
      text: t.text,
      weight: t.weight,
    }))
    const creators = new Map(profile.creators.map((c) => [c.name.toLowerCase(), c.weight]))
    const scored = trending.filter(usable).map((v) => {
      const title = v.title.toLowerCase()
      let score = 0
      let matched: string | null = null
      for (const t of topicWords) {
        if (t.words.some((w) => title.includes(w))) {
          score += t.weight
          matched ??= t.text
        }
      }
      const creatorWeight = v.author ? creators.get(v.author.toLowerCase()) ?? 0 : 0
      score += creatorWeight * 1.2
      return { v, score, matched }
    }).filter((s) => s.score >= 0.25).sort((a, b) => b.score - a.score)
    for (const s of scored.slice(0, 8)) {
      taken.add(s.v.videoId)
      topical.push({ ...s.v, why: s.matched ? `Trending in ${s.matched}` : 'Trending from a creator you watch' })
    }
  }

  // Policy filters last, then cache.
  const layer: LiveLayer = {
    hot: (await filterYtItemsForUser(userId, hot.slice(0, 24))) as Suggested[],
    binge: (await filterYtItemsForUser(userId, binge)) as Suggested[],
    topical: (await filterYtItemsForUser(userId, topical)) as Suggested[],
  }
  await enrichChannelThumbs([...layer.hot, ...layer.binge, ...layer.topical])
  liveLayers.set(userId, { key, at: Date.now(), layer })
}

/** Cached layer for this serve; kicks a background (re)build when stale or when
 *  the newest watch changed — the next serve gets the reactive cluster. */
function peekLiveLayer(userId: string, newestWatchId: string | null): LiveLayer | null {
  const cached = liveLayers.get(userId)
  const stale = !cached
    || Date.now() - cached.at > LIVE_LAYER_TTL_MS
    || (newestWatchId != null && !cached.key.startsWith(newestWatchId))
  if (stale && !liveBuilding.has(userId)) {
    liveBuilding.add(userId)
    void buildLiveLayer(userId)
      .catch((err) => logger.warn(`[interests/videos] live layer build failed: ${err}`))
      .finally(() => liveBuilding.delete(userId))
  }
  return cached?.layer ?? null
}

// ── Page composition (format quotas + evergreen anchors + creator cap) ─────────

const durClass = (v: ItVideo): 'short' | 'std' | 'long' => {
  const d = v.durationSec ?? 0
  if (d > 1800) return 'long'
  if (d > 0 && d < 360) return 'short'
  return 'std'
}

function viewsNumber(raw: string | null): number {
  if (!raw) return 0
  const m = raw.replace(/,/g, '').match(/([\d.]+)\s*([KMB])?/i)
  if (!m) return 0
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[m[2]?.toUpperCase() as 'K' | 'M' | 'B'] ?? 1
  return parseFloat(m[1]!) * mult
}

/** Old but massive — the proven classics YouTube anchors every page with. */
const isEvergreen = (v: ItVideo): boolean =>
  viewsNumber(v.views) >= 1_000_000 && /([2-9]|\d{2,})\s+years?\s+ago/.test(v.publishedText ?? '')

/** One YouTube-like page block: hot leads, quota slots for short/long/evergreen,
 *  binge and topical each get a look, base (ranked pool) fills the rest. */
const SLOT_PLAN: Array<{ pool: 'hot' | 'binge' | 'topical' | 'base'; pref?: 'short' | 'long' | 'evergreen' }> = [
  { pool: 'hot' }, { pool: 'base' }, { pool: 'base', pref: 'short' }, { pool: 'hot' },
  { pool: 'base', pref: 'long' }, { pool: 'topical' }, { pool: 'base' }, { pool: 'binge' },
  { pool: 'base', pref: 'short' }, { pool: 'hot' }, { pool: 'base', pref: 'evergreen' }, { pool: 'base' },
]

function composeFeed(base: Suggested[], layer: LiveLayer | null, target: number, watched: Set<string>): Suggested[] {
  const pools: Record<'hot' | 'binge' | 'topical' | 'base', Suggested[]> = {
    base: [...base],
    hot: [...(layer?.hot ?? [])],
    binge: [...(layer?.binge ?? [])],
    topical: [...(layer?.topical ?? [])],
  }
  const seen = new Set<string>()
  const perCreator = new Map<string, number>()
  const out: Suggested[] = []

  const prefOk = (v: Suggested, pref?: 'short' | 'long' | 'evergreen') =>
    !pref || (pref === 'evergreen' ? isEvergreen(v) : durClass(v) === pref)
  const takeFrom = (arr: Suggested[], pref?: 'short' | 'long' | 'evergreen'): Suggested | null => {
    const i = arr.findIndex((v) =>
      !seen.has(v.videoId)
      && !watched.has(ytRef(v.videoId))
      && prefOk(v, pref)
      && (perCreator.get((v.author ?? '').toLowerCase()) ?? 0) < 3)
    if (i < 0) return null
    const [v] = arr.splice(i, 1)
    seen.add(v!.videoId)
    const creator = (v!.author ?? '').toLowerCase()
    if (creator) perCreator.set(creator, (perCreator.get(creator) ?? 0) + 1)
    return v!
  }

  let slot = 0
  while (out.length < target) {
    const plan = SLOT_PLAN[slot % SLOT_PLAN.length]!
    const v = takeFrom(pools[plan.pool], plan.pref)
      ?? takeFrom(pools[plan.pool])
      ?? takeFrom(pools.base, plan.pref)
      ?? takeFrom(pools.base)
      ?? takeFrom(pools.hot)
      ?? takeFrom(pools.topical)
      ?? takeFrom(pools.binge)
    if (!v) break
    out.push(v)
    slot++
  }
  return out
}

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
  const kept = dedupeNearDuplicates(
    await filterYtItemsForUser(userId, entries.map((e) => e.payload as ItVideo)))
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
  // Explain every recommendation: each card carries where it came from.
  const explained = served.map((v) => {
    const entry = byRef.get(ytRef(v.videoId))
    return { ...v, why: entry ? whyServed(entry) : undefined }
  })

  // Live layer + page composition: hot clusters from the newest watches, binge
  // collections, topical trending and format quotas over the ranked base.
  const newestWatchId = (await recentYtWatches(userId, 1))[0]?.videoId ?? null
  const layer = peekLiveLayer(userId, newestWatchId)
  return { videos: composeFeed(explained, layer, target, watchedRefs), building: false }
}

// ── Bottomless feed ─────────────────────────────────────────────────────────────
// Web-YouTube's home never runs out: past the ranked pool (~150 candidates),
// the feed keeps going via live related fan-out seeded from its own tail. The
// extension is cached per user so every deeper page APPENDS instead of
// recomputing, and expires so a later session rebuilds from fresh rotation.
const DEEP_MAX = 600
const DEEP_TTL_MS = 30 * 60_000
const deepFeeds = new Map<string, { at: number; videos: ItVideo[] }>()

export async function serveYtRecommendedDeep(
  userId: string,
  target: number,
): Promise<{ videos: ItVideo[]; building: boolean }> {
  const base = await serveYtRecommended(userId, Math.min(target, 120))
  if (base.building || !base.videos.length || base.videos.length >= target) return base

  const cached = deepFeeds.get(userId)
  const ext = cached && Date.now() - cached.at < DEEP_TTL_MS ? cached.videos : []
  if (ext !== cached?.videos) deepFeeds.set(userId, { at: Date.now(), videos: ext })

  const watched = await watchedVideoRefs(userId)
  const seen = new Set([...base.videos.map((v) => v.videoId), ...ext.map((v) => v.videoId)])
  const want = Math.min(target, DEEP_MAX)

  // A few bounded fan-out rounds per request: each deeper page tops the
  // extension up incrementally rather than building the whole tail at once.
  let rounds = 0
  while (base.videos.length + ext.length < want && rounds < 3) {
    rounds++
    const seeds = (ext.length ? ext : base.videos).slice(-5).map((v) => v.videoId)
    if (!seeds.length) break
    const batches = await Promise.all(seeds.map((id) =>
      tryInnertube('deep-related', () => innertubeRelated(id, 20), [] as ItVideo[])))
    const fresh = await filterYtItemsForUser(userId,
      batches.flat().filter((v) => !seen.has(v.videoId) && !watched.has(ytRef(v.videoId))))
    const kept = dedupeNearDuplicates(fresh)
    if (!kept.length) break
    await enrichChannelThumbs(kept)
    for (const v of kept) {
      if (seen.has(v.videoId)) continue
      seen.add(v.videoId)
      ext.push(v)
      if (base.videos.length + ext.length >= want) break
    }
  }
  const tail = ext.map((v) => ({ ...v, why: 'More like the rest of your feed' }))
  return { videos: [...base.videos, ...tail].slice(0, target), building: false }
}

/** Human-readable provenance for a served suggestion (real request: viewers
 *  should be able to hold a card and see why it is there). */
function whyServed(entry: RankedCandidate): string {
  switch (entry.bucket) {
    case 'related':
      return entry.topics[0] ? `Because you watched "${entry.topics[0]}"` : 'Similar to videos you watched'
    case 'topic-search':
      return entry.topics[0] ? `Because you're into ${entry.topics[0]}` : 'Matches your interests'
    case 'creator-latest':
      return entry.creatorName ? `New from ${entry.creatorName}, a channel you keep coming back to` : 'From a creator you watch'
    case 'yt-home':
      return 'Picked for you by YouTube\'s recommendations'
    case 'similar':
      return 'Similar to your favorites'
    case 'trending':
      return 'Trending right now'
  }
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

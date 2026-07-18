// Opportunistic LLM precompute - the generic 'precompute' download-job type.
//
// Every handler here wraps an existing ensure*/get* function that is already
// cached (lookup_cache row, DB column, or table), so precomputing is pure
// warm-up: the user-facing path stays exactly as it was, it just finds the
// cache hot instead of paying a 1-5s model call on first open. Jobs are
// enqueued at OPPORTUNISTIC_PRIORITY, which means the download scheduler only
// dispatches them while the idle gate (lib/idleScheduler) says the system is
// quiet, and they ride the compute lane's per-domain serialization (one
// precompute at a time, never competing with a transcode or a Whisper run).
//
// Adding a kind: write a handler that calls the existing cached function, add
// it to the switch in runPrecomputeJob, and enqueue from the content-landing
// point (feed poller, save hook, nightly warm) with a small per-pass cap.

import { desc, eq, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { feedItems, mediaWatchlist, users } from '@/db/schema'
import { logger } from '@/lib/logger'

export type PrecomputeKind =
  | 'podcast-insights'   // pre-listen summary/takeaways/chapters for a new episode
  | 'yt-summary'         // transcript summary + Smart Description for a subscribed upload
  | 'news-summary'       // article TL;DR persisted onto the feed item
  | 'smart-title'        // caption→title for caption-only sources (TikTok)
  | 'title-extras'       // trivia + reviews digest for a watchlist title

interface BasePayload { kind: PrecomputeKind }
export interface PodcastInsightsPayload extends BasePayload { kind: 'podcast-insights'; episodeId: string }
export interface YtSummaryPayload extends BasePayload { kind: 'yt-summary'; videoId: string; userId: string; firstName: string }
export interface NewsSummaryPayload extends BasePayload { kind: 'news-summary'; itemId: string }
export interface SmartTitlePayload extends BasePayload { kind: 'smart-title'; source: string; id: string; caption: string; author: string | null }
export interface TitleExtrasPayload extends BasePayload { kind: 'title-extras'; title: string; year: string | null; mediaKind: 'movie' | 'show' }
export type PrecomputePayload =
  | PodcastInsightsPayload | YtSummaryPayload | NewsSummaryPayload | SmartTitlePayload | TitleExtrasPayload

/** Enqueue one precompute unit. Key must be stable per unit (it coalesces re-enqueues
 *  across feed polls). No-op while the admin switch is off. Never throws. */
export async function enqueuePrecompute(key: string, label: string, payload: PrecomputePayload): Promise<void> {
  try {
    const { isOpportunisticEnabled } = await import('@/lib/idleScheduler')
    if (!isOpportunisticEnabled()) return
    const { enqueuePrecomputeJob } = await import('@/lib/downloadJobs')
    await enqueuePrecomputeJob(`${payload.kind}:${key}`, label, JSON.stringify(payload))
  } catch (err) {
    logger.warn(`[precompute] enqueue failed for ${payload.kind}:${key}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Job runner (dispatched from downloadJobs.runJob). refId is the JSON payload. */
export async function runPrecomputeJob(refId: string): Promise<void> {
  const p = JSON.parse(refId) as PrecomputePayload
  switch (p.kind) {
    case 'podcast-insights': {
      const { generateEpisodeInsights } = await import('@/lib/podcast/ai')
      await generateEpisodeInsights(p.episodeId)
      return
    }
    case 'yt-summary': {
      const { ensureSummary, ensureSmartDescription } = await import('@/lib/youtube/summarize')
      // Summary first - Smart Description falls back to it when the raw description is
      // all sponsor read. Both are shared caches; the per-user args pick caption language.
      await ensureSummary(p.videoId, p.userId, p.firstName)
      await ensureSmartDescription(p.videoId, p.userId, p.firstName)
      return
    }
    case 'news-summary': {
      const [row] = await db.select().from(feedItems).where(eq(feedItems.id, p.itemId)).limit(1)
      if (!row) return  // pruned before we got to it - nothing to warm
      const { ensureFeedItemSummary } = await import('@/lib/news/summarize')
      await ensureFeedItemSummary(row)
      return
    }
    case 'smart-title': {
      const { ensureSmartTitle } = await import('@/lib/videos/smartTitle')
      await ensureSmartTitle(p.source, p.id, p.caption, p.author)
      return
    }
    case 'title-extras': {
      const { getTrivia } = await import('@/lib/titles/trivia')
      const { getReviews } = await import('@/lib/titles/reviews')
      await getTrivia(p.title, p.year, p.mediaKind)
      await getReviews(p.title, p.year, p.mediaKind)
      return
    }
  }
}

// ── Nightly title warm ──────────────────────────────────────────────────────────

// First visit to a title page pays web search + LLM distillation for trivia and the
// reviews digest (~5-10s cold). Both are 30-day lookup_cache entries, so warming the
// household's watchlist nightly makes those pages open hot. Capped: the watchlist is
// bounded per-family, and re-runs are cache hits inside getTrivia/getReviews anyway.
const TITLE_WARM_CAP = 24
const DAY_MS = 24 * 60 * 60 * 1000

async function titleWarmPass(): Promise<void> {
  const rows = await db.select({
    mediaType: mediaWatchlist.mediaType, title: mediaWatchlist.title, subtitle: mediaWatchlist.subtitle,
  }).from(mediaWatchlist)
    .where(isNull(mediaWatchlist.deletedAt))
    .orderBy(desc(mediaWatchlist.updatedAt))
    .limit(200)
  const seen = new Set<string>()
  let queued = 0
  for (const r of rows) {
    if (queued >= TITLE_WARM_CAP) break
    const key = `${r.mediaType}:${r.title.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    const year = r.subtitle?.match(/\b(19|20)\d{2}\b/)?.[0] ?? null
    await enqueuePrecompute(key, `Warm title extras: ${r.title}`, {
      kind: 'title-extras', title: r.title, year, mediaKind: r.mediaType,
    })
    queued++
  }
  if (queued) logger.info(`[precompute] nightly title warm queued ${queued} title(s)`)
}

let titleWarmStarted = false

/** Boot hook: warm watchlist titles once shortly after start, then daily. */
export function startNightlyTitleWarm(): void {
  if (titleWarmStarted) return
  titleWarmStarted = true
  setTimeout(() => void titleWarmPass().catch(() => {}), 10 * 60_000)
  setInterval(() => void titleWarmPass().catch(() => {}), DAY_MS).unref()
}

// ── Shared helper for feed-landing enqueue points ───────────────────────────────

/** Resolve a user's first name for the per-user args some ensure* helpers take. */
export async function firstNameOf(userId: string): Promise<string> {
  const [u] = await db.select({ firstName: users.firstName }).from(users).where(eq(users.id, userId)).limit(1)
  return u?.firstName ?? 'user'
}

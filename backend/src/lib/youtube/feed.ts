// YouTube RSS feed poller. Every YouTube channel and playlist exposes a public
// Atom/RSS feed — no API key, no login required:
//   Channel:  https://www.youtube.com/feeds/videos.xml?channel_id=UC…
//   Playlist: https://www.youtube.com/feeds/videos.xml?playlist_id=PL…

import { eq, and, isNull, or, like, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { ytSubscriptions, ytVideos, ytChannelCache } from '@/db/schema'
import { logger } from '@/lib/logger'
import { backfillDurations } from '@/lib/youtube/durations'
import { resolveYouTubeInput } from '@/lib/youtube/resolve'

const YT_FEED_BASE = 'https://www.youtube.com/feeds/videos.xml'
const FEED_INTERVAL_MS = 15 * 60 * 1000   // poll every 15 min
const FETCH_TIMEOUT_MS = 10_000

// ── XML helpers ───────────────────────────────────────────────────────────────

function extractTag(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return m ? m[1]!.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : ''
}

function extractAttr(block: string, tag: string, attr: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`, 'i'))
  return m ? m[1]! : ''
}

interface FeedEntry {
  videoId: string
  title: string
  author: string
  channelId: string | null
  thumbnailUrl: string | null
  publishedAt: number | null   // Unix ms
  description: string | null
}

function parseFeed(xml: string, subscriptionId: string): FeedEntry[] {
  const entries: FeedEntry[] = []
  const entryRe = /<entry>([\s\S]*?)<\/entry>/gi
  let m: RegExpExecArray | null
  while ((m = entryRe.exec(xml)) !== null) {
    const block = m[1]!
    const videoId = extractTag(block, 'yt:videoId') || extractAttr(block, 'id', 'videoId')
    if (!videoId) continue

    const rawPub = extractTag(block, 'published')
    const pubMs = rawPub ? Date.parse(rawPub) : null

    const thumbnailUrl = extractAttr(block, 'media:thumbnail', 'url') ||
      (videoId ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` : null)

    entries.push({
      videoId,
      title: extractTag(block, 'title') || extractTag(block, 'media:title'),
      author: extractTag(block, 'name') || extractTag(block, 'author'),
      channelId: extractTag(block, 'yt:channelId') || null,
      thumbnailUrl,
      publishedAt: pubMs && !isNaN(pubMs) ? pubMs : null,
      description: extractTag(block, 'media:description') || extractTag(block, 'summary') || null,
    })
  }
  return entries
}

// ── Channel metadata backfill ───────────────────────────────────────────────

// Re-resolve a subscription's real name + avatar via yt-dlp -J (see resolve.ts).
// Repairs both a missing thumbnail and a title that's still the raw pasted URL —
// older subscriptions were saved that way because the prior resolver came back empty.
async function backfillChannelMeta(sub: typeof ytSubscriptions.$inferSelect): Promise<void> {
  try {
    const ytUrl = sub.kind === 'playlist'
      ? `https://www.youtube.com/playlist?list=${sub.externalId}`
      : `https://www.youtube.com/channel/${sub.externalId}`

    const resolved = await resolveYouTubeInput(ytUrl)

    const patch: Partial<typeof ytSubscriptions.$inferSelect> = {}
    if (resolved.thumbnailUrl && !sub.thumbnailUrl) patch.thumbnailUrl = resolved.thumbnailUrl
    // Replace a URL-as-title (or empty) with the real channel name.
    const titleLooksRaw = !sub.title || /^https?:\/\//i.test(sub.title) || sub.title === sub.externalId
    if (titleLooksRaw && resolved.title && !/^https?:\/\//i.test(resolved.title)) patch.title = resolved.title
    if (!sub.handle && resolved.handle) patch.handle = resolved.handle
    if (!sub.description && resolved.description) patch.description = resolved.description

    if (!Object.keys(patch).length) return
    await db.update(ytSubscriptions).set(patch).where(eq(ytSubscriptions.id, sub.id))
    logger.info(`[youtube] backfilled metadata for "${patch.title ?? sub.title}"`)
  } catch (err) {
    logger.warn(`[youtube] metadata backfill failed for "${sub.title}": ${err}`)
  }
}

// ── Fetch + upsert ────────────────────────────────────────────────────────────

async function fetchAndUpsertFeed(sub: typeof ytSubscriptions.$inferSelect): Promise<number> {
  const feedParam = sub.kind === 'playlist'
    ? `playlist_id=${sub.externalId}`
    : `channel_id=${sub.externalId}`
  const url = `${YT_FEED_BASE}?${feedParam}`

  const res = await fetch(url, {
    headers: { 'User-Agent': 'LokiDoki/1.0', Accept: 'application/rss+xml, application/atom+xml, text/xml' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`RSS ${res.status} for ${url}`)

  const xml = await res.text()
  const entries = parseFeed(xml, sub.id)
  if (!entries.length) return 0

  const now = new Date()
  // Which of this feed's videos do we already have? One IN query instead of one SELECT
  // per entry (a feed is ~15 entries; this turns ~30 round-trips into 2).
  const feedIds = entries.map(e => e.videoId)
  const known = await db.select({ videoId: ytVideos.videoId }).from(ytVideos)
    .where(inArray(ytVideos.videoId, feedIds))
  const knownSet = new Set(known.map(r => r.videoId))
  const fresh = entries.filter(e => !knownSet.has(e.videoId))

  if (fresh.length) {
    await db.insert(ytVideos).values(fresh.map(e => ({
      id: crypto.randomUUID(),
      videoId: e.videoId,
      subscriptionId: sub.id,
      title: e.title,
      author: e.author || sub.title,
      channelId: e.channelId,
      thumbnailUrl: e.thumbnailUrl,
      publishedAt: e.publishedAt ?? null,
      durationSec: null,
      description: e.description,
      summary: null,
      createdAt: now,
    }))).onConflictDoNothing()
  }
  const inserted = fresh.length
  const newIds = fresh.map(e => e.videoId)

  // Claim any rows that already existed with a null subscriptionId — these were inserted
  // by non-poller paths (watch history, search) before we polled, and would otherwise be
  // invisible in the subscription feed (which keys off subscriptionId). onConflictDoNothing
  // above never repairs them because they're filtered out of `fresh`, so do it explicitly.
  if (feedIds.length) {
    await db.update(ytVideos).set({ subscriptionId: sub.id })
      .where(and(inArray(ytVideos.videoId, feedIds), isNull(ytVideos.subscriptionId)))
  }

  await db.update(ytSubscriptions)
    .set({ lastFetchedAt: now })
    .where(eq(ytSubscriptions.id, sub.id))

  // New uploads landed → invalidate this channel's cached page so the next channel
  // view re-fetches (surfacing the new videos and dropping any since-removed ones,
  // since the channel cache stores a full-replace snapshot, not an append).
  if (inserted > 0 && sub.kind === 'channel') {
    try { await db.delete(ytChannelCache).where(eq(ytChannelCache.channelId, sub.externalId)) }
    catch { /* cache bust is best-effort — never fail a feed refresh over it */ }
  }

  // Backfill durations for the new videos in the background so Shorts are
  // pre-split before the user opens the app (best-effort, non-blocking).
  if (newIds.length) void backfillDurations(newIds).catch(() => {})

  // Fetch channel name/avatar/description the first time we see this subscription (or repair it).
  if (!sub.thumbnailUrl || !sub.description || /^https?:\/\//i.test(sub.title)) void backfillChannelMeta(sub).catch(() => {})

  return inserted
}

// ── Public API ────────────────────────────────────────────────────────────────

// Cap how many feeds we fetch at once. Unbounded Promise.allSettled over every
// subscription fired N simultaneous requests at YouTube (thundering herd) and N
// concurrent DB upserts; process in small batches instead.
const FEED_CONCURRENCY = 3

async function fetchFeedsBounded(subs: (typeof ytSubscriptions.$inferSelect)[]): Promise<void> {
  for (let i = 0; i < subs.length; i += FEED_CONCURRENCY) {
    const batch = subs.slice(i, i + FEED_CONCURRENCY)
    await Promise.allSettled(batch.map(async (sub) => {
      try {
        const n = await fetchAndUpsertFeed(sub)
        if (n > 0) logger.info(`[youtube] fetched ${n} new videos for "${sub.title}"`)
      } catch (err) {
        logger.warn(`[youtube] feed error for "${sub.title}": ${err}`)
      }
    }))
  }
}

/** Refresh feeds for a specific user's subscriptions. */
export async function refreshUserFeeds(userId: string): Promise<void> {
  const subs = await db.select().from(ytSubscriptions)
    .where(eq(ytSubscriptions.userId, userId))
  await fetchFeedsBounded(subs)
}

/** Refresh feeds for a single subscription by id. */
export async function refreshSubscriptionFeed(subId: string): Promise<number> {
  const [sub] = await db.select().from(ytSubscriptions).where(eq(ytSubscriptions.id, subId)).limit(1)
  if (!sub) return 0
  return fetchAndUpsertFeed(sub)
}

/** One-shot: repair name + avatar for subscriptions missing a thumbnail or still
 *  showing a raw URL as their title. */
export async function backfillAllThumbnails(): Promise<void> {
  const subs = await db.select().from(ytSubscriptions)
    .where(or(isNull(ytSubscriptions.thumbnailUrl), isNull(ytSubscriptions.description), like(ytSubscriptions.title, 'http%')))
  // Serial to avoid hammering yt-dlp
  for (const sub of subs) {
    await backfillChannelMeta(sub)
  }
}

// ── Background poll ───────────────────────────────────────────────────────────

let _pollTimer: ReturnType<typeof setInterval> | null = null
// Guards against the poller overlapping itself: a slow run (lots of stale feeds, slow
// network) can outlast the interval, and a second tick firing on top of the first would
// double the load and re-fetch feeds already in flight.
let _polling = false

export function startYoutubeFeedPoller(): void {
  if (_pollTimer) return
  _pollTimer = setInterval(async () => {
    if (_polling) return
    _polling = true
    try {
      // Refresh all subscriptions that haven't been fetched in the last interval
      const subs = await db.select().from(ytSubscriptions)
      const stale = subs.filter(s => {
        if (!s.lastFetchedAt) return true
        return Date.now() - s.lastFetchedAt.getTime() > FEED_INTERVAL_MS
      })
      await fetchFeedsBounded(stale)
    } catch (err) {
      logger.warn(`[youtube] poller error: ${err}`)
    } finally {
      _polling = false
    }
  }, FEED_INTERVAL_MS)
}

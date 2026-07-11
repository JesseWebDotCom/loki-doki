// Follows poller for non-YouTube sources: refreshes video_items for every followed
// creator on a 15-minute cadence (same rhythm as lib/youtube/feed.ts) and runs the
// cross-source auto-save automation (download new uploads, prune to keep-N — mirrors
// lib/youtube/automation.ts's rolling window, auto rows only).

import { and, asc, desc, eq, lt, isNull, or } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { db } from '@/db'
import { videoFollows, videoItems, videoSaves } from '@/db/schema'
import { getProvider } from '@/lib/videos/registry'
import { enqueueVideoMedia } from '@/lib/downloadJobs'
import { effectiveSaveHeight } from '@/lib/videos/quality'
import { getAutoSaveKeepDefault } from '@/lib/youtube/automation'
import { runOfflineWatchedSweep } from '@/lib/videos/offlineSweep'
import { logger } from '@/lib/logger'

const POLL_INTERVAL_MS = 15 * 60_000
const STALE_MS = 14 * 60_000

async function pollFollow(follow: typeof videoFollows.$inferSelect): Promise<void> {
  const provider = getProvider(follow.source)
  if (!provider?.fetchCreatorFeed) return

  // Refresh the creator name/avatar on every poll (not just when missing): this is the
  // authoritative per-creator identity every followed-uploads card reads via a join, so it
  // must self-heal as provider name resolution improves (e.g. TikTok's real display name
  // landing after a handle-only follow) rather than staying stuck at whatever was captured
  // at follow time. getCreator is cached at the provider layer, so this is cheap once warm.
  if (provider.getCreator) {
    const creator = await provider.getCreator(follow.externalId).then((r) => r.creator).catch(() => null)
    if (creator && (creator.name !== follow.title || creator.avatarUrl !== follow.thumbnailUrl)) {
      await db.update(videoFollows)
        .set({ thumbnailUrl: creator.avatarUrl ?? follow.thumbnailUrl, title: creator.name || follow.title, handle: creator.handle ?? follow.handle })
        .where(eq(videoFollows.id, follow.id))
    }
  }

  // What we already have, so quota-aware providers can skip fetching unchanged feeds.
  const known = await db.select({ externalId: videoItems.externalId }).from(videoItems)
    .where(eq(videoItems.followId, follow.id))
    .orderBy(desc(videoItems.createdAt)).limit(200)
  const items = await provider.fetchCreatorFeed(follow.externalId, new Set(known.map((k) => k.externalId)))
  const now = new Date()
  const fresh: string[] = []
  for (const it of items) {
    const inserted = await db.insert(videoItems).values({
      id: randomUUID(), source: follow.source, externalId: it.id, followId: follow.id,
      title: it.title, creatorId: it.creator?.id ?? null, creatorName: it.creator?.name ?? null,
      url: it.url, thumbnailUrl: it.thumbnailUrl ?? null, durationSec: it.durationSec ?? null,
      viewsText: it.viewsText ?? null,
      publishedAt: it.publishedAt ? new Date(it.publishedAt) : null,
      isAdult: !!it.isAdult, metaJson: it.meta ? JSON.stringify(it.meta) : null, createdAt: now,
    }).onConflictDoNothing().returning({ id: videoItems.id })
    if (inserted.length > 0) fresh.push(it.id)
  }
  await db.update(videoFollows).set({ lastFetchedAt: now }).where(eq(videoFollows.id, follow.id))

  // Auto-save: enqueue downloads for genuinely new uploads, then prune the rolling window.
  if (!follow.autoSave || fresh.length === 0) return
  const kind = follow.autoSaveKind
  // Per-source quality tiers apply to auto-saves the same as manual ones (audio → null).
  const maxHeight = kind === 'video' ? await effectiveSaveHeight(follow.userId, follow.source) : null
  for (const videoId of fresh) {
    const item = items.find((i) => i.id === videoId)
    if (!item || item.isAdult) continue   // auto-save never pulls adult-flagged content
    await db.insert(videoSaves).values({
      id: randomUUID(), userId: follow.userId, source: follow.source, videoId, title: item.title,
      kind, status: 'pending', assetId: null, sizeBytes: null, maxHeight,
      thumbnailUrl: item.thumbnailUrl ?? null, creatorName: item.creator?.name ?? null,
      durationSec: item.durationSec ?? null, sourceUrl: item.url, auto: true,
      isAdult: false, error: null, createdAt: now, updatedAt: now,
    }).onConflictDoNothing()
    await enqueueVideoMedia({ source: follow.source, videoId, kind, maxHeight }, `${follow.title}: ${item.title}`)
  }

  // keepN semantics: null → global default (shared with YouTube's admin knob), 0 → unlimited.
  const keep = follow.autoSaveKeep ?? await getAutoSaveKeepDefault()
  if (keep <= 0) return
  // Match auto rows to this follow via video_items.follow_id, NOT creatorName — the poller
  // self-heals follow.title above, which would orphan every save made under the old name.
  // Order by real upload date (save time as tiebreak) so the window mirrors youtube's
  // pruneAutoSaves rather than tracking download order.
  const autoRows = await db.select({ id: videoSaves.id, videoId: videoSaves.videoId, publishedAt: videoItems.publishedAt, createdAt: videoSaves.createdAt })
    .from(videoSaves)
    .innerJoin(videoItems, and(eq(videoItems.source, videoSaves.source), eq(videoItems.externalId, videoSaves.videoId)))
    .where(and(
      eq(videoSaves.userId, follow.userId), eq(videoSaves.source, follow.source),
      eq(videoItems.followId, follow.id), eq(videoSaves.auto, true), eq(videoSaves.kind, kind),
    ))
  autoRows.sort((a, b) =>
    (Number(b.publishedAt ?? 0) - Number(a.publishedAt ?? 0)) ||
    (b.createdAt.getTime() - a.createdAt.getTime()))
  const excess = autoRows.slice(keep)
  if (excess.length > 0) {
    const { enqueuePlexSync } = await import('@/lib/downloadJobs')
    for (const row of excess) {
      await db.delete(videoSaves).where(eq(videoSaves.id, row.id))
      // Keep the user's Plex tree in step with the prune (no-op if never placed).
      if (kind === 'video') void enqueuePlexSync(follow.userId, row.videoId, 'remove', follow.source).catch(() => {})
    }
    // Orphaned assets/blobs are reclaimed by the content store's GC sweep.
  }
}

async function pollOnce(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_MS)
  const due = await db.select().from(videoFollows)
    .where(or(isNull(videoFollows.lastFetchedAt), lt(videoFollows.lastFetchedAt, cutoff)))
    .orderBy(asc(videoFollows.lastFetchedAt))
    .limit(20)
  for (const follow of due) {
    try {
      await pollFollow(follow)
    } catch (err) {
      logger.warn(`[videos-feed] poll failed for ${follow.source}:${follow.externalId}: ${err}`)
      // Stamp lastFetchedAt even on failure. Otherwise a permanently-broken follow (deleted/
      // renamed creator, provider breakage) keeps its stale timestamp, sorts to the head of the
      // asc(lastFetchedAt) due-list every tick, and starves healthy follows out of the limit(20).
      await db.update(videoFollows).set({ lastFetchedAt: new Date() }).where(eq(videoFollows.id, follow.id)).catch(() => {})
    }
  }
  // Follow/subscription-level remove-once-watched rides the same tick (covers YouTube too).
  await runOfflineWatchedSweep().catch((err) => logger.warn(`[videos-feed] offline watched sweep failed: ${err}`))
}

const MAX_WARM_CREATORS = 30   // bound background yt-dlp load per source per tick

/** Keep every zero-setup browse feed — and the creator profiles they (or a follow) link
 *  to — warm, so the hub home, browse category chips, and creator-profile clicks never
 *  wait on a cold yt-dlp extraction. Runs on the poller cadence; each provider's own
 *  cachedLookup TTLs (set longer than POLL_INTERVAL_MS) make repeat warms nearly free.
 *  Every feed and every creator warms in parallel — the shared yt-dlp concurrency slot
 *  (lib/ytdlp.ts) bounds actual subprocess fan-out, so this doesn't need its own limiter. */
async function warmBrowseCaches(): Promise<void> {
  for (const source of ['tiktok', 'vimeo'] as const) {
    const provider = getProvider(source)
    if (!provider?.browse) continue
    const creatorIds = new Set<string>()

    // Every category chip a user can click, not just the default feed.
    const feeds: Array<string | undefined> = provider.browseFeeds?.length
      ? provider.browseFeeds.map((f) => f.id) : [undefined]
    const pages = await Promise.all(feeds.map(async (feed) => {
      try {
        return await provider.browse!({ feed, userId: '__warm__', allowAdult: false, warm: true })
      } catch (err) {
        logger.warn(`[videos-feed] browse warm failed for ${source}${feed ? `:${feed}` : ''}: ${err}`)
        return null
      }
    }))
    for (const page of pages) for (const it of page?.items ?? []) if (it.creator?.id) creatorIds.add(it.creator.id)

    // Creator-profile pages are a separate cache from browse's own — warm those too
    // (browsed creators + anyone any user follows) so opening one is never a cold hit.
    if (!provider.getCreator) continue
    const follows = await db.select({ externalId: videoFollows.externalId }).from(videoFollows)
      .where(eq(videoFollows.source, source))
    for (const f of follows) creatorIds.add(f.externalId)

    const ids = [...creatorIds]
    if (ids.length > MAX_WARM_CREATORS) logger.warn(`[videos-feed] ${source}: warming ${MAX_WARM_CREATORS}/${ids.length} creator profiles this tick`)
    await Promise.all(ids.slice(0, MAX_WARM_CREATORS).map(async (id) => {
      try { await provider.getCreator!(id, null, { warm: true }) } catch (err) {
        logger.warn(`[videos-feed] creator warm failed for ${source}:${id}: ${err}`)
      }
    }))
  }
}

let timer: ReturnType<typeof setInterval> | null = null

/** Start the follows poller (call once at boot; hot-reload safe). */
export function startVideosFeedPoller(): void {
  if (timer) return
  timer = setInterval(() => { void pollOnce(); void warmBrowseCaches() }, POLL_INTERVAL_MS)
  timer.unref?.()
  // First warm pass soon after boot so the cache-only browse surfaces have content quickly
  // (they serve empty until the first warm lands). Kept a few seconds back so it doesn't
  // pile onto the boot burst.
  setTimeout(() => { void pollOnce(); void warmBrowseCaches() }, 5_000).unref?.()
}

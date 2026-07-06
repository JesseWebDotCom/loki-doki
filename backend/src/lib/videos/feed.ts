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
import { logger } from '@/lib/logger'

const POLL_INTERVAL_MS = 15 * 60_000
const STALE_MS = 14 * 60_000
const DEFAULT_KEEP = 10

async function pollFollow(follow: typeof videoFollows.$inferSelect): Promise<void> {
  const provider = getProvider(follow.source)
  if (!provider?.fetchCreatorFeed) return

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
      publishedAt: it.publishedAt ? new Date(it.publishedAt) : null,
      isAdult: !!it.isAdult, metaJson: it.meta ? JSON.stringify(it.meta) : null, createdAt: now,
    }).onConflictDoNothing().returning({ id: videoItems.id })
    if (inserted.length > 0) fresh.push(it.id)
  }
  await db.update(videoFollows).set({ lastFetchedAt: now }).where(eq(videoFollows.id, follow.id))

  // Auto-save: enqueue downloads for genuinely new uploads, then prune the rolling window.
  if (!follow.autoSave || fresh.length === 0) return
  const kind = follow.autoSaveKind
  for (const videoId of fresh) {
    const item = items.find((i) => i.id === videoId)
    if (!item || item.isAdult) continue   // auto-save never pulls adult-flagged content
    await db.insert(videoSaves).values({
      id: randomUUID(), userId: follow.userId, source: follow.source, videoId, title: item.title,
      kind, status: 'pending', assetId: null, sizeBytes: null, maxHeight: null,
      thumbnailUrl: item.thumbnailUrl ?? null, creatorName: item.creator?.name ?? null,
      durationSec: item.durationSec ?? null, sourceUrl: item.url, auto: true,
      isAdult: false, error: null, createdAt: now, updatedAt: now,
    }).onConflictDoNothing()
    await enqueueVideoMedia({ source: follow.source, videoId, kind }, `${follow.title}: ${item.title}`)
  }

  const keep = follow.autoSaveKeep ?? DEFAULT_KEEP
  const autoRows = await db.select({ id: videoSaves.id }).from(videoSaves)
    .where(and(
      eq(videoSaves.userId, follow.userId), eq(videoSaves.source, follow.source),
      eq(videoSaves.creatorName, follow.title), eq(videoSaves.auto, true), eq(videoSaves.kind, kind),
    ))
    .orderBy(desc(videoSaves.createdAt))
  const excess = autoRows.slice(keep)
  if (excess.length > 0) {
    for (const row of excess) await db.delete(videoSaves).where(eq(videoSaves.id, row.id))
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
    }
  }
}

/** Keep the zero-setup browse feeds warm so the hub home never waits on a cold yt-dlp
 *  profile extraction. Runs on the poller cadence; each provider's own cachedLookup
 *  TTLs make repeat warms nearly free. */
async function warmBrowseCaches(): Promise<void> {
  for (const source of ['tiktok', 'vimeo'] as const) {
    const provider = getProvider(source)
    if (!provider?.browse) continue
    try {
      await provider.browse({ userId: '__warm__', allowAdult: false })
    } catch (err) {
      logger.warn(`[videos-feed] browse warm failed for ${source}: ${err}`)
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null

/** Start the follows poller (call once at boot; hot-reload safe). */
export function startVideosFeedPoller(): void {
  if (timer) return
  timer = setInterval(() => { void pollOnce(); void warmBrowseCaches() }, POLL_INTERVAL_MS)
  timer.unref?.()
  setTimeout(() => { void pollOnce(); void warmBrowseCaches() }, 45_000).unref?.()   // first pass shortly after boot
}

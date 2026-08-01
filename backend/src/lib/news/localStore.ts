// Persistence for the Local news blend. The blend (Patch + Daily Voice + Bing News) is
// fetched live and each source only surfaces its current front page, so without a store
// the Local tab covers roughly one day. This module gives the blend real history: a
// hidden marker feed row in the built-in 'local' folder that ONLY this code writes
// (the poller skips any feed whose url starts with 'system:'), upserted from every live
// blend fetch and pruned to KEEP_LOCAL_ITEMS newest-first.
//
// Follows the seed.ts patterns for lazy row creation and the poller's upsert/prune shape.

import { and, desc, eq, gte, inArray, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { feeds, feedItems, feedFolders } from '@/db/schema'
import type { BriefingItem } from '@/lib/briefing/types'

// Marker url: never fetchable, recognized by the poller guard so it is never polled.
export const LOCAL_BLEND_URL = 'system:local-blend'

// Local accumulates longer than regular feeds (poller keeps 200/feed) because each blend
// fetch contributes only a handful of new items per day.
const KEEP_LOCAL_ITEMS = 500
const HISTORY_DAYS = 14

let cachedFeedId: string | null = null

/** Find or lazily create the hidden Local history feed. Returns null before the built-in
 *  'local' category has been seeded (fresh boot) - callers just skip persistence then. */
async function ensureLocalBlendFeed(): Promise<string | null> {
  if (cachedFeedId) return cachedFeedId
  // NULL userId is "distinct" in the unique index, so guard the insert explicitly (seed.ts).
  const existing = await db.select({ id: feeds.id }).from(feeds)
    .where(and(isNull(feeds.userId), eq(feeds.url, LOCAL_BLEND_URL))).then((r) => r[0])
  if (existing) {
    cachedFeedId = existing.id
    return existing.id
  }
  const folder = await db.select({ id: feedFolders.id }).from(feedFolders)
    .where(eq(feedFolders.slug, 'local')).then((r) => r[0])
  if (!folder) return null
  const id = crypto.randomUUID()
  await db.insert(feeds).values({
    id,
    userId: null,
    kind: 'rss',
    url: LOCAL_BLEND_URL,
    query: null,
    title: 'Local (blend history)',
    faviconUrl: null,
    siteUrl: null,
    folderId: folder.id,
    isSystem: true,
    sortOrder: 0,
    notify: false,
    etag: null,
    lastModified: null,
    lastFetchedAt: null,
    lastError: null,
    pollIntervalSec: null, // never polled anyway (poller guard on the url marker)
    addedAt: new Date(),
  })
  cachedFeedId = id
  return id
}

// Dedup key per item: url when present, else the normalized title.
function guidFor(it: BriefingItem): string {
  return it.url ?? `title:${it.title.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120)}`
}

/** Upsert live blend items into the history feed (dedupe by guid, back-fill images),
 *  then prune to KEEP_LOCAL_ITEMS newest-first. Never throws. */
export async function persistLocalItems(items: BriefingItem[]): Promise<void> {
  try {
    const feedId = await ensureLocalBlendFeed()
    if (!feedId || !items.length) return

    // Last-write-wins map so a duplicated guid inside one batch can't violate the unique index.
    const byGuid = new Map(items.filter((it) => it.title).map((it) => [guidFor(it), it]))
    const guids = [...byGuid.keys()]
    const known = await db.select({ guid: feedItems.guid, id: feedItems.id, imageUrl: feedItems.imageUrl })
      .from(feedItems).where(and(eq(feedItems.feedId, feedId), inArray(feedItems.guid, guids)))
    const knownMap = new Map(known.map((r) => [r.guid, r]))

    // Back-fill imageUrl for rows stored before their source produced an image.
    for (const [guid, it] of byGuid) {
      const row = knownMap.get(guid)
      if (row && !row.imageUrl && it.imageUrl) {
        await db.update(feedItems).set({ imageUrl: it.imageUrl })
          .where(and(eq(feedItems.id, row.id), isNull(feedItems.imageUrl)))
      }
    }

    const now = new Date()
    const fresh = [...byGuid.entries()].filter(([guid]) => !knownMap.has(guid))
    if (fresh.length) {
      await db.insert(feedItems).values(fresh.map(([guid, it]) => ({
        id: crypto.randomUUID(),
        feedId,
        guid,
        title: it.title,
        url: it.url ?? null,
        // No dedicated per-item source column exists; `author` is unused for these rows,
        // so the source label ("Milford Patch", "Daily Voice") rides there.
        author: it.detail ?? null,
        summary: it.summary ?? null,
        contentHtml: null,
        imageUrl: it.imageUrl ?? null,
        publishedAt: it.publishedAt ?? null,
        fetchedAt: now,
      }))).onConflictDoNothing()
    }

    // Prune (poller's approach, higher local cap - KEEP_PER_FEED stays 200 for real feeds).
    const rows = await db.select({ id: feedItems.id }).from(feedItems)
      .where(eq(feedItems.feedId, feedId))
      .orderBy(desc(feedItems.publishedAt), desc(feedItems.fetchedAt))
    if (rows.length > KEEP_LOCAL_ITEMS) {
      const overflow = rows.slice(KEEP_LOCAL_ITEMS).map((r) => r.id)
      for (let i = 0; i < overflow.length; i += 400) {
        await db.delete(feedItems).where(inArray(feedItems.id, overflow.slice(i, i + 400)))
      }
    }

    // Mark the feed fresh so the poller's staleness filter leaves it alone (belt and
    // suspenders on top of the url-marker guard).
    await db.update(feeds).set({ lastFetchedAt: now, lastError: null }).where(eq(feeds.id, feedId))
  } catch {
    // Persistence is best-effort: a store failure must never break serving live items.
  }
}

/** Stored history for the Local tab: the last HISTORY_DAYS of rows, newest first
 *  (publishedAt desc, nulls last per SQLite; fetchedAt breaks ties). */
export async function recentLocalItems(): Promise<(typeof feedItems.$inferSelect)[]> {
  try {
    const feedId = await ensureLocalBlendFeed()
    if (!feedId) return []
    const cutoff = new Date(Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000)
    return await db.select().from(feedItems)
      .where(and(eq(feedItems.feedId, feedId), gte(feedItems.fetchedAt, cutoff)))
      .orderBy(desc(feedItems.publishedAt), desc(feedItems.fetchedAt))
  } catch {
    return []
  }
}

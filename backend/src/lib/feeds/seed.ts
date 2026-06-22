// Seed the curated News sources as non-removable system feeds (userId=null, isSystem=1).
// Single source of truth for the URLs is WORLD_FEEDS in briefing/sources/rss.ts.

import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { feeds } from '@/db/schema'
import { WORLD_FEEDS } from '@/lib/briefing/sources/rss'
import { logger } from '@/lib/logger'

export async function seedSystemFeeds(): Promise<void> {
  const now = new Date()
  let added = 0
  for (let i = 0; i < WORLD_FEEDS.length; i++) {
    const f = WORLD_FEEDS[i]!
    // NULL userId is "distinct" in the unique index, so guard the seed explicitly.
    const existing = await db.select({ id: feeds.id }).from(feeds)
      .where(and(isNull(feeds.userId), eq(feeds.url, f.url))).then((r) => r[0])
    if (existing) continue
    await db.insert(feeds).values({
      id: crypto.randomUUID(),
      userId: null,
      kind: 'rss',
      url: f.url,
      query: null,
      title: f.source,
      faviconUrl: null,
      siteUrl: null,
      folderId: null,
      isSystem: true,
      sortOrder: i,
      notify: false,
      etag: null,
      lastModified: null,
      lastFetchedAt: null,
      lastError: null,
      pollIntervalSec: 900, // system feeds poll ~15 min
      addedAt: now,
    })
    added++
  }
  if (added) logger.info(`[feeds] seeded ${added} system feeds`)
}

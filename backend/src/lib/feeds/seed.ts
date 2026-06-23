// Seed the curated News sources as non-removable system feeds (userId=null, isSystem=1)
// and the built-in News categories (Global/Local). Single source of truth for the URLs is
// WORLD_FEEDS in briefing/sources/rss.ts.
//
// Categories are feed_folders rows. Built-ins are shared (userId=null), slugged, and locked:
//   - 'global' holds the curated WORLD_FEEDS.
//   - 'local'  has no feeds — its items come from the town-aware Patch source at request time.

import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { feeds, feedFolders } from '@/db/schema'
import { WORLD_FEEDS } from '@/lib/briefing/sources/rss'
import { logger } from '@/lib/logger'

// Upsert a shared, locked built-in category by slug; returns its folder id.
async function ensureBuiltinCategory(slug: 'global' | 'local', name: string, sortOrder: number): Promise<string> {
  const existing = await db.select({ id: feedFolders.id }).from(feedFolders)
    .where(eq(feedFolders.slug, slug)).then((r) => r[0])
  if (existing) return existing.id
  const id = crypto.randomUUID()
  await db.insert(feedFolders).values({
    id, userId: null, name, slug, locked: true, sortOrder, createdAt: new Date(),
  })
  logger.info(`[feeds] seeded built-in category "${name}"`)
  return id
}

export async function seedSystemFeeds(): Promise<void> {
  const now = new Date()

  // Built-in categories first so system feeds can be filed under Global.
  const globalId = await ensureBuiltinCategory('global', 'Global', 0)
  await ensureBuiltinCategory('local', 'Local', 1)

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
      folderId: globalId,
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

  // Back-fill existing installs: file any unfiled system feeds under Global.
  await db.update(feeds).set({ folderId: globalId })
    .where(and(isNull(feeds.userId), eq(feeds.isSystem, true), isNull(feeds.folderId)))
}

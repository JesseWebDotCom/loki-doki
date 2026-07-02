// Shared bookmark creation: the insert + archive/thumbnail enqueue core of
// POST /api/bookmarks, callable without an HTTP context — used by the route, the
// Telegram bridge ("send the bot a link"), and the companion save_bookmark tool.
// Tag/collection-name resolution stays with the route (HTTP-only concerns).

import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { bookmarks } from '@/db/schema'
import { enqueueArchiveArticle, enqueueBookmarkThumbnail } from '@/lib/downloadJobs'

export interface CreateBookmarkOpts {
  /** Owner; pass null only for admin-created global bookmarks. */
  ownerId: string | null
  url: string
  title?: string
  type?: 'live' | 'offline'
  faviconUrl?: string | null
  collectionId?: string | null
  category?: string
  useProxy?: boolean
  useEmbed?: boolean
  captureMedia?: boolean
}

export async function createBookmark(opts: CreateBookmarkOpts): Promise<typeof bookmarks.$inferSelect> {
  const type = opts.type === 'offline' ? 'offline' : 'live'
  const url = opts.url.trim()
  const title = opts.title?.trim() || url
  const now = new Date()
  const id = crypto.randomUUID()

  await db.insert(bookmarks).values({
    id, ownerId: opts.ownerId, source: type === 'offline' ? 'article' : 'bookmark', sourceRef: null, type,
    url, title,
    byline: null, siteName: null, faviconUrl: opts.faviconUrl ?? null, excerpt: null,
    contentHtml: null, contentText: null, wordCount: 0, readingMins: 0,
    status: 'unread', archiveState: type === 'offline' ? 'pending' : 'none', archiveError: null, readAt: null,
    useProxy: opts.useProxy ?? false, useEmbed: opts.useEmbed ?? false,
    category: opts.category?.trim() || 'Other', collectionId: opts.collectionId ?? null, sortOrder: 0,
    screenshotPath: null, snapshotPath: null, ogImagePath: null,
    pdfPath: null, mediaPath: null, captureMedia: opts.captureMedia ?? false, archiveOrgUrl: null,
    isAdult: false,
    createdAt: now, updatedAt: now,
  })

  // Offline → full archive (server-renders + screenshots); live → screenshot thumbnail only.
  if (type === 'offline') await enqueueArchiveArticle(id, title)
  else await enqueueBookmarkThumbnail(id, title)

  const row = await db.select().from(bookmarks).where(eq(bookmarks.id, id)).then((r) => r[0])
  return row!
}

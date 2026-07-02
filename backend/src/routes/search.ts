import { Hono } from 'hono'
import { and, desc, eq, isNull, like, or, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  bookmarks, bookmarkHighlights, characters, homeDevices,
  ytDownloads, ytCollections, ytVideos, ytSubscriptions,
  feedItems, feeds, podcastEpisodes, podcastShows,
} from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import type { AppEnv } from '@/types'

const searchRouter = new Hono<AppEnv>()

// ── Unified global search ────────────────────────────────────────────────────────
//
// One endpoint that fans out across the user's actual *content* (saved articles, links,
// companions, home inventory, saved YouTube videos) so Spotlight can surface more than just
// app names + ZIM libraries. Each provider is independent and best-effort: a provider that
// throws contributes no hits rather than failing the whole search. Static app entries and ZIM
// libraries stay client-side in SpotlightSearch — this covers everything that lives in the DB.

export interface SearchHit {
  type: 'bookmark' | 'news' | 'companion' | 'device' | 'youtube' | 'podcast'
  id: string
  title: string
  subtitle: string | null
  /** Image URL for the row icon, or null to fall back to a per-type glyph. */
  icon: string | null
  /** In-app route to navigate to on select. */
  route: string
  /** Display group heading. */
  group: string
}

const PER_PROVIDER = 6

// Build an FTS5 MATCH expression (mirrors reader.ts): keep tokens ≥2 chars, prefix the last
// token so partial words match as you type. Empty → no usable query.
function buildMatch(q: string): string {
  const tokens = q.toLowerCase().replace(/["*()^:]/g, ' ').split(/\s+/).filter((t) => t.length >= 2)
  if (!tokens.length) return ''
  return tokens.map((t, i) => (i === tokens.length - 1 ? `${t}*` : t)).join(' ')
}

// Escape LIKE wildcards in user input so "100%" searches literally (ESCAPE '\' below).
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
}

type Provider = (userId: string, q: string) => Promise<SearchHit[]>

// Saved bookmarks: live links, offline articles, and promoted feed items. FTS indexes `url`, so a
// domain term ("amazon") matches by address, not just title. Includes shared (ownerId null) rows.
const bookmarksProvider: Provider = async (userId, q) => {
  const match = buildMatch(q)
  if (!match) return []
  const rows = await db.select().from(bookmarks)
    .where(and(
      or(isNull(bookmarks.ownerId), eq(bookmarks.ownerId, userId)),
      sql`bookmarks.rowid IN (SELECT rowid FROM bookmarks_fts WHERE bookmarks_fts MATCH ${match})`,
    ))
    .orderBy(desc(bookmarks.createdAt))
    .limit(PER_PROVIDER)
  return rows.map((r) => ({
    type: 'bookmark' as const,
    id: r.id,
    title: r.title || r.url,
    subtitle: r.siteName || r.url,
    icon: r.faviconUrl,
    route: `/bookmarks/read/${r.id}`,
    group: 'Bookmarks',
  }))
}

// Published companions, matched by name.
const companionProvider: Provider = async (_userId, q) => {
  const pattern = likePattern(q)
  const rows = await db.select().from(characters)
    .where(and(
      eq(characters.isActive, true),
      eq(characters.published, true),
      like(characters.name, pattern),
    ))
    .limit(PER_PROVIDER)
  return rows.map((r) => ({
    type: 'companion' as const,
    id: r.id,
    title: r.name,
    subtitle: r.category,
    icon: null,
    route: `/companions/c/${r.id}`,
    group: 'Companions',
  }))
}

// Home inventory is a shared household list (matches /api/home/devices — no owner filter).
const deviceProvider: Provider = async (_userId, q) => {
  const pattern = likePattern(q)
  const rows = await db.select().from(homeDevices)
    .where(or(
      like(homeDevices.name, pattern),
      like(homeDevices.brand, pattern),
      like(homeDevices.model, pattern),
      like(homeDevices.location, pattern),
    ))
    .limit(PER_PROVIDER)
  return rows.map((r) => ({
    type: 'device' as const,
    id: r.id,
    title: r.name,
    subtitle: [r.brand, r.model].filter(Boolean).join(' ') || r.location || null,
    icon: null,
    route: `/home-inventory?device=${r.id}`,
    group: 'Home Inventory',
  }))
}

// News & RSS articles. News and the Feeds reader are two views over the same persisted
// feed_items table; visible items are those from system feeds (feeds.userId null) or the
// user's own feeds. Matched on title or summary.
const newsProvider: Provider = async (userId, q) => {
  const pattern = likePattern(q)
  const rows = await db.select({
    id: feedItems.id,
    title: feedItems.title,
    url: feedItems.url,
    summary: feedItems.summary,
    imageUrl: feedItems.imageUrl,
    favicon: feeds.faviconUrl,
    feedTitle: feeds.title,
  })
    .from(feedItems)
    .innerJoin(feeds, eq(feedItems.feedId, feeds.id))
    .where(and(
      or(isNull(feeds.userId), eq(feeds.userId, userId)),
      or(like(feedItems.title, pattern), like(feedItems.summary, pattern)),
    ))
    .orderBy(desc(feedItems.publishedAt))
    .limit(PER_PROVIDER)
  return rows.map((r) => ({
    type: 'news' as const,
    id: r.id,
    title: r.title || r.url || 'Untitled',
    subtitle: r.feedTitle || r.url,
    icon: r.favicon || r.imageUrl,
    route: `/news/read/${r.id}`,
    group: 'News & Feeds',
  }))
}

// YouTube videos across all the user's stores: offline downloads, watch-later/liked
// collections, and subscription-feed videos. Deduped by videoId (downloads > collections >
// feed) so a video saved in several places shows once.
const youtubeProvider: Provider = async (userId, q) => {
  const pattern = likePattern(q)
  const [downloads, collections, subVideos] = await Promise.all([
    db.select().from(ytDownloads)
      .where(and(eq(ytDownloads.userId, userId), like(ytDownloads.title, pattern)))
      .orderBy(desc(ytDownloads.createdAt)).limit(PER_PROVIDER),
    db.select().from(ytCollections)
      .where(and(eq(ytCollections.userId, userId), like(ytCollections.title, pattern)))
      .orderBy(desc(ytCollections.addedAt)).limit(PER_PROVIDER),
    db.select({
      videoId: ytVideos.videoId,
      title: ytVideos.title,
      author: ytVideos.author,
      thumbnailUrl: ytVideos.thumbnailUrl,
    })
      .from(ytVideos)
      .innerJoin(ytSubscriptions, eq(ytVideos.subscriptionId, ytSubscriptions.id))
      .where(and(
        eq(ytSubscriptions.userId, userId),
        or(like(ytVideos.title, pattern), like(ytVideos.author, pattern)),
      ))
      .orderBy(desc(ytVideos.publishedAt)).limit(PER_PROVIDER),
  ])

  const byVideo = new Map<string, SearchHit>()
  const add = (videoId: string, title: string, subtitle: string | null, icon: string | null) => {
    if (byVideo.has(videoId)) return
    byVideo.set(videoId, {
      type: 'youtube', id: videoId, title: title || videoId, subtitle, icon,
      route: `/youtube/watch/${videoId}`, group: 'YouTube',
    })
  }
  for (const r of downloads) add(r.videoId, r.title, r.kind === 'audio' ? 'Saved audio' : 'Saved video', null)
  for (const r of collections) add(r.videoId, r.title, r.author || (r.collection === 'liked' ? 'Liked' : 'Watch later'), null)
  for (const r of subVideos) add(r.videoId, r.title, r.author || null, r.thumbnailUrl)
  return [...byVideo.values()].slice(0, PER_PROVIDER)
}

// Podcast episodes from shows the user owns or that are shared. Matched on episode title or
// description; opens the parent show page (episodes have no standalone route).
const podcastProvider: Provider = async (userId, q) => {
  const pattern = likePattern(q)
  const rows = await db.select({
    id: podcastEpisodes.id,
    title: podcastEpisodes.title,
    showId: podcastShows.id,
    showName: podcastShows.name,
  })
    .from(podcastEpisodes)
    .innerJoin(podcastShows, eq(podcastEpisodes.showId, podcastShows.id))
    .where(and(
      or(eq(podcastShows.ownerUserId, userId), eq(podcastShows.visibility, 'shared')),
      or(like(podcastEpisodes.title, pattern), like(podcastEpisodes.description, pattern)),
    ))
    .orderBy(desc(podcastEpisodes.createdAt))
    .limit(PER_PROVIDER)
  return rows.map((r) => ({
    type: 'podcast' as const,
    id: r.id,
    title: r.title,
    subtitle: r.showName,
    icon: null,
    route: `/podcasts/show/${r.showId}`,
    group: 'Podcasts',
  }))
}

// The user's own article highlights and notes — searching your own annotations is often
// faster than re-finding the article. LIKE (not FTS): hand-authored short strings at
// household volume are sub-ms with the (bookmarkId, userId) index.
const highlightsProvider: Provider = async (userId, q) => {
  const pattern = likePattern(q)
  const rows = await db.select({
    id: bookmarkHighlights.id,
    bookmarkId: bookmarkHighlights.bookmarkId,
    quote: bookmarkHighlights.quote,
    note: bookmarkHighlights.note,
    title: bookmarks.title,
  }).from(bookmarkHighlights)
    .innerJoin(bookmarks, eq(bookmarks.id, bookmarkHighlights.bookmarkId))
    .where(and(
      eq(bookmarkHighlights.userId, userId),
      or(
        sql`${bookmarkHighlights.quote} LIKE ${pattern} ESCAPE '\\'`,
        sql`${bookmarkHighlights.note} LIKE ${pattern} ESCAPE '\\'`,
      ),
    ))
    .limit(PER_PROVIDER)
  return rows.map((r) => ({
    type: 'bookmark' as const,
    id: r.id,
    title: r.note?.trim() || r.quote.slice(0, 80),
    subtitle: `Highlight · ${r.title}`,
    icon: null,
    route: `/bookmarks/read/${r.bookmarkId}`,
    group: 'Highlights',
  }))
}

const PROVIDERS: Provider[] = [
  bookmarksProvider,
  highlightsProvider,
  newsProvider,
  youtubeProvider,
  podcastProvider,
  companionProvider,
  deviceProvider,
]

searchRouter.get('/', requireAuth, async (c) => {
  const user = c.get('user')
  const q = c.req.query('q')?.trim() ?? ''
  if (q.length < 2) return c.json({ hits: [] })

  const settled = await Promise.all(
    PROVIDERS.map((p) =>
      p(user.id, q).catch((err) => {
        console.warn('[search] provider failed:', err instanceof Error ? err.message : err)
        return [] as SearchHit[]
      }),
    ),
  )

  return c.json({ hits: settled.flat() })
})

export { searchRouter }

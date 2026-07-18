import { Hono } from 'hono'
import { and, desc, eq, inArray, isNull, like, or, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  bookmarks, bookmarkHighlights, characters, homeDevices, notes,
  ytDownloads, ytCollections, ytVideos, ytSubscriptions,
  feedItems, feeds, podcastEpisodes, podcastShows, clips,
  videoSaves, videoItems, videoFollows,
  books, bookLibrary,
  musicStations, musicPlaylists,
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
  type: 'bookmark' | 'news' | 'companion' | 'device' | 'youtube' | 'podcast' | 'clip' | 'video' | 'note' | 'book' | 'music'
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

  const hits = rows.map((r) => ({
    type: 'bookmark' as const,
    id: r.id,
    title: r.title || r.url,
    subtitle: r.siteName || r.url,
    icon: r.faviconUrl,
    route: `/bookmarks/read/${r.id}`,
    group: 'Bookmarks',
  }))

  // Thin FTS results → semantic fallback over embedded article chunks, so a
  // paraphrased query ("that piece about the housing market") still lands.
  // retrieveBookmarkChunks returns [] when embeddings are unavailable.
  if (hits.length < 3) {
    const { retrieveBookmarkChunks } = await import('@/lib/bookmarks/chunks')
    const chunkHits = await retrieveBookmarkChunks(userId, q, 6).catch(() => [])
    const seen = new Set(hits.map((h) => h.id))
    const extraIds = [...new Set(chunkHits.map((h) => h.bookmarkId))].filter((id) => !seen.has(id)).slice(0, 3)
    if (extraIds.length) {
      const extra = await db.select().from(bookmarks).where(inArray(bookmarks.id, extraIds))
      for (const r of extra) {
        hits.push({
          type: 'bookmark' as const,
          id: r.id,
          title: r.title || r.url,
          subtitle: `${r.siteName || r.url} · related`,
          icon: r.faviconUrl,
          route: `/bookmarks/read/${r.id}`,
          group: 'Bookmarks',
        })
      }
    }
  }
  return hits
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
      route: `/videos/youtube/watch/${videoId}`, group: 'YouTube',
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

// Saved Clipper clips (any yt-dlp-supported URL saved offline), matched by title.
const clipperProvider: Provider = async (userId, q) => {
  const pattern = likePattern(q)
  const rows = await db.select().from(clips)
    .where(and(eq(clips.userId, userId), like(clips.title, pattern)))
    .orderBy(desc(clips.createdAt))
    .limit(PER_PROVIDER)
  return rows.map((r) => ({
    type: 'clip' as const,
    id: r.id,
    title: r.title || r.sourceUrl,
    subtitle: r.extractor || r.sourceUrl,
    icon: r.thumbnailUrl,
    route: '/videos/clip',
    group: 'Clipper',
  }))
}

// Videos hub (non-YouTube sources): the user's saves plus followed creators' cached
// uploads. Local DB only — Spotlight must stay instant, so no live provider calls here.
const videosProvider: Provider = async (userId, q) => {
  const pattern = likePattern(q)
  const [saves, followUploads] = await Promise.all([
    db.select().from(videoSaves)
      .where(and(eq(videoSaves.userId, userId), like(videoSaves.title, pattern)))
      .orderBy(desc(videoSaves.createdAt)).limit(PER_PROVIDER),
    db.select({
      source: videoItems.source, externalId: videoItems.externalId, title: videoItems.title,
      creatorName: videoItems.creatorName, thumbnailUrl: videoItems.thumbnailUrl,
    })
      .from(videoItems)
      .innerJoin(videoFollows, eq(videoItems.followId, videoFollows.id))
      .where(and(
        eq(videoFollows.userId, userId),
        or(like(videoItems.title, pattern), like(videoItems.creatorName, pattern)),
      ))
      .orderBy(desc(videoItems.publishedAt)).limit(PER_PROVIDER),
  ])
  const label = (s: string) => s === 'reddit' ? 'Reddit' : s === 'tiktok' ? 'TikTok' : s === 'vimeo' ? 'Vimeo' : s
  const byKey = new Map<string, SearchHit>()
  const add = (source: string, videoId: string, title: string, subtitle: string | null, icon: string | null) => {
    const key = `${source}:${videoId}`
    if (byKey.has(key)) return
    byKey.set(key, {
      type: 'video', id: key, title: title || videoId, subtitle, icon,
      route: `/videos/${source}/watch/${encodeURIComponent(videoId)}`, group: label(source),
    })
  }
  for (const r of saves) add(r.source, r.videoId, r.title, r.creatorName ? `${r.creatorName} · Saved` : 'Saved', r.thumbnailUrl)
  for (const r of followUploads) add(r.source, r.externalId, r.title, r.creatorName, r.thumbnailUrl)
  return [...byKey.values()].slice(0, PER_PROVIDER)
}

// Notes: FTS over title/body/tags, own + household-shared. Thin results → semantic
// fallback over embedded note chunks (paraphrase queries), mirroring bookmarks.
const notesProvider: Provider = async (userId, q) => {
  const match = buildMatch(q)
  if (!match) return []
  const visible = or(isNull(notes.ownerId), eq(notes.ownerId, userId))
  const rows = await db.select().from(notes)
    .where(and(visible, sql`notes.rowid IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ${match})`))
    .orderBy(desc(notes.updatedAt))
    .limit(PER_PROVIDER)

  const subtitleOf = (r: typeof rows[number], suffix?: string) => {
    const scope = r.ownerId === null ? 'Household' : 'Personal'
    const firstLine = r.body.replace(/[#*`>\-\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
    return [scope, firstLine, suffix].filter(Boolean).join(' · ')
  }
  const hits = rows.map((r) => ({
    type: 'note' as const,
    id: r.id,
    title: r.title || 'Untitled note',
    subtitle: subtitleOf(r),
    icon: null,
    route: `/notes/${r.id}`,
    group: 'Notes',
  }))

  if (hits.length < 3) {
    const { retrieveNoteChunks } = await import('@/lib/notes/chunks')
    const chunkHits = await retrieveNoteChunks(userId, q, 6).catch(() => [])
    const seen = new Set(hits.map((h) => h.id))
    const extraIds = [...new Set(chunkHits.map((h) => h.noteId))].filter((id) => !seen.has(id)).slice(0, 3)
    if (extraIds.length) {
      const extra = await db.select().from(notes).where(inArray(notes.id, extraIds))
      for (const r of extra) {
        hits.push({
          type: 'note' as const,
          id: r.id,
          title: r.title || 'Untitled note',
          subtitle: subtitleOf(r, 'related'),
          icon: null,
          route: `/notes/${r.id}`,
          group: 'Notes',
        })
      }
    }
  }
  return hits
}

// Books in the user's library, FTS over title/author/description. Opens the book's
// detail page. Cover comes from the catalog coverUrl (remote sources) — the local
// /:id/cover endpoint needs no auth-less URL, so fall back to a glyph for those.
const booksProvider: Provider = async (userId, q) => {
  const match = buildMatch(q)
  if (!match) return []
  const rows = await db.select({
    id: books.id, title: books.title, author: books.author, coverUrl: books.coverUrl,
    contentType: books.contentType, addedAt: bookLibrary.addedAt,
  })
    .from(bookLibrary)
    .innerJoin(books, eq(bookLibrary.bookId, books.id))
    .where(and(
      eq(bookLibrary.userId, userId),
      sql`books.rowid IN (SELECT rowid FROM books_fts WHERE books_fts MATCH ${match})`,
    ))
    .orderBy(desc(bookLibrary.addedAt))
    .limit(PER_PROVIDER)
  return rows.map((r) => ({
    type: 'book' as const,
    id: r.id,
    title: r.title,
    subtitle: [r.author, r.contentType !== 'book' ? r.contentType : null].filter(Boolean).join(' · ') || null,
    icon: r.coverUrl,
    route: `/books/${r.id}`,
    group: 'Books',
  }))
}

// Music stations (built-in + the user's own) and playlists, matched by name.
// Individual songs are skipped: music plays via the mini-player, not a standalone
// page, unlike videos/podcasts which have somewhere to route to.
const musicProvider: Provider = async (userId, q) => {
  const pattern = likePattern(q)
  const [stations, playlists] = await Promise.all([
    db.select().from(musicStations)
      .where(and(
        or(isNull(musicStations.userId), eq(musicStations.userId, userId)),
        like(musicStations.name, pattern),
      ))
      .orderBy(desc(musicStations.updatedAt))
      .limit(PER_PROVIDER),
    db.select().from(musicPlaylists)
      .where(and(eq(musicPlaylists.userId, userId), like(musicPlaylists.name, pattern)))
      .orderBy(desc(musicPlaylists.updatedAt))
      .limit(PER_PROVIDER),
  ])
  const hits: SearchHit[] = [
    ...stations.map((r) => ({
      type: 'music' as const, id: r.id, title: r.name,
      subtitle: r.description || 'Station', icon: null,
      route: `/music/station/${r.id}`, group: 'Music',
    })),
    ...playlists.map((r) => ({
      type: 'music' as const, id: r.id, title: r.name,
      subtitle: r.description || 'Playlist', icon: null,
      route: `/music/playlist/${r.id}`, group: 'Music',
    })),
  ]
  return hits.slice(0, PER_PROVIDER)
}

const PROVIDERS: Provider[] = [
  bookmarksProvider,
  booksProvider,
  notesProvider,
  highlightsProvider,
  newsProvider,
  youtubeProvider,
  videosProvider,
  podcastProvider,
  musicProvider,
  clipperProvider,
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

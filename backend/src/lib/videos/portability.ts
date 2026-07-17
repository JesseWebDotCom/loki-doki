// Portability: get your subscriptions in and out. Lock-in is disqualifying to the
// self-hosted audience (every alt-frontend ships OPML + Takeout import, and Invidious's
// per-channel RSS is the single most-loved thing about it), and it's the honest posture
// for a private hub: your follows are yours.
//
// Three directions:
//   • OPML in  - the universal subscriptions interchange (NewPipe, FreeTube, Invidious,
//                Grayjay all read/write it); YouTube channel RSS URLs carry the channel id.
//   • OPML out - every subscription and follow as channel RSS entries.
//   • RSS out  - our own per-creator / per-folder feeds, so the household's follows can be
//                read by any RSS client. Token-authed: RSS readers can't hold a session.

import { randomUUID, randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { userPreferences, videoFolders, videoFolderMembers, videoFollows, videoItems, ytSubscriptions, ytVideos } from '@/db/schema'
import { logger } from '@/lib/logger'

export const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// ── Feed token ───────────────────────────────────────────────────────────────────
// RSS readers can't send our session cookie, so the feed URL carries a per-user opaque
// token, exactly like the OPDS catalog's (lib/books/opdsServer.ts).

const RSS_TOKEN_PREF = 'videos.rss_token'

export async function getOrCreateRssToken(userId: string): Promise<string> {
  const [row] = await db.select({ value: userPreferences.value }).from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, RSS_TOKEN_PREF))).limit(1)
  if (row?.value) { try { return JSON.parse(row.value) as string } catch { /* regenerate */ } }
  const token = randomBytes(24).toString('base64url')
  const now = new Date()
  await db.insert(userPreferences)
    .values({ id: randomUUID(), userId, key: RSS_TOKEN_PREF, value: JSON.stringify(token), updatedAt: now })
    .onConflictDoUpdate({ target: [userPreferences.userId, userPreferences.key], set: { value: JSON.stringify(token), updatedAt: now } })
  return token
}

export async function resolveRssToken(token: string): Promise<string | null> {
  if (!token) return null
  const rows = await db.select({ userId: userPreferences.userId, value: userPreferences.value })
    .from(userPreferences).where(eq(userPreferences.key, RSS_TOKEN_PREF))
  for (const r of rows) {
    try { if (JSON.parse(r.value) === token) return r.userId } catch { /* skip */ }
  }
  return null
}

// ── OPML export ──────────────────────────────────────────────────────────────────

export interface OpmlEntry { title: string; xmlUrl: string; htmlUrl: string | null }

/** Channel-RSS URL for a creator, where the platform publishes one. Null otherwise (our
 *  own feed URL is offered separately by the RSS routes). */
export function channelRssUrl(source: string, externalId: string): string | null {
  switch (source) {
    case 'youtube':
      // Only real channel ids have a feed; a handle-shaped id would 404, so skip those.
      return externalId.startsWith('UC') ? `https://www.youtube.com/feeds/videos.xml?channel_id=${externalId}` : null
    case 'reddit':
      return `https://www.reddit.com/r/${encodeURIComponent(externalId)}/.rss`
    case 'vimeo':
      return `https://vimeo.com/${encodeURIComponent(externalId)}/videos/rss`
    default:
      // TikTok has no public feed; those entries export as our own feed URLs instead.
      return null
  }
}

export async function subscriptionsAsOpml(userId: string, ownFeedBase: string | null): Promise<string> {
  const [subs, follows] = await Promise.all([
    db.select({ externalId: ytSubscriptions.externalId, title: ytSubscriptions.title })
      .from(ytSubscriptions).where(and(eq(ytSubscriptions.userId, userId), eq(ytSubscriptions.kind, 'channel'))),
    db.select({ source: videoFollows.source, externalId: videoFollows.externalId, title: videoFollows.title })
      .from(videoFollows).where(eq(videoFollows.userId, userId)),
  ])
  const entries: OpmlEntry[] = []
  for (const s of subs) {
    const xmlUrl = channelRssUrl('youtube', s.externalId)
      ?? (ownFeedBase ? `${ownFeedBase}/youtube/${encodeURIComponent(s.externalId)}` : null)
    if (xmlUrl) entries.push({ title: s.title || s.externalId, xmlUrl, htmlUrl: `https://www.youtube.com/channel/${s.externalId}` })
  }
  for (const f of follows) {
    const xmlUrl = channelRssUrl(f.source, f.externalId)
      ?? (ownFeedBase ? `${ownFeedBase}/${f.source}/${encodeURIComponent(f.externalId)}` : null)
    if (xmlUrl) entries.push({ title: f.title || f.externalId, xmlUrl, htmlUrl: null })
  }
  const lines = entries.map((e) =>
    `    <outline text="${esc(e.title)}" title="${esc(e.title)}" type="rss" xmlUrl="${esc(e.xmlUrl)}"${e.htmlUrl ? ` htmlUrl="${esc(e.htmlUrl)}"` : ''}/>`)
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="1.0">\n  <head><title>Loki Doki subscriptions</title></head>\n  <body>\n${lines.join('\n')}\n  </body>\n</opml>\n`
}

// ── OPML import ──────────────────────────────────────────────────────────────────

export interface ImportCandidate { source: string; externalId: string; title: string }

/** Pull subscribable creators out of an OPML file. Understands the channel-RSS URL shapes
 *  every exporter writes (YouTube Takeout, NewPipe, FreeTube, Invidious, Grayjay). */
export function parseOpml(opml: string): ImportCandidate[] {
  const out: ImportCandidate[] = []
  const seen = new Set<string>()
  const outlineRe = /<outline\b[^>]*\/?>/gi
  for (const tag of opml.match(outlineRe) ?? []) {
    const xmlUrl = tag.match(/xmlUrl="([^"]+)"/i)?.[1]
    if (!xmlUrl) continue
    const title = (tag.match(/(?:title|text)="([^"]*)"/i)?.[1] ?? '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    const url = xmlUrl.replace(/&amp;/g, '&')
    let hit: ImportCandidate | null = null
    const yt = url.match(/youtube\.com\/feeds\/videos\.xml\?channel_id=([\w-]+)/i)
    if (yt) hit = { source: 'youtube', externalId: yt[1]!, title: title || yt[1]! }
    const reddit = url.match(/reddit\.com\/r\/([\w-]+)/i)
    if (!hit && reddit) hit = { source: 'reddit', externalId: reddit[1]!, title: title || reddit[1]! }
    const vimeo = url.match(/vimeo\.com\/(?:channels\/)?([\w-]+)\/videos\/rss/i)
    if (!hit && vimeo) hit = { source: 'vimeo', externalId: vimeo[1]!, title: title || vimeo[1]! }
    // Our own export round-trips: /api/video-rss/<token>/<source>/<id>
    const own = url.match(/\/video-rss\/[^/]+\/(youtube|reddit|tiktok|vimeo)\/([^/?#]+)/i)
    if (!hit && own) hit = { source: own[1]!.toLowerCase(), externalId: decodeURIComponent(own[2]!), title: title || own[2]! }
    if (!hit) continue
    const key = `${hit.source}:${hit.externalId.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(hit)
  }
  return out
}

// ── RSS out ──────────────────────────────────────────────────────────────────────

interface FeedItem { title: string; link: string; guid: string; pubDate: number | null; thumb: string | null; creator: string | null }

function rssDoc(title: string, selfUrl: string, items: FeedItem[]): string {
  const entries = items.map((i) => [
    '    <item>',
    `      <title>${esc(i.title)}</title>`,
    `      <link>${esc(i.link)}</link>`,
    `      <guid isPermaLink="false">${esc(i.guid)}</guid>`,
    i.pubDate ? `      <pubDate>${new Date(i.pubDate).toUTCString()}</pubDate>` : '',
    i.creator ? `      <dc:creator>${esc(i.creator)}</dc:creator>` : '',
    i.thumb ? `      <media:thumbnail url="${esc(i.thumb)}"/>` : '',
    '    </item>',
  ].filter(Boolean).join('\n')).join('\n')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${esc(title)}</title>`,
    `    <link>${esc(selfUrl)}</link>`,
    `    <description>${esc(title)} — from your Loki Doki hub</description>`,
    entries,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n')
}

/** Feed of one creator's recent videos, from the poller's cache. */
export async function creatorFeed(userId: string, source: string, externalId: string, selfUrl: string): Promise<string | null> {
  if (source === 'youtube') {
    const [sub] = await db.select({ id: ytSubscriptions.id, title: ytSubscriptions.title })
      .from(ytSubscriptions)
      .where(and(eq(ytSubscriptions.userId, userId), eq(ytSubscriptions.externalId, externalId)))
      .limit(1)
    if (!sub) return null
    const rows = await db.select().from(ytVideos)
      .where(eq(ytVideos.channelId, externalId))
      .limit(50)
    const items: FeedItem[] = rows.map((v) => ({
      title: v.title, link: `https://www.youtube.com/watch?v=${v.videoId}`, guid: `youtube:${v.videoId}`,
      pubDate: v.publishedAt ? v.publishedAt.getTime() : null, thumb: v.thumbnailUrl, creator: v.author || null,
    }))
    return rssDoc(sub.title || externalId, selfUrl, items)
  }
  const [follow] = await db.select({ id: videoFollows.id, title: videoFollows.title })
    .from(videoFollows)
    .where(and(eq(videoFollows.userId, userId), eq(videoFollows.source, source), eq(videoFollows.externalId, externalId)))
    .limit(1)
  if (!follow) return null
  const rows = await db.select().from(videoItems).where(eq(videoItems.followId, follow.id)).limit(50)
  const items: FeedItem[] = rows.map((v) => ({
    title: v.title, link: v.url ?? '', guid: `${v.source}:${v.externalId}`,
    pubDate: v.publishedAt ? v.publishedAt.getTime() : null, thumb: v.thumbnailUrl, creator: v.creatorName,
  }))
  return rssDoc(follow.title || externalId, selfUrl, items)
}

/** Feed of everything in one subscription folder. */
export async function folderFeed(userId: string, folderId: string, selfUrl: string): Promise<string | null> {
  const [folder] = await db.select().from(videoFolders)
    .where(and(eq(videoFolders.id, folderId), eq(videoFolders.userId, userId))).limit(1)
  if (!folder) return null
  const members = await db.select().from(videoFolderMembers).where(eq(videoFolderMembers.folderId, folderId))
  const items: FeedItem[] = []
  for (const m of members) {
    if (m.source === 'youtube') {
      const rows = await db.select().from(ytVideos).where(eq(ytVideos.channelId, m.externalId)).limit(20)
      items.push(...rows.map((v) => ({
        title: v.title, link: `https://www.youtube.com/watch?v=${v.videoId}`, guid: `youtube:${v.videoId}`,
        pubDate: v.publishedAt ? v.publishedAt.getTime() : null, thumb: v.thumbnailUrl, creator: v.author || null,
      })))
    } else {
      const [follow] = await db.select({ id: videoFollows.id }).from(videoFollows)
        .where(and(eq(videoFollows.userId, userId), eq(videoFollows.source, m.source), eq(videoFollows.externalId, m.externalId)))
        .limit(1)
      if (!follow) continue
      const rows = await db.select().from(videoItems).where(eq(videoItems.followId, follow.id)).limit(20)
      items.push(...rows.map((v) => ({
        title: v.title, link: v.url ?? '', guid: `${v.source}:${v.externalId}`,
        pubDate: v.publishedAt ? v.publishedAt.getTime() : null, thumb: v.thumbnailUrl, creator: v.creatorName,
      })))
    }
  }
  items.sort((a, b) => (b.pubDate ?? 0) - (a.pubDate ?? 0))
  return rssDoc(`${folder.name} — Loki Doki`, selfUrl, items.slice(0, 60))
}

// ── Dead-video detection ─────────────────────────────────────────────────────────
// Playlists rot: videos go private, get deleted, or are region-blocked, and YouTube just
// shows "[Deleted video]" with no recourse. We keep the title from when it was added, so
// we can offer to find a reupload, which YouTube structurally cannot.

export interface DeadEntry { videoId: string; title: string | null }

/** Titles for a set of YouTube ids, from our own cache: an id we cached a real title for
 *  can be searched for even after YouTube stops serving its metadata. */
export async function cachedTitles(videoIds: string[]): Promise<Map<string, string>> {
  if (!videoIds.length) return new Map()
  const rows = await db.select({ videoId: ytVideos.videoId, title: ytVideos.title }).from(ytVideos)
  const wanted = new Set(videoIds)
  const out = new Map<string, string>()
  for (const r of rows) if (wanted.has(r.videoId) && r.title) out.set(r.videoId, r.title)
  logger.debug(`[videos/portability] cached titles for ${out.size}/${videoIds.length} dead entries`)
  return out
}

// Private RSS feeds OUT: every generated AI show and the user's radio-recordings
// collection gets a feed URL any podcatcher on the LAN can subscribe to.
//
// Auth is a per-user opaque token embedded in the URL (podcatchers can't send our
// session cookie), stored in user_preferences and revocable from settings. This is the
// same posture as the OPDS server (lib/books/opdsServer.ts); the feed and every
// enclosure/cover link carry the same token, so one URL is all a client needs.

import { randomUUID, randomBytes } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { musicRadioRecordings, podcastEpisodes, podcastShows, userPreferences } from '@/db/schema'

const RSS_TOKEN_PREF = 'podcasts.rss_token'

export async function getOrCreateRssToken(userId: string): Promise<string> {
  const [row] = await db.select({ value: userPreferences.value }).from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, RSS_TOKEN_PREF))).limit(1)
  if (row?.value) { try { return JSON.parse(row.value) as string } catch { /* regenerate below */ } }
  return regenerateRssToken(userId)
}

/** Mint a fresh token, invalidating every URL handed out before now. */
export async function regenerateRssToken(userId: string): Promise<string> {
  const token = randomBytes(24).toString('base64url')
  const now = new Date()
  await db.insert(userPreferences).values({
    id: randomUUID(), userId, key: RSS_TOKEN_PREF, value: JSON.stringify(token), updatedAt: now,
  }).onConflictDoUpdate({
    target: [userPreferences.userId, userPreferences.key],
    set: { value: JSON.stringify(token), updatedAt: now },
  })
  return token
}

/** Revoke: any existing feed URL stops working until a new token is generated. */
export async function revokeRssToken(userId: string): Promise<void> {
  await db.delete(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, RSS_TOKEN_PREF)))
}

export async function resolveRssToken(token: string): Promise<string | null> {
  if (!token) return null
  const rows = await db.select({ userId: userPreferences.userId, value: userPreferences.value })
    .from(userPreferences).where(eq(userPreferences.key, RSS_TOKEN_PREF))
  for (const r of rows) {
    try { if (JSON.parse(r.value) === token) return r.userId } catch { /* skip malformed */ }
  }
  return null
}

// ── Feed generation ─────────────────────────────────────────────────────────────────

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

interface FeedItem {
  guid: string
  title: string
  description: string | null
  enclosureUrl: string
  enclosureBytes: number | null
  durationSec: number | null
  pubDate: Date
}

interface FeedChannel {
  title: string
  description: string
  link: string
  imageUrl: string | null
  author: string
  items: FeedItem[]
}

function renderFeed(ch: FeedChannel): string {
  const items = ch.items.map(it => [
    '    <item>',
    `      <title>${xmlEscape(it.title)}</title>`,
    `      <guid isPermaLink="false">${xmlEscape(it.guid)}</guid>`,
    it.description ? `      <description>${xmlEscape(it.description)}</description>` : '',
    `      <pubDate>${it.pubDate.toUTCString()}</pubDate>`,
    `      <enclosure url="${xmlEscape(it.enclosureUrl)}" type="audio/mpeg"${it.enclosureBytes ? ` length="${it.enclosureBytes}"` : ''}/>`,
    it.durationSec ? `      <itunes:duration>${Math.round(it.durationSec)}</itunes:duration>` : '',
    '    </item>',
  ].filter(Boolean).join('\n')).join('\n')

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">',
    '  <channel>',
    `    <title>${xmlEscape(ch.title)}</title>`,
    `    <description>${xmlEscape(ch.description)}</description>`,
    `    <link>${xmlEscape(ch.link)}</link>`,
    `    <itunes:author>${xmlEscape(ch.author)}</itunes:author>`,
    // Private feeds must never end up in a directory.
    '    <itunes:block>Yes</itunes:block>',
    ch.imageUrl ? `    <itunes:image href="${xmlEscape(ch.imageUrl)}"/>` : '',
    `    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>`,
    items,
    '  </channel>',
    '</rss>',
    '',
  ].filter(Boolean).join('\n')
}

/** Feed for one generated AI show. `base` is the absolute origin (e.g. http://host:3000).
 *  Null when the show doesn't exist, isn't the token user's, or is an RSS subscription
 *  (re-publishing someone else's feed is not ours to do). */
export async function buildShowFeed(userId: string, showId: string, base: string, token: string): Promise<string | null> {
  const [show] = await db.select().from(podcastShows).where(eq(podcastShows.id, showId)).limit(1)
  if (!show || show.source === 'rss') return null
  if (show.ownerUserId !== userId && show.visibility !== 'shared') return null

  const episodes = await db.select().from(podcastEpisodes)
    .where(and(eq(podcastEpisodes.showId, showId), eq(podcastEpisodes.status, 'ready')))
    .orderBy(desc(podcastEpisodes.generatedAt), desc(podcastEpisodes.createdAt))
    .limit(300)

  return renderFeed({
    title: show.name,
    description: show.description ?? `${show.name}, an AI show from Loki Doki.`,
    link: `${base}/podcasts/show/${show.id}`,
    imageUrl: show.coverRelPath ? `${base}/api/podcast-rss/${token}/show/${show.id}/cover` : null,
    author: 'Loki Doki',
    items: episodes
      .filter(e => e.audioRelPath)
      .map(e => ({
        guid: e.id,
        title: e.title,
        description: e.description,
        enclosureUrl: `${base}/api/podcast-rss/${token}/episode/${e.id}.mp3`,
        enclosureBytes: null,
        durationSec: e.durationSec,
        pubDate: e.generatedAt ?? e.createdAt,
      })),
  })
}

/** One feed for the user's whole radio-recordings collection: a podcatcher subscribes
 *  once and every new capture shows up as an episode. */
export async function buildRadioFeed(userId: string, base: string, token: string): Promise<string> {
  const recordings = await db.select().from(musicRadioRecordings)
    .where(and(eq(musicRadioRecordings.userId, userId), eq(musicRadioRecordings.status, 'ready')))
    .orderBy(desc(musicRadioRecordings.createdAt))
    .limit(300)

  return renderFeed({
    title: 'Radio recordings',
    description: 'Live radio captured on Loki Doki.',
    link: `${base}/music/library?tab=radio`,
    imageUrl: null,
    author: 'Loki Doki',
    items: recordings
      .filter(r => r.relPath)
      .map(r => ({
        guid: r.id,
        title: r.title,
        description: r.stationName,
        enclosureUrl: `${base}/api/podcast-rss/${token}/recording/${r.id}.mp3`,
        enclosureBytes: r.sizeBytes,
        durationSec: r.durationSec,
        pubDate: r.createdAt,
      })),
  })
}

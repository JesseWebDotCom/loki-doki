// Real podcast subscriptions: subscribe/unsubscribe lifecycle + the refresh poller.
//
// One podcast_shows row per feed URL, shared household-wide (source='rss'); per-user
// membership lives in podcast_subscriptions. Modeled on the feeds poller (conditional
// GET, per-host throttle, bounded concurrency, overlap guard) but writing into the
// podcast tables so subscribed episodes flow through the existing player untouched.

import { and, desc, eq, inArray, isNull, notInArray } from 'drizzle-orm'
import { db } from '@/db'
import { podcastDownloads, podcastEpisodes, podcastShows, podcastSubscriptions, podcastWatchState } from '@/db/schema'
import { parsePodcastFeed } from '@/lib/podcast/rss'
import { safeFetch } from '@/lib/ssrfGuard'
import { logger } from '@/lib/logger'

const UA = 'LokiDoki/3.0 podcast'
const FETCH_TIMEOUT_MS = 15_000
const REFRESH_INTERVAL_MS = 60 * 60 * 1000  // podcasts are low-churn; conditional GET makes most refreshes a 304
const MIN_HOST_GAP_MS = 1500
const CONCURRENCY = 4
const KEEP_PER_SHOW = 300
export const DEFAULT_AUTO_KEEP = 3

const lastHostFetch = new Map<string, number>()
async function hostThrottle(url: string): Promise<void> {
  let host: string
  try { host = new URL(url).host } catch { return }
  const last = lastHostFetch.get(host) ?? 0
  const wait = MIN_HOST_GAP_MS - (Date.now() - last)
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastHostFetch.set(host, Date.now())
}

/** Canonical form for dedup so the household doesn't get duplicate shows for
 *  `https://feeds.x.com/show` vs `.../show/` vs `HTTP://FEEDS.X.COM/show`. */
export function normalizeFeedUrl(raw: string): string {
  try {
    const u = new URL(raw.trim())
    u.hostname = u.hostname.toLowerCase()
    u.hash = ''
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1)
    return u.toString()
  } catch {
    return raw.trim()
  }
}

async function findShowByFeedUrl(feedUrl: string): Promise<{ id: string } | null> {
  const normalized = normalizeFeedUrl(feedUrl)
  // Also match the https-upgraded form so an http:// entry of an existing https feed dedups.
  const httpsForm = normalized.startsWith('http://') ? `https://${normalized.slice(7)}` : normalized
  const [row] = await db.select({ id: podcastShows.id }).from(podcastShows)
    .where(and(eq(podcastShows.source, 'rss'), inArray(podcastShows.feedUrl, [...new Set([normalized, httpsForm])])))
    .limit(1)
  return row ?? null
}

async function fetchFeedXml(feedUrl: string, cond?: { etag?: string | null; lastModified?: string | null }): Promise<
  { status: 'ok'; xml: string; etag: string | null; lastModified: string | null } | { status: 'not-modified' }
> {
  await hostThrottle(feedUrl)
  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept: 'application/rss+xml, application/xml, text/xml, */*',
  }
  if (cond?.etag) headers['If-None-Match'] = cond.etag
  if (cond?.lastModified) headers['If-Modified-Since'] = cond.lastModified
  const res = await safeFetch(feedUrl, { headers }, { timeoutMs: FETCH_TIMEOUT_MS })
  if (res.status === 304) { res.body?.cancel().catch(() => {}); return { status: 'not-modified' } }
  if (!res.ok) { res.body?.cancel().catch(() => {}); throw new Error(`feed responded ${res.status}`) }
  return {
    status: 'ok',
    xml: await res.text(),
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
  }
}

/** Subscribe a user to a feed. Reuses the household's existing show row when someone
 *  already subscribed to this feed; otherwise fetches + parses the feed and creates the
 *  show with its episode backlog. Throws with a user-facing message on a bad feed. */
export async function subscribeToFeed(
  userId: string,
  feedUrl: string,
  seed?: { title?: string | null; artworkUrl?: string | null; author?: string | null; genre?: string | null },
): Promise<{ showId: string; created: boolean }> {
  const normalized = normalizeFeedUrl(feedUrl)
  const existing = await findShowByFeedUrl(normalized)
  if (existing) {
    await db.insert(podcastSubscriptions).values({
      id: crypto.randomUUID(), userId, showId: existing.id, addedAt: new Date(),
    }).onConflictDoNothing()
    return { showId: existing.id, created: false }
  }

  const fetched = await fetchFeedXml(normalized)
  if (fetched.status !== 'ok') throw new Error('Feed did not return content')
  const parsed = parsePodcastFeed(fetched.xml)
  const name = parsed.title || seed?.title || null
  if (!name) throw new Error('Not a podcast feed (no title found)')
  if (!parsed.episodes.length) throw new Error('Feed has no playable audio episodes')
  // Big back-catalogs (The Daily ships ~3k items in one feed) get capped up front to the
  // same window the prune keeps — inserting thousands of rows just to prune them is waste.
  const backlog = [...parsed.episodes]
    .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
    .slice(0, KEEP_PER_SHOW)

  const now = new Date()
  const showId = crypto.randomUUID()
  await db.insert(podcastShows).values({
    id: showId, ownerUserId: userId, name,
    description: parsed.description ?? null,
    style: 'recap', segmentsJson: '[]', hostsJson: '[]',
    visibility: 'personal', source: 'rss',
    feedUrl: normalized,
    artworkUrl: parsed.imageUrl || seed?.artworkUrl || null,
    author: parsed.author || seed?.author || null,
    link: parsed.link ?? null,
    categoriesJson: JSON.stringify(parsed.categories.length ? parsed.categories : (seed?.genre ? [seed.genre] : [])),
    feedEtag: fetched.etag, feedLastModified: fetched.lastModified, feedFetchedAt: now,
    createdAt: now,
  })
  await insertEpisodes(showId, backlog)
  await db.insert(podcastSubscriptions).values({
    id: crypto.randomUUID(), userId, showId, addedAt: now,
  })
  logger.info(`[podcast-rss] subscribed: "${name}" (${backlog.length} of ${parsed.episodes.length} episodes)`)
  return { showId, created: true }
}

type ParsedEpisodes = ReturnType<typeof parsePodcastFeed>['episodes']

async function insertEpisodes(showId: string, episodes: ParsedEpisodes): Promise<number> {
  if (!episodes.length) return 0
  const guids = episodes.map(e => e.guid)
  const known = new Set<string>()
  for (let i = 0; i < guids.length; i += 400) {
    const rows = await db.select({ guid: podcastEpisodes.guid }).from(podcastEpisodes)
      .where(and(eq(podcastEpisodes.showId, showId), inArray(podcastEpisodes.guid, guids.slice(i, i + 400))))
    for (const r of rows) if (r.guid) known.add(r.guid)
  }
  const fresh = episodes.filter(e => !known.has(e.guid))
  if (!fresh.length) return 0
  const now = new Date()
  for (let i = 0; i < fresh.length; i += 200) {
    await db.insert(podcastEpisodes).values(fresh.slice(i, i + 200).map(e => ({
      id: crypto.randomUUID(), showId,
      title: e.title, description: e.description,
      durationSec: e.durationSec,
      status: 'ready' as const,  // playable immediately via the remote proxy
      guid: e.guid,
      enclosureUrl: e.enclosureUrl, enclosureType: e.enclosureType, enclosureBytes: e.enclosureBytes,
      imageUrl: e.imageUrl, link: e.link,
      publishedAt: e.publishedAt ? new Date(e.publishedAt) : null,
      createdAt: now,
    }))).onConflictDoNothing()
  }
  return fresh.length
}

/** Keep the newest N episodes; never prune one somebody downloaded or has watch-state on
 *  (pruned-then-republished episodes come back as new rows, losing that state). */
async function pruneEpisodes(showId: string): Promise<void> {
  const rows = await db.select({ id: podcastEpisodes.id }).from(podcastEpisodes)
    .where(eq(podcastEpisodes.showId, showId))
    .orderBy(desc(podcastEpisodes.publishedAt), desc(podcastEpisodes.createdAt))
  if (rows.length <= KEEP_PER_SHOW) return
  const overflow = rows.slice(KEEP_PER_SHOW).map(r => r.id)
  for (let i = 0; i < overflow.length; i += 400) {
    const chunk = overflow.slice(i, i + 400)
    const pinnedDl = await db.select({ id: podcastDownloads.episodeId }).from(podcastDownloads)
      .where(inArray(podcastDownloads.episodeId, chunk))
    const pinnedWs = await db.select({ id: podcastWatchState.episodeId }).from(podcastWatchState)
      .where(inArray(podcastWatchState.episodeId, chunk))
    const pinned = new Set([...pinnedDl.map(r => r.id), ...pinnedWs.map(r => r.id)])
    const deletable = chunk.filter(id => !pinned.has(id))
    if (deletable.length) await db.delete(podcastEpisodes).where(inArray(podcastEpisodes.id, deletable))
  }
}

/** Refresh one RSS show: conditional GET → upsert fresh episodes → prune → auto-download
 *  pass for subscribers who opted in. Returns # new episodes. */
export async function refreshPodcastFeed(showId: string): Promise<number> {
  const [show] = await db.select().from(podcastShows)
    .where(and(eq(podcastShows.id, showId), eq(podcastShows.source, 'rss')))
    .limit(1)
  if (!show?.feedUrl) return 0
  const now = new Date()

  let added = 0
  try {
    const fetched = await fetchFeedXml(show.feedUrl, { etag: show.feedEtag, lastModified: show.feedLastModified })
    if (fetched.status === 'ok') {
      const parsed = parsePodcastFeed(fetched.xml)
      added = await insertEpisodes(showId, parsed.episodes)
      await pruneEpisodes(showId)
      await db.update(podcastShows).set({
        description: show.description ?? parsed.description ?? null,
        artworkUrl: parsed.imageUrl || show.artworkUrl,
        author: parsed.author || show.author,
        link: parsed.link ?? show.link,
        feedEtag: fetched.etag ?? show.feedEtag,
        feedLastModified: fetched.lastModified ?? show.feedLastModified,
        feedFetchedAt: now, feedError: null,
      }).where(eq(podcastShows.id, showId))
    } else {
      await db.update(podcastShows).set({ feedFetchedAt: now, feedError: null }).where(eq(podcastShows.id, showId))
    }
  } catch (err) {
    await db.update(podcastShows).set({ feedFetchedAt: now, feedError: String(err).slice(0, 300) }).where(eq(podcastShows.id, showId))
    throw err
  }

  await runAutoDownloadPass(showId).catch(err => logger.warn(`[podcast-rss] auto-download pass failed for ${showId}: ${err}`))
  if (added > 0) logger.info(`[podcast-rss] +${added} episode(s) for "${show.name}"`)
  return added
}

/** For every auto-download subscriber of this show: enqueue the newest-N episodes they
 *  don't have yet (as auto refs) and release auto refs that fell out of the window.
 *  Manual downloads are never touched — mirrors YouTube's pruneAutoSaves contract. */
export async function runAutoDownloadPass(showId: string): Promise<void> {
  const subs = await db.select().from(podcastSubscriptions)
    .where(and(eq(podcastSubscriptions.showId, showId), eq(podcastSubscriptions.autoDownload, true)))
  if (!subs.length) return
  const newest = await db.select({ id: podcastEpisodes.id }).from(podcastEpisodes)
    .where(and(eq(podcastEpisodes.showId, showId), isNull(podcastEpisodes.audioRelPath)))
    .orderBy(desc(podcastEpisodes.publishedAt), desc(podcastEpisodes.createdAt))
    .limit(20)

  const { enqueueEpisodeDownload, removeEpisodeDownload } = await import('@/lib/podcast/offline')
  for (const sub of subs) {
    const keep = Math.max(1, Math.min(sub.autoDownloadKeep ?? DEFAULT_AUTO_KEEP, 20))
    const wanted = newest.slice(0, keep).map(e => e.id)
    if (!wanted.length) continue

    const existing = await db.select({ episodeId: podcastDownloads.episodeId }).from(podcastDownloads)
      .where(and(eq(podcastDownloads.userId, sub.userId), inArray(podcastDownloads.episodeId, wanted)))
    const have = new Set(existing.map(r => r.episodeId))
    for (const episodeId of wanted) {
      if (!have.has(episodeId)) await enqueueEpisodeDownload(sub.userId, episodeId, { auto: true })
    }

    // Release auto refs outside the keep window (blob space reclaimed by gcSweep once
    // no other user references the asset).
    const showEpisodeIds = await db.select({ id: podcastEpisodes.id }).from(podcastEpisodes)
      .where(eq(podcastEpisodes.showId, showId))
    const stale = await db.select({ episodeId: podcastDownloads.episodeId }).from(podcastDownloads)
      .where(and(
        eq(podcastDownloads.userId, sub.userId),
        eq(podcastDownloads.auto, true),
        inArray(podcastDownloads.episodeId, showEpisodeIds.map(r => r.id)),
        wanted.length ? notInArray(podcastDownloads.episodeId, wanted) : undefined,
      ))
    for (const s of stale) await removeEpisodeDownload(sub.userId, s.episodeId)
  }
}

/** Unsubscribe. Last subscriber out deletes the show (cascade drops episodes → download
 *  refs → gcSweep reclaims blobs); otherwise the show survives and ownership transfers
 *  off the leaver so their account deletion can never cascade the household's show away. */
export async function unsubscribe(userId: string, showId: string): Promise<void> {
  await db.delete(podcastSubscriptions)
    .where(and(eq(podcastSubscriptions.userId, userId), eq(podcastSubscriptions.showId, showId)))
  // Their download refs go too — keeping refs without membership would pin blobs forever.
  const showEpisodes = await db.select({ id: podcastEpisodes.id }).from(podcastEpisodes)
    .where(eq(podcastEpisodes.showId, showId))
  if (showEpisodes.length) {
    await db.delete(podcastDownloads).where(and(
      eq(podcastDownloads.userId, userId),
      inArray(podcastDownloads.episodeId, showEpisodes.map(r => r.id)),
    ))
  }

  const remaining = await db.select({ userId: podcastSubscriptions.userId }).from(podcastSubscriptions)
    .where(eq(podcastSubscriptions.showId, showId))
  if (!remaining.length) {
    await db.delete(podcastShows).where(and(eq(podcastShows.id, showId), eq(podcastShows.source, 'rss')))
    return
  }
  const [show] = await db.select({ ownerUserId: podcastShows.ownerUserId }).from(podcastShows)
    .where(eq(podcastShows.id, showId)).limit(1)
  if (show && show.ownerUserId === userId) {
    await db.update(podcastShows).set({ ownerUserId: remaining[0]!.userId }).where(eq(podcastShows.id, showId))
  }
}

// ── Poller ────────────────────────────────────────────────────────────────────────

let _timer: ReturnType<typeof setInterval> | null = null
let _polling = false

export function startPodcastFeedPoller(): void {
  if (_timer) return
  _timer = setInterval(async () => {
    if (_polling) return
    _polling = true
    try {
      const shows = await db.select({ id: podcastShows.id, feedFetchedAt: podcastShows.feedFetchedAt }).from(podcastShows)
        .where(eq(podcastShows.source, 'rss'))
      const stale = shows.filter(s => !s.feedFetchedAt || Date.now() - s.feedFetchedAt.getTime() > REFRESH_INTERVAL_MS)
      for (let i = 0; i < stale.length; i += CONCURRENCY) {
        await Promise.allSettled(stale.slice(i, i + CONCURRENCY).map(s =>
          refreshPodcastFeed(s.id).catch(err => logger.warn(`[podcast-rss] refresh failed for ${s.id}: ${err}`))))
      }
    } catch (err) {
      logger.warn(`[podcast-rss] poller error: ${err}`)
    } finally {
      _polling = false
    }
  }, 60_000)  // wake every minute; per-show staleness gating decides what actually fetches
}

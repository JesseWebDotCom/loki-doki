import { Hono } from 'hono'
import type { Context } from 'hono'
import { readFile, stat, readdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { eq, ne, and, or, desc, inArray, notInArray } from 'drizzle-orm'
import { db } from '@/db'
import { ytSubscriptions, ytVideos, ytDownloads, ytWatchState, ytCollections, ytChannelCache, users, userPreferences, podcastShows, podcastEpisodes, podcastEpisodeSources, downloadJobs, musicOfflineStationTracks, plexLibrarySections } from '@/db/schema'
import { requireAuth, requireAdmin } from '@/middleware/auth'
import { youtubeTool } from '@/tools/youtube'
import { resolveToolConfig } from '@/lib/toolConfig'
import { cleanAutoTitle } from '@/lib/cleanTitle'
import { resolveYouTubeInput, parseTakeoutCsv } from '@/lib/youtube/resolve'
import { refreshUserFeeds, refreshSubscriptionFeed, backfillAllThumbnails } from '@/lib/youtube/feed'
import { getTranscriptText, formatTranscript } from '@/lib/youtube/transcript'
import { ensureSummary, ensureSmartDescription, backfillCollectionChannelThumbs, backfillHistoryChannelThumbs } from '@/lib/youtube/summarize'
import { ensureRelatedTopics } from '@/lib/youtube/relatedTopics'
import { serveYtRecommendedDeep, serveYtHomeShelves } from '@/lib/interests/videos'
import { peekPool } from '@/lib/interests/pool'
import { buildChannelProfiles, subscriptionTopics } from '@/lib/interests/channelProfiles'
import { exportsDir, backfillSavedHeights, backfillSavedChannelThumbs, ensureTranscript } from '@/lib/youtube/download'
import { backfillDurations } from '@/lib/youtube/durations'
import { innertubeChannel, innertubeChannelPlaylists, innertubeChannelAbout, innertubeChannelAvatar, innertubeRelated, innertubePlayerMeta, innertubePlayerStoryboards, innertubeComments, innertubeChapters, innertubeHeatmap, innertubeSearchMore, innertubePlaylist, innertubeSearch, innertubeMovies, innertubeLoudnessDb, SEARCH_FILTERS, tryInnertube, tryInnertubeRetry, type ItVideo, type ItChannel, type ItPlaylist, type ItChannelPage } from '@/lib/youtube/innertube'
import { cachedLookup } from '@/lib/lookupCache'
import { fetchPopular, fetchTrending, enrichChannelThumbs } from '@/lib/youtube/discovery'
import { getSkipSegments, getUserSkipModes } from '@/lib/youtube/sponsorblock'
import { peekAiChapters, kickAiChapters } from '@/lib/youtube/aiChapters'
import { peekRecap, kickRecap, recapBucket } from '@/lib/youtube/recap'
import { peekFiller, kickFiller } from '@/lib/youtube/filler'
import { peekAsk, kickAsk } from '@/lib/youtube/askVideo'
import { peekPopupFacts, kickPopupFacts } from '@/lib/youtube/popupFacts'
import { kickTriviaIngest, triviaIngestStatus } from '@/lib/imdb/ingest'
import { peekWorth, kickWorth } from '@/lib/youtube/worthIt'
import { getVotes } from '@/lib/youtube/returndislike'
import { getDeArrowBatch, getOrFetchDeArrowThumb, deArrowThumbKey } from '@/lib/youtube/dearrow'
import { honestTitlesFor, ensureHonestTitle } from '@/lib/youtube/honestTitle'
import { getOrFetchImageResized, sizedChannelArtUrl } from '@/lib/youtube/imageCache'
import { resolveStreamUrl, invalidateStreamUrl, resolveStreamPreviewUrl, resolveSplitStreamUrls, invalidateSplitStreamUrls, probeKeyframeBefore, isValidVideoId, parseQuality, REMUX_QUALITIES, type StreamKind } from '@/lib/youtube/stream'
import { getHlsPresentation, refreshHlsTrackUrl, hlsMasterPlaylist, hlsMediaPlaylist, hlsIframePlaylist, hlsSubtitlePlaylist, type HlsVideoVariant } from '@/lib/youtube/hls'
import { getTranscodePlan, getTranscodeSegment, getTranscodeInit, hevcMasterPlaylist, hevcMediaPlaylist, TRANSCODE_HEIGHTS, type SegmentResult } from '@/lib/youtube/hlsTranscode'
import { ensureFfmpeg, ffmpegBin } from '@/lib/ffmpeg'
import { ytDlpBin, getYtDlpStatus, ensureYtDlp, withYtDlpSlot, getCookiesStatus, saveCookiesFile, clearCookiesFile } from '@/lib/ytdlp'
import {
  SAVE_HEIGHTS, getGlobalCap, getUserCapOverride, getEffectiveCap,
  getUserPreference, DEFAULT_GLOBAL_CAP,
} from '@/lib/youtube/quality'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { ytDlpAuthArgs } from '@/lib/ytdlp'
import { filterYtItemsForUser, videoAllowedForUser } from '@/lib/videos/policy'
import { getVideoViewFlags } from '@/lib/videos/viewFlags'
import { checkVideoTime, recordWatchBeat } from '@/lib/videos/watchTime'
import { ensureVideoIndexed } from '@/lib/videos/semanticIndex'
import { TRANSLATE_LANGUAGES, languageLabel, translateVtt } from '@/lib/videos/translate'
import { videoPolicyFor } from '@/lib/media/policyTier'
import { logger } from '@/lib/logger'
import {
  enqueueVideoSave, cancelVideoSaves, createYoutubeEpisode,
  isAutomationPaused, setAutomationPaused, getAutoSaveKeepDefault, AUTO_KEEP_KEY,
} from '@/lib/youtube/automation'
import { resolveUserPath, userPath } from '@/lib/storage/paths'
import { resolvePlaybackBlob, releaseAssetsIfOrphaned, enhancedStatusForAssets, AUDIO_FORMATS, type AudioFormat } from '@/lib/youtube/assets'
import { startLiveRecording, getLiveStatus, stopLiveRecording } from '@/lib/youtube/live'
import { getYoutubeSuggestions } from '@/lib/youtube/suggest'
import { getAccountRow, getLinkFlow, getValidAccessToken, startAccountLink, cancelLinkFlow, unlinkAccount } from '@/lib/youtube/account'
// Type-only: the runtime tvClient module stays dynamically imported (account-scoped, lazy).
import type { TvVideo } from '@/lib/youtube/tvClient'
import { syncAccount, pushSubscribe, pushUnsubscribe, pushCollectionChange } from '@/lib/youtube/accountSync'
import { ytAccounts } from '@/db/schema'
import { acquireRead, releaseRead } from '@/lib/content/store'
import { ollamaChat } from '@/llm/ollama'
import { getFastModel } from '@/lib/models'
import type { AppEnv } from '@/types'

const youtubeRoute = new Hono<AppEnv>()
youtubeRoute.use('*', requireAuth)

// ── Helper ────────────────────────────────────────────────────────────────────

async function getUserFirstName(userId: string): Promise<string> {
  const [u] = await db.select({ firstName: users.firstName }).from(users).where(eq(users.id, userId)).limit(1)
  return u?.firstName ?? 'user'
}

// refId / progress are server-written JSON, but a single malformed row shouldn't 500 the
// whole endpoint — parse defensively and treat garbage as "not found".
function safeJson<T>(raw: string | null): T | null {
  if (!raw) return null
  try { return JSON.parse(raw) as T } catch { return null }
}

// Fire-and-forget: top up a ytVideos row whose caption stats never landed (stub rows from
// watch-state / ensureChannelThumb carry no views/publishedAt, and the /video fast path
// short-circuits on description alone, so they'd otherwise never heal). Deduped per
// process so heartbeat-frequency callers don't hammer InnerTube for the same video.
const statsBackfillTried = new Set<string>()
async function backfillVideoStats(videoId: string): Promise<void> {
  if (statsBackfillTried.has(videoId)) return
  statsBackfillTried.add(videoId)
  const [row] = await db.select({ views: ytVideos.views, publishedAt: ytVideos.publishedAt, durationSec: ytVideos.durationSec })
    .from(ytVideos).where(eq(ytVideos.videoId, videoId)).limit(1)
  if (!row || (row.views != null && row.publishedAt != null)) return
  const meta = await tryInnertube('statsBackfill', () => innertubePlayerMeta(videoId), null)
  if (!meta) return
  const patch: Partial<typeof ytVideos.$inferInsert> = {}
  if (row.views == null && meta.views) patch.views = meta.views
  if (row.publishedAt == null && meta.publishedAt) patch.publishedAt = meta.publishedAt
  if (row.durationSec == null && meta.durationSec != null) patch.durationSec = meta.durationSec
  if (Object.keys(patch).length > 0) await db.update(ytVideos).set(patch).where(eq(ytVideos.videoId, videoId)).catch(() => {})
}

// Map InnerTube shapes to the frontend's search-result shapes (shared by the typed +
// "load more" search paths).
const itVideoResult = (v: ItVideo) => ({
  title: v.title, url: `https://www.youtube.com/watch?v=${v.videoId}`, videoId: v.videoId,
  snippet: v.author ?? '', embedUrl: `https://www.youtube.com/embed/${v.videoId}`,
  author: v.author ?? undefined, channelId: v.channelId ?? undefined, channelThumb: v.channelThumb,
  thumbnailUrl: v.thumbnailUrl,
  durationSec: v.durationSec, publishedText: v.publishedText, views: v.views,
  publishedAt: v.publishedAt ?? null,
})
const itChannelResult = (ch: ItChannel) => ({
  channelId: ch.channelId, title: ch.title, handle: ch.handle, thumbnailUrl: ch.thumbnailUrl,
  subscribers: ch.subscribers, url: `https://www.youtube.com/channel/${ch.channelId}`,
})
const itPlaylistResult = (p: ItPlaylist) => ({
  playlistId: p.playlistId, title: p.title, videoCount: p.videoCount, thumbnailUrl: p.thumbnailUrl,
  author: p.author, channelId: p.channelId, url: `https://www.youtube.com/playlist?list=${p.playlistId}`,
})

// Query autosuggest for the SmartSearch header dropdown — per-keystroke, so it leans on
// the lib's LRU cache; a short private browser cache dedupes retyped prefixes too.
youtubeRoute.get('/suggest', async (c) => {
  c.header('cache-control', 'private, max-age=60')
  const q = c.req.query('q')?.trim()
  if (!q) return c.json({ suggestions: [] })
  return c.json({ suggestions: await getYoutubeSuggestions(q) })
})

// ── Search (existing) ─────────────────────────────────────────────────────────

/**
 * YouTube's film catalogue: the real store entries, not a keyword search
 * over uploads. Each carries the official title, year, genre, certificate,
 * cast, director, runtime and synopsis, plus whether it is free with ads
 * (Jesse, 2026-08-07: "it seems like you are doing a generic youtube movie
 * search as opposed to showing the movies youtube has on their channel").
 */
/**
 * Whether films may resolve through the hub's YouTube cookies. Off by
 * default: normal viewing stays anonymous so one personal session isn't
 * forced onto shared household traffic. Films are the exception because
 * YouTube publishes no playable formats for them otherwise.
 */
const MOVIE_AUTH_KEY = 'youtube.movie_auth'

export async function movieAuthEnabled(): Promise<boolean> {
  return (await getAppSetting(MOVIE_AUTH_KEY)) === 'true' && ytDlpAuthArgs().length > 0
}

youtubeRoute.get('/movie-auth', async (c) => {
  return c.json({
    enabled: (await getAppSetting(MOVIE_AUTH_KEY)) === 'true',
    // Without a cookies.txt the toggle can be on and still do nothing, so
    // the apps can say which it is.
    haveCookies: ytDlpAuthArgs().length > 0,
  })
})

youtubeRoute.post('/movie-auth', requireAdmin, async (c) => {
  const body = await c.req.json<{ enabled?: boolean }>().catch(() => ({}))
  await setAppSetting(MOVIE_AUTH_KEY, body.enabled ? 'true' : 'false')
  return c.json({ enabled: !!body.enabled, haveCookies: ytDlpAuthArgs().length > 0 })
})

youtubeRoute.get('/movies', async (c) => {
  c.header('cache-control', 'private, max-age=300')
  const genre = c.req.query('genre')?.trim() || 'movies'
  const cursor = c.req.query('cursor') || null
  // Free-with-ads only unless the caller asks for everything.
  const freeOnly = c.req.query('all') !== '1'
  try {
    const page = await innertubeMovies(genre, 40, 12_000, cursor)
    let movies = freeOnly ? page.movies.filter((m) => m.free) : page.movies
    // A keyword query drags in the adjacent ("comedy" returns stand-up
    // specials, "classic" returns music documentaries). Each record carries
    // its own store genre, so prefer the ones that actually match - unless
    // that would leave the shelf nearly empty.
    const wanted = genre.toLowerCase().split(' ')[0]
    const onGenre = movies.filter((m) => (m.genre ?? '').toLowerCase().includes(wanted))
    if (onGenre.length >= 4) movies = onGenre
    return c.json({ movies, continuation: page.continuation })
  } catch {
    return c.json({ movies: [], continuation: null, error: 'unavailable' }, 200)
  }
})

youtubeRoute.get('/search', async (c) => {
  const user = c.get('user')
  c.header('cache-control', 'private, max-age=60')
  const q = c.req.query('q')?.trim()
  const cursor = c.req.query('cursor')

  // "Load more": page straight off the InnerTube continuation token (keyless path only).
  // A continuation only replays the result type of the search it came from, so a
  // Channels/Playlists-filtered search needs its type re-passed to keep collecting those.
  if (cursor) {
    const cursorType = c.req.query('type') as keyof typeof SEARCH_FILTERS | undefined
    // Cached like page 1 below (back/forward and both search surfaces replay the same
    // token). Tokens run hundreds of chars and are case-sensitive base64, so hash them
    // here — cachedLookup's own keying lowercases before hashing.
    const cursorKey = createHash('sha256').update(`${cursorType ?? ''}:${cursor}`).digest('hex')
    const page = await cachedLookup('youtube:searchMore', cursorKey, 10 * 60_000, () => tryInnertube('searchMore',
      () => innertubeSearchMore(cursor, 24, 8000, cursorType === 'channels' ? 24 : 0, cursorType === 'playlists' ? 30 : 0),
      { videos: [], channels: [], playlists: [], continuation: null }))
    const videos = cursorType === 'shorts' ? page.videos.filter(v => v.durationSec == null || v.durationSec <= 90) : page.videos
    const safeVideos = await filterYtItemsForUser(user.id, videos)
    return c.json({ results: safeVideos.map(itVideoResult), channels: page.channels.map(itChannelResult), playlists: page.playlists.map(itPlaylistResult), continuation: page.continuation })
  }

  if (!q) return c.json({ results: [], error: 'Query required' }, 400)

  // Typed search (Videos / Shorts / Playlists / Channels chips) — restrict to one result
  // type via the InnerTube filter param. Keyless InnerTube only. Cached (20min, matching
  // the other providers' warm-cycle-safe TTL): the Videos hub's unified category chips
  // repeat these exact (type, label) pairs constantly (e.g. type=videos, q="Comedy"), so an
  // uncached live search on every click was a real, avoidable ~0.6-1.2s per category.
  const type = c.req.query('type') as keyof typeof SEARCH_FILTERS | undefined
  if (type && SEARCH_FILTERS[type]) {
    // Kid-safe: on a kid/teen profile, ask YouTube for Restricted-Mode results. The shared
    // cache is keyed by the `safe` flag so restricted and unrestricted variants never clobber.
    const safe = (await videoPolicyFor(user.id)).restrictedMode
    const page = await cachedLookup('youtube:search', `${type}:${q.toLowerCase()}:${safe ? 's' : 'o'}`, 20 * 60_000, () => tryInnertube('typedSearch',
      () => innertubeSearch(q, 36, type === 'channels' ? 24 : 0, 8000, type === 'playlists' ? 30 : 0, SEARCH_FILTERS[type], safe),
      { videos: [], channels: [], playlists: [], continuation: null }))
    const videos = type === 'shorts' ? page.videos.filter(v => v.durationSec == null || v.durationSec <= 90) : page.videos
    const safeVideos = await filterYtItemsForUser(user.id, videos)
    return c.json({
      results: safeVideos.map(itVideoResult),
      channels: page.channels.map(itChannelResult),
      playlists: page.playlists.map(itPlaylistResult),
      continuation: page.continuation,
    })
  }

  // The browse grid wants a full page of results, not the chat assistant's default of 5.
  const n = Math.min(40, Math.max(1, parseInt(c.req.query('n') ?? '24', 10)))
  const config = await resolveToolConfig('youtube', user.id)
  config['_userId'] = user.id
  const result = await youtubeTool.execute({ query: q, max_results: n }, config)
  if (!result.success) return c.json({ results: [], channels: [], error: result.error ?? 'Search failed' })

  const data = result.data as { videos: unknown[]; channels?: unknown[]; playlists?: unknown[]; continuation?: string | null } | undefined
  const vids = (data?.videos ?? []) as Array<{ videoId: string; title: string; author?: string | null; channelId?: string | null }>
  const safeVids = await filterYtItemsForUser(user.id, vids.map(v => ({ ...v, author: v.author ?? null })))
  return c.json({ results: safeVids, channels: data?.channels ?? [], playlists: data?.playlists ?? [], continuation: data?.continuation ?? null })
})

// Keep old path alive for the existing frontend
youtubeRoute.get('/', async (c) => {
  const user = c.get('user')
  const q = c.req.query('q')?.trim()
  if (!q) return c.json({ results: [] })

  const config = await resolveToolConfig('youtube', user.id)
  config['_userId'] = user.id
  const result = await youtubeTool.execute({ query: q }, config)
  const data = result.data as { videos: unknown[] } | undefined
  return c.json({ results: data?.videos ?? [] })
})

// ── Image proxy (read-through cache) ────────────────────────────────────────────
// Serve YouTube thumbnails/avatars/banners same-origin so they can be drawn onto a
// <canvas> (podcast covers) without tainting it, and without the browser contacting
// Google. Backed by a disk cache (lib/youtube/imageCache.ts): a miss fetches + stores,
// hits serve straight off disk. Eviction/renewal is handled by the maintenance pass.
youtubeRoute.get('/img', async (c) => {
  const u = c.req.query('u')
  if (!u) return c.json({ error: 'missing u' }, 400)
  let url: URL
  try { url = new URL(u) } catch { return c.json({ error: 'bad url' }, 400) }
  const allowed = /(^|\.)(ytimg\.com|ggpht\.com|googleusercontent\.com|youtube\.com)$/i.test(url.hostname)
  if (url.protocol !== 'https:' || !allowed) return c.json({ error: 'forbidden host' }, 403)
  const w = c.req.query('w')

  // Video thumbnails (i.ytimg.com/vi/<id>/…) are immutable per id, so they get the long
  // immutable lifetime plus a strong ETag derived from the request (URL + width) — which
  // lets a revalidating client 304 without us touching disk at all. Channel avatars and
  // banners CAN change at a stable URL, so they get a shorter lifetime, but a week, not
  // a day: Google rotates the URL on most art changes anyway, the maintenance pass keeps
  // the server copy fresh, and daily full re-downloads on phones (whose HTTP cache is the
  // only cache over http, no service worker) were a real slow-network cost. Their
  // stale-while-revalidate window keeps paint instant while the refresh happens behind it.
  const isVideoThumb = /(^|\.)ytimg\.com$/i.test(url.hostname) && url.pathname.startsWith('/vi/')
  const cacheControl = isVideoThumb
    ? 'public, max-age=2592000, immutable'
    : 'public, max-age=604800, stale-while-revalidate=2592000'
  if (isVideoThumb) {
    const etag = `"${createHash('sha256').update(`${url}|w=${w ?? ''}`).digest('hex').slice(0, 32)}"`
    if (c.req.header('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { etag, 'cache-control': cacheControl } })
    }
    const img = await getOrFetchImageResized(url.toString(), w)
    if (!img) return c.json({ error: 'upstream' }, 502)
    return new Response(img.data as unknown as BodyInit, {
      headers: { 'content-type': img.contentType, 'cache-control': cacheControl, etag },
    })
  }

  // Channel art with a width hint: let Google's CDN serve the small square directly
  // (=sNNN) rather than pulling the ~900px original and downscaling it here. The rewritten
  // URL is a real URL, so it caches under its own key with no special casing; when it is
  // not rewritable (banners, odd URLs) we fall back to the vips path with `w`.
  const sized = sizedChannelArtUrl(url.toString(), w)
  const img = await getOrFetchImageResized(sized ?? url.toString(), sized ? undefined : w)
  if (!img) return c.json({ error: 'upstream' }, 502)
  // Strong ETag over the BYTES (channel art is mutable at a stable URL, so a URL-derived
  // tag would 304 stale copies forever): an unchanged avatar/banner revalidates for free,
  // a changed one still comes through in full.
  const etag = `"${createHash('sha256').update(img.data).digest('hex').slice(0, 32)}"`
  if (c.req.header('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { etag, 'cache-control': cacheControl } })
  }
  // Buffer is a valid body at runtime; the cast sidesteps a TS Buffer-generic mismatch.
  return new Response(img.data as unknown as BodyInit, {
    headers: {
      'content-type': img.contentType,
      // Server holds the canonical copy and revalidates/evicts it; the browser holds its
      // own for a week (see cacheControl above) so repeat views don't even hit us.
      'cache-control': cacheControl,
      etag,
    },
  })
})

// ── Subscriptions ─────────────────────────────────────────────────────────────

youtubeRoute.get('/subscriptions', async (c) => {
  const user = c.get('user')
  const subs = await db.select().from(ytSubscriptions)
    .where(eq(ytSubscriptions.userId, user.id))
    .orderBy(ytSubscriptions.title)
  return c.json({ subscriptions: subs })
})

youtubeRoute.post('/subscriptions', async (c) => {
  const user = c.get('user')
  const { input } = await c.req.json<{ input: string }>()
  if (!input?.trim()) return c.json({ error: 'input required' }, 400)

  let resolved
  try {
    resolved = await resolveYouTubeInput(input)
  } catch (err: any) {
    return c.json({ error: `Could not resolve "${input}": ${err?.message ?? err}` }, 422)
  }

  const now = new Date()
  const id = crypto.randomUUID()
  await db.insert(ytSubscriptions).values({
    id,
    userId: user.id,
    kind: resolved.kind,
    externalId: resolved.externalId,
    title: resolved.title,
    handle: resolved.handle,
    thumbnailUrl: resolved.thumbnailUrl,
    description: resolved.description,
    addedAt: now,
  }).onConflictDoNothing()

  // Fetch feed immediately in background
  void refreshSubscriptionFeed(id).catch(() => {})
  // Mirror to the linked YouTube account (no-op when none / push disabled).
  if (resolved.kind === 'channel') pushSubscribe(user.id, resolved.externalId)

  return c.json({ ok: true, subscription: { id, ...resolved } })
})

youtubeRoute.post('/subscriptions/import', async (c) => {
  const user = c.get('user')
  const body = await c.req.text()   // CSV text uploaded as plain text/csv or form body
  if (!body.trim()) return c.json({ error: 'CSV body required' }, 400)

  const records = parseTakeoutCsv(body)
  if (!records.length) return c.json({ error: 'No valid channel IDs found in CSV' }, 422)

  const now = new Date()
  let created = 0
  for (const r of records) {
    const id = crypto.randomUUID()
    const result = await db.insert(ytSubscriptions).values({
      id,
      userId: user.id,
      kind: r.kind,
      externalId: r.externalId,
      title: r.title,
      handle: r.handle,
      thumbnailUrl: r.thumbnailUrl,
      description: r.description,
      addedAt: now,
    }).onConflictDoNothing()
    if ((result as any).changes > 0) {
      created++
      void refreshSubscriptionFeed(id).catch(() => {})
    }
  }

  return c.json({ ok: true, imported: records.length, created })
})

youtubeRoute.delete('/subscriptions/:id', async (c) => {
  const user = c.get('user')
  const subId = c.req.param('id')
  // Capture the channel id before deleting so we can clean up its cached page.
  const [sub] = await db.select({ externalId: ytSubscriptions.externalId, kind: ytSubscriptions.kind })
    .from(ytSubscriptions).where(and(eq(ytSubscriptions.id, subId), eq(ytSubscriptions.userId, user.id)))
  await db.delete(ytSubscriptions)
    .where(and(eq(ytSubscriptions.id, subId), eq(ytSubscriptions.userId, user.id)))
  // The channel-page cache is global/shared — only drop it once nobody follows the
  // channel anymore, so we don't churn it for other users who still do.
  if (sub?.kind === 'channel') {
    const [stillFollowed] = await db.select({ id: ytSubscriptions.id }).from(ytSubscriptions)
      .where(eq(ytSubscriptions.externalId, sub.externalId)).limit(1)
    if (!stillFollowed) await db.delete(ytChannelCache).where(eq(ytChannelCache.channelId, sub.externalId))
    // Mirror to the linked YouTube account (no-op when none / push disabled).
    pushUnsubscribe(user.id, sub.externalId)
  }
  return c.json({ ok: true })
})

// Update a subscription's automation settings (auto-save on/off, format, keep-N override).
// Off by default; auto-save applies to NEW uploads going forward, not the existing feed.
youtubeRoute.patch('/subscriptions/:id', async (c) => {
  const user = c.get('user')
  const subId = c.req.param('id')
  const body = (await c.req.json().catch(() => ({}))) as { autoSave?: boolean; autoSaveKind?: 'audio' | 'video'; autoSaveKeep?: number | null; removeWatched?: boolean; autoTranscribe?: boolean }

  const [sub] = await db.select({ id: ytSubscriptions.id }).from(ytSubscriptions)
    .where(and(eq(ytSubscriptions.id, subId), eq(ytSubscriptions.userId, user.id))).limit(1)
  if (!sub) return c.json({ error: 'Not found' }, 404)

  const patch: Partial<typeof ytSubscriptions.$inferInsert> = {}
  if (typeof body.autoSave === 'boolean') patch.autoSave = body.autoSave
  if (body.autoSaveKind === 'audio' || body.autoSaveKind === 'video') patch.autoSaveKind = body.autoSaveKind
  if (typeof body.removeWatched === 'boolean') patch.removeWatched = body.removeWatched
  if (typeof body.autoTranscribe === 'boolean') patch.autoTranscribe = body.autoTranscribe
  if (body.autoSaveKeep === null) patch.autoSaveKeep = null
  else if (typeof body.autoSaveKeep === 'number' && Number.isFinite(body.autoSaveKeep)) {
    patch.autoSaveKeep = Math.max(0, Math.floor(body.autoSaveKeep))
  }
  if (!Object.keys(patch).length) return c.json({ ok: true })

  await db.update(ytSubscriptions).set(patch).where(eq(ytSubscriptions.id, subId))
  return c.json({ ok: true })
})

youtubeRoute.post('/subscriptions/:id/refresh', async (c) => {
  const user = c.get('user')
  const subId = c.req.param('id')
  // Verify ownership
  const [sub] = await db.select({ id: ytSubscriptions.id }).from(ytSubscriptions)
    .where(and(eq(ytSubscriptions.id, subId), eq(ytSubscriptions.userId, user.id))).limit(1)
  if (!sub) return c.json({ error: 'Not found' }, 404)

  const count = await refreshSubscriptionFeed(subId)
  return c.json({ ok: true, newVideos: count })
})

youtubeRoute.post('/subscriptions/refresh-all', async (c) => {
  const user = c.get('user')
  await refreshUserFeeds(user.id)
  return c.json({ ok: true })
})

youtubeRoute.post('/subscriptions/backfill-thumbnails', requireAdmin, async (c) => {
  void backfillAllThumbnails().catch(() => {})
  return c.json({ ok: true })
})

// ── Automation master switch ─────────────────────────────────────────────────
// Per-user pause freezes ALL automation (auto-save + auto-podcast) without losing any
// per-subscription/per-show settings, so unpausing resumes exactly where it left off.
// keepDefault is the global rolling "keep latest N auto-saved" cap (admin-managed).

youtubeRoute.get('/automation', async (c) => {
  const user = c.get('user')
  const [paused, keepDefault] = await Promise.all([isAutomationPaused(user.id), getAutoSaveKeepDefault()])
  return c.json({ paused, keepDefault, isAdmin: user.role === 'admin' })
})

youtubeRoute.put('/automation', async (c) => {
  const user = c.get('user')
  const body = (await c.req.json().catch(() => ({}))) as { paused?: boolean; keepDefault?: number }

  if (typeof body.paused === 'boolean') await setAutomationPaused(user.id, body.paused)
  // The global keep-N default is an app-wide cap → admin only (mirrors save-quality limits).
  if (typeof body.keepDefault === 'number' && Number.isFinite(body.keepDefault)) {
    if (user.role !== 'admin') return c.json({ error: 'Forbidden' }, 403)
    await setAppSetting(AUTO_KEEP_KEY, Math.max(1, Math.floor(body.keepDefault)))
  }
  return c.json({ ok: true })
})

// ── Feed ──────────────────────────────────────────────────────────────────────

youtubeRoute.get('/feed', async (c) => {
  const user = c.get('user')
  const limit = Math.min(100, parseInt(c.req.query('limit') ?? '50', 10))
  const offset = parseInt(c.req.query('offset') ?? '0', 10)

  // Get all subscriptions for this user.
  const subs = await db.select({ id: ytSubscriptions.id, externalId: ytSubscriptions.externalId, kind: ytSubscriptions.kind })
    .from(ytSubscriptions).where(eq(ytSubscriptions.userId, user.id))

  if (!subs.length) return c.json({ videos: [], total: 0 })

  const subIds = subs.map(s => s.id)
  // A channel subscription's externalId IS the video's channelId. Match on that too, so
  // videos inserted by non-poller paths (watch history, search) with a *null*
  // subscriptionId still surface under the right subscription instead of vanishing.
  const channelExtIds = subs.filter(s => s.kind === 'channel').map(s => s.externalId)
  const matchConds = [inArray(ytVideos.subscriptionId, subIds)]
  if (channelExtIds.length) matchConds.push(inArray(ytVideos.channelId, channelExtIds))

  // Join the subscription by channelId so each video carries its *channel's* avatar
  // (channelThumb) — works whether or not the row's subscriptionId was set.
  let rows = await db.select({ video: ytVideos, channelThumb: ytSubscriptions.thumbnailUrl })
    .from(ytVideos)
    .leftJoin(ytSubscriptions, and(eq(ytSubscriptions.externalId, ytVideos.channelId), eq(ytSubscriptions.userId, user.id)))
    .where(or(...matchConds))
    .orderBy(desc(ytVideos.publishedAt))
    .limit(limit)
    .offset(offset)

  // Follow levels (youtube.follow_levels pref: {channelId: level}): a channel can
  // stay subscribed while its feed presence is trimmed. quiet drops everything,
  // live keeps only live items, major drops Shorts and sub-4-minute uploads.
  try {
    const [levelRow] = await db.select({ value: userPreferences.value }).from(userPreferences)
      .where(and(eq(userPreferences.userId, user.id), eq(userPreferences.key, 'youtube.follow_levels')))
      .limit(1)
    const levels = levelRow ? JSON.parse(levelRow.value) as Record<string, string> : {}
    if (Object.keys(levels).length) {
      rows = rows.filter((r) => {
        const level = levels[r.video.channelId ?? ''] ?? 'all'
        // Live rows carry no duration in the feed, which doubles as the live proxy.
        const isLiveish = (r.video.durationSec ?? 0) === 0
        if (level === 'quiet') return false
        if (level === 'live') return isLiveish
        if (level === 'major') return (r.video.durationSec ?? 0) >= 240 || isLiveish
        return true
      })
    }
  } catch { /* malformed pref never breaks the feed */ }

  // Attach watch state
  const videoIds = rows.map(r => r.video.videoId)
  const watchRows = videoIds.length
    ? await db.select().from(ytWatchState)
        .where(and(eq(ytWatchState.userId, user.id), inArray(ytWatchState.videoId, videoIds)))
    : []
  const watchMap = new Map(watchRows.map(w => [w.videoId, w]))

  const result = rows.map(r => ({
    ...r.video,
    channelThumb: r.channelThumb,
    watchState: watchMap.get(r.video.videoId) ?? null,
  }))

  // Kid-safe: a subscribed channel can still post a mature upload — filter the feed too.
  return c.json({ videos: await filterYtItemsForUser(user.id, result) })
})

// The linked account's REAL Subscriptions feed (Google's own newest-uploads roll),
// an alternative to the RSS-built /feed above: it covers channels the poller hasn't
// caught up on and honors the account's own ordering. Item shape mirrors /feed as
// closely as the TV response allows (no publishedAt timestamp, only relative text).
youtubeRoute.get('/feed/account', async (c) => {
  const user = c.get('user')
  const token = await getValidAccessToken(user.id).catch(() => null)
  if (!token) return c.json({ error: 'not linked' }, 404)
  const { fetchSubscriptionsFeed } = await import('@/lib/youtube/tvClient')
  const items = await cachedLookup('yt-account-subfeed', user.id, 10 * 60_000,
    () => fetchSubscriptionsFeed(token, 60)).catch(() => [] as TvVideo[])

  // Watch state in one query, exactly like /feed.
  const videoIds = items.map(v => v.videoId)
  const watchRows = videoIds.length
    ? await db.select().from(ytWatchState)
        .where(and(eq(ytWatchState.userId, user.id), inArray(ytWatchState.videoId, videoIds)))
    : []
  const watchMap = new Map(watchRows.map(w => [w.videoId, w]))

  const mapped = items.map(v => ({
    id: v.videoId,
    videoId: v.videoId,
    title: v.title,
    author: v.author,
    channelId: v.channelId,
    thumbnailUrl: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
    durationSec: v.durationSec,
    views: v.views,
    publishedText: v.publishedText,
    publishedAt: null,
    channelThumb: null,
    watchState: watchMap.get(v.videoId) ?? null,
  }))
  return c.json({ videos: await filterYtItemsForUser(user.id, mapped) })
})

// Backfill video durations (RSS feeds omit them) so the UI can split Shorts from
// regular videos. Best-effort: yt-dlp prints id+duration without downloading media.
// Bounded per call; the frontend calls it lazily for what's on screen.
youtubeRoute.post('/durations', async (c) => {
  const { videoIds } = await c.req.json<{ videoIds: string[] }>().catch(() => ({ videoIds: [] as string[] }))
  const durations = await backfillDurations(videoIds ?? [])
  return c.json({ durations })
})

// ── Downloads ─────────────────────────────────────────────────────────────────

// The Offline library. Enrich each saved row with author/publishedAt from ytVideos
// (when the video is also in a feed) so the cards match the Online look.
youtubeRoute.get('/downloads', async (c) => {
  const user = c.get('user')
  // Music saves (station snapshots + à-la-carte song saves) reuse the shared save pipeline, so
  // they land in ytDownloads too — but they belong to the Music app's offline library, not
  // YouTube's. The Saved tab shows only videos saved from within YouTube. New music saves are
  // tagged origin='music' (filtered below); the station-track videoIds cover rows saved BEFORE
  // the origin column existed. Rows still exist + serve offline music via /api/music/library/offline.
  const stationTrackRows = await db.select({ videoId: musicOfflineStationTracks.videoId })
    .from(musicOfflineStationTracks).where(eq(musicOfflineStationTracks.userId, user.id))
  const stationVideoIds = [...new Set(stationTrackRows.map(r => r.videoId))]
  const rows = await db.select({
    id: ytDownloads.id,
    assetId: ytDownloads.assetId,
    videoId: ytDownloads.videoId,
    title: ytDownloads.title,
    kind: ytDownloads.kind,
    status: ytDownloads.status,
    sizeBytes: ytDownloads.sizeBytes,
    maxHeight: ytDownloads.maxHeight,
    createdAt: ytDownloads.createdAt,
    author: ytVideos.author,
    channelId: ytVideos.channelId,
    publishedAt: ytVideos.publishedAt,
    durationSec: ytVideos.durationSec,
    views: ytVideos.views,
    // Channel avatar so Offline cards/rails show real logos exactly like the Online feed.
    // Prefer the subscription's stored thumbnail; fall back to the avatar resolved + warmed
    // at save time (yt_videos.channel_thumb), which covers non-subscribed channels too.
    channelThumbSub: ytSubscriptions.thumbnailUrl,
    channelThumbVid: ytVideos.channelThumb,
  })
    .from(ytDownloads)
    .leftJoin(ytVideos, eq(ytVideos.videoId, ytDownloads.videoId))
    .leftJoin(ytSubscriptions, and(eq(ytSubscriptions.externalId, ytVideos.channelId), eq(ytSubscriptions.userId, user.id)))
    // Exclude transient music prefetch-cache refs and music-originated saves — neither is part
    // of the user's YouTube saved library.
    .where(and(
      eq(ytDownloads.userId, user.id),
      eq(ytDownloads.prefetch, false),
      ne(ytDownloads.origin, 'music'),
      ...(stationVideoIds.length ? [notInArray(ytDownloads.videoId, stationVideoIds)] : []),
    ))
    .orderBy(desc(ytDownloads.createdAt))

  // Attach watch state via a separate query (same approach as /feed).
  const videoIds = rows.map(r => r.videoId)
  const watchRows = videoIds.length
    ? await db.select().from(ytWatchState).where(and(eq(ytWatchState.userId, user.id), inArray(ytWatchState.videoId, videoIds)))
    : []
  const watchMap = new Map(watchRows.map(w => [w.videoId, w]))

  // Real download progress (0..1) for in-flight saves, so the Offline view can show a
  // live bar instead of hiding the item until it flips to 'ready'. Progress lives on the
  // coalesced yt-media job keyed by refId={assetId}; fetch the active ones and map by asset.
  const activeAssetIds = new Set(rows.filter(r => (r.status === 'pending' || r.status === 'downloading') && r.assetId).map(r => r.assetId!))
  const progressByAsset = new Map<string, number>()
  if (activeAssetIds.size) {
    const jobs = await db.select({ refId: downloadJobs.refId, progress: downloadJobs.progress })
      .from(downloadJobs)
      .where(and(eq(downloadJobs.type, 'yt-media'), inArray(downloadJobs.status, ['pending', 'running'])))
    for (const j of jobs) {
      try {
        const { assetId } = JSON.parse(j.refId) as { assetId?: string }
        if (!assetId || !activeAssetIds.has(assetId) || !j.progress) continue
        const p = JSON.parse(j.progress) as { completed?: number; total?: number }
        if (p.total && p.total > 0 && typeof p.completed === 'number') {
          progressByAsset.set(assetId, Math.max(0, Math.min(1, p.completed / p.total)))
        }
      } catch { /* skip malformed job/progress rows */ }
    }
  }

  // Enhanced-rendition status for the "Enhancing…/Enhanced" chip (video rows only).
  const enhanceMap = await enhancedStatusForAssets(
    rows.filter(r => r.kind === 'video' && r.assetId).map(r => r.assetId!),
  )

  // Live progress (0..1) for in-flight enhance re-encodes, keyed by BASE assetId (the media-enhance
  // job's refId is { assetId } of the base video). Lets the "Enhancing…" chip show a real percentage.
  const enhanceProgressByAsset = new Map<string, number>()
  {
    const jobs = await db.select({ refId: downloadJobs.refId, progress: downloadJobs.progress })
      .from(downloadJobs)
      .where(and(eq(downloadJobs.type, 'media-enhance'), inArray(downloadJobs.status, ['pending', 'running'])))
    for (const j of jobs) {
      try {
        const { assetId } = JSON.parse(j.refId) as { assetId?: string }
        if (!assetId || !j.progress) continue
        const p = JSON.parse(j.progress) as { completed?: number; total?: number }
        if (p.total && p.total > 0 && typeof p.completed === 'number') {
          enhanceProgressByAsset.set(assetId, Math.max(0, Math.min(1, p.completed / p.total)))
        }
      } catch { /* skip malformed job/progress rows */ }
    }
  }

  const downloads = rows.map(({ channelThumbSub, channelThumbVid, assetId, ...r }) => ({
    ...r,
    channelThumb: channelThumbSub ?? channelThumbVid ?? null,
    progress: assetId ? progressByAsset.get(assetId) ?? null : null,
    enhance: assetId ? enhanceMap.get(assetId) ?? null : null,
    enhanceProgress: assetId ? enhanceProgressByAsset.get(assetId) ?? null : null,
    positionSec: watchMap.get(r.videoId)?.positionSec ?? null,
    completed: watchMap.get(r.videoId)?.completed ?? null,
  }))

  // Backfill missing resolutions in the background so badges fill in on the next poll —
  // but only when something actually lacks one, since the client polls this every 5s.
  if (rows.some(r => r.maxHeight == null)) void backfillSavedHeights(user.id).catch(() => {})
  // Resolve missing channel avatars in the background so logos fill in on the next poll.
  if (downloads.some(r => !r.channelThumb)) void backfillSavedChannelThumbs(user.id).catch(() => {})
  return c.json({ downloads })
})

// Delete saved items (DB rows + files on disk). Batch by ids.
youtubeRoute.post('/downloads/delete', async (c) => {
  const user = c.get('user')
  const { ids } = await c.req.json<{ ids: string[] }>().catch(() => ({ ids: [] as string[] }))
  if (!ids?.length) return c.json({ ok: true, deleted: 0 })

  const rows = await db.select().from(ytDownloads)
    .where(and(eq(ytDownloads.userId, user.id), inArray(ytDownloads.id, ids)))
  for (const r of rows) {
    // The media is a SHARED blob — never unlink it here (another user may reference the same
    // asset). Only this user's per-user transcript file is safe to remove.
    if (r.transcriptRelPath) { try { await unlink(await resolveUserPath(r.transcriptRelPath)) } catch { /* already gone */ } }
    // Legacy unmigrated rows still own a private per-user media file — clean that up directly.
    if (!r.assetId && r.relPath) { try { await unlink(await resolveUserPath(r.relPath)) } catch { /* already gone */ } }
  }
  await db.delete(ytDownloads)
    .where(and(eq(ytDownloads.userId, user.id), inArray(ytDownloads.id, ids)))
  // Drop any asset that now has zero references → its blob becomes unreferenced and GC reclaims it.
  await releaseAssetsIfOrphaned(rows.map(r => r.assetId))
  // Manual unsave — if this user has a Plex library, remove the matching episode/file too.
  // Best-effort: never let a Plex-export hiccup block the delete the user actually asked for.
  for (const r of rows) {
    const { enqueuePlexSync } = await import('@/lib/downloadJobs')
    void enqueuePlexSync(user.id, r.videoId, 'remove').catch(() => {})
  }
  return c.json({ ok: true, deleted: rows.length })
})

// Manual trigger to (re)sync every ready video save to this user's Plex library — for
// testing the export before the automatic hooks (new save / auto-prune) are wired in.
youtubeRoute.post('/plex/sync-all', async (c) => {
  const user = c.get('user')
  // Fail loudly here rather than silently — syncVideoToPlex() itself no-ops (not an error)
  // when the user has no ready Plex library yet, which is CORRECT for the automatic
  // save/prune hooks (most users never opt into Plex at all) but was actively misleading
  // for this manual button: every enqueued job came back "completed" having done nothing,
  // indistinguishable from a real success, with the library simply never getting populated.
  const [section] = await db.select().from(plexLibrarySections)
    .where(and(eq(plexLibrarySections.userId, user.id), eq(plexLibrarySections.contentType, 'youtube')))
  if (!section || section.status !== 'ready') {
    return c.json({ ok: false, error: 'Your Plex library isn’t provisioned yet — ask an admin to set it up in Admin → Plex first.' }, 400)
  }
  // prefetch=true rows are the app's own speculative cache-warming, never a real user save
  // (confirmed live: a "Killers" song and 2 others leaked into Plex this way — the user
  // never saved them, they don't appear in the app's own Offline tab either, since that
  // list is genuine-saves-only for the same reason).
  const rows = await db.select({ videoId: ytDownloads.videoId }).from(ytDownloads)
    .where(and(eq(ytDownloads.userId, user.id), eq(ytDownloads.kind, 'video'), eq(ytDownloads.status, 'ready'), eq(ytDownloads.prefetch, false)))
  const { enqueuePlexSync } = await import('@/lib/downloadJobs')
  for (const r of rows) await enqueuePlexSync(user.id, r.videoId, 'add')
  return c.json({ ok: true, enqueued: rows.length })
})

// Manual trigger to sync this user's playlists/Watch Later/Liked into real Plex Playlists.
// Runs inline (not queued) — it's read-heavy against Plex plus a handful of PUTs, not a
// download, and its own timeouts already bound how long a single call can take.
youtubeRoute.post('/plex/sync-collections', async (c) => {
  const user = c.get('user')
  const { syncPlaylistsForUser } = await import('@/lib/plex/export/playlists')
  // Fail loudly: swallowing the error returned {ok:true} while nothing synced (Plex down /
  // token expired) with no signal to the user — the sibling /plex/sync-all was fixed for this.
  try {
    await syncPlaylistsForUser(user.id)
  } catch (err) {
    logger.warn(`[youtube] plex playlist sync failed: ${err instanceof Error ? err.message : err}`)
    return c.json({ error: 'Plex playlist sync failed — check your Plex connection.' }, 502)
  }
  return c.json({ ok: true })
})

// Cancel in-flight saves (still queued/downloading). Unlike delete, this aborts the running
// yt-dlp job when nothing else references the shared asset. Batch by ids (the ytDownloads ref ids).
youtubeRoute.post('/downloads/cancel', async (c) => {
  const user = c.get('user')
  const { ids } = await c.req.json<{ ids: string[] }>().catch(() => ({ ids: [] as string[] }))
  if (!ids?.length) return c.json({ ok: true, cancelled: 0 })
  const cancelled = await cancelVideoSaves(user.id, ids)
  return c.json({ ok: true, cancelled })
})

// Save a video into the Offline library. Capped at the user's effective Save height
// (admin global/per-user cap ∧ user preference). Audio is fetched at best quality.
async function handleSave(c: Context<AppEnv>) {
  const user = c.get('user')
  const { videoId, kind = 'audio', title = '', maxHeight: reqHeight, audioFormat } = await c.req.json<{ videoId: string; kind?: 'audio' | 'video'; title?: string; maxHeight?: number; audioFormat?: string }>()
  if (!videoId) return c.json({ error: 'videoId required' }, 400)
  // Reject anything that isn't a real id before it reaches yt-dlp's -o template / the stored
  // relPath (a `..`-bearing videoId would otherwise shape on-disk paths).
  if (!isValidVideoId(videoId)) return c.json({ error: 'Invalid video id' }, 400)

  const firstName = await getUserFirstName(user.id)

  // Resolve the save resolution: the user's chosen height (from the Save dialog) clamped
  // to their effective cap, or their preference/cap when unspecified.
  const cap = await getEffectiveCap(user.id)
  const maxHeight = kind === 'audio' ? null
    : Math.min(reqHeight ?? (await getUserPreference(user.id)) ?? cap, cap)

  // Upsert the download row + enqueue the durable yt-media job (shared with auto-save).
  const fmt = (AUDIO_FORMATS as readonly string[]).includes(audioFormat ?? '') ? audioFormat as AudioFormat : undefined
  const { status, id } = await enqueueVideoSave({ userId: user.id, videoId, title, kind, maxHeight, firstName, audioFormat: fmt })
  return c.json({ ok: true, status, id })
}

youtubeRoute.post('/save', handleSave)
youtubeRoute.post('/download', handleSave)   // legacy alias

// Save a channel's current back-catalogue: fetch its latest `count` uploads and enqueue each
// as an offline save right now. With auto:true (the "Configure for offline" backfill) the
// rows join the rolling keep-N window alongside poller auto-saves; with auto:false (default)
// they are explicit saves the prune never touches.
youtubeRoute.post('/channel/:channelId/save-now', async (c) => {
  const user = c.get('user')
  const channelId = c.req.param('channelId')
  const { kind: reqKind = 'video', count = 10, auto = false } = await c.req.json<{ kind?: 'audio' | 'video'; count?: number; auto?: boolean }>().catch(() => ({}) as { kind?: 'audio' | 'video'; count?: number; auto?: boolean })
  const kind: 'audio' | 'video' = reqKind === 'audio' ? 'audio' : 'video'
  const n = Math.max(1, Math.min(50, Math.floor(count) || 10))

  const page = await innertubeChannel(channelId, null, n).catch(() => null)
  const videos = (page?.videos ?? []).filter(v => isValidVideoId(v.videoId)).slice(0, n)
  if (!videos.length) return c.json({ error: 'No videos found for this channel' }, 404)

  const firstName = await getUserFirstName(user.id)
  const cap = await getEffectiveCap(user.id)
  const maxHeight = kind === 'audio' ? null : Math.min((await getUserPreference(user.id)) ?? cap, cap)

  // Auto backfill rows must be visible to the keep-N prune and the remove-watched sweep,
  // which both join yt_videos on subscriptionId — make sure those rows exist (the RSS
  // poller only ever covers the newest ~15, so deeper backfills would otherwise escape
  // the rolling window forever).
  if (auto === true) {
    const [sub] = await db.select().from(ytSubscriptions).where(and(
      eq(ytSubscriptions.userId, user.id), eq(ytSubscriptions.externalId, channelId), eq(ytSubscriptions.kind, 'channel'),
    )).limit(1)
    if (!sub) return c.json({ error: 'subscribe to this channel first' }, 400)
    const { upsertSubscriptionVideos } = await import('@/lib/youtube/feed')
    await upsertSubscriptionVideos(sub, videos.map(v => ({
      videoId: v.videoId, title: v.title ?? '', author: v.author, channelId: v.channelId,
      thumbnailUrl: v.thumbnailUrl, publishedAt: v.publishedAt ?? null,
      durationSec: v.durationSec, views: v.views, description: null,
    })))
  }

  let queued = 0
  for (const v of videos) {
    const r = await enqueueVideoSave({ userId: user.id, videoId: v.videoId, title: v.title ?? '', kind, maxHeight, firstName, auto: auto === true })
      .catch(() => null)
    if (r) queued++
  }
  return c.json({ ok: true, queued, total: videos.length })
})

// ── Live-from-start DVR ──────────────────────────────────────────────────────────

// Re-verifies via yt-dlp right before recording — the cheap InnerTube-backed isLive shown
// on the watch page can be stale by the time the button is actually clicked.
youtubeRoute.post('/live/:videoId/record', async (c) => {
  const user = c.get('user')
  const videoId = c.req.param('videoId')
  if (!isValidVideoId(videoId)) return c.json({ error: 'Invalid video id' }, 400)
  const { title = '' } = await c.req.json<{ title?: string }>().catch(() => ({} as { title?: string }))

  const live = await getLiveStatus(videoId)
  if (!live.isLive) return c.json({ error: 'Video is not currently live' }, 409)

  const { status, id } = await startLiveRecording({ userId: user.id, videoId, title })
  return c.json({ ok: true, status, id })
})

// Graceful stop-and-keep: yt-dlp finalizes whatever it captured rather than discarding it.
youtubeRoute.post('/live/:videoId/stop', async (c) => {
  const ok = stopLiveRecording(c.req.param('videoId'))
  return c.json({ ok })
})

// ── Save quality (the picker the user sees) ─────────────────────────────────────

youtubeRoute.get('/save-quality', async (c) => {
  const user = c.get('user')
  const [cap, pref] = await Promise.all([getEffectiveCap(user.id), getUserPreference(user.id)])
  return c.json({
    tiers: SAVE_HEIGHTS,
    cap,                                 // ceiling the user cannot exceed
    pref,                                // their chosen height, or null (= use cap)
    effective: pref == null ? cap : Math.min(pref, cap),
  })
})

// ── Admin: Save quality limits (global + per-user caps) ─────────────────────────

youtubeRoute.get('/admin/limits', requireAdmin, async (c) => {
  const globalCap = await getGlobalCap()
  const allUsers = await db.select({ id: users.id, firstName: users.firstName, nickname: users.nickname, role: users.role }).from(users)
  const withCaps = await Promise.all(allUsers.map(async (u) => ({
    ...u,
    cap: await getUserCapOverride(u.id),   // null = follows global default
  })))
  return c.json({ tiers: SAVE_HEIGHTS, defaultCap: DEFAULT_GLOBAL_CAP, globalCap, users: withCaps })
})

// yt-dlp binary health — version, which binary is active, and when it was last checked.
youtubeRoute.get('/admin/ytdlp', requireAdmin, async (c) => c.json(await getYtDlpStatus()))

// Force an immediate update check, then return the refreshed status.
youtubeRoute.post('/admin/ytdlp/check', requireAdmin, async (c) => {
  await ensureYtDlp(true)
  return c.json(await getYtDlpStatus())
})

// Admin-uploaded cookies.txt (Netscape format) for age-gated/private video downloads,
// exports, and transcript fetches. Not used for shared live-playback resolution — see
// ytDlpAuthArgs()'s comment in lib/ytdlp.ts.
youtubeRoute.get('/admin/cookies', requireAdmin, async (c) => c.json(await getCookiesStatus()))

youtubeRoute.post('/admin/cookies', requireAdmin, async (c) => {
  const formData = await c.req.formData()
  const file = formData.get('file') as File | null
  if (!file) return c.json({ error: 'No file provided' }, 400)
  if (file.size > 1_000_000) return c.json({ error: 'File too large (max 1MB)' }, 400)
  const text = await file.text()
  const looksLikeCookies = text.includes('# Netscape HTTP Cookie File') || text.includes('# HTTP Cookie File') ||
    /^[^\t\n]+\t[^\t\n]+\t[^\t\n]+\t[^\t\n]+\t[^\t\n]+\t[^\t\n]+\t[^\t\n]+$/m.test(text)
  if (!looksLikeCookies) return c.json({ error: 'Does not look like a Netscape-format cookies.txt file' }, 400)
  await saveCookiesFile(Buffer.from(text, 'utf-8'))
  return c.json(await getCookiesStatus())
})

youtubeRoute.delete('/admin/cookies', requireAdmin, async (c) => {
  await clearCookiesFile()
  return c.json(await getCookiesStatus())
})

youtubeRoute.put('/admin/limits/global', requireAdmin, async (c) => {
  const { height } = await c.req.json<{ height: number }>()
  if (!(SAVE_HEIGHTS as readonly number[]).includes(height)) return c.json({ error: 'Invalid height' }, 400)
  await setAppSetting('youtube.save_max_height', height)
  return c.json({ ok: true })
})

youtubeRoute.put('/admin/limits/:userId', requireAdmin, async (c) => {
  const userId = c.req.param('userId')
  const { height } = await c.req.json<{ height: number | null }>()
  if (height != null && !(SAVE_HEIGHTS as readonly number[]).includes(height)) return c.json({ error: 'Invalid height' }, 400)
  // null clears the override (stored as null → treated as "follows global default").
  await setAppSetting(`youtube.save_max_height.${userId}`, height)
  return c.json({ ok: true })
})

// Interest-engine diagnostics for the recommended feed: what the channel profiler
// thinks the admin's subscriptions are about, what the candidate pool holds per
// bucket (and how old it is), and what a fresh serve actually returns with its
// provenance. Read-only: channel profiles come from cache only (no LLM builds are
// triggered), and the only side effect is the impression recording a normal serve
// already performs.
youtubeRoute.get('/admin/interests/debug', requireAdmin, async (c) => {
  const user = c.get('user')
  const [subTopics, profiles, pool] = await Promise.all([
    subscriptionTopics(user.id, true),
    buildChannelProfiles(user.id, true),
    peekPool(user.id, 'videos'),
  ])
  const poolBuckets: Record<string, number> = {}
  for (const e of pool.entries) {
    if (!e.ref.startsWith('youtube:')) continue
    poolBuckets[e.bucket] = (poolBuckets[e.bucket] ?? 0) + 1
  }
  const bucketByRef = new Map(pool.entries.map((e) => [e.ref, e.bucket]))
  const served = await serveYtRecommendedDeep(user.id, 24)
  return c.json({
    subscriptionTopics: subTopics,
    channelProfiles: profiles.map((p) => ({ channel: p.channelName, what: p.what, topics: p.topics })),
    poolBuckets,
    poolAge: pool.ageMs,
    servedSample: served.videos.slice(0, 24).map((v) => ({
      ref: `youtube:${v.videoId}`,
      bucket: bucketByRef.get(`youtube:${v.videoId}`) ?? null,
      why: v.why ?? null,
    })),
  })
})

// ── Admin: IMDb datasets for computable Pop-Up Facts ────────────────────────────

// Kick the background ingest of IMDb's non-commercial TSV datasets into the local
// trivia tables (lib/imdb/ingest.ts). Coalesced: a second POST while one is running
// reports started:false and the live status instead of starting another download.
youtubeRoute.post('/admin/imdb/ingest', requireAdmin, async (c) => {
  const started = kickTriviaIngest()
  return c.json({ started, ...triviaIngestStatus() })
})

// Row counts per table, last completed ingest time, and the in-progress phase.
youtubeRoute.get('/admin/imdb/status', requireAdmin, async (c) => c.json(triviaIngestStatus()))

// ── Download to device: list formats, run export, stream the file ───────────────

interface YtFormat { formatId: string; ext: string; resolution: string; note: string; filesize: number | null; vcodec: string; acodec: string }

youtubeRoute.get('/formats/:videoId', async (c) => {
  const videoId = c.req.param('videoId')
  if (!isValidVideoId(videoId)) return c.json({ formats: [], error: 'Invalid video id' }, 400)
  const url = `https://www.youtube.com/watch?v=${videoId}`
  try {
    const json = await withYtDlpSlot(() => new Promise<string>((resolve, reject) => {
      const proc = spawn(ytDlpBin(), ['-J', '--no-playlist', url], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      let out = ''
      proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
      proc.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(`yt-dlp exited ${code}`)))
      proc.on('error', reject)
    }))
    const meta = JSON.parse(json) as { formats?: any[] }
    const formats: YtFormat[] = (meta.formats ?? [])
      .filter((f) => f.format_id && (f.vcodec !== 'none' || f.acodec !== 'none'))
      .map((f) => ({
        formatId: String(f.format_id),
        ext: f.ext ?? '',
        resolution: f.resolution ?? (f.height ? `${f.height}p` : 'audio'),
        note: f.format_note ?? '',
        filesize: f.filesize ?? f.filesize_approx ?? null,
        vcodec: f.vcodec ?? 'none',
        acodec: f.acodec ?? 'none',
      }))
    return c.json({ formats })
  } catch (err: any) {
    return c.json({ formats: [], error: String(err?.message ?? err) }, 200)
  }
})

youtubeRoute.post('/export', async (c) => {
  const user = c.get('user')
  const { videoId, format, audioFormat, title = '' } = await c.req.json<{
    videoId: string; format?: string; audioFormat?: string; title?: string
  }>()
  if (!videoId) return c.json({ error: 'videoId required' }, 400)
  if (!isValidVideoId(videoId)) return c.json({ error: 'Invalid video id' }, 400)
  if (!format && !audioFormat) return c.json({ error: 'format or audioFormat required' }, 400)

  const firstName = await getUserFirstName(user.id)
  const exportId = crypto.randomUUID()
  const now = new Date()
  const payload = { exportId, videoId, userId: user.id, userFirstName: firstName, format, audioFormat }

  await db.insert(downloadJobs).values({
    id: exportId,                        // job id == exportId so the file & poll share a key
    type: 'yt-export',
    refId: JSON.stringify(payload),
    domain: 'youtube',
    sizeClass: 'large',
    label: `Download "${title || videoId}"`,
    status: 'pending',
    priority: 45,
    attempts: 0,
    maxAttempts: 2,
    variantKey: null,
    lastError: null,
    nextEligibleAt: null,
    progress: null,
    createdAt: now,
    updatedAt: now,
  })

  return c.json({ ok: true, jobId: exportId })
})

youtubeRoute.get('/export/:jobId', async (c) => {
  const user = c.get('user')
  const jobId = c.req.param('jobId')
  const [job] = await db.select().from(downloadJobs).where(eq(downloadJobs.id, jobId)).limit(1)
  if (!job || job.type !== 'yt-export') return c.json({ error: 'Not found' }, 404)
  const payload = safeJson<{ userId: string }>(job.refId)
  if (!payload) return c.json({ error: 'Not found' }, 404)
  if (payload.userId !== user.id) return c.json({ error: 'Forbidden' }, 403)

  const state = job.status === 'completed' ? 'ready'
    : job.status === 'failed' || job.status === 'cancelled' ? 'failed'
    : 'working'
  return c.json({ state, status: job.status, progress: safeJson(job.progress), error: job.lastError })
})

youtubeRoute.get('/export/:jobId/file', async (c) => {
  const user = c.get('user')
  const jobId = c.req.param('jobId')
  const [job] = await db.select().from(downloadJobs).where(eq(downloadJobs.id, jobId)).limit(1)
  if (!job || job.type !== 'yt-export') return c.json({ error: 'Not found' }, 404)
  const payload = safeJson<{ userId: string; userFirstName: string; videoId: string }>(job.refId)
  if (!payload) return c.json({ error: 'Not found' }, 404)
  if (payload.userId !== user.id) return c.json({ error: 'Forbidden' }, 403)
  if (job.status !== 'completed') return c.json({ error: 'Not ready' }, 409)

  const dir = await exportsDir(payload.userId, payload.userFirstName)
  const file = (await readdir(dir).catch(() => [] as string[])).find((f) => f.startsWith(`${jobId}.`))
  if (!file) return c.json({ error: 'File missing' }, 404)

  const absPath = join(dir, file)
  const ext = file.slice(file.lastIndexOf('.'))
  const safeName = (job.label.replace(/^Download "|"$/g, '') || payload.videoId).replace(/[^\w.\- ]+/g, '_').slice(0, 80)
  const buf = await readFile(absPath)

  // One-shot: drop the temp file after handing it to the browser.
  void unlink(absPath).catch(() => {})

  return new Response(buf, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${safeName}${ext}"`,
      'Content-Length': String(buf.byteLength),
    },
  })
})

// ── Serve downloaded file ─────────────────────────────────────────────────────

youtubeRoute.get('/file/:videoId/:kind', async (c) => {
  const user = c.get('user')
  const videoId = c.req.param('videoId')
  const kind = c.req.param('kind') as 'audio' | 'video'

  const [dl] = await db.select({ status: ytDownloads.status, relPath: ytDownloads.relPath, assetId: ytDownloads.assetId })
    .from(ytDownloads)
    .where(and(eq(ytDownloads.userId, user.id), eq(ytDownloads.videoId, videoId), eq(ytDownloads.kind, kind)))
    .limit(1)

  if (!dl || dl.status !== 'ready') return c.json({ error: 'Not found' }, 404)

  // Prefer the shared content blob (the user holds a ready ref → owns access); fall back to a
  // legacy per-user relPath for rows the background dedup migration hasn't linked yet.
  // resolvePlaybackBlob transparently prefers the user's enhanced rendition when opted in.
  const blob = await resolvePlaybackBlob({ ...dl, userId: user.id })
  let absPath: string
  let contentType: string
  let trackHash: string | null = null
  if (blob) {
    absPath = blob.absPath
    contentType = blob.mime
    trackHash = blob.hash
  } else if (dl.relPath) {
    absPath = await resolveUserPath(dl.relPath)
    contentType = dl.relPath.endsWith('.mp3') ? 'audio/mpeg' : kind === 'audio' ? 'audio/mp4' : 'video/mp4'
  } else {
    return c.json({ error: 'Not found' }, 404)
  }
  if (!existsSync(absPath)) return c.json({ error: 'File missing' }, 404)

  const fileStat = await stat(absPath)

  // Range support for media players. Only honor a well-formed `bytes=start-end`; clamp to
  // the file size and reject impossible ranges (a malformed header otherwise yields NaN
  // offsets and a broken 206) — falling through to a full 200 response when absent.
  const rangeHeader = c.req.header('range')
  const rangeMatch = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null
  if (rangeMatch) {
    const size = fileStat.size
    let start = rangeMatch[1] ? parseInt(rangeMatch[1], 10) : 0
    let end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : size - 1
    if (Number.isNaN(start) || start < 0) start = 0
    if (Number.isNaN(end) || end >= size) end = size - 1
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    }
    const chunkSize = end - start + 1

    // Hold an in-flight read on this blob so GC can't unlink it mid-stream (a swap to a higher
    // tier may make the old blob unreferenced while a player is still pulling range requests).
    if (trackHash) acquireRead(trackHash)
    const { createReadStream } = await import('node:fs')
    const stream = createReadStream(absPath, { start, end })
    if (trackHash) {
      const release = () => releaseRead(trackHash!)
      stream.once('close', release)
      stream.once('error', release)
    }
    return new Response(stream as any, {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(chunkSize),
        'Content-Type': contentType,
      },
    })
  }

  const buf = await readFile(absPath)
  return new Response(buf, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(fileStat.size),
      'Accept-Ranges': 'bytes',
    },
  })
})

// ── Transcript ────────────────────────────────────────────────────────────────

youtubeRoute.get('/transcript/:videoId', async (c) => {
  const user = c.get('user')
  const videoId = c.req.param('videoId')

  // Prefer a transcript saved alongside an offline download…
  const [dl] = await db.select({ transcriptRelPath: ytDownloads.transcriptRelPath })
    .from(ytDownloads)
    .where(and(eq(ytDownloads.userId, user.id), eq(ytDownloads.videoId, videoId)))
    .limit(1)

  let absPath = dl?.transcriptRelPath ? await resolveUserPath(dl.transcriptRelPath) : null
  // …otherwise fetch the timed (VTT) captions live, so the transcript panel gets
  // timestamps — and can follow along — for any online video, not just downloads.
  if (!absPath || !existsSync(absPath)) {
    const firstName = await getUserFirstName(user.id)
    absPath = await ensureTranscript(videoId, user.id, firstName)
  }
  if (!absPath || !existsSync(absPath)) return c.json({ error: 'No transcript' }, 404)

  const vtt = await readFile(absPath, 'utf-8')
  // ?lang=<code> serves the same cues translated, so the family can watch anything in
  // their language. Timing is untouched, so it stays in sync with no alignment work.
  // A translation failure falls back to the original rather than an empty track.
  const lang = c.req.query('lang')
  if (lang && languageLabel(lang)) {
    const translated = await translateVtt(vtt, lang, videoId)
    if (translated) return c.text(translated, 200, { 'Content-Type': 'text/vtt' })
  }
  return c.text(vtt, 200, { 'Content-Type': 'text/vtt' })
})

// The languages we can translate captions into (the picker's source of truth).
youtubeRoute.get('/translate-languages', (c) => {
  return c.json({ languages: TRANSLATE_LANGUAGES })
})

// Cleaned, plain-text transcript for the "Read transcript" modal. Fetches captions
// on demand (no media download) when they aren't already on disk.
youtubeRoute.get('/transcript-text/:videoId', async (c) => {
  const user = c.get('user')
  const videoId = c.req.param('videoId')
  const firstName = await getUserFirstName(user.id)
  const text = await getTranscriptText(videoId, user.id, firstName)
  if (!text) return c.json({ error: 'No captions available for this video.' }, 422)
  return c.json({ text: formatTranscript(text) })
})

// ── Video metadata (title, channel, description) ────────────────────────────────
// DB-first (instant for feed/saved videos); falls back to yt-dlp for anything else
// (e.g. search results) so the player can always show a channel + description.
youtubeRoute.get('/video/:videoId', async (c) => {
  const user = c.get('user')
  const videoId = c.req.param('videoId')

  // Play-time enrichment (fire-and-forget, idempotent): the player hits this when it
  // opens, so use it to download captions if they're missing and — when we have a
  // transcript but no cached summary yet — summarize in the background. Both calls
  // no-op when the work is already done, so repeat plays are cheap. Delayed ~15s so
  // the LLM work isn't competing with segment proxying at the moment playback starts.
  setTimeout(() => {
    void (async () => {
      const firstName = await getUserFirstName(user.id)
      await ensureTranscript(videoId, user.id, firstName)
      await ensureSummary(videoId, user.id, firstName)
      await ensureSmartDescription(videoId, user.id, firstName)
      // Last, so the rewrite gets to read the summary it just generated: that describes
      // what the video actually contains, which is exactly what a clickbait title hides.
      await ensureHonestTitle(videoId)
    })().catch(() => { /* enrichment is best-effort */ })
  }, 15_000)

  const [v] = await db.select().from(ytVideos).where(eq(ytVideos.videoId, videoId)).limit(1)

  // Kid-safe media hard gate: the player needs this metadata to start playback, so refusing
  // it here blocks a direct link even if a card slipped past the list filters. Uses the row's
  // text when present (feed/saved videos), else one player-meta fetch (cold links); the
  // classifier verdict is cached so repeat plays are cheap. Fails open for non-kid tiers.
  {
    const gate = v?.title
      ? { title: v.title, channelId: v.channelId, author: v.author }
      : await tryInnertube('videoGate', () => innertubePlayerMeta(videoId), null)
    if (gate?.title && !(await videoAllowedForUser(user.id, {
      source: 'youtube', id: videoId, url: `https://www.youtube.com/watch?v=${videoId}`,
      title: gate.title,
      creator: gate.channelId ? { id: gate.channelId, name: gate.author ?? '' } : null,
    }))) {
      return c.json({ error: 'not available' }, 403)
    }
  }

  // Time budget gate: watch start is refused (with a friendly reason) once today's video
  // minutes are used up or outside the allowed hours. Metering lives on the heartbeats.
  {
    const timeGate = await checkVideoTime(user.id)
    if (!timeGate.allowed) {
      return c.json({
        error: timeGate.reason === 'hours' ? 'Videos are paused right now. Try again during allowed hours.' : 'Video time is used up for today.',
        code: 'time_limit',
      }, 403)
    }
  }

  // Resume position for this user (0 if none / finished).
  const [ws] = await db.select({ positionSec: ytWatchState.positionSec, completed: ytWatchState.completed })
    .from(ytWatchState)
    .where(and(eq(ytWatchState.userId, user.id), eq(ytWatchState.videoId, videoId)))
    .limit(1)
  const positionSec = ws && !ws.completed ? Math.floor(ws.positionSec) : 0

  // The user's subscription row for the video's channel (so the player can show a
  // toggleable "Subscribed" button instead of a misleading "Subscribe" one).
  const subFor = async (channelId: string | null | undefined): Promise<{ id: string; thumbnailUrl: string | null } | null> => {
    if (!channelId) return null
    const [s] = await db.select({ id: ytSubscriptions.id, thumbnailUrl: ytSubscriptions.thumbnailUrl }).from(ytSubscriptions)
      .where(and(eq(ytSubscriptions.userId, user.id), eq(ytSubscriptions.externalId, channelId))).limit(1)
    return s ?? null
  }

  // Avatar: prefer the subscription's stored thumbnail; otherwise fetch the channel's avatar
  // via InnerTube (cached) so non-subscribed channels (e.g. opening a trailer cold) still show
  // their logo instead of a letter placeholder.
  const avatarFor = async (sub: { thumbnailUrl: string | null } | null, channelId: string | null | undefined): Promise<string | null> => {
    if (sub?.thumbnailUrl) return sub.thumbnailUrl
    if (!channelId) return null
    return cachedLookup('yt-channel-avatar', channelId, 7 * 24 * 60 * 60 * 1000, () => innertubeChannelAvatar(channelId))
  }

  // Subscriber count for the creator row (e.g. "22.7M subscribers") — cached a full day,
  // same rationale as the avatar: this number doesn't move fast enough to justify a live
  // fetch on every watch, and `limit: 1` keeps the underlying channel-page fetch cheap.
  const subscribersFor = async (channelId: string | null | undefined): Promise<string | null> => {
    if (!channelId) return null
    return cachedLookup('yt-channel-subs', channelId, 24 * 60 * 60 * 1000, async () => {
      const page = await innertubeChannel(channelId, null, 1).catch(() => null)
      return page?.meta?.subscribers ?? null
    })
  }

  if (v?.description) {
    const sub = await subFor(v.channelId)
    // Self-heal: a stub row can exist with description/views but a blank title/author (the
    // schema's NOT NULL DEFAULT '' — e.g. ensureChannelThumb creating a row before any
    // metadata fetch ever ran). This fast path would otherwise serve that blank forever, since
    // it's the only branch a row with a description ever reaches again. One live top-up fixes
    // it for good; every later hit stays on the true fast path below.
    let title = v.title, author = v.author
    if (!title || !author) {
      const fix = await tryInnertube('playerMeta', () => innertubePlayerMeta(videoId), null)
      if (fix?.title) {
        title = fix.title
        author = fix.author ?? author
        await db.update(ytVideos).set({ title, author }).where(eq(ytVideos.videoId, videoId)).catch(() => {})
      }
    }
    // No cached live signal on this row — a video that was live when it was first cached could
    // theoretically still be live, but this fast path is dominated by long-finished feed/saved
    // videos, so defaulting false here (rather than always paying for an InnerTube call) is the
    // right tradeoff. The Record button re-verifies via getLiveStatus() before it ever records.
    // Same self-heal for stats: this fast path short-circuits on description alone, so a
    // row missing views/publishedAt would serve a blank caption forever. Backfill in the
    // background — don't block the response on an InnerTube round-trip.
    if (v.views == null || v.publishedAt == null) void backfillVideoStats(videoId).catch(() => {})
    // loudnessDb rides the same memoized /player call playback is about to make anyway
    // (innertubeLoudnessDb never throws), so the client can normalize volume per video.
    const [channelThumb, subscribers, loudnessDb] = await Promise.all([avatarFor(sub, v.channelId), subscribersFor(v.channelId), innertubeLoudnessDb(videoId)])
    return c.json({ videoId, title, author, channelId: v.channelId, channelThumb, subscribers, description: v.description, descriptionClean: v.descriptionClean, summary: v.summary, durationSec: v.durationSec, views: v.views, publishedAt: v.publishedAt ?? null, positionSec, subscribed: !!sub, subscriptionId: sub?.id ?? null, isLive: false, loudnessDb })
  }

  // Fast metadata path: InnerTube's player endpoint (structured JSON, no subprocess).
  // Only fall through to yt-dlp if it comes back empty.
  const it = await tryInnertube('playerMeta', () => innertubePlayerMeta(videoId), null)
  if (it?.title) {
    // Persist description + view count back onto the row so the cached path (above) and the
    // Offline/Feed cards can show them without re-resolving. Also backfills title/author when
    // blank (e.g. a stub row created by ensureChannelThumb before any metadata fetch ran) so
    // the row is never left to reach the cached path above with an empty title/author.
    if (v && (it.description || it.views || (it.publishedAt && !v.publishedAt) || !v.title || !v.author)) {
      const patch: Partial<typeof ytVideos.$inferInsert> = {}
      if (it.description) patch.description = it.description
      if (it.views) patch.views = it.views
      if (it.publishedAt && !v.publishedAt) patch.publishedAt = it.publishedAt
      if (!v.title && it.title) patch.title = it.title
      if (!v.author && it.author) patch.author = it.author
      if (Object.keys(patch).length > 0) await db.update(ytVideos).set(patch).where(eq(ytVideos.videoId, videoId)).catch(() => {})
    }
    const channelId = it.channelId ?? v?.channelId ?? null
    const sub = await subFor(channelId)
    const [channelThumb, subscribers, loudnessDb] = await Promise.all([avatarFor(sub, channelId), subscribersFor(channelId), innertubeLoudnessDb(videoId)])
    return c.json({
      videoId, title: it.title, author: it.author ?? v?.author ?? null, channelId,
      channelThumb, subscribers, description: it.description ?? v?.description ?? null,
      descriptionClean: v?.descriptionClean ?? null,
      summary: v?.summary ?? null, durationSec: it.durationSec ?? v?.durationSec ?? null,
      views: it.views ?? v?.views ?? null,
      publishedAt: it.publishedAt ?? v?.publishedAt ?? null,
      positionSec, subscribed: !!sub, subscriptionId: sub?.id ?? null, isLive: it.isLive,
      loudnessDb,
    })
  }

  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`
    const json = await new Promise<string>((resolve, reject) => {
      const proc = spawn(ytDlpBin(), ['-J', '--no-playlist', url], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      // yt-dlp can hang indefinitely on a network stall; the pooled callers get a timeout
      // from lib/ytdlp's execFile options, but this raw spawn needs its own kill switch.
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL') } catch { /* already gone */ }
        reject(new Error('yt-dlp timed out'))
      }, 30_000)
      let out = ''
      proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
      proc.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`yt-dlp exited ${code}`)) })
      proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    })
    const m = JSON.parse(json) as { title?: string; channel?: string; uploader?: string; channel_id?: string; description?: string; duration?: number; is_live?: boolean; view_count?: number; timestamp?: number; upload_date?: string }
    const mViews = m.view_count != null ? String(m.view_count) : null
    // Upload date: prefer the exact unix timestamp; fall back to the YYYYMMDD upload_date.
    const mPublishedAt = m.timestamp ? m.timestamp * 1000
      : m.upload_date && /^\d{8}$/.test(m.upload_date)
        ? Date.parse(`${m.upload_date.slice(0, 4)}-${m.upload_date.slice(4, 6)}-${m.upload_date.slice(6, 8)}`)
        : null
    // Persist description + view count back onto the row when we have them.
    if (v && (m.description || mViews)) {
      const patch: Partial<typeof ytVideos.$inferInsert> = {}
      if (m.description) patch.description = m.description
      if (mViews) patch.views = mViews
      await db.update(ytVideos).set(patch).where(eq(ytVideos.videoId, videoId)).catch(() => {})
    }
    const channelId = m.channel_id ?? v?.channelId ?? null
    const sub = await subFor(channelId)
    return c.json({
      videoId,
      title: m.title ?? v?.title ?? '',
      author: m.channel ?? m.uploader ?? v?.author ?? null,
      channelId,
      channelThumb: await avatarFor(sub, channelId),
      subscribers: await subscribersFor(channelId),
      description: m.description ?? v?.description ?? null,
      descriptionClean: v?.descriptionClean ?? null,
      summary: v?.summary ?? null,
      durationSec: m.duration ?? v?.durationSec ?? null,
      views: mViews ?? v?.views ?? null,
      publishedAt: mPublishedAt ?? v?.publishedAt ?? null,
      positionSec,
      subscribed: !!sub,
      subscriptionId: sub?.id ?? null,
      isLive: !!m.is_live,
      // yt-dlp branch: InnerTube already declined this video, so no loudness signal.
      loudnessDb: null,
    })
  } catch {
    const sub = await subFor(v?.channelId)
    return c.json({ videoId, title: v?.title ?? '', author: v?.author ?? null, channelId: v?.channelId ?? null, channelThumb: await avatarFor(sub, v?.channelId), subscribers: await subscribersFor(v?.channelId), description: v?.description ?? null, summary: v?.summary ?? null, durationSec: v?.durationSec ?? null, views: v?.views ?? null, publishedAt: v?.publishedAt ?? null, positionSec, subscribed: !!sub, subscriptionId: sub?.id ?? null, loudnessDb: null })
  }
})

// ── Summarize ─────────────────────────────────────────────────────────────────

youtubeRoute.post('/summarize/:videoId', async (c) => {
  const user = c.get('user')
  const videoId = c.req.param('videoId')
  const firstName = await getUserFirstName(user.id)
  const summary = await ensureSummary(videoId, user.id, firstName)
  if (!summary) return c.json({ error: 'No captions available for this video.' }, 422)
  return c.json({ summary })
})

// ── Make a podcast from YouTube content ─────────────────────────────────────────

const YT_DIGEST_SHOW_NAME = 'YouTube Digest'

/** Find or create the per-user auto "YouTube Digest" show that holds these episodes. */
async function ensureDigestShow(userId: string): Promise<string> {
  const [existing] = await db.select({ id: podcastShows.id })
    .from(podcastShows)
    .where(and(eq(podcastShows.ownerUserId, userId), eq(podcastShows.name, YT_DIGEST_SHOW_NAME)))
    .limit(1)
  if (existing) return existing.id

  const id = crypto.randomUUID()
  await db.insert(podcastShows).values({
    id,
    ownerUserId: userId,
    name: YT_DIGEST_SHOW_NAME,
    description: 'AI-hosted episodes generated from your YouTube videos.',
    style: 'recap',
    segmentsJson: '[]',   // content comes per-episode from the job payload
    hostsJson: '[]',      // generation falls back to a default host
    visibility: 'personal',
    source: 'app',
    createdAt: new Date(),
  })
  return id
}

youtubeRoute.post('/podcast', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{
    // videoId is the source-native id; source + url let non-YouTube videos (TikTok/Vimeo/
    // Reddit/link) resolve a transcript from their page URL. Omitted → treated as YouTube.
    videos?: { videoId: string; title?: string; author?: string; source?: string; url?: string }[]
    subscriptionId?: string
    label?: string
    // Target show: an existing show id, or a name to create a new show. When neither
    // is given, episodes land in the auto "YouTube Digest" show (legacy default).
    showId?: string
    newShowName?: string
    // How many episodes to generate in this batch (newest first). Default 5, max 25.
    limit?: number
    // Origin tag for a new show, e.g. 'channel:<id>' — lets the source page find and
    // continue this show later. Ignored when adding to an existing show.
    sourceRef?: string
  }>().catch(() => ({} as Record<string, never>))

  // Resolve the source video list: explicit selection, or a channel's recent videos.
  let videos = (body.videos ?? []).filter(v => v?.videoId)
  if (!videos.length && body.subscriptionId) {
    // Confirm the channel belongs to this user before pulling its videos.
    const [sub] = await db.select({ id: ytSubscriptions.id })
      .from(ytSubscriptions)
      .where(and(eq(ytSubscriptions.id, body.subscriptionId), eq(ytSubscriptions.userId, user.id)))
      .limit(1)
    if (sub) {
      const rows = await db.select({ videoId: ytVideos.videoId, title: ytVideos.title, author: ytVideos.author })
        .from(ytVideos)
        .where(eq(ytVideos.subscriptionId, sub.id))
        .orderBy(desc(ytVideos.publishedAt))
        .limit(5)
      videos = rows.map(r => ({ videoId: r.videoId, title: r.title ?? undefined, author: r.author ?? undefined }))
    }
  }
  if (!videos.length) return c.json({ error: 'No videos to make a podcast from.' }, 400)

  try {
    // Resolve the target show: existing (must be owned), brand-new, or the digest default.
    let showId: string
    if (body.showId) {
      const [owned] = await db.select({ id: podcastShows.id }).from(podcastShows)
        .where(and(eq(podcastShows.id, body.showId), eq(podcastShows.ownerUserId, user.id))).limit(1)
      if (!owned) return c.json({ error: 'Show not found.' }, 404)
      showId = owned.id
    } else if (body.newShowName?.trim()) {
      showId = crypto.randomUUID()
      // Channel/playlist names routinely carry emoji and em dashes — scrub them from the title.
      const showName = cleanAutoTitle(body.newShowName).slice(0, 80) || 'My Podcast'
      // A real description grounded in the actual source, instead of a generic stock line.
      const srcName = cleanAutoTitle(videos[0]?.author || showName.replace(/\s+podcast$/i, ''))
      const isPlaylist = body.sourceRef?.trim().startsWith('playlist:')
      const description = srcName
        ? `AI-hosted episodes diving into ${srcName}'s ${isPlaylist ? 'playlist' : 'videos'}, with a fresh take on every new upload.`
        : 'AI-hosted episodes generated from your YouTube content.'
      await db.insert(podcastShows).values({
        id: showId,
        ownerUserId: user.id,
        name: showName,
        description,
        style: 'recap',
        segmentsJson: '[]',
        hostsJson: '[]',
        visibility: 'personal',
        source: 'user',
        sourceRef: body.sourceRef?.trim() || null,
        createdAt: new Date(),
      })
    } else {
      showId = await ensureDigestShow(user.id)
    }
    const firstName = await getUserFirstName(user.id)
    const now = new Date()
    const dateLabel = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })

    // One episode per video — each video becomes its own AI-discussed episode, so a
    // channel or playlist fans out into a full back-catalogue of episodes. The source
    // list is newest-first, and we generate in that order (newest → oldest): the queue
    // sorts by ascending priority then createdAt, so newest gets the lowest priority and
    // most-recent createdAt (which also floats it to the top of the show's episode list).
    const batch = Math.min(25, Math.max(1, Math.floor(body.limit ?? 5)))
    // Skip videos already made into episodes in this show, so repeated calls walk the
    // back-catalogue ("generate next batch") rather than repeating the newest ones.
    // Dedup by sourceId within the show regardless of sourceType — native ids are unique
    // per platform, so no cross-source collision, and this now covers non-YouTube episodes too.
    const doneRows = await db.select({ sourceId: podcastEpisodeSources.sourceId })
      .from(podcastEpisodeSources)
      .innerJoin(podcastEpisodes, eq(podcastEpisodeSources.episodeId, podcastEpisodes.id))
      .where(eq(podcastEpisodes.showId, showId))
    const done = new Set(doneRows.map(r => r.sourceId))
    const candidates = videos.filter(v => !done.has(v.videoId))
    const targets = candidates.slice(0, batch)
    for (let i = 0; i < targets.length; i++) {
      const v = targets[i]!
      // Single video can carry a custom episode title; multi-video uses each video's own.
      await createYoutubeEpisode({
        showId,
        userId: user.id,
        firstName,
        video: v,
        dateLabel,
        createdAt: new Date(now.getTime() - i * 1000),
        episodeTitle: targets.length === 1 ? body.label : undefined,
      })
    }

    return c.json({ ok: true, showId, episodeCount: targets.length, remaining: candidates.length - targets.length })
  } catch (err) {
    console.error('[youtube/podcast] failed:', err)
    return c.json({ error: err instanceof Error ? err.message : 'Failed to start podcast' }, 500)
  }
})

youtubeRoute.post('/digest', async (c) => {
  const user = c.get('user')
  const { limit = 10 } = await c.req.json<{ limit?: number }>().catch(() => ({ limit: 10 }))

  // Get newest videos with summaries or transcripts for this user's subs
  const subs = await db.select({ id: ytSubscriptions.id }).from(ytSubscriptions)
    .where(eq(ytSubscriptions.userId, user.id))
  if (!subs.length) return c.json({ digest: null, error: 'No subscriptions' })

  const subIds = subs.map(s => s.id)
  const recentVideos = await db.select({ videoId: ytVideos.videoId, title: ytVideos.title, author: ytVideos.author, summary: ytVideos.summary })
    .from(ytVideos)
    .where(inArray(ytVideos.subscriptionId, subIds))
    .orderBy(desc(ytVideos.publishedAt))
    .limit(limit)

  if (!recentVideos.length) return c.json({ digest: null, error: 'No recent videos' })

  const items = recentVideos.map(v =>
    `- "${v.title}" by ${v.author}${v.summary ? `: ${v.summary.slice(0, 200)}` : ''}`
  ).join('\n')

  const model = await getFastModel()
  const result = await ollamaChat(model, [
    { role: 'system', content: 'You are a helpful assistant creating a brief digest of recent YouTube videos from a user\'s subscriptions.' },
    { role: 'user', content: `Here are the most recent ${recentVideos.length} videos from my subscriptions:\n${items}\n\nWrite a 2-3 paragraph digest summarizing what\'s been happening across my subscriptions.` },
  ], undefined, { temperature: 0.5, num_predict: 500 })

  return c.json({ digest: result.message.content.trim(), videoCount: recentVideos.length })
})

// ── Discovery (InnerTube) ───────────────────────────────────────────────────────
// Trending, full channel catalogues (paged — not the 15-item RSS cap), and genuine
// per-video related videos. All keyless via YouTube's internal youtubei/v1 API.

// Discovery feeds. YouTube retired its anonymous Trending page (FEtrending now 400s), so
// these aggregate from privacy front-ends — cached, best-effort. See discovery.ts.
// "Popular" = most-watched (Invidious /popular, reliable). "Trending" = YouTube trending
// tab (Piped, thinner/flakier — may be empty, in which case the UI hides the shelf).
youtubeRoute.get('/popular', async (c) => {
  const limit = Math.min(600, parseInt(c.req.query('limit') ?? '30', 10))
  return c.json({ videos: await filterYtItemsForUser(c.get('user').id, await fetchPopular(limit)) })
})

youtubeRoute.get('/trending', async (c) => {
  const limit = Math.min(600, parseInt(c.req.query('limit') ?? '30', 10))
  return c.json({ videos: await filterYtItemsForUser(c.get('user').id, await fetchTrending(limit)) })
})

// A channel's actual uploads, beyond whatever the RSS poller last cached. `cursor` is
// the opaque continuation token from a previous page (omit for the first page).
//
// First page is cached (yt_channel_cache): a fresh cache loads instantly without
// hitting YouTube; on a stale/missing cache we fetch live with retries and refresh
// the cache; if the live fetch fails we serve the stale cache rather than show an
// empty channel. Continuation pages are always live (deep pages aren't cached).
const CHANNEL_CACHE_TTL_MS = 30 * 60_000
// Subscribed channels live in the sidebar and get cheap freshness for free: the 15-min feed
// poller busts this cache the moment a new upload lands (see feed.ts). So we can hold their
// page far longer and let the daily expiry double as the "did they change their avatar/banner?"
// re-check, rather than re-fetching the whole page every 30 min on every visit.
const SUBSCRIBED_CHANNEL_CACHE_TTL_MS = 24 * 60 * 60_000

youtubeRoute.get('/channel/:channelId', async (c) => {
  const channelId = c.req.param('channelId')
  const cursor = c.req.query('cursor') ?? null

  if (cursor) {
    const more = await tryInnertubeRetry('channel-more', () => innertubeChannel(channelId, cursor))
    return c.json(more ?? { meta: null, videos: [], continuation: null })
  }

  // Subscribed (by anyone) → longer TTL; the poller keeps videos fresh out-of-band.
  const subRows = await db.select({ id: ytSubscriptions.id, thumbnailUrl: ytSubscriptions.thumbnailUrl })
    .from(ytSubscriptions).where(eq(ytSubscriptions.externalId, channelId))
  const ttl = subRows.length ? SUBSCRIBED_CHANNEL_CACHE_TTL_MS : CHANNEL_CACHE_TTL_MS

  const [cached] = await db.select().from(ytChannelCache).where(eq(ytChannelCache.channelId, channelId))
  const readCache = () => ({
    meta: cached!.metaJson ? JSON.parse(cached!.metaJson) : null,
    videos: JSON.parse(cached!.videosJson) as ItVideo[],
    continuation: cached!.continuation,
    cached: true,
  })

  // Fresh cache → serve immediately, no network.
  if (cached && Date.now() - cached.fetchedAt.getTime() < ttl) {
    return c.json(readCache())
  }

  // Stale/missing → fetch live (retried). Cache + return on a real result.
  const page = await tryInnertubeRetry('channel', () => innertubeChannel(channelId, null))
  if (page && page.videos.length > 0) {
    // Carry forward a previously-known logo/banner if this fetch's meta came back without one
    // (a transient parse miss shouldn't erase artwork we already had — that's the "shows in
    // search but not on the channel page" inconsistency).
    if (page.meta) {
      const prev = cached?.metaJson ? (JSON.parse(cached.metaJson) as ItChannelPage['meta']) : null
      if (prev) {
        page.meta.thumbnailUrl ??= prev.thumbnailUrl ?? null
        page.meta.bannerUrl ??= prev.bannerUrl ?? null
      }
    }
    const row = {
      channelId,
      metaJson: page.meta ? JSON.stringify(page.meta) : null,
      videosJson: JSON.stringify(page.videos),
      continuation: page.continuation ?? null,
      fetchedAt: new Date(),
    }
    await db.insert(ytChannelCache).values(row).onConflictDoUpdate({
      target: ytChannelCache.channelId,
      set: { metaJson: row.metaJson, videosJson: row.videosJson, continuation: row.continuation, fetchedAt: row.fetchedAt },
    })
    return c.json(page)
  }

  // Live failed or empty → never show an empty channel if we have *any* cached page.
  if (cached) return c.json(readCache())

  // No cache at all: return whatever we got (meta may exist even with zero videos —
  // e.g. a channel that genuinely has no uploads).
  return c.json(page ?? ({ meta: null, videos: [], continuation: null } as ItChannelPage))
})

// A channel's secondary tabs — Shorts, Live (past streams), Playlists, and About.
// Unlike the Videos tab these aren't cached (they're opened far less), but they page off
// the same continuation tokens. `cursor` is the opaque token from the previous page.
youtubeRoute.get('/channel/:channelId/:tab', async (c) => {
  const channelId = c.req.param('channelId')
  const tab = c.req.param('tab')
  const cursor = c.req.query('cursor') ?? null

  if (tab === 'about') {
    const about = await tryInnertube('channel-about', () => innertubeChannelAbout(channelId), null)
    return c.json({ about })
  }
  if (tab === 'playlists') {
    const page = await tryInnertubeRetry('channel-playlists', () => innertubeChannelPlaylists(channelId, cursor))
    return c.json(page ?? { meta: null, playlists: [], continuation: null })
  }
  if (tab === 'shorts' || tab === 'live') {
    const page = await tryInnertubeRetry(`channel-${tab}`, () => innertubeChannel(channelId, cursor, 30, 8000, tab))
    return c.json(page ?? { meta: null, videos: [], continuation: null })
  }
  return c.json({ error: 'Unknown channel tab' }, 404)
})

// Real "Up next" — YouTube's own related videos for this watch page. Cached (20min,
// matching typed search above): every watch-page open re-fetched this live from
// InnerTube (~1.7s measured). cachedLookup is INSIDE tryInnertube — not around it like
// the search route — so a transient InnerTube failure returns [] once instead of
// memoizing an empty "Up next" rail for the full TTL.
youtubeRoute.get('/related/:videoId', async (c) => {
  const user = c.get('user')
  const videoId = c.req.param('videoId')
  const limit = Math.min(40, parseInt(c.req.query('limit') ?? '20', 10))

  // Linked account first: Google's OWN watch-next picks for this user on this video
  // ('next' on the TV client) beat anything the anonymous related graph can guess.
  // Cached 10min per (user, video); best-effort, so an expired token or upstream
  // hiccup just leaves the anonymous rail alone.
  let personalized: ItVideo[] = []
  const accountToken = await getValidAccessToken(user.id).catch(() => null)
  if (accountToken) {
    const { fetchAccountNext } = await import('@/lib/youtube/tvClient')
    const items = await cachedLookup('yt-account-next', `${user.id}:${videoId}`, 10 * 60_000,
      () => fetchAccountNext(accountToken, videoId, limit)).catch(() => [])
    personalized = items.map(v => ({
      videoId: v.videoId, title: v.title, author: v.author, channelId: v.channelId,
      channelThumb: null, thumbnailUrl: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
      durationSec: v.durationSec, publishedText: v.publishedText, views: v.views,
    }))
  }

  const anon = await tryInnertube('related',
    () => cachedLookup('youtube:related', `${videoId}:${limit}`, 20 * 60_000, () => innertubeRelated(videoId, limit)),
    [])
  // Account picks lead; anonymous related tops up, deduped, same response shape.
  const seen = new Set(personalized.map(v => v.videoId))
  const videos = [...personalized, ...anon.filter(v => !seen.has(v.videoId))].slice(0, limit)
  return c.json({ videos: await filterYtItemsForUser(user.id, videos) })
})

// Topic-grouped related shelves — an LLM names the video's 2-4 concrete subjects from its
// title + transcript (cached on yt_videos), then each becomes a labeled InnerTube video
// search. Complements /related above (engagement-ranked, unlabeled) with "more about the
// THING in this video" rows. Searches share the typed-search cache key, so a shelf query
// and the same manual search never fetch twice.
youtubeRoute.get('/related-searches/:videoId', async (c) => {
  const user = c.get('user')
  const videoId = c.req.param('videoId')
  const topics = await ensureRelatedTopics(videoId, user.id, await getUserFirstName(user.id))
    .catch((err) => { logger.warn({ err, videoId }, 'yt related topics failed'); return [] as string[] })
  if (!topics.length) return c.json({ topics: [] })

  const safe = (await videoPolicyFor(user.id)).restrictedMode
  const results = await Promise.all(topics.map(async (query) => {
    const page = await cachedLookup('youtube:search', `videos:${query.toLowerCase()}:${safe ? 's' : 'o'}`, 20 * 60_000, () => tryInnertube('typedSearch',
      () => innertubeSearch(query, 14, 0, 8000, 0, SEARCH_FILTERS.videos, safe),
      { videos: [], channels: [], playlists: [], continuation: null }))
    return { query, videos: await filterYtItemsForUser(user.id, page.videos) }
  }))
  // Closely-phrased topics return overlapping results — each video appears once, on the
  // earliest (highest-priority) shelf, so two shelves never show the same card.
  const seen = new Set<string>([videoId])
  const shelves = results.map(({ query, videos }) => {
    const fresh = videos.filter(v => !seen.has(v.videoId)).slice(0, 10)
    for (const v of fresh) seen.add(v.videoId)
    return { query, videos: fresh }
  })
  return c.json({ topics: shelves.filter(s => s.videos.length > 0) })
})

// Comments — InnerTube `next` continuation, proxied so the browser never hits Google.
youtubeRoute.get('/comments/:videoId', async (c) => {
  const videoId = c.req.param('videoId')
  const limit = Math.min(50, parseInt(c.req.query('limit') ?? '20', 10))
  const comments = await tryInnertube('comments', () => innertubeComments(videoId, limit), [])
  return c.json({ comments })
})

// Authoritative chapter list (creator/auto chapters) — used to enrich the watch page
// when the description has no parseable timestamps. Chapterless videos fall back to
// AI chapters built from the caption track: served instantly when cached, otherwise a
// background build is kicked and this returns empty with `aiPending` so clients know
// chapters may appear on a later fetch.
youtubeRoute.get('/chapters/:videoId', async (c) => {
  const user = c.get('user')
  const videoId = c.req.param('videoId')
  const chapters = await tryInnertube('chapters', () => innertubeChapters(videoId), [])
  if (chapters.length > 0) return c.json({ chapters })

  const ai = await peekAiChapters(videoId)
  if (ai && ai.length > 0) return c.json({ chapters: ai, ai: true })
  if (ai === undefined && user) {
    kickAiChapters(videoId, user.id, await getUserFirstName(user.id))
    return c.json({ chapters: [], aiPending: true })
  }
  return c.json({ chapters: [] })
})

// "Get To The Point": AI filler segments (drawn-out intros, housekeeping, repeated
// recaps, padding) served like SponsorBlock spans. Instant from cache; a miss kicks
// a background analysis and returns `pending` so clients poll while playing.
youtubeRoute.get('/filler/:videoId', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  const videoId = c.req.param('videoId')
  const segments = await peekFiller(videoId)
  if (segments !== undefined) return c.json({ segments: segments ?? [] })
  kickFiller(videoId, user.id, await getUserFirstName(user.id))
  return c.json({ segments: [], pending: true })
})

// The linked account's raw YouTube home feed (Google's recommender), used to
// calibrate and seed our own suggestions. Also handy for eyeballing what Google
// thinks this user likes.
youtubeRoute.get('/account/home-feed', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  const token = await getValidAccessToken(user.id).catch(() => null)
  if (!token) return c.json({ linked: false, videos: [] })
  const { fetchHomeFeed } = await import('@/lib/youtube/tvClient')
  const videos = await fetchHomeFeed(token, 60).catch(() => [])
  return c.json({ linked: true, videos })
})

// "Worth it?": pre-watch verdict (tl;dr, does-it-answer-the-title, real topics).
// Instant from cache; a miss kicks a background build and returns `pending`.
youtubeRoute.get('/worth/:videoId', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  const videoId = c.req.param('videoId')
  const title = c.req.query('title')?.trim() || videoId
  const verdict = await peekWorth(videoId)
  if (verdict !== undefined) return c.json({ verdict })
  kickWorth(videoId, title, user.id, await getUserFirstName(user.id))
  return c.json({ verdict: null, pending: true })
})

// Pop-Up Facts: VH1-style trivia bubbles timed to the video's topic sections.
// Instant from cache; a miss kicks a background build and returns `pending`.
youtubeRoute.get('/popup/:videoId', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  const videoId = c.req.param('videoId')
  const facts = await peekPopupFacts(videoId)
  if (facts !== undefined) return c.json({ facts: facts ?? [] })
  kickPopupFacts(videoId, user.id, await getUserFirstName(user.id))
  return c.json({ facts: [], pending: true })
})

// "Ask This Video": transcript-grounded Q&A with jump-to-moment citations.
// Instant from cache per (video, question); a miss kicks a background build and
// returns `pending` so clients poll while playback continues.
youtubeRoute.get('/ask/:videoId', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  const videoId = c.req.param('videoId')
  const question = c.req.query('q')?.trim()
  if (!question || question.length < 3) return c.json({ error: 'question required' }, 400)

  const cached = await peekAsk(videoId, question)
  if (cached !== undefined) return c.json({ result: cached })
  kickAsk(videoId, question, user.id, await getUserFirstName(user.id))
  return c.json({ result: null, pending: true })
})

// "Previously..." resume recap: a 2-3 sentence reminder of everything before the
// viewer's resume point. Instant from cache; a miss kicks a background build and
// returns `pending` so the client can poll while playback continues.
youtubeRoute.get('/recap/:videoId', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  const videoId = c.req.param('videoId')
  const atSec = parseInt(c.req.query('atSec') ?? '0', 10)
  if (!Number.isFinite(atSec) || atSec < 300) return c.json({ recap: null })

  const bucket = recapBucket(atSec)
  const recap = await peekRecap(videoId, bucket)
  if (recap !== undefined) return c.json({ recap })
  kickRecap(videoId, user.id, await getUserFirstName(user.id), atSec)
  return c.json({ recap: null, pending: true })
})

// Most-replayed heatmap: the rewatch-intensity curve drawn under the scrubber. Rides the
// same `next` response as chapters, so it's cached for a day (heat data moves slowly and
// a cold call costs a full InnerTube round trip). Empty for videos with no heat data.
youtubeRoute.get('/heatmap/:videoId', async (c) => {
  const videoId = c.req.param('videoId')
  const markers = await cachedLookup('youtube:heatmap', videoId, 24 * 60 * 60_000, () =>
    tryInnertube('heatmap', () => innertubeHeatmap(videoId), []))
  return c.json({ markers: markers ?? [] })
})

// Return YouTube Dislike — estimated like/dislike counts, proxied server-side.
youtubeRoute.get('/votes/:videoId', async (c) => {
  const videoId = c.req.param('videoId')
  const votes = await getVotes(videoId)
  return c.json({ votes })
})

// A playlist's videos (for browsing a playlist found in search).
youtubeRoute.get('/playlist/:playlistId', async (c) => {
  const playlistId = c.req.param('playlistId')
  const page = await tryInnertube('playlist', () => innertubePlaylist(playlistId), { title: null, description: null, owner: null, videos: [] })
  return c.json(page)
})

// YouTube-style sectioned home: 4-6 topic shelves per serve, grouped server-side
// from the user's interest pool (sub-topic and topic-search candidates by their
// query, plus large semantic clusters), rotating which topics get shelves per 6h
// window. Videos use the /recommended serialization (itVideoResult + why).
// ?includeMixed=1 appends one 12-item mixed shelf from the normal serve; by
// default there is none (the client already has Suggested via /recommended).
youtubeRoute.get('/home-shelves', async (c) => {
  const user = c.get('user')

  // Same per-user "no suggestions" limit as /recommended (kids).
  if ((await getVideoViewFlags(user.id)).noSuggestions) return c.json({ shelves: [] })

  const { shelves } = await serveYtHomeShelves(user.id, c.req.query('includeMixed') === '1')
  return c.json({
    shelves: shelves.map(s => ({
      key: s.key,
      title: s.title,
      kind: s.kind,
      videos: s.videos.map(v => ({ ...itVideoResult(v), why: v.why })),
    })),
  })
})

// "Recommended for you" — discover content beyond your subscriptions. Served from the
// interest engine (lib/interests/videos.ts): a background-built pool ranked against the
// user's recent interests (stratified history seeds + topic searches + creator affinity),
// excluding everything watched and rotating via impression demotion. While the first pool
// build runs (building:true), the legacy chain below serves: live related fan-out from
// the newest watches → subscription uploads → popular.
youtubeRoute.get('/recommended', async (c) => {
  const user = c.get('user')

  // Per-user "no suggestions" limit (kids): serve nothing rather than trust the UI to hide.
  if ((await getVideoViewFlags(user.id)).noSuggestions) return c.json({ videos: [], building: false })

  // Endless scroll grows the ask. The ranked pool covers the first ~120;
  // past that the bottomless extension fans out live related videos from the
  // feed's own tail (web-YouTube's endless home), capped at 600 per session.
  const limit = Math.min(600, Math.max(1, parseInt(c.req.query('limit') ?? '24', 10) || 24))
  const suggested = await serveYtRecommendedDeep(user.id, limit)
  if (!suggested.building && suggested.videos.length) {
    return c.json({ videos: suggested.videos, seeded: true, building: false })
  }

  // Up to 100 recently-watched ids: the newest few are seeds, all are the exclude set.
  const watched = await db.select({ videoId: ytWatchState.videoId, updatedAt: ytWatchState.updatedAt })
    .from(ytWatchState).where(eq(ytWatchState.userId, user.id))
    .orderBy(desc(ytWatchState.updatedAt)).limit(100)
  const watchedSet = new Set(watched.map(w => w.videoId))

  let seeds = watched.slice(0, 5).map(w => w.videoId)

  // No watch history yet → seed from the latest subscription uploads.
  if (seeds.length < 2) {
    const subs = await db.select({ id: ytSubscriptions.id }).from(ytSubscriptions).where(eq(ytSubscriptions.userId, user.id))
    if (subs.length) {
      const recent = await db.select({ videoId: ytVideos.videoId }).from(ytVideos)
        .where(inArray(ytVideos.subscriptionId, subs.map(s => s.id)))
        .orderBy(desc(ytVideos.publishedAt)).limit(5)
      seeds = recent.map(r => r.videoId)
    }
  }

  // Still nothing (brand-new user) → just show what's popular.
  if (!seeds.length) {
    const videos = await filterYtItemsForUser(user.id, await fetchPopular(24))
    return c.json({ videos, seeded: false, building: suggested.building })
  }

  // Fan out related lookups across the seeds, then merge + dedupe + filter watched.
  const lists = await Promise.all(seeds.slice(0, 4).map(id => tryInnertube('recRelated', () => innertubeRelated(id, 15), [] as ItVideo[])))
  const out: ItVideo[] = []
  const seen = new Set<string>()
  for (const list of lists) {
    for (const v of list) {
      if (watchedSet.has(v.videoId) || seen.has(v.videoId)) continue
      seen.add(v.videoId); out.push(v)
    }
  }
  // Interleave isn't critical; shuffle-light by round-robin would help variety, but a
  // simple merge already mixes seeds since we iterate lists in order.
  const videos = await filterYtItemsForUser(user.id, out.slice(0, 24))
  await enrichChannelThumbs(videos)
  return c.json({ videos, seeded: true, building: suggested.building })
})

// ── SponsorBlock ────────────────────────────────────────────────────────────────
// Proxied so the browser never tells a third party which videos are being watched.

youtubeRoute.get('/sponsorblock/:videoId', async (c) => {
  const user = c.get('user')
  const videoId = c.req.param('videoId')
  // Per-category behavior: each returned segment carries the user's mode for its
  // category (skip / show / prompt). Category set to off never leaves the server.
  // Legacy boolean prefs map to skip/off, so old settings keep working, and old
  // clients that ignore `mode` still auto-skip exactly the segments they used to
  // receive when we drop the non-skip ones for them (no `modes=1` query flag).
  const modes = await getUserSkipModes(user.id)
  const wantModes = c.req.query('modes') === '1'
  const withModes = (await getSkipSegments(videoId))
    .map(s => ({ ...s, mode: modes[s.category as keyof typeof modes] ?? 'off' }))
    .filter(s => s.mode !== 'off')
  const segments = wantModes ? withModes : withModes.filter(s => s.mode === 'skip')
  return c.json({ segments })
})

// ── DeArrow ───────────────────────────────────────────────────────────────────
// Crowdsourced de-clickbait titles/thumbnails. Batched by id so a feed of cards is a
// single round-trip; thumbnails are proxied through us (separate host from /img).
//
// Honest Titles ride the same response: DeArrow only covers videos someone has taken
// the trouble to retitle, so a small channel's clickbait never gets touched. When the
// community has nothing for an id, we fall back to our own cached AI rewrite (see
// lib/youtube/honestTitle.ts). A human vote always beats the model, and every client
// already renders whatever title this endpoint hands back, so all of them get it.

youtubeRoute.post('/dearrow', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ videoIds?: string[] }>().catch(() => ({ videoIds: [] }))
  const ids = (body.videoIds ?? []).filter(id => isValidVideoId(id)).slice(0, 100)
  if (!ids.length) return c.json({ branding: {} })
  const raw = await getDeArrowBatch(ids)
  // Hand the client a ready-to-render thumbnail URL (proxied) instead of the timestamp.
  const branding: Record<string, { title: string | null; thumbnailUrl: string | null }> = {}
  for (const [id, b] of Object.entries(raw)) {
    branding[id] = {
      title: b.title,
      thumbnailUrl: b.thumbTime != null ? `/api/youtube/dearrow-thumb/${id}?t=${b.thumbTime}` : null,
    }
  }
  const honest = await honestTitlesFor(ids.filter(id => !branding[id]?.title), user.id)
  for (const [id, title] of Object.entries(honest)) {
    branding[id] = { title, thumbnailUrl: branding[id]?.thumbnailUrl ?? null }
  }
  return c.json({ branding })
})

youtubeRoute.get('/dearrow-thumb/:videoId', async (c) => {
  const videoId = c.req.param('videoId')
  const time = parseFloat(c.req.query('t') ?? '')
  if (!isValidVideoId(videoId) || !Number.isFinite(time)) return c.json({ error: 'bad request' }, 400)
  // Upstream renders a video frame on demand — expensive for them, slow for us — but the
  // frame for a given id@time never changes. Disk-cached server-side (lib/youtube/dearrow),
  // immutable + ETag'd client-side, so repeat views cost a 304 at most.
  const cacheControl = 'public, max-age=604800, immutable'
  const etag = `"${deArrowThumbKey(videoId, time).slice(0, 32)}"`
  if (c.req.header('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { etag, 'cache-control': cacheControl } })
  }
  const img = await getOrFetchDeArrowThumb(videoId, time)
  if (!img) return c.json({ error: 'upstream' }, 502)
  return new Response(img.data as unknown as BodyInit, {
    headers: { 'content-type': img.contentType, 'cache-control': cacheControl, etag },
  })
})

// ── Privacy stream proxy ────────────────────────────────────────────────────────
// Stream a video (or its audio) through our own server so the client never contacts
// Google — no embed, no cookies, no tracking. yt-dlp resolves a direct
// googlevideo URL (solving the signature/throttle ciphers); we proxy the bytes with
// Range passthrough so seeking works.

youtubeRoute.get('/stream/:videoId', async (c) => {
  const videoId = c.req.param('videoId')
  if (!isValidVideoId(videoId)) return c.json({ error: 'Invalid video id' }, 400)
  const kind: StreamKind = c.req.query('kind') === 'audio' ? 'audio' : 'video'
  let quality = parseQuality(c.req.query('q'))

  // High tiers (1080/1440/2160): YouTube splits everything above 720p into video-only +
  // audio-only tracks, so this branch remuxes the pair server-side — ffmpeg stream copy
  // (no re-encode) into fragmented MP4, piped straight to the response. Above 1080p the
  // tracks are VP9/AV1 (h264 stops at 1080), which modern browsers decode fine in MP4.
  // The pipe is not byte-seekable; the player seeks by re-requesting with ?t=<seconds>,
  // which ffmpeg honors with an input-side -ss (fast keyframe seek in both tracks).
  if (kind === 'video' && REMUX_QUALITIES.has(quality)) {
    const maxHeight = Number(quality)
    const urls = await resolveSplitStreamUrls(videoId, maxHeight)
    if (urls) {
      await ensureFfmpeg().catch(() => { /* falls out below if the binary is truly absent */ })
      const startSec = Math.max(0, Number.parseFloat(c.req.query('t') ?? '0') || 0)
      const seek = startSec > 0.25 ? ['-ss', startSec.toFixed(3)] : []
      // googlevideo is picky about the UA matching the client that resolved the URL,
      // and long plays benefit from ffmpeg's own reconnect handling. The tight probe
      // caps matter for time-to-first-byte: ffmpeg's defaults read ~5MB per input
      // before emitting anything, which costs seconds at googlevideo's paced delivery.
      const inputFlags = [
        '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '2',
        '-probesize', '1000000', '-analyzeduration', '1000000',
      ]
      const proc = spawn(ffmpegBin(), [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        ...inputFlags, ...seek, '-i', urls.video,
        ...inputFlags, ...seek, '-i', urls.audio,
        '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        // Emit ~1s fragments and flush eagerly so the browser can start decoding the
        // moment data exists instead of waiting on ffmpeg's internal buffering.
        '-frag_duration', '1000000', '-flush_packets', '1',
        '-f', 'mp4', 'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let ffErr = ''
      proc.stderr?.on('data', (d) => { ffErr = (ffErr + String(d)).slice(-2048) })
      // A ChildProcess 'error' event (ffmpeg binary missing — ensureFfmpeg() never throws and
      // falls back to a bare 'ffmpeg' that may not exist — or a transient EMFILE) is otherwise
      // unhandled and becomes an uncaughtException, which index.ts turns into process.exit(1).
      // Swallow it: the response body (proc.stdout) will error and close on its own.
      proc.on('error', (err) => {
        invalidateSplitStreamUrls(videoId, maxHeight)
        logger.warn(`[youtube/stream] remux ffmpeg spawn failed for ${videoId}: ${String(err)}`)
      })
      proc.on('close', (code) => {
        if (code) {
          // A dead remux usually means the signed URLs rotated — drop them so the
          // player's retry (or next seek) resolves fresh instead of failing the same way.
          invalidateSplitStreamUrls(videoId, maxHeight)
          if (!c.req.raw.signal.aborted) logger.warn(`[youtube/stream] remux ffmpeg exited ${code} for ${videoId}: ${ffErr.slice(-400)}`)
        }
      })
      c.req.raw.signal.addEventListener('abort', () => { try { proc.kill('SIGKILL') } catch { /* already gone */ } }, { once: true })
      return new Response(proc.stdout as any, {
        status: 200,
        headers: {
          'content-type': 'video/mp4',
          'cache-control': 'private, max-age=0',
          // Deliberately NOT byte-seekable — the client seeks via ?t= re-requests.
          'accept-ranges': 'none',
        },
      })
    }
    // No suitable split tracks (rare) → serve the best progressive stream instead.
    quality = 'auto'
  }

  // ?film=1 asks for the authenticated resolve. Honored only when the
  // household has switched it on and a cookies.txt actually exists.
  const asFilm = c.req.query('film') === '1' && await movieAuthEnabled()
  const upstreamUrl = await resolveStreamUrl(videoId, kind, quality, false, asFilm)
  if (!upstreamUrl) {
    // Last resort: both the InnerTube fast path and the yt-dlp -g retry chain gave up (see
    // resolveStreamUrl) — instead of dead-ending the player, kick off the same offline-download
    // pipeline "Save offline" uses (enqueueVideoSave is idempotent: it coalesces with any save/
    // job already in flight for this video) and tell the client to wait for the file rather
    // than erroring out.
    const user = c.get('user')
    const firstName = await getUserFirstName(user.id)
    await enqueueVideoSave({ userId: user.id, videoId, title: '', kind, maxHeight: null, firstName })
      .catch(err => logger.warn(`[youtube/stream] fallback download enqueue failed for ${videoId}: ${err}`))
    return c.json({ status: 'preparing', videoId, kind }, 202)
  }

  // Abort the upstream fetch when the client disconnects (seek/close) so we don't keep
  // draining a googlevideo connection into a dead socket.
  const ac = new AbortController()
  c.req.raw.signal.addEventListener('abort', () => ac.abort(), { once: true })

  const range = c.req.header('range')
  // Combine the client-disconnect signal with a hard timeout so a googlevideo connection
  // that stalls mid-handshake can't hang the request (and the proxied socket) forever.
  const fetchUpstream = (url: string) => fetch(url, {
    signal: AbortSignal.any([ac.signal, AbortSignal.timeout(30_000)]),
    headers: {
      ...(range ? { Range: range } : {}),
      // googlevideo is picky about the UA that matches the cipher solve.
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  })

  try {
    let upstream = await fetchUpstream(upstreamUrl)
    // A 403 usually means the cached URL's signature rotated — re-resolve once. Force the
    // yt-dlp path here: if the fast InnerTube URL was the one that 403'd, retrying it the
    // same way would likely 403 again, so fall straight through to the robust resolver.
    if (upstream.status === 403) {
      // Drain the stale response before refetching so its connection isn't leaked.
      try { await upstream.body?.cancel() } catch { /* already closed */ }
      invalidateStreamUrl(videoId, kind, quality)
      const fresh = await resolveStreamUrl(videoId, kind, quality, true, asFilm)
      if (fresh) upstream = await fetchUpstream(fresh)
    }
    if (!upstream.ok && upstream.status !== 206) {
      return c.json({ error: `Upstream ${upstream.status}` }, 502)
    }

    // Forward the bytes plus the headers a media element needs to seek.
    const headers = new Headers()
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(h)
      if (v) headers.set(h, v)
    }
    if (!headers.has('accept-ranges')) headers.set('accept-ranges', 'bytes')
    if (!headers.has('content-type')) headers.set('content-type', kind === 'audio' ? 'audio/mp4' : 'video/mp4')
    headers.set('cache-control', 'private, max-age=0')

    return new Response(upstream.body, { status: upstream.status, headers })
  } catch (err) {
    // Client went away mid-stream — expected, nothing to send back.
    if (ac.signal.aborted) return new Response(null, { status: 499 })
    return c.json({ error: 'Stream failed' }, 502)
  }
})

// Pre-resolve (and cache) the proxy stream URL ahead of time so a later hand-off to the
// docked mini-player plays instantly instead of waiting on a cold resolve (InnerTube →
// yt-dlp). Fire-and-forget: returns immediately while the cache warms in the background.
youtubeRoute.get('/stream/:videoId/prewarm', async (c) => {
  const videoId = c.req.param('videoId')
  if (!isValidVideoId(videoId)) return c.json({ error: 'Invalid video id' }, 400)
  // Warm the SAME (videoId, kind, quality) the caller will actually play — the caches are
  // keyed accordingly, so warming 'video'/'auto' does nothing for a 1080p-remux consumer.
  const kind: StreamKind = c.req.query('kind') === 'audio' ? 'audio' : 'video'
  const quality = parseQuality(c.req.query('q'))
  if (kind === 'video' && REMUX_QUALITIES.has(quality)) void resolveSplitStreamUrls(videoId, Number(quality))
  else void resolveStreamUrl(videoId, kind, REMUX_QUALITIES.has(quality) ? 'auto' : quality)
  return c.body(null, 204)
})

// Remux seek alignment: the player asks where the video keyframe at-or-before `t`
// actually sits, then requests the stream from THAT timestamp - starting both tracks on
// the same keyframe is what keeps audio and video in sync across seeks (a bare -ss snaps
// video back to the previous keyframe while audio seeks exactly). Falls back to the raw
// `t` when anything fails, which merely reintroduces the up-to-a-GOP offset.
youtubeRoute.get('/stream/:videoId/align', async (c) => {
  const videoId = c.req.param('videoId')
  if (!isValidVideoId(videoId)) return c.json({ error: 'Invalid video id' }, 400)
  const quality = parseQuality(c.req.query('q'))
  const t = Math.max(0, Number.parseFloat(c.req.query('t') ?? '0') || 0)
  if (!REMUX_QUALITIES.has(quality) || t <= 0.25) return c.json({ start: t })
  const urls = await resolveSplitStreamUrls(videoId, Number(quality))
  if (!urls) return c.json({ start: t })
  const kf = await probeKeyframeBefore(urls.video, t)
  return c.json({ start: kf ?? t })
})

// ── HLS presentation (Apple TV / AVPlayer) ──────────────────────────────────────
// A seekable VOD alternative to the ffmpeg remux pipe above, for native players that need
// a real timeline instead of an endless fragmented-MP4 stream. Nothing here transcodes or
// spawns anything: YouTube's DASH tracks are already fragmented MP4 with a `sidx` index,
// so lib/youtube/hls.ts turns that index into byte-range HLS segments and the segment
// route below is plain Range passthrough. Falls back with 404 + the progressive URL when a
// video has no indexable avc1 track. That stream is Range-seekable already, just capped
// at 720p.
//
// Two tiers, picked by `q` on the master playlist:
//   q=auto/360/720/1080 → passthrough (lib/youtube/hls.ts). Zero CPU, instant seeks.
//   q=1440/2160         → HEVC transcode (lib/youtube/hlsTranscode.ts), because YouTube
//                         publishes nothing above 1080p that isn't VP9 or AV1, and the
//                         Apple TV 4K (A10X) decodes neither. Falls back to the
//                         passthrough tier when the box has no hardware HEVC encoder or
//                         the video has no track above 1080p.

/** The tier query the transcode master playlist propagates down to its media playlist and
 *  segments (the passthrough tier has a single quality, so its URIs carry no query). */
function hlsQuery(c: Context<AppEnv>): string {
  const q = parseQuality(c.req.query('q'))
  return q === 'auto' ? '' : `?q=${q}`
}

// Playlists are static for the life of a cached presentation (TTL 3h), so let the player
// keep them 10 min instead of re-fetching on every quality flip / player re-open.
const hlsPlaylistResponse = (c: Context<AppEnv>, body: string) =>
  c.body(body, 200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'private, max-age=600' })

const hlsUnavailable = (c: Context<AppEnv>, videoId: string) =>
  c.json({ error: 'No HLS presentation for this video', fallback: `/api/youtube/stream/${videoId}?kind=video` }, 404)

/** Variant discriminator for the passthrough video playlist/segments: `?v=720` selects
 *  the secondary rung. No/unknown query = the original single-1080p behavior. */
const hlsVariant = (c: Context<AppEnv>): HlsVideoVariant | undefined =>
  c.req.query('v') === '720' ? '720' : undefined

/** Cheap on-disk lookup for an ALREADY-fetched transcript VTT. Deliberately never calls
 *  ensureTranscript (yt-dlp / network): the HLS master must reflect what exists right
 *  now, not stall playback acquiring captions. The /video route's play-time enrichment
 *  fetches captions in the background, so replays pick the rendition up naturally. */
async function findExistingTranscriptVtt(userId: string, videoId: string): Promise<string | null> {
  if (!isValidVideoId(videoId)) return null
  // Downloads row first (same precedence as the /transcript route).
  const [dl] = await db.select({ transcriptRelPath: ytDownloads.transcriptRelPath })
    .from(ytDownloads)
    .where(and(eq(ytDownloads.userId, userId), eq(ytDownloads.videoId, videoId)))
    .limit(1)
  if (dl?.transcriptRelPath) {
    const p = await resolveUserPath(dl.transcriptRelPath)
    if (p.endsWith('.vtt') && existsSync(p)) return p
  }
  // Then the per-user transcripts dir ensureTranscript writes into (any language suffix).
  const firstName = await getUserFirstName(userId)
  const dir = await userPath(userId, firstName, 'youtube/transcripts')
  const files = await readdir(dir).catch(() => [] as string[])
  const vtt = files.find(f => f.startsWith(`${videoId}.`) && f.endsWith('.vtt'))
  return vtt ? join(dir, vtt) : null
}

/** One track's media playlist. Segment URIs are relative to this playlist's own directory
 *  (`…/hls/`), so the player stays on our origin and keeps sending the session cookie. */
async function serveHlsMediaPlaylist(c: Context<AppEnv>, kind: StreamKind) {
  const videoId = c.req.param('videoId')
  if (!isValidVideoId(videoId)) return c.json({ error: 'Invalid video id' }, 400)
  const pres = await getHlsPresentation(videoId)
  if (!pres) return hlsUnavailable(c, videoId)
  // `?v=720` with no low rung falls back to the primary track (still a valid answer).
  const use720 = kind === 'video' && hlsVariant(c) === '720' && !!pres.video720
  const track = kind === 'audio' ? pres.audio : use720 ? pres.video720! : pres.video
  return hlsPlaylistResponse(c, hlsMediaPlaylist(track, use720 ? 'video.mp4?v=720' : `${kind}.mp4`))
}

/** The bytes behind every segment of one track: a Range proxy over the upstream DASH file,
 *  same shape as the progressive proxy (403 → re-resolve once → retry). */
async function serveHlsTrack(c: Context<AppEnv>, kind: StreamKind) {
  const videoId = c.req.param('videoId')
  if (!isValidVideoId(videoId)) return c.json({ error: 'Invalid video id' }, 400)
  const pres = await getHlsPresentation(videoId)
  if (!pres) return hlsUnavailable(c, videoId)
  const use720 = kind === 'video' && hlsVariant(c) === '720' && !!pres.video720
  const track = kind === 'audio' ? pres.audio : use720 ? pres.video720! : pres.video

  const ac = new AbortController()
  c.req.raw.signal.addEventListener('abort', () => ac.abort(), { once: true })
  const range = c.req.header('range')
  const fetchUpstream = (url: string) => fetch(url, {
    signal: AbortSignal.any([ac.signal, AbortSignal.timeout(30_000)]),
    headers: {
      ...(range ? { Range: range } : {}),
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  })

  try {
    let upstream = await fetchUpstream(track.url)
    // 403 = the signature rotated mid-play. Re-resolving is only safe when the fresh URL
    // is the same itag (refreshHlsTrackUrl enforces that), otherwise every byte offset in
    // the playlist the client is holding would point at the wrong file.
    if (upstream.status === 403) {
      try { await upstream.body?.cancel() } catch { /* already closed */ }
      const fresh = await refreshHlsTrackUrl(videoId, kind, use720 ? '720' : undefined)
      if (fresh) upstream = await fetchUpstream(fresh)
    }
    if (!upstream.ok && upstream.status !== 206) return c.json({ error: `Upstream ${upstream.status}` }, 502)

    const headers = new Headers()
    for (const h of ['content-length', 'content-range']) {
      const v = upstream.headers.get(h)
      if (v) headers.set(h, v)
    }
    headers.set('content-type', kind === 'audio' ? 'audio/mp4' : 'video/mp4')
    headers.set('accept-ranges', 'bytes')
    // A byte range of an immutable DASH file never changes — cache hard so a replayed
    // segment (seek back, rebuffer) is served from the player's own cache, not upstream.
    headers.set('cache-control', 'private, max-age=31536000, immutable')
    return new Response(upstream.body, { status: upstream.status, headers })
  } catch {
    if (ac.signal.aborted) return new Response(null, { status: 499 })   // client seeked/closed
    return c.json({ error: 'Stream failed' }, 502)
  }
}

/** The transcoded tier this request asks for, or null for the passthrough tier. */
function transcodeHeight(c: Context<AppEnv>): number | null {
  const height = Number(parseQuality(c.req.query('q')))
  return TRANSCODE_HEIGHTS.has(height) ? height : null
}

/** Serve one file produced by a transcode session, translating the two "not now" answers
 *  into statuses the player understands: 503 (encoders busy, retry) vs 404 (no such tier). */
function transcodeFileResponse(c: Context<AppEnv>, result: SegmentResult, videoId: string) {
  if (result === 'capacity') return c.json({ error: 'Transcoders busy' }, 503, { 'retry-after': '5' })
  if (result === 'unavailable') return hlsUnavailable(c, videoId)
  return new Response(Bun.file(result), {
    headers: { 'content-type': 'video/mp4', 'cache-control': 'private, max-age=0' },
  })
}

// Master playlist: the entry point a native client opens. `q` picks the tier (see the
// block comment above) and is propagated to the media playlists.
youtubeRoute.get('/stream/:videoId/hls.m3u8', async (c) => {
  const videoId = c.req.param('videoId')
  if (!isValidVideoId(videoId)) return c.json({ error: 'Invalid video id' }, 400)
  const height = transcodeHeight(c)
  if (height) {
    const plan = await getTranscodePlan(videoId, height)
    if (plan) return hlsPlaylistResponse(c, hevcMasterPlaylist(plan, hlsQuery(c)))
    // No 4K source or no hardware encoder: 1080p passthrough beats an unplayable playlist.
    logger.info(`[youtube/hls] ${videoId}: no ${height}p transcode tier, serving the 1080p passthrough tier`)
  }
  const pres = await getHlsPresentation(videoId)
  if (!pres) return hlsUnavailable(c, videoId)
  // Subtitles rendition only when a transcript VTT already exists on disk (cheap check,
  // never a fetch): an advertised rendition that 404s would stall AVPlayer.
  const vtt = await findExistingTranscriptVtt(c.get('user').id, videoId).catch(() => null)
  return hlsPlaylistResponse(c, hlsMasterPlaylist(pres, { subtitles: !!vtt }))
})

youtubeRoute.get('/stream/:videoId/hls/video.m3u8', (c) => serveHlsMediaPlaylist(c, 'video'))
youtubeRoute.get('/stream/:videoId/hls/audio.m3u8', (c) => serveHlsMediaPlaylist(c, 'audio'))
youtubeRoute.get('/stream/:videoId/hls/video.mp4', (c) => serveHlsTrack(c, 'video'))
youtubeRoute.get('/stream/:videoId/hls/audio.mp4', (c) => serveHlsTrack(c, 'audio'))

// I-frame playlist for native trick play. Built from the lightest indexed variant so
// scrub thumbnails pull the fewest bytes; every segment start is a keyframe (SAP 1).
youtubeRoute.get('/stream/:videoId/hls/iframe.m3u8', async (c) => {
  const videoId = c.req.param('videoId')
  if (!isValidVideoId(videoId)) return c.json({ error: 'Invalid video id' }, 400)
  const pres = await getHlsPresentation(videoId)
  if (!pres) return hlsUnavailable(c, videoId)
  const track = pres.video720 ?? pres.video
  return hlsPlaylistResponse(c, hlsIframePlaylist(track, pres.video720 ? 'video.mp4?v=720' : 'video.mp4'))
})

// Subtitle rendition: a single-segment WebVTT playlist over the full duration, backed by
// the transcript VTT already on disk. 404 when none exists (the master then never
// advertised the group, so a well-behaved player won't ask).
youtubeRoute.get('/stream/:videoId/hls/subs.m3u8', async (c) => {
  const user = c.get('user')
  const videoId = c.req.param('videoId')
  if (!isValidVideoId(videoId)) return c.json({ error: 'Invalid video id' }, 400)
  const vtt = await findExistingTranscriptVtt(user.id, videoId).catch(() => null)
  if (!vtt) return c.json({ error: 'No subtitles for this video' }, 404)
  const pres = await getHlsPresentation(videoId)
  if (!pres) return hlsUnavailable(c, videoId)
  return hlsPlaylistResponse(c, hlsSubtitlePlaylist(pres.video.duration))
})

youtubeRoute.get('/stream/:videoId/hls/subs.vtt', async (c) => {
  const user = c.get('user')
  const videoId = c.req.param('videoId')
  if (!isValidVideoId(videoId)) return c.json({ error: 'Invalid video id' }, 400)
  const vtt = await findExistingTranscriptVtt(user.id, videoId).catch(() => null)
  if (!vtt) return c.json({ error: 'No subtitles for this video' }, 404)
  const body = await readFile(vtt, 'utf-8')
  return c.text(body, 200, { 'Content-Type': 'text/vtt', 'Cache-Control': 'private, max-age=600' })
})

// Transcoded tier: playlist is computed from the duration up front (fully seekable from
// the first request), segments are encoded on demand around wherever the player is.
youtubeRoute.get('/stream/:videoId/hls/hevc.m3u8', async (c) => {
  const videoId = c.req.param('videoId')
  const height = transcodeHeight(c)
  if (!isValidVideoId(videoId) || !height) return c.json({ error: 'Invalid video id or quality' }, 400)
  const plan = await getTranscodePlan(videoId, height)
  if (!plan) return hlsUnavailable(c, videoId)
  return hlsPlaylistResponse(c, hevcMediaPlaylist(plan, hlsQuery(c)))
})

youtubeRoute.get('/stream/:videoId/hls/hevc/init.mp4', async (c) => {
  const videoId = c.req.param('videoId')
  const height = transcodeHeight(c)
  if (!isValidVideoId(videoId) || !height) return c.json({ error: 'Invalid video id or quality' }, 400)
  return transcodeFileResponse(c, await getTranscodeInit(videoId, height), videoId)
})

youtubeRoute.get('/stream/:videoId/hls/hevc/:segment', async (c) => {
  const videoId = c.req.param('videoId')
  const height = transcodeHeight(c)
  const index = Number(/^(\d+)\.m4s$/.exec(c.req.param('segment'))?.[1] ?? NaN)
  if (!isValidVideoId(videoId) || !height || !Number.isInteger(index)) return c.json({ error: 'Invalid segment request' }, 400)
  return transcodeFileResponse(c, await getTranscodeSegment(videoId, height, index), videoId)
})

// Card hover-preview support: cache hit is free, otherwise one InnerTube HTTP call (no
// subprocess) to see if a preview stream is available — never falls back to yt-dlp, so
// hovering a grid of cards can't contend for the tiny global yt-dlp concurrency pool the
// actual player also depends on. `available: false` just means "skip the preview".
youtubeRoute.get('/stream/:videoId/preview', async (c) => {
  const videoId = c.req.param('videoId')
  if (!isValidVideoId(videoId)) return c.json({ error: 'Invalid video id' }, 400)
  const kind: StreamKind = c.req.query('kind') === 'audio' ? 'audio' : 'video'
  const url = await resolveStreamPreviewUrl(videoId, kind)
  return c.json({ available: !!url })
})

// Scrub-preview sprite sheet levels (trickplay), parsed from InnerTube's storyboard spec.
// 4h TTL matches the stream-URL cache — the sprite URLs carry a `sigh` signature token
// whose real lifetime isn't documented, so periodic refresh is the safety valve.
youtubeRoute.get('/storyboards/:videoId', async (c) => {
  const videoId = c.req.param('videoId')
  if (!isValidVideoId(videoId)) return c.json({ error: 'Invalid video id' }, 400)
  const levels = await cachedLookup('yt-storyboard', videoId, 4 * 60 * 60 * 1000, () => innertubePlayerStoryboards(videoId))
  return c.json({ levels: levels ?? [] })
})

// Poll target for the /stream 202 "preparing" fallback above: lets the client know when the
// offline download it kicked off has landed, so it can switch to /file/:videoId/:kind.
youtubeRoute.get('/download-status/:videoId/:kind', async (c) => {
  const user = c.get('user')
  const videoId = c.req.param('videoId')
  const kind = c.req.param('kind') as 'audio' | 'video'
  const [dl] = await db.select({ status: ytDownloads.status }).from(ytDownloads)
    .where(and(eq(ytDownloads.userId, user.id), eq(ytDownloads.videoId, videoId), eq(ytDownloads.kind, kind)))
    .limit(1)
  return c.json({ status: dl?.status ?? 'none' })
})

// ── Collections (Watch Later / Liked) ───────────────────────────────────────────
// Server-backed so they sync across devices. The client mirrors them into
// localStorage for instant rendering and hydrates from here on load.

type CollectionKey = 'watch-later' | 'liked'
const isCollectionKey = (k: string): k is CollectionKey => k === 'watch-later' || k === 'liked'

youtubeRoute.get('/collections', async (c) => {
  const user = c.get('user')
  // Join for the channel avatar exactly like /downloads: prefer the subscription's stored
  // thumbnail, else the avatar resolved + warmed for the video (yt_videos.channel_thumb), so
  // Watch Later / Liked cards show real logos instead of letter placeholders.
  const rows = await db.select({
    collection: ytCollections.collection,
    videoId: ytCollections.videoId,
    title: ytCollections.title,
    author: ytCollections.author,
    channelId: ytCollections.channelId,
    durationSec: ytCollections.durationSec,
    thumbnailUrl: ytCollections.thumbnailUrl,
    addedAt: ytCollections.addedAt,
    videoSource: ytCollections.videoSource,
    channelThumbSub: ytSubscriptions.thumbnailUrl,
    channelThumbVid: ytVideos.channelThumb,
    views: ytVideos.views,
    viewCount: ytVideos.viewCount,
    publishedAt: ytVideos.publishedAt,
  })
    .from(ytCollections)
    .leftJoin(ytVideos, eq(ytVideos.videoId, ytCollections.videoId))
    .leftJoin(ytSubscriptions, and(eq(ytSubscriptions.externalId, ytCollections.channelId), eq(ytSubscriptions.userId, user.id)))
    .where(eq(ytCollections.userId, user.id))
    .orderBy(desc(ytCollections.addedAt))
  const out: Record<CollectionKey, unknown[]> = { 'watch-later': [], liked: [] }
  for (const r of rows) {
    if (!isCollectionKey(r.collection)) continue
    out[r.collection].push({
      videoId: r.videoId, title: r.title, author: r.author, channelId: r.channelId,
      channelThumb: r.videoSource === 'youtube' ? (r.channelThumbSub ?? r.channelThumbVid ?? null) : null,
      durationSec: r.durationSec, thumbnailUrl: r.thumbnailUrl,
      addedAt: r.addedAt ? r.addedAt.getTime() : 0,
      videoSource: r.videoSource,
      views: r.views ?? (r.viewCount != null ? String(r.viewCount) : null),
      publishedAt: r.publishedAt ?? null,
    })
  }
  // Resolve missing avatars in the background so logos fill in on the next poll.
  if (rows.some(r => !r.channelThumbSub && !r.channelThumbVid && r.channelId)) {
    void backfillCollectionChannelThumbs(user.id).catch(() => {})
  }

  // Linked account: append the REAL Watch Later / Liked lists (first page each) so the
  // Library shows everything the account holds, not just what was saved in-app. Deduped
  // by videoId against local rows; read-only merge, never written into the local DB.
  // Cached 15min per user (shared keys with the interest-signal reader).
  try {
    const token = await getValidAccessToken(user.id)
    if (token) {
      const { fetchAccountWatchLater, fetchAccountLiked } = await import('@/lib/youtube/tvClient')
      const [wl, liked] = await Promise.all([
        cachedLookup('yt-account-wl', user.id, 15 * 60_000, () => fetchAccountWatchLater(token, 60)).catch(() => [] as TvVideo[]),
        cachedLookup('yt-account-liked', user.id, 15 * 60_000, () => fetchAccountLiked(token, 60)).catch(() => [] as TvVideo[]),
      ])
      const append = (key: CollectionKey, items: TvVideo[]) => {
        const have = new Set((out[key] as Array<{ videoId: string }>).map(r => r.videoId))
        for (const v of items) {
          if (!v.videoId || have.has(v.videoId)) continue
          have.add(v.videoId)
          out[key].push({
            videoId: v.videoId, title: v.title, author: v.author, channelId: v.channelId,
            channelThumb: null, durationSec: v.durationSec,
            thumbnailUrl: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
            addedAt: null, videoSource: 'youtube', views: v.views, publishedAt: null,
          })
        }
      }
      append('watch-later', wl)
      append('liked', liked)
    }
  } catch { /* account lists are best-effort; the local rows stand alone */ }
  return c.json(out)
})

const isVideoSourceLike = (s: unknown): s is 'youtube' | 'reddit' | 'tiktok' | 'vimeo' | 'link' | 'mine' =>
  s === 'youtube' || s === 'reddit' || s === 'tiktok' || s === 'vimeo' || s === 'link' || s === 'mine'

youtubeRoute.put('/collections/:key/:videoId', async (c) => {
  const user = c.get('user')
  const key = c.req.param('key')
  const videoId = c.req.param('videoId')
  if (!isCollectionKey(key)) return c.json({ error: 'Invalid collection' }, 400)
  type CollBody = { title?: string; author?: string | null; channelId?: string | null; durationSec?: number | null; thumbnailUrl?: string | null; videoSource?: string }
  const body = await c.req.json<CollBody>().catch(() => ({} as CollBody))
  const videoSource = isVideoSourceLike(body.videoSource) ? body.videoSource : 'youtube'

  await db.insert(ytCollections).values({
    id: crypto.randomUUID(),
    userId: user.id,
    collection: key,
    videoId,
    title: body.title ?? '',
    author: body.author ?? null,
    channelId: body.channelId ?? null,
    durationSec: body.durationSec ?? null,
    thumbnailUrl: body.thumbnailUrl ?? null,
    videoSource,
    addedAt: new Date(),
  }).onConflictDoNothing()

  // Mirror to the linked YouTube account (Watch Later / like) — no-op for non-YouTube sources
  // (gated inside pushCollectionChange) and when no account is linked.
  pushCollectionChange(user.id, key, videoId, 'add', videoSource)

  return c.json({ ok: true })
})

youtubeRoute.delete('/collections/:key/:videoId', async (c) => {
  const user = c.get('user')
  const key = c.req.param('key')
  const videoId = c.req.param('videoId')
  if (!isCollectionKey(key)) return c.json({ error: 'Invalid collection' }, 400)
  const [existing] = await db.select({ videoSource: ytCollections.videoSource }).from(ytCollections)
    .where(and(eq(ytCollections.userId, user.id), eq(ytCollections.collection, key), eq(ytCollections.videoId, videoId)))
    .limit(1)
  await db.delete(ytCollections)
    .where(and(eq(ytCollections.userId, user.id), eq(ytCollections.collection, key), eq(ytCollections.videoId, videoId)))
  pushCollectionChange(user.id, key, videoId, 'remove', existing?.videoSource ?? 'youtube')
  return c.json({ ok: true })
})

// ── Linked YouTube account ────────────────────────────────────────────────────
// Per-user Google-account link via the TV-client OAuth device flow (account.ts). The
// client starts a link, then polls /account/link while the user enters the code on
// their phone; account sync (accountSync.ts) does the actual mirroring.

// Everything the settings card needs; tokens never leave the server.
async function accountStatePayload(userId: string) {
  const account = await getAccountRow(userId)
  const flow = getLinkFlow(userId)
  return {
    linked: !!account,
    account: account ? {
      channelTitle: account.channelTitle,
      channelHandle: account.channelHandle,
      channelAvatarUrl: account.channelAvatarUrl,
      status: account.status,
      syncSubscriptions: account.syncSubscriptions,
      syncWatchLater: account.syncWatchLater,
      syncLiked: account.syncLiked,
      pushEnabled: account.pushEnabled,
      lastSyncAt: account.lastSyncAt?.getTime() ?? null,
      lastSyncError: account.lastSyncError,
      connectedAt: account.connectedAt.getTime(),
    } : null,
    flow,
  }
}

youtubeRoute.get('/account', async (c) => {
  const user = c.get('user')
  return c.json(await accountStatePayload(user.id))
})

// The linked account's own playlists (custom ones; Watch Later and Liked have
// their own sync and are excluded). Empty when no account is linked.
youtubeRoute.get('/account/playlists', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  const token = await getValidAccessToken(user.id).catch(() => null)
  if (!token) return c.json({ linked: false, playlists: [] })
  const { fetchAccountPlaylists } = await import('@/lib/youtube/tvClient')
  const playlists = await fetchAccountPlaylists(token).catch(() => [])
  return c.json({ linked: true, playlists })
})

// Add or remove one video in one of the account's own playlists. The TV
// client's edit_playlist call takes any playlist id, so Save to Playlist on
// the phone can target real YouTube playlists, not just hub collections.
youtubeRoute.put('/account/playlists/:id/:videoId', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  const token = await getValidAccessToken(user.id).catch(() => null)
  if (!token) return c.json({ error: 'No linked account' }, 400)
  const { tvPlaylistAdd } = await import('@/lib/youtube/tvClient')
  try {
    await tvPlaylistAdd(token, c.req.param('id'), c.req.param('videoId'))
    return c.json({ ok: true })
  } catch (err) {
    logger.warn({ err: String(err) }, '[youtube] account playlist add failed')
    return c.json({ error: 'YouTube rejected the change' }, 502)
  }
})

youtubeRoute.delete('/account/playlists/:id/:videoId', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  const token = await getValidAccessToken(user.id).catch(() => null)
  if (!token) return c.json({ error: 'No linked account' }, 400)
  const { tvPlaylistRemove } = await import('@/lib/youtube/tvClient')
  try {
    await tvPlaylistRemove(token, c.req.param('id'), c.req.param('videoId'))
    return c.json({ ok: true })
  } catch (err) {
    logger.warn({ err: String(err) }, '[youtube] account playlist remove failed')
    return c.json({ error: 'YouTube rejected the change' }, 502)
  }
})

// One account playlist's videos, authenticated: private playlists resolve too,
// which the public /playlist/:id endpoint cannot do.
youtubeRoute.get('/account/playlists/:id', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  const token = await getValidAccessToken(user.id).catch(() => null)
  if (!token) return c.json({ linked: false, videos: [] })
  const { fetchAccountPlaylist } = await import('@/lib/youtube/tvClient')
  const videos = await fetchAccountPlaylist(token, c.req.param('id'), 400).catch(() => [])
  return c.json({ linked: true, videos })
})

youtubeRoute.post('/account/link', async (c) => {
  const user = c.get('user')
  try {
    const flow = await startAccountLink(user.id)
    return c.json({ ok: true, flow })
  } catch (err) {
    logger.warn({ err: String(err) }, '[youtube] account link start failed')
    return c.json({ error: 'Could not reach Google to start sign-in. Check the server\'s internet connection and try again.' }, 502)
  }
})

youtubeRoute.delete('/account/link', async (c) => {
  const user = c.get('user')
  cancelLinkFlow(user.id)
  return c.json({ ok: true })
})

youtubeRoute.patch('/account', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<Partial<Record<'syncSubscriptions' | 'syncWatchLater' | 'syncLiked' | 'pushEnabled', boolean>>>()
  const patch: Record<string, boolean> = {}
  for (const key of ['syncSubscriptions', 'syncWatchLater', 'syncLiked', 'pushEnabled'] as const) {
    if (typeof body[key] === 'boolean') patch[key] = body[key]
  }
  if (!Object.keys(patch).length) return c.json({ error: 'No valid settings in body' }, 400)
  await db.update(ytAccounts).set(patch).where(eq(ytAccounts.userId, user.id))
  return c.json(await accountStatePayload(user.id))
})

youtubeRoute.post('/account/sync', async (c) => {
  const user = c.get('user')
  const account = await getAccountRow(user.id)
  if (!account) return c.json({ error: 'No linked account' }, 400)
  if (account.status !== 'active') return c.json({ error: 'Account needs to be reconnected' }, 409)
  // Run in the background — a full pull can take a while; the card polls lastSyncAt.
  void syncAccount(user.id).catch(err => logger.warn({ err: String(err) }, '[youtube] manual sync failed'))
  return c.json({ ok: true, started: true })
})

youtubeRoute.delete('/account', async (c) => {
  const user = c.get('user')
  await unlinkAccount(user.id)
  return c.json({ ok: true })
})

// ── History ───────────────────────────────────────────────────────────────────
// Every video the user has watched, newest first — sourced from watch-state joined to
// the (now always-present) video metadata, so it isn't limited to subscriptions/saves.

youtubeRoute.get('/history', async (c) => {
  const user = c.get('user')
  const limit = Math.min(200, parseInt(c.req.query('limit') ?? '100', 10))
  const rows = await db.select({
    videoId: ytWatchState.videoId,
    positionSec: ytWatchState.positionSec,
    completed: ytWatchState.completed,
    updatedAt: ytWatchState.updatedAt,
    title: ytVideos.title,
    author: ytVideos.author,
    channelId: ytVideos.channelId,
    durationSec: ytVideos.durationSec,
    views: ytVideos.views,
    viewCount: ytVideos.viewCount,
    publishedAt: ytVideos.publishedAt,
    channelThumbSub: ytSubscriptions.thumbnailUrl,
    channelThumbVid: ytVideos.channelThumb,
  })
    .from(ytWatchState)
    .leftJoin(ytVideos, eq(ytVideos.videoId, ytWatchState.videoId))
    .leftJoin(ytSubscriptions, and(eq(ytSubscriptions.externalId, ytVideos.channelId), eq(ytSubscriptions.userId, user.id)))
    // Music-station plays share the player but belong to the Music app's history.
    .where(and(eq(ytWatchState.userId, user.id), eq(ytWatchState.origin, 'youtube')))
    .orderBy(desc(ytWatchState.updatedAt))
    .limit(limit)

  const history = rows.map(r => ({
    videoId: r.videoId,
    // `||` (not `??`): a persisted-but-blank title (yt_videos.title defaults to '', and a
    // couple of insert paths could write that) must fall back the same as a missing row,
    // so the self-heal below (which matches on title === videoId) catches both shapes.
    title: r.title || r.videoId,
    author: r.author ?? null,
    channelId: r.channelId ?? null,
    // Prefer the subscription thumb, then the avatar persisted + warmed for offline.
    channelThumb: r.channelThumbSub ?? r.channelThumbVid ?? null,
    durationSec: r.durationSec ?? null,
    views: r.views ?? (r.viewCount != null ? String(r.viewCount) : null),
    publishedAt: r.publishedAt ?? null,
    positionSec: r.positionSec,
    completed: r.completed,
    updatedAt: r.updatedAt ? r.updatedAt.getTime() : 0,
  }))

  // Heal rows whose metadata never landed (title falls back to the raw video id):
  // fetch player metadata for the first few, persist to yt_videos so it sticks.
  const broken = history.filter(h => h.title === h.videoId).slice(0, 8)
  await Promise.all(broken.map(async (h) => {
    const meta = await tryInnertubeRetry(`history-heal:${h.videoId}`, () => innertubePlayerMeta(h.videoId), 1)
    if (!meta?.title) return
    h.title = meta.title
    h.author = meta.author ?? h.author
    h.channelId = meta.channelId ?? h.channelId
    h.durationSec = meta.durationSec ?? h.durationSec
    await db.insert(ytVideos).values({
      id: crypto.randomUUID(), videoId: h.videoId, title: meta.title, author: meta.author ?? '',
      channelId: meta.channelId ?? null, thumbnailUrl: `https://i.ytimg.com/vi/${h.videoId}/mqdefault.jpg`,
      publishedAt: null, durationSec: meta.durationSec ?? null, createdAt: new Date(),
    }).onConflictDoNothing().catch(() => {})
  }))

  // Fill any still-missing avatars live (online) so History matches the channel/discovery
  // pages immediately, then persist + warm + pin them in the background for offline use.
  await enrichChannelThumbs(history)
  if (history.some(h => !h.channelThumb && h.channelId)) void backfillHistoryChannelThumbs(user.id).catch(() => {})

  // Linked YouTube account: merge the real account history (deduped against local rows)
  // as its own section, so signed-in users see everything they watched anywhere.
  let accountHistory: Array<{ videoId: string; title: string; author: string | null; channelId: string | null; durationSec: number | null; views: string | null; publishedText: string | null; channelThumb: string | null }> = []
  try {
    const token = await getValidAccessToken(user.id)
    if (token) {
      const { fetchWatchHistory } = await import('@/lib/youtube/tvClient')
      const items = await cachedLookup(`yt-account-history`, user.id, 5 * 60_000, () => fetchWatchHistory(token, 60))
      const seen = new Set(history.map(h => h.videoId))
      accountHistory = items.filter(v => !seen.has(v.videoId)).map(v => ({ ...v, channelThumb: null }))
      await enrichChannelThumbs(accountHistory)
    }
  } catch { /* account history is best-effort */ }

  return c.json({ history, accountHistory })
})

// Remove a single video from watch history (also drops its resume position + completion).
youtubeRoute.delete('/history/:videoId', async (c) => {
  const user = c.get('user')
  await db.delete(ytWatchState)
    .where(and(eq(ytWatchState.userId, user.id), eq(ytWatchState.videoId, c.req.param('videoId'))))
  return c.json({ ok: true })
})

// Clear the user's entire watch history.
youtubeRoute.delete('/history', async (c) => {
  const user = c.get('user')
  await db.delete(ytWatchState).where(eq(ytWatchState.userId, user.id))
  return c.json({ ok: true })
})

// ── Watch state ───────────────────────────────────────────────────────────────

youtubeRoute.post('/watch-state', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{
    videoId: string; positionSec: number; completed?: boolean
    title?: string; author?: string | null; channelId?: string | null; durationSec?: number | null
    origin?: 'youtube' | 'music'
  }>()
  const { videoId, positionSec, completed = false } = body
  const origin: 'youtube' | 'music' = body.origin === 'music' ? 'music' : 'youtube'
  if (!videoId) return c.json({ error: 'videoId required' }, 400)

  // Record a minimal video row the first time we see it so it shows up in History even
  // when it was never in a subscription feed (e.g. opened from search/related/trending).
  // onConflictDoNothing keeps richer feed/saved metadata intact.
  if (body.title) {
    await db.insert(ytVideos).values({
      id: crypto.randomUUID(),
      videoId,
      title: body.title,
      author: body.author ?? '',
      channelId: body.channelId ?? null,
      thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      publishedAt: null,
      durationSec: body.durationSec ?? null,
      createdAt: new Date(),
    }).onConflictDoNothing()
  }
  // The stub row above carries no views/publishedAt (and pre-existing stubs may lack them
  // too) — backfill in the background so History captions heal. Deduped inside; a no-op
  // once the row is complete.
  void backfillVideoStats(videoId).catch(() => {})

  const now = new Date()
  await db.insert(ytWatchState).values({
    id: crypto.randomUUID(),
    userId: user.id,
    videoId,
    positionSec,
    completed,
    origin,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [ytWatchState.userId, ytWatchState.videoId],
    set: { positionSec, completed, origin, updatedAt: now },
  })

  // Time budget metering + gate: each heartbeat counts toward today's minutes, and the
  // response tells the player when the budget runs out so it can wind down mid-video.
  recordWatchBeat(user.id)
  // Watched videos join the semantic search index organically (fire and forget).
  ensureVideoIndexed('youtube', videoId, {
    userId: user.id, userFirstName: user.firstName,
    title: body.title ?? null, creatorName: body.author ?? null,
  })
  const timeGate = await checkVideoTime(user.id)
  return c.json({ ok: true, timeLimit: timeGate.remainingSec != null || !timeGate.allowed ? timeGate : undefined })
})

export { youtubeRoute }

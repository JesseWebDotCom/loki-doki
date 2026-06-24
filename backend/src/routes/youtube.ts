import { Hono } from 'hono'
import type { Context } from 'hono'
import { readFile, stat, readdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { eq, and, or, desc, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { ytSubscriptions, ytVideos, ytDownloads, ytWatchState, ytCollections, ytChannelCache, users, podcastShows, podcastEpisodes, podcastEpisodeSources, downloadJobs } from '@/db/schema'
import { requireAuth, requireAdmin } from '@/middleware/auth'
import { youtubeTool } from '@/tools/youtube'
import { resolveToolConfig } from '@/lib/toolConfig'
import { resolveYouTubeInput, parseTakeoutCsv } from '@/lib/youtube/resolve'
import { refreshUserFeeds, refreshSubscriptionFeed, backfillAllThumbnails } from '@/lib/youtube/feed'
import { getTranscriptText, formatTranscript } from '@/lib/youtube/transcript'
import { ensureSummary } from '@/lib/youtube/summarize'
import { exportsDir, backfillSavedHeights, ensureTranscript } from '@/lib/youtube/download'
import { backfillDurations } from '@/lib/youtube/durations'
import { innertubeChannel, innertubeChannelPlaylists, innertubeChannelAbout, innertubeChannelAvatar, innertubeRelated, innertubePlayerMeta, innertubeComments, innertubeChapters, innertubeSearchMore, innertubePlaylist, innertubeSearch, SEARCH_FILTERS, tryInnertube, tryInnertubeRetry, type ItVideo, type ItChannel, type ItPlaylist, type ItChannelPage } from '@/lib/youtube/innertube'
import { cachedLookup } from '@/lib/lookupCache'
import { fetchPopular, fetchTrending, enrichChannelThumbs } from '@/lib/youtube/discovery'
import { getSkipSegments, getUserSkipCategories } from '@/lib/youtube/sponsorblock'
import { getVotes } from '@/lib/youtube/returndislike'
import { getDeArrowBatch, fetchDeArrowThumb } from '@/lib/youtube/dearrow'
import { getOrFetchImage } from '@/lib/youtube/imageCache'
import { resolveStreamUrl, invalidateStreamUrl, isValidVideoId, parseQuality, type StreamKind } from '@/lib/youtube/stream'
import { ytDlpBin, getYtDlpStatus, ensureYtDlp, withYtDlpSlot } from '@/lib/youtube/ytdlp'
import {
  SAVE_HEIGHTS, getGlobalCap, getUserCapOverride, getEffectiveCap,
  getUserPreference, DEFAULT_GLOBAL_CAP,
} from '@/lib/youtube/quality'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import {
  enqueueVideoSave, createYoutubeEpisode,
  isAutomationPaused, setAutomationPaused, getAutoSaveKeepDefault, AUTO_KEEP_KEY,
} from '@/lib/youtube/automation'
import { resolveUserPath } from '@/lib/storage/paths'
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

// Map InnerTube shapes to the frontend's search-result shapes (shared by the typed +
// "load more" search paths).
const itVideoResult = (v: ItVideo) => ({
  title: v.title, url: `https://www.youtube.com/watch?v=${v.videoId}`, videoId: v.videoId,
  snippet: v.author ?? '', embedUrl: `https://www.youtube.com/embed/${v.videoId}`,
  author: v.author ?? undefined, channelId: v.channelId ?? undefined, channelThumb: v.channelThumb,
  durationSec: v.durationSec, publishedText: v.publishedText, views: v.views,
})
const itChannelResult = (ch: ItChannel) => ({
  channelId: ch.channelId, title: ch.title, handle: ch.handle, thumbnailUrl: ch.thumbnailUrl,
  subscribers: ch.subscribers, url: `https://www.youtube.com/channel/${ch.channelId}`,
})
const itPlaylistResult = (p: ItPlaylist) => ({
  playlistId: p.playlistId, title: p.title, videoCount: p.videoCount, thumbnailUrl: p.thumbnailUrl,
  author: p.author, channelId: p.channelId, url: `https://www.youtube.com/playlist?list=${p.playlistId}`,
})

// ── Search (existing) ─────────────────────────────────────────────────────────

youtubeRoute.get('/search', async (c) => {
  const user = c.get('user')
  const q = c.req.query('q')?.trim()
  const cursor = c.req.query('cursor')

  // "Load more": page straight off the InnerTube continuation token (keyless path only).
  if (cursor) {
    const page = await tryInnertube('searchMore', () => innertubeSearchMore(cursor, 24), { videos: [], continuation: null })
    return c.json({ results: page.videos.map(itVideoResult), channels: [], continuation: page.continuation })
  }

  if (!q) return c.json({ results: [], error: 'Query required' }, 400)

  // Typed search (Videos / Shorts / Playlists / Channels chips) — restrict to one result
  // type via the InnerTube filter param. Keyless InnerTube only.
  const type = c.req.query('type') as keyof typeof SEARCH_FILTERS | undefined
  if (type && SEARCH_FILTERS[type]) {
    const page = await tryInnertube('typedSearch',
      () => innertubeSearch(q, 36, type === 'channels' ? 24 : 0, 8000, type === 'playlists' ? 30 : 0, SEARCH_FILTERS[type]),
      { videos: [], channels: [], playlists: [], continuation: null })
    const videos = type === 'shorts' ? page.videos.filter(v => v.durationSec == null || v.durationSec <= 90) : page.videos
    return c.json({
      results: videos.map(itVideoResult),
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
  return c.json({ results: data?.videos ?? [], channels: data?.channels ?? [], playlists: data?.playlists ?? [], continuation: data?.continuation ?? null })
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
  const img = await getOrFetchImage(url.toString())
  if (!img) return c.json({ error: 'upstream' }, 502)
  // Buffer is a valid body at runtime; the cast sidesteps a TS Buffer-generic mismatch.
  return new Response(img.data as unknown as BodyInit, {
    headers: {
      'content-type': img.contentType,
      // Server holds the canonical copy and revalidates/evicts it; let the browser
      // hold its own copy for a day too so repeat views don't even hit us.
      'cache-control': 'public, max-age=86400',
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
  }
  return c.json({ ok: true })
})

// Update a subscription's automation settings (auto-save on/off, format, keep-N override).
// Off by default; auto-save applies to NEW uploads going forward, not the existing feed.
youtubeRoute.patch('/subscriptions/:id', async (c) => {
  const user = c.get('user')
  const subId = c.req.param('id')
  const body = (await c.req.json().catch(() => ({}))) as { autoSave?: boolean; autoSaveKind?: 'audio' | 'video'; autoSaveKeep?: number | null }

  const [sub] = await db.select({ id: ytSubscriptions.id }).from(ytSubscriptions)
    .where(and(eq(ytSubscriptions.id, subId), eq(ytSubscriptions.userId, user.id))).limit(1)
  if (!sub) return c.json({ error: 'Not found' }, 404)

  const patch: Partial<typeof ytSubscriptions.$inferInsert> = {}
  if (typeof body.autoSave === 'boolean') patch.autoSave = body.autoSave
  if (body.autoSaveKind === 'audio' || body.autoSaveKind === 'video') patch.autoSaveKind = body.autoSaveKind
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
  const rows = await db.select({ video: ytVideos, channelThumb: ytSubscriptions.thumbnailUrl })
    .from(ytVideos)
    .leftJoin(ytSubscriptions, and(eq(ytSubscriptions.externalId, ytVideos.channelId), eq(ytSubscriptions.userId, user.id)))
    .where(or(...matchConds))
    .orderBy(desc(ytVideos.publishedAt))
    .limit(limit)
    .offset(offset)

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

  return c.json({ videos: result })
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
  const rows = await db.select({
    id: ytDownloads.id,
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
    // Channel avatar (when the video's channel is one of the user's subscriptions),
    // so Offline cards/rails show real logos exactly like the Online feed.
    channelThumb: ytSubscriptions.thumbnailUrl,
  })
    .from(ytDownloads)
    .leftJoin(ytVideos, eq(ytVideos.videoId, ytDownloads.videoId))
    .leftJoin(ytSubscriptions, and(eq(ytSubscriptions.externalId, ytVideos.channelId), eq(ytSubscriptions.userId, user.id)))
    .where(eq(ytDownloads.userId, user.id))
    .orderBy(desc(ytDownloads.createdAt))

  // Attach watch state via a separate query (same approach as /feed).
  const videoIds = rows.map(r => r.videoId)
  const watchRows = videoIds.length
    ? await db.select().from(ytWatchState).where(and(eq(ytWatchState.userId, user.id), inArray(ytWatchState.videoId, videoIds)))
    : []
  const watchMap = new Map(watchRows.map(w => [w.videoId, w]))
  const downloads = rows.map(r => ({
    ...r,
    positionSec: watchMap.get(r.videoId)?.positionSec ?? null,
    completed: watchMap.get(r.videoId)?.completed ?? null,
  }))

  // Backfill missing resolutions in the background so badges fill in on the next poll —
  // but only when something actually lacks one, since the client polls this every 5s.
  if (rows.some(r => r.maxHeight == null)) void backfillSavedHeights(user.id).catch(() => {})
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
    if (r.relPath) { try { await unlink(await resolveUserPath(r.relPath)) } catch { /* already gone */ } }
    if (r.transcriptRelPath) { try { await unlink(await resolveUserPath(r.transcriptRelPath)) } catch { /* already gone */ } }
  }
  await db.delete(ytDownloads)
    .where(and(eq(ytDownloads.userId, user.id), inArray(ytDownloads.id, ids)))
  return c.json({ ok: true, deleted: rows.length })
})

// Save a video into the Offline library. Capped at the user's effective Save height
// (admin global/per-user cap ∧ user preference). Audio is fetched at best quality.
async function handleSave(c: Context<AppEnv>) {
  const user = c.get('user')
  const { videoId, kind = 'audio', title = '', maxHeight: reqHeight, audioFormat } = await c.req.json<{ videoId: string; kind?: 'audio' | 'video'; title?: string; maxHeight?: number; audioFormat?: 'm4a' | 'mp3' }>()
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
  const { status, id } = await enqueueVideoSave({ userId: user.id, videoId, title, kind, maxHeight, firstName, audioFormat })
  return c.json({ ok: true, status, id })
}

youtubeRoute.post('/save', handleSave)
youtubeRoute.post('/download', handleSave)   // legacy alias

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

// ── Download to device: list formats, run export, stream the file ───────────────

interface YtFormat { formatId: string; ext: string; resolution: string; note: string; filesize: number | null; vcodec: string; acodec: string }

youtubeRoute.get('/formats/:videoId', async (c) => {
  const videoId = c.req.param('videoId')
  if (!isValidVideoId(videoId)) return c.json({ formats: [], error: 'Invalid video id' }, 400)
  const url = `https://www.youtube.com/watch?v=${videoId}`
  try {
    const json = await withYtDlpSlot(() => new Promise<string>((resolve, reject) => {
      const proc = spawn(ytDlpBin(), ['-J', '--no-playlist', url], { stdio: ['ignore', 'pipe', 'ignore'] })
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

  const [dl] = await db.select().from(ytDownloads)
    .where(and(eq(ytDownloads.userId, user.id), eq(ytDownloads.videoId, videoId), eq(ytDownloads.kind, kind)))
    .limit(1)

  if (!dl || dl.status !== 'ready' || !dl.relPath) {
    return c.json({ error: 'Not found' }, 404)
  }

  const absPath = await resolveUserPath(dl.relPath)
  if (!existsSync(absPath)) return c.json({ error: 'File missing' }, 404)

  const fileStat = await stat(absPath)
  // Derive the MIME from the actual file extension (audio can be m4a or mp3).
  const contentType = dl.relPath.endsWith('.mp3') ? 'audio/mpeg'
    : kind === 'audio' ? 'audio/mp4'
    : 'video/mp4'

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

    const { createReadStream } = await import('node:fs')
    const stream = createReadStream(absPath, { start, end })
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
  return c.text(vtt, 200, { 'Content-Type': 'text/vtt' })
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
  // no-op when the work is already done, so repeat plays are cheap.
  void (async () => {
    const firstName = await getUserFirstName(user.id)
    await ensureTranscript(videoId, user.id, firstName)
    await ensureSummary(videoId, user.id, firstName)
  })().catch(() => { /* enrichment is best-effort */ })

  const [v] = await db.select().from(ytVideos).where(eq(ytVideos.videoId, videoId)).limit(1)

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

  if (v?.description) {
    const sub = await subFor(v.channelId)
    return c.json({ videoId, title: v.title, author: v.author, channelId: v.channelId, channelThumb: await avatarFor(sub, v.channelId), description: v.description, summary: v.summary, durationSec: v.durationSec, positionSec, subscribed: !!sub, subscriptionId: sub?.id ?? null })
  }

  // Fast metadata path: InnerTube's player endpoint (structured JSON, no subprocess).
  // Only fall through to yt-dlp if it comes back empty.
  const it = await tryInnertube('playerMeta', () => innertubePlayerMeta(videoId), null)
  if (it?.title) {
    if (v && it.description) await db.update(ytVideos).set({ description: it.description }).where(eq(ytVideos.videoId, videoId)).catch(() => {})
    const channelId = it.channelId ?? v?.channelId ?? null
    const sub = await subFor(channelId)
    return c.json({
      videoId, title: it.title, author: it.author ?? v?.author ?? null, channelId,
      channelThumb: await avatarFor(sub, channelId), description: it.description ?? v?.description ?? null,
      summary: v?.summary ?? null, durationSec: it.durationSec ?? v?.durationSec ?? null,
      positionSec, subscribed: !!sub, subscriptionId: sub?.id ?? null,
    })
  }

  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`
    const json = await new Promise<string>((resolve, reject) => {
      const proc = spawn(ytDlpBin(), ['-J', '--no-playlist', url], { stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
      proc.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(`yt-dlp exited ${code}`)))
      proc.on('error', reject)
    })
    const m = JSON.parse(json) as { title?: string; channel?: string; uploader?: string; channel_id?: string; description?: string; duration?: number }
    // Persist the description back onto the row when we have one.
    if (v && m.description) await db.update(ytVideos).set({ description: m.description }).where(eq(ytVideos.videoId, videoId)).catch(() => {})
    const channelId = m.channel_id ?? v?.channelId ?? null
    const sub = await subFor(channelId)
    return c.json({
      videoId,
      title: m.title ?? v?.title ?? '',
      author: m.channel ?? m.uploader ?? v?.author ?? null,
      channelId,
      channelThumb: await avatarFor(sub, channelId),
      description: m.description ?? v?.description ?? null,
      summary: v?.summary ?? null,
      durationSec: m.duration ?? v?.durationSec ?? null,
      positionSec,
      subscribed: !!sub,
      subscriptionId: sub?.id ?? null,
    })
  } catch {
    const sub = await subFor(v?.channelId)
    return c.json({ videoId, title: v?.title ?? '', author: v?.author ?? null, channelId: v?.channelId ?? null, channelThumb: await avatarFor(sub, v?.channelId), description: v?.description ?? null, summary: v?.summary ?? null, durationSec: v?.durationSec ?? null, positionSec, subscribed: !!sub, subscriptionId: sub?.id ?? null })
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
    videos?: { videoId: string; title?: string; author?: string }[]
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
      await db.insert(podcastShows).values({
        id: showId,
        ownerUserId: user.id,
        name: body.newShowName.trim().slice(0, 80),
        description: 'AI-hosted episodes generated from your YouTube content.',
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
    const doneRows = await db.select({ sourceId: podcastEpisodeSources.sourceId })
      .from(podcastEpisodeSources)
      .innerJoin(podcastEpisodes, eq(podcastEpisodeSources.episodeId, podcastEpisodes.id))
      .where(and(eq(podcastEpisodes.showId, showId), eq(podcastEpisodeSources.sourceType, 'youtube')))
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
  const limit = Math.min(50, parseInt(c.req.query('limit') ?? '30', 10))
  return c.json({ videos: await fetchPopular(limit) })
})

youtubeRoute.get('/trending', async (c) => {
  const limit = Math.min(50, parseInt(c.req.query('limit') ?? '30', 10))
  return c.json({ videos: await fetchTrending(limit) })
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

// Real "Up next" — YouTube's own related videos for this watch page.
youtubeRoute.get('/related/:videoId', async (c) => {
  const videoId = c.req.param('videoId')
  const limit = Math.min(40, parseInt(c.req.query('limit') ?? '20', 10))
  const videos = await tryInnertube('related', () => innertubeRelated(videoId, limit), [])
  return c.json({ videos })
})

// Comments — InnerTube `next` continuation, proxied so the browser never hits Google.
youtubeRoute.get('/comments/:videoId', async (c) => {
  const videoId = c.req.param('videoId')
  const limit = Math.min(50, parseInt(c.req.query('limit') ?? '20', 10))
  const comments = await tryInnertube('comments', () => innertubeComments(videoId, limit), [])
  return c.json({ comments })
})

// Authoritative chapter list (creator/auto chapters) — used to enrich the watch page
// when the description has no parseable timestamps.
youtubeRoute.get('/chapters/:videoId', async (c) => {
  const videoId = c.req.param('videoId')
  const chapters = await tryInnertube('chapters', () => innertubeChapters(videoId), [])
  return c.json({ chapters })
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

// "Recommended for you" — discover content beyond your subscriptions. Seeds YouTube's
// related-videos engine with what you've actually watched (falling back to recent
// subscription uploads, then trending), then filters out anything already watched.
youtubeRoute.get('/recommended', async (c) => {
  const user = c.get('user')

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
    const videos = await fetchPopular(24)
    return c.json({ videos, seeded: false })
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
  const videos = out.slice(0, 24)
  await enrichChannelThumbs(videos)
  return c.json({ videos, seeded: true })
})

// ── SponsorBlock ────────────────────────────────────────────────────────────────
// Proxied so the browser never tells a third party which videos are being watched.

youtubeRoute.get('/sponsorblock/:videoId', async (c) => {
  const user = c.get('user')
  const videoId = c.req.param('videoId')
  // Only return the categories this user has chosen to skip — the player auto-skips
  // whatever it receives, so filtering here keeps unskipped segments off the scrubber too.
  const enabled = await getUserSkipCategories(user.id)
  const segments = (await getSkipSegments(videoId)).filter(s => enabled[s.category as keyof typeof enabled])
  return c.json({ segments })
})

// ── DeArrow ───────────────────────────────────────────────────────────────────
// Crowdsourced de-clickbait titles/thumbnails. Batched by id so a feed of cards is a
// single round-trip; thumbnails are proxied through us (separate host from /img).

youtubeRoute.post('/dearrow', async (c) => {
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
  return c.json({ branding })
})

youtubeRoute.get('/dearrow-thumb/:videoId', async (c) => {
  const videoId = c.req.param('videoId')
  const time = parseFloat(c.req.query('t') ?? '')
  if (!isValidVideoId(videoId) || !Number.isFinite(time)) return c.json({ error: 'bad request' }, 400)
  const upstream = await fetchDeArrowThumb(videoId, time)
  if (!upstream) return c.json({ error: 'upstream' }, 502)
  return new Response(upstream.body, {
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'image/webp',
      'cache-control': 'public, max-age=86400',
    },
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
  const quality = parseQuality(c.req.query('q'))

  const upstreamUrl = await resolveStreamUrl(videoId, kind, quality)
  if (!upstreamUrl) return c.json({ error: 'Could not resolve a playable stream' }, 502)

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
      const fresh = await resolveStreamUrl(videoId, kind, quality, true)
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
  // Warm the SAME (videoId, kind) the caller will actually play — the cache is keyed by kind,
  // so warming 'video' does nothing for an audio-only consumer like AI Radio.
  const kind: StreamKind = c.req.query('kind') === 'audio' ? 'audio' : 'video'
  void resolveStreamUrl(videoId, kind, 'auto')
  return c.body(null, 204)
})

// ── Collections (Watch Later / Liked) ───────────────────────────────────────────
// Server-backed so they sync across devices. The client mirrors them into
// localStorage for instant rendering and hydrates from here on load.

type CollectionKey = 'watch-later' | 'liked'
const isCollectionKey = (k: string): k is CollectionKey => k === 'watch-later' || k === 'liked'

youtubeRoute.get('/collections', async (c) => {
  const user = c.get('user')
  const rows = await db.select().from(ytCollections)
    .where(eq(ytCollections.userId, user.id))
    .orderBy(desc(ytCollections.addedAt))
  const out: Record<CollectionKey, unknown[]> = { 'watch-later': [], liked: [] }
  for (const r of rows) {
    if (!isCollectionKey(r.collection)) continue
    out[r.collection].push({
      videoId: r.videoId, title: r.title, author: r.author, channelId: r.channelId,
      durationSec: r.durationSec, addedAt: r.addedAt ? r.addedAt.getTime() : 0,
    })
  }
  return c.json(out)
})

youtubeRoute.put('/collections/:key/:videoId', async (c) => {
  const user = c.get('user')
  const key = c.req.param('key')
  const videoId = c.req.param('videoId')
  if (!isCollectionKey(key)) return c.json({ error: 'Invalid collection' }, 400)
  type CollBody = { title?: string; author?: string | null; channelId?: string | null; durationSec?: number | null }
  const body = await c.req.json<CollBody>().catch(() => ({} as CollBody))

  await db.insert(ytCollections).values({
    id: crypto.randomUUID(),
    userId: user.id,
    collection: key,
    videoId,
    title: body.title ?? '',
    author: body.author ?? null,
    channelId: body.channelId ?? null,
    durationSec: body.durationSec ?? null,
    addedAt: new Date(),
  }).onConflictDoNothing()

  return c.json({ ok: true })
})

youtubeRoute.delete('/collections/:key/:videoId', async (c) => {
  const user = c.get('user')
  const key = c.req.param('key')
  const videoId = c.req.param('videoId')
  if (!isCollectionKey(key)) return c.json({ error: 'Invalid collection' }, 400)
  await db.delete(ytCollections)
    .where(and(eq(ytCollections.userId, user.id), eq(ytCollections.collection, key), eq(ytCollections.videoId, videoId)))
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
    channelThumb: ytSubscriptions.thumbnailUrl,
  })
    .from(ytWatchState)
    .leftJoin(ytVideos, eq(ytVideos.videoId, ytWatchState.videoId))
    .leftJoin(ytSubscriptions, and(eq(ytSubscriptions.externalId, ytVideos.channelId), eq(ytSubscriptions.userId, user.id)))
    .where(eq(ytWatchState.userId, user.id))
    .orderBy(desc(ytWatchState.updatedAt))
    .limit(limit)

  const history = rows.map(r => ({
    videoId: r.videoId,
    title: r.title ?? r.videoId,
    author: r.author ?? null,
    channelId: r.channelId ?? null,
    channelThumb: r.channelThumb ?? null,
    durationSec: r.durationSec ?? null,
    positionSec: r.positionSec,
    completed: r.completed,
    updatedAt: r.updatedAt ? r.updatedAt.getTime() : 0,
  }))
  // Backfill avatars for non-subscribed channels (the subscription join only covers
  // subs) so History/Continue-watching match the channel + discovery pages.
  await enrichChannelThumbs(history)
  return c.json({ history })
})

// ── Watch state ───────────────────────────────────────────────────────────────

youtubeRoute.post('/watch-state', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{
    videoId: string; positionSec: number; completed?: boolean
    title?: string; author?: string | null; channelId?: string | null; durationSec?: number | null
  }>()
  const { videoId, positionSec, completed = false } = body
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

  const now = new Date()
  await db.insert(ytWatchState).values({
    id: crypto.randomUUID(),
    userId: user.id,
    videoId,
    positionSec,
    completed,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [ytWatchState.userId, ytWatchState.videoId],
    set: { positionSec, completed, updatedAt: now },
  })

  return c.json({ ok: true })
})

export { youtubeRoute }

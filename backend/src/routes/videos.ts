// Videos hub API: source-agnostic endpoints over the provider registry.
// YouTube-specific plumbing stays on /api/youtube; these routes serve the
// hub surfaces (mixed home, universal clipper resolve, per-source browse).

import { Hono } from 'hono'
import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { db } from '@/db'
import { mediaAssets, videoFollows, videoItems, videoSaves, videoWatchState, ytSubscriptions, ytVideos as ytVideosTable } from '@/db/schema'
import { requireAuth, requireAdmin } from '@/middleware/auth'
import { getProvider, listProviders, matchUrlToProvider, getEnabledSources, setEnabledSources } from '@/lib/videos/registry'
import { allowAdultVideos, filterVideosForUser, videoAllowedForUser } from '@/lib/videos/policy'
import { allowlistOnlyEnabled } from '@/lib/videos/allowlist'
import { getVideoViewFlags } from '@/lib/videos/viewFlags'
import { checkVideoTime, recordWatchBeat } from '@/lib/videos/watchTime'
import { ensureVideoIndexed, semanticSearch } from '@/lib/videos/semanticIndex'
import { askVideo } from '@/lib/videos/askVideo'
import { enqueueVideoMedia } from '@/lib/downloadJobs'
import { redditPost } from '@/lib/videos/providers/reddit'
import { getRedditClientId, REDDIT_CLIENT_ID_KEY } from '@/lib/videos/redditAuth'
import { getVimeoToken, VIMEO_TOKEN_KEY } from '@/lib/videos/providers/vimeo'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { blobAbsPath, acquireRead, releaseRead } from '@/lib/content/store'
import { resolveClip } from '@/lib/clipper/resolve'
import { resolveVideoTranscript, resolveVideoVtt } from '@/lib/podcast/transcript'
import { summarizeTranscriptText } from '@/lib/youtube/summarize'
import { stampSmartTitles } from '@/lib/videos/smartTitle'
import { serveVideosSuggested } from '@/lib/interests/videos'
import { cachedLookup, cachedLookupStale } from '@/lib/lookupCache'
import type { Pager, Playlist, VideoItem, VideoSource } from '@/lib/videos/types'
import type { AppEnv } from '@/types'

// Cap how long the mixed-home feed waits on any one provider's browse. Sources are fetched
// in parallel and interleaved, so a slow one just drops out of this load rather than
// holding up the whole page.
const HOME_BROWSE_TIMEOUT_MS = 6_000
const FOLLOWS_PAGE = 40

// The mixed-home cursor: per-source browse cursors (`p`) + followed-uploads offset (`f`,
// null once exhausted), base64url-JSON so it round-trips as one opaque query string.
interface HomeCursor { p: Record<string, string>; f: number | null }
function parseHomeCursor(raw: string | undefined): HomeCursor | null {
  if (!raw) return null
  try {
    const obj = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<HomeCursor>
    if (obj && typeof obj === 'object' && obj.p && typeof obj.p === 'object') {
      return { p: obj.p as Record<string, string>, f: typeof obj.f === 'number' ? obj.f : null }
    }
  } catch { /* malformed → treat as first page */ }
  return null
}

const GENERIC_SOURCES = ['reddit', 'tiktok', 'vimeo', 'link'] as const
type GenericSource = (typeof GENERIC_SOURCES)[number]
const isGenericSource = (s: string): s is GenericSource => (GENERIC_SOURCES as readonly string[]).includes(s)

const videosRoute = new Hono<AppEnv>()
videosRoute.use('*', requireAuth)

// ── Sources: capabilities + config status (drives the rail + settings nudges) ──

videosRoute.get('/sources', async (c) => {
  const enabled = await getEnabledSources()
  const sources = await Promise.all(listProviders().map(async (p) => ({
    source: p.source,
    label: p.label,
    capabilities: p.capabilities,
    browseFeeds: p.browseFeeds ?? [],
    discovery: p.resolveDiscovery ? await p.resolveDiscovery() : (p.discovery ?? []),
    status: p.status ? await p.status() : { configured: true },
    enabled: enabled.includes(p.source),
  })))
  // Approved-only mode (kids): the UI hides discovery affordances (search, browse,
  // suggestions) when on; the server filters regardless (lib/videos/allowlist.ts).
  // viewFlags are the softer per-user limits (no autoplay / Shorts / suggestions).
  const [allowlistOnly, viewFlags] = await Promise.all([
    allowlistOnlyEnabled(c.get('user').id),
    getVideoViewFlags(c.get('user').id),
  ])
  return c.json({ sources, allowlistOnly, viewFlags })
})

// Admin: which sources show up on discovery surfaces (rail, home feed, browse pages).
videosRoute.put('/config/sources', requireAdmin, async (c) => {
  const body = await c.req.json<{ sources?: string[] }>().catch(() => ({}) as Record<string, never>)
  const valid = new Set(listProviders().map((p) => p.source))
  const sources = (body.sources ?? []).filter((s): s is VideoSource => valid.has(s as VideoSource))
  await setEnabledSources(sources)
  return c.json({ ok: true })
})

// ── Mixed home: interleave provider browse feeds, policy-filtered ──────────────

videosRoute.get('/home', async (c) => {
  const user = c.get('user')
  const allowAdult = await allowAdultVideos(user.id)
  const wanted = (c.req.query('sources') ?? '').split(',').filter(Boolean)
  const enabled = await getEnabledSources()

  // Pagination: the cursor is a composite of each still-paginating provider's own cursor
  // plus the followed-uploads offset, so "load more" advances every source together.
  const incoming = parseHomeCursor(c.req.query('cursor'))
  const isFirst = !incoming

  const active = listProviders().filter((p) =>
    p.browse && p.capabilities.browse && enabled.includes(p.source) && (wanted.length === 0 || wanted.includes(p.source)))

  // First page browses every source; a "load more" only re-queries the ones that reported
  // another page last time — a single-page source (TikTok / keyless Vimeo) would otherwise
  // repeat its first page and duplicate content.
  const toQuery = isFirst
    ? active.map((p) => ({ p, cursor: null as string | null }))
    : active.filter((p) => incoming!.p[p.source] != null).map((p) => ({ p, cursor: incoming!.p[p.source]! }))

  // A slow OR broken source never blanks (or stalls) the hub home: each provider browse is
  // both try/caught and time-boxed. TikTok already serves cache-only here (no yt-dlp on this
  // path); the timeout also bounds a slow Reddit/Vimeo network fetch.
  const nextP: Record<string, string> = {}
  const feeds = await Promise.all(toQuery.map(async ({ p, cursor }) => {
    // .catch() BEFORE the race so a browse that rejects *after* the timeout already won
    // resolves to empty instead of surfacing as an unhandled rejection.
    const browse = p.browse!({ userId: user.id, allowAdult, cursor })
      .catch(() => ({ items: [], cursor: null }) as Pager<VideoItem>)
    const page = await Promise.race([
      browse,
      new Promise<Pager<VideoItem>>((resolve) => setTimeout(() => resolve({ items: [], cursor: null }), HOME_BROWSE_TIMEOUT_MS)),
    ])
    if (page.cursor) nextP[p.source] = page.cursor
    return page.items.filter((it) => allowAdult || !it.isAdult)
  }))

  // Followed-creator uploads join the mix too — this is how TikTok (browse-less) and
  // followed subreddits/channels surface on Home. Paginated by offset via the cursor's `f`.
  const followsOffset = isFirst ? 0 : incoming!.f
  let nextF: number | null = null
  if (followsOffset != null) {
    const follows = await db.select({ id: videoFollows.id, source: videoFollows.source, title: videoFollows.title, thumbnailUrl: videoFollows.thumbnailUrl })
      .from(videoFollows).where(eq(videoFollows.userId, user.id))
    const followsWanted = follows.filter((f) => enabled.includes(f.source) && (wanted.length === 0 || wanted.includes(f.source)))
    if (followsWanted.length > 0) {
      // The follow row is the creator's one authoritative, self-healing identity (refreshed
      // every poll tick); a video_items row is a write-once snapshot from whenever it was
      // first polled, so prefer the follow's name/avatar over the per-item columns.
      const followsById = new Map(followsWanted.map((f) => [f.id, f]))
      const rows = await db.select().from(videoItems)
        .where(inArray(videoItems.followId, followsWanted.map((f) => f.id)))
        .orderBy(desc(videoItems.publishedAt), desc(videoItems.createdAt))
        .limit(FOLLOWS_PAGE).offset(followsOffset)
      const followFeed: VideoItem[] = rows
        .filter((r) => allowAdult || !r.isAdult)
        .map((r) => {
          const follow = r.followId ? followsById.get(r.followId) : null
          return {
            source: r.source, id: r.externalId, url: r.url ?? '', title: r.title,
            creator: follow?.title || r.creatorId || r.creatorName
              ? { id: r.creatorId ?? '', name: follow?.title || r.creatorName || '', avatarUrl: follow?.thumbnailUrl ?? null }
              : null,
            thumbnailUrl: r.thumbnailUrl, durationSec: r.durationSec, viewsText: r.viewsText ?? null,
            publishedAt: r.publishedAt ? r.publishedAt.getTime() : null,
            isAdult: r.isAdult, vertical: r.source === 'tiktok',
          }
        })
      if (followFeed.length > 0) feeds.push(followFeed)
      nextF = rows.length === FOLLOWS_PAGE ? followsOffset + FOLLOWS_PAGE : null
    }
  }

  // Round-robin interleave so every enabled source is visible above the fold.
  const items: VideoItem[] = []
  const seen = new Set<string>()
  for (let i = 0; feeds.some((f) => i < f.length); i++) {
    for (const feed of feeds) {
      const it = feed[i]
      if (it && !seen.has(`${it.source}:${it.id}`)) { seen.add(`${it.source}:${it.id}`); items.push(it) }
    }
  }

  const hasMore = Object.keys(nextP).length > 0 || nextF != null
  const cursor = hasMore ? Buffer.from(JSON.stringify({ p: nextP, f: nextF }), 'utf8').toString('base64url') : null
  // Kid-safe media: full policy pass (adult flags + topical classifier + hide-unknown on a
  // kid tier) over the merged feed. The per-feed adult filters above are a cheap first cut;
  // this is the authoritative gate every hub list route shares.
  const safe = await filterVideosForUser(user.id, items)
  return c.json({ items: await stampSmartTitles(safe, user.id), cursor })
})

// ── Suggested for you: interest-engine rail across every source ────────────────
// Personalized from watch history (lib/interests/videos.ts): never repeats watched
// items, rotates via impression demotion, honors "Not interested". While the first
// pool build runs, returns empty + building:true and the shelf stays hidden — the hub
// home already has Popular/Trending, so no fallback rail is needed here.

videosRoute.get('/suggested', async (c) => {
  const user = c.get('user')
  // Per-user "no suggestions" limit (kids): serve nothing rather than trust the UI to hide.
  if ((await getVideoViewFlags(user.id)).noSuggestions) return c.json({ items: [], building: false })
  const { items, building } = await serveVideosSuggested(user.id, 18)
  return c.json({ items: await stampSmartTitles(items, user.id), building })
})

// ── Universal clipper resolve: provider match first, yt-dlp fallback ───────────

videosRoute.post('/resolve', async (c) => {
  const { url } = await c.req.json<{ url?: string }>().catch(() => ({ url: undefined }))
  const trimmed = url?.trim()
  if (!trimmed) return c.json({ error: 'url required' }, 400)

  const hit = matchUrlToProvider(trimmed)
  if (hit) {
    const { provider, match } = hit
    if (match.kind === 'video') {
      try {
        const item = await provider.getItem(match.id, c.get('user').id)
        if (item) return c.json({ ok: true, kind: 'provider', match: 'video', source: provider.source, item })
      } catch { /* fall through to the generic path */ }
    } else if (match.kind === 'creator' && provider.getCreator) {
      try {
        const { creator } = await provider.getCreator(match.id)
        return c.json({ ok: true, kind: 'provider', match: 'creator', source: provider.source, creator })
      } catch { /* fall through */ }
    }
  }

  // No provider claimed it (or the provider failed): yt-dlp metadata dump, same as
  // the classic Clipper. This is also the paste-a-link path for Instagram/X today.
  try {
    const meta = await resolveClip(trimmed)
    return c.json({ ok: true, kind: 'clip', ...meta })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Could not resolve that link' }, 422)
  }
})

// Fast URL router for the search bar: sniff a pasted link against the curated providers
// (no network) and return where to navigate, falling back to the universal 'link' source.
// Unlike /resolve it never runs yt-dlp, so pasting a link navigates instantly — the actual
// metadata resolve happens on the watch page (and is cached there).
videosRoute.post('/route', async (c) => {
  const { url } = await c.req.json<{ url?: string }>().catch(() => ({ url: undefined }))
  const trimmed = url?.trim()
  if (!trimmed) return c.json({ error: 'url required' }, 400)

  const hit = matchUrlToProvider(trimmed)
  if (hit) return c.json({ source: hit.provider.source, kind: hit.match.kind, id: hit.match.id })

  // Unclaimed → the universal link source; its id is the base64url of the URL itself.
  try {
    const u = new URL(trimmed)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad scheme')
  } catch {
    return c.json({ error: 'invalid url' }, 400)
  }
  return c.json({ source: 'link', kind: 'video', id: Buffer.from(trimmed, 'utf8').toString('base64url') })
})

// ── Per-source endpoints (validated against the registry) ──────────────────────

videosRoute.get('/:source/browse', async (c) => {
  const provider = getProvider(c.req.param('source'))
  if (!provider?.browse) return c.json({ error: 'unknown source' }, 404)
  const user = c.get('user')
  const allowAdult = await allowAdultVideos(user.id)
  // Not-configured (e.g. Reddit with no client id) is an expected, common state — never let
  // it (or any other provider hiccup) surface as a hard 500; an empty page is the correct
  // answer both for the ConnectRedditCard flow and for cross-source aggregators like the
  // Videos hub's mixed category shelves.
  const page = await provider.browse({
    userId: user.id,
    feed: c.req.query('feed') ?? undefined,
    cursor: c.req.query('cursor') ?? null,
    allowAdult,
  }).catch(() => ({ items: [], cursor: null }) as Pager<VideoItem>)
  page.items = await stampSmartTitles(await filterVideosForUser(user.id, page.items), user.id)
  return c.json(page)
})

videosRoute.get('/:source/search', async (c) => {
  const provider = getProvider(c.req.param('source'))
  if (!provider?.search) return c.json({ error: 'unknown source' }, 404)
  const q = c.req.query('q')?.trim()
  if (!q) return c.json({ error: 'q required' }, 400)
  const user = c.get('user')
  const allowAdult = await allowAdultVideos(user.id)
  const page = await provider.search(q, { cursor: c.req.query('cursor') ?? null, allowAdult })
  page.items = await stampSmartTitles(await filterVideosForUser(user.id, page.items), user.id)
  return c.json(page)
})

videosRoute.get('/:source/creator/:id', async (c) => {
  const provider = getProvider(c.req.param('source'))
  if (!provider?.getCreator) return c.json({ error: 'unknown source' }, 404)
  const res = await provider.getCreator(c.req.param('id'), c.req.query('cursor') ?? null)
  const user = c.get('user')
  const allowAdult = await allowAdultVideos(user.id)
  if (!allowAdult && res.creator.isAdult) return c.json({ error: 'not available' }, 403)
  res.videos.items = await stampSmartTitles(await filterVideosForUser(user.id, res.videos.items), user.id)
  return c.json(res)
})

videosRoute.get('/:source/creator/:id/playlists', async (c) => {
  const provider = getProvider(c.req.param('source'))
  if (!provider?.getCreatorPlaylists) return c.json({ error: 'unknown source' }, 404)
  const page = await provider.getCreatorPlaylists(c.req.param('id'), c.req.query('cursor') ?? null)
  return c.json(page)
})

videosRoute.get('/:source/playlist/:id', async (c) => {
  const provider = getProvider(c.req.param('source'))
  if (!provider?.getPlaylistItems) return c.json({ error: 'unknown source' }, 404)
  const user = c.get('user')
  const page = await provider.getPlaylistItems(c.req.param('id'), c.req.query('cursor') ?? null)
  page.items = await filterVideosForUser(user.id, page.items)
  return c.json(page)
})

// ── Subscriptions' playlists: aggregated across every followed channel/creator ─────────
// A user's subscriptions (YouTube especially) can number in the hundreds; fetching each
// one's playlists live on every page load would mean hundreds of concurrent InnerTube/
// TikTok calls per request. Instead this reads a shared, hard-cached-per-channel store
// (stale-while-revalidate, same idiom as TikTok's own creatorRecentCached) and warms
// misses/stale entries in the background at bounded concurrency, so a first visit returns
// instantly with whatever's already known and fills in over the following visits/refetches.
const SUB_PLAYLISTS_NS = 'videos:creator-playlists'
const SUB_PLAYLISTS_TTL = 6 * 60 * 60_000
const SUB_PLAYLISTS_WARM_CONCURRENCY = 4

const activePlaylistWarms = new Set<string>()
async function warmOneCreatorPlaylists(source: VideoSource, externalId: string): Promise<void> {
  const key = `${source}:${externalId}`
  if (activePlaylistWarms.has(key)) return
  activePlaylistWarms.add(key)
  try {
    await cachedLookup(SUB_PLAYLISTS_NS, key, SUB_PLAYLISTS_TTL, async () => {
      const provider = getProvider(source)
      if (!provider?.getCreatorPlaylists) return { items: [], cursor: null } as Pager<Playlist>
      return provider.getCreatorPlaylists(externalId, null).catch(() => ({ items: [], cursor: null }) as Pager<Playlist>)
    })
  } finally {
    activePlaylistWarms.delete(key)
  }
}
function warmCreatorPlaylistsInBackground(targets: Array<{ source: VideoSource; externalId: string }>): void {
  let i = 0
  const worker = async () => {
    while (i < targets.length) {
      const t = targets[i++]!
      await warmOneCreatorPlaylists(t.source, t.externalId)
    }
  }
  void Promise.all(Array.from({ length: Math.min(SUB_PLAYLISTS_WARM_CONCURRENCY, targets.length) }, worker))
}

videosRoute.get('/subscriptions/playlists', async (c) => {
  const user = c.get('user')
  const [ytSubs, follows] = await Promise.all([
    db.select({ externalId: ytSubscriptions.externalId, title: ytSubscriptions.title, thumbnailUrl: ytSubscriptions.thumbnailUrl })
      .from(ytSubscriptions).where(and(eq(ytSubscriptions.userId, user.id), eq(ytSubscriptions.kind, 'channel'))),
    db.select().from(videoFollows).where(eq(videoFollows.userId, user.id)),
  ])
  const channels: Array<{ source: VideoSource; externalId: string; title: string; thumbnailUrl: string | null }> = [
    ...ytSubs.map((s) => ({ source: 'youtube' as const, externalId: s.externalId, title: s.title, thumbnailUrl: s.thumbnailUrl })),
    ...follows
      .filter((f) => f.kind !== 'subreddit')
      .map((f) => ({ source: f.source, externalId: f.externalId, title: f.title, thumbnailUrl: f.thumbnailUrl })),
  ]

  const results = await Promise.all(channels.map(async (ch) => {
    const cached = await cachedLookupStale<Pager<Playlist>>(SUB_PLAYLISTS_NS, `${ch.source}:${ch.externalId}`)
    return { ...ch, playlists: cached.value?.items ?? [], stale: !cached.fresh }
  }))

  const toWarm = results.filter((r) => r.stale).map((r) => ({ source: r.source, externalId: r.externalId }))
  warmCreatorPlaylistsInBackground(toWarm)

  const groups = results
    .filter((r) => r.playlists.length > 0)
    .map(({ source, externalId, title, thumbnailUrl, playlists }) => ({ source, externalId, title, thumbnailUrl, playlists }))
  return c.json({ groups, warming: toWarm.length })
})

videosRoute.get('/:source/item/:id', async (c) => {
  const source = c.req.param('source')
  const provider = getProvider(source)
  if (!provider) return c.json({ error: 'unknown source' }, 404)
  const user = c.get('user')
  const item = await provider.getItem(c.req.param('id'), user.id)
  if (!item) return c.json({ error: 'not found' }, 404)
  // Kid-safe media hard gate: a direct link can't play a blocked video for a kid profile even
  // if a card leaked through. Classifies synchronously here (single item, the watch path
  // tolerates the ~1s) so the verdict is real rather than a pending "unknown".
  if (!(await videoAllowedForUser(user.id, item))) return c.json({ error: 'not available' }, 403)
  // Time budget gate: watch start is refused (with a friendly reason) once today's video
  // minutes are used up or outside the allowed hours. Metering lives on the heartbeats.
  const timeGate = await checkVideoTime(user.id)
  if (!timeGate.allowed) {
    return c.json({
      error: timeGate.reason === 'hours' ? 'Videos are paused right now. Try again during allowed hours.' : 'Video time is used up for today.',
      code: 'time_limit',
    }, 403)
  }
  // Attach this user's saved position so the watch page can resume where any device left
  // off (the same watch state the history/Continue-watching shelves read).
  const [watch] = await db.select({ positionSec: videoWatchState.positionSec, completed: videoWatchState.completed })
    .from(videoWatchState)
    .where(and(eq(videoWatchState.userId, user.id), eq(videoWatchState.source, source), eq(videoWatchState.videoId, item.id)))
    .limit(1)
  if (watch) item.watch = { positionSec: watch.positionSec, completed: watch.completed }
  // Rewrite playback for the client: upstream URLs (signed, Referer-gated) never leave
  // the server — progressive and yt-dlp-piped sources both play through /stream below,
  // just via a different server-side strategy depending on the provider.
  const playback = await provider.getPlayback(item.id)
  const clientPlayback = (playback.mode === 'proxy-progressive' || playback.mode === 'ytdlp-pipe')
    ? { mode: 'stream' as const, streamUrl: `/api/videos/${source}/stream/${encodeURIComponent(item.id)}` }
    : playback
  return c.json({ item, playback: clientPlayback })
})

// ── Stream proxy: either a Range-forwarding fetch, or a live yt-dlp pipe ────────
//
// Two server-side strategies behind one client-facing endpoint, chosen by the
// provider's PlaybackInfo mode:
//  - proxy-progressive: fetch the resolved CDN URL ourselves and forward Range
//    (works when the CDN accepts a plain server fetch — Vimeo).
//  - ytdlp-pipe: spawn yt-dlp against the page URL and pipe its stdout directly.
//    No Range/seek support (a live process, not a static resource), but this is the
//    only thing that gets past CDNs that reject direct fetches even with identical
//    headers (TikTok) — yt-dlp's own request succeeds where our fetch() doesn't.

videosRoute.get('/:source/stream/:id', async (c) => {
  const provider = getProvider(c.req.param('source'))
  if (!provider) return c.json({ error: 'unknown source' }, 404)
  const playback = await provider.getPlayback(c.req.param('id')).catch(() => null)
  if (!playback) return c.json({ error: 'not streamable' }, 404)

  if (playback.mode === 'ytdlp-pipe') {
    const { ytDlpBin } = await import('@/lib/ytdlp')
    const { spawn } = await import('node:child_process')
    const { Readable } = await import('node:stream')
    const args = [
      ...(playback.formatSelector ? ['-f', playback.formatSelector] : []),
      '--no-playlist', '--no-warnings', '--merge-output-format', 'mp4', '-o', '-', playback.pageUrl,
    ]
    const proc = spawn(ytDlpBin(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let errTail = ''
    proc.stderr.on('data', (d: Buffer) => { errTail = (errTail + d.toString()).slice(-2048) })
    c.req.raw.signal.addEventListener('abort', () => { try { proc.kill('SIGTERM') } catch { /* gone */ } }, { once: true })
    proc.on('error', () => {})
    proc.stdout.once('error', () => {})

    // First-byte guard: if yt-dlp fails immediately (bad url, extractor error), surface
    // a real error instead of a 200 response that silently carries zero bytes. Pulled
    // exclusively through the stream's own async iterator (never `.once('data', ...)`,
    // which forces flowing mode and can drop chunks emitted before a later `for await`
    // reattaches — a classic Node streams footgun for exactly this "peek then resume"
    // pattern) so no bytes between the first chunk and the rest are ever lost.
    let exitCode: number | null = null
    const closed = new Promise<void>((resolve) => proc.once('close', (code) => { exitCode = code; resolve() }))
    const iter = proc.stdout[Symbol.asyncIterator]() as AsyncIterator<Buffer>
    const first = await iter.next()
    if (first.done) {
      await closed
      if (exitCode !== 0) {
        return c.json({ error: `stream failed: ${errTail.trim().split('\n').slice(-2).join(' | ').slice(-300) || 'yt-dlp exited early'}` }, 502)
      }
    }
    const prefixed = (async function* () {
      if (!first.done) yield first.value
      while (true) {
        const next = await iter.next()
        if (next.done) return
        yield next.value
      }
    })()
    const body = Readable.toWeb(Readable.from(prefixed)) as unknown as ReadableStream
    return new Response(body, { headers: { 'Content-Type': 'video/mp4', 'Cache-Control': 'private, max-age=0' } })
  }

  if (playback.mode !== 'proxy-progressive') return c.json({ error: 'not streamable' }, 404)
  const ac = new AbortController()
  c.req.raw.signal.addEventListener('abort', () => ac.abort(), { once: true })
  const range = c.req.header('range')
  try {
    const upstream = await fetch(playback.upstreamUrl, {
      signal: AbortSignal.any([ac.signal, AbortSignal.timeout(30_000)]),
      headers: {
        ...(range ? { Range: range } : {}),
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        ...(playback.headers ?? {}),
      },
    })
    if (!upstream.ok && upstream.status !== 206) return c.json({ error: `upstream ${upstream.status}` }, 502)
    const headers = new Headers()
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(h)
      if (v) headers.set(h, v)
    }
    if (!headers.has('accept-ranges')) headers.set('accept-ranges', 'bytes')
    if (!headers.has('content-type')) headers.set('content-type', 'video/mp4')
    headers.set('cache-control', 'private, max-age=0')
    return new Response(upstream.body, { status: upstream.status, headers })
  } catch {
    if (ac.signal.aborted) return new Response(null, { status: 499 })
    return c.json({ error: 'stream failed' }, 502)
  }
})

// ── Watch history for non-YouTube sources (YouTube keeps /api/youtube/history) ──

videosRoute.get('/history', async (c) => {
  const user = c.get('user')
  const allowAdult = await allowAdultVideos(user.id)
  const rows = await db.select({
    source: videoWatchState.source,
    videoId: videoWatchState.videoId,
    positionSec: videoWatchState.positionSec,
    completed: videoWatchState.completed,
    updatedAt: videoWatchState.updatedAt,
    title: videoItems.title,
    creatorId: videoItems.creatorId,
    creatorName: videoItems.creatorName,
    creatorAvatarUrl: videoFollows.thumbnailUrl,
    thumbnailUrl: videoItems.thumbnailUrl,
    durationSec: videoItems.durationSec,
    isAdult: videoItems.isAdult,
  })
    .from(videoWatchState)
    .leftJoin(videoItems, and(eq(videoItems.source, videoWatchState.source), eq(videoItems.externalId, videoWatchState.videoId)))
    // Best-effort creator avatar: only followed creators have a cached thumbnail — anything
    // watched via search/a pasted link falls back to CreatorAvatar's letter avatar client-side.
    .leftJoin(videoFollows, and(eq(videoFollows.userId, user.id), eq(videoFollows.source, videoWatchState.source), eq(videoFollows.externalId, videoItems.creatorId)))
    .where(eq(videoWatchState.userId, user.id))
    .orderBy(desc(videoWatchState.updatedAt))
    .limit(150)
  const history = rows
    .filter((r) => allowAdult || !r.isAdult)
    // A row with no video_items match at all (title null) has nothing to render — predates
    // the watch-state snapshot, or the snapshot write raced the item lookup. Drop it rather
    // than show a blank "videoId as title" card.
    .filter((r) => r.title != null)
    .map((r) => ({
      source: r.source, videoId: r.videoId, title: r.title!,
      creatorId: r.creatorId, creatorName: r.creatorName, creatorAvatarUrl: r.creatorAvatarUrl,
      thumbnailUrl: r.thumbnailUrl, durationSec: r.durationSec,
      positionSec: r.positionSec, completed: r.completed,
      updatedAt: r.updatedAt ? r.updatedAt.getTime() : 0,
    }))
  return c.json({ history })
})

// ── Following feed: recent uploads from followed creators (poller-fed cache) ─────

videosRoute.get('/following-feed', async (c) => {
  const user = c.get('user')
  const source = c.req.query('source')
  const allowAdult = await allowAdultVideos(user.id)
  const follows = await db.select({ id: videoFollows.id, title: videoFollows.title, thumbnailUrl: videoFollows.thumbnailUrl }).from(videoFollows).where(and(
    eq(videoFollows.userId, user.id),
    ...(source && isGenericSource(source) ? [eq(videoFollows.source, source)] : []),
  ))
  if (follows.length === 0) return c.json({ items: [] })
  // The follow row is the creator's one authoritative, self-healing identity (refreshed
  // every poll tick); a video_items row is a write-once snapshot from whenever it was first
  // polled, so prefer the follow's name/avatar over the per-item columns.
  const followsById = new Map(follows.map((f) => [f.id, f]))
  const rows = await db.select().from(videoItems)
    .where(inArray(videoItems.followId, follows.map((f) => f.id)))
    .orderBy(desc(videoItems.publishedAt), desc(videoItems.createdAt))
    .limit(120)
  const items = rows
    .filter((r) => allowAdult || !r.isAdult)
    .map((r) => {
      const follow = r.followId ? followsById.get(r.followId) : null
      return {
        source: r.source, id: r.externalId, url: r.url ?? '', title: r.title,
        creator: follow?.title || r.creatorId || r.creatorName
          ? { id: r.creatorId ?? '', name: follow?.title || r.creatorName || '', avatarUrl: follow?.thumbnailUrl ?? null }
          : null,
        thumbnailUrl: r.thumbnailUrl, durationSec: r.durationSec, viewsText: r.viewsText ?? null,
        publishedAt: r.publishedAt ? r.publishedAt.getTime() : null,
        isAdult: r.isAdult, vertical: r.source === 'tiktok',
      }
    })
  return c.json({ items: await stampSmartTitles(await filterVideosForUser(user.id, items), user.id) })
})

videosRoute.get('/:source/comments/:id', async (c) => {
  const provider = getProvider(c.req.param('source'))
  if (!provider?.getComments) return c.json({ error: 'unknown source' }, 404)
  return c.json({ comments: await provider.getComments(c.req.param('id')) })
})

videosRoute.get('/:source/related/:id', async (c) => {
  const provider = getProvider(c.req.param('source'))
  if (!provider?.getRelated) return c.json({ error: 'unknown source' }, 404)
  const items = await provider.getRelated(c.req.param('id')).catch(() => [])
  return c.json({ items: await filterVideosForUser(c.get('user').id, items) })
})

// Raw WebVTT for the watch page's transcript tab. Provider caption APIs answer fast
// (Vimeo texttracks); everything else falls back to the yt-dlp subtitle fetch inside
// resolveVideoVtt, disk-cached per user. YouTube has its own /api/youtube/transcript.
videosRoute.get('/:source/transcript/:id', async (c) => {
  const source = c.req.param('source')
  const id = c.req.param('id')
  const provider = getProvider(source)
  if (!provider || source === 'youtube') return c.text('', 404)
  const user = c.get('user')
  const item = await provider.getItem(id, user.id).catch(() => null)
  if (!item) return c.text('', 404)
  const vtt = await resolveVideoVtt({ videoId: id, source, url: item.url }, user.id, user.firstName).catch(() => null)
  if (!vtt) return c.text('', 404)
  return c.text(vtt, 200, { 'Content-Type': 'text/vtt; charset=utf-8' })
})

// AI summary for a hub video: transcript (provider captions API or yt-dlp) through the
// same summarizer prompt/model as YouTube's. Cached a week — transcripts don't change.
// An LLM failure throws out of cachedLookup (nothing cached) so a transient outage
// doesn't pin "no summary" for a week; genuinely caption-less videos do cache null.
videosRoute.get('/:source/summary/:id', async (c) => {
  const source = c.req.param('source')
  const id = c.req.param('id')
  const provider = getProvider(source)
  if (!provider || source === 'youtube') return c.json({ error: 'unknown source' }, 404)
  const user = c.get('user')
  const item = await provider.getItem(id, user.id).catch(() => null)
  if (!item) return c.json({ error: 'not found' }, 404)
  const summary = await cachedLookup('videos:summary', `${source}:${id}`, 7 * 24 * 60 * 60_000, async () => {
    const text = await resolveVideoTranscript({ videoId: id, source, url: item.url }, user.id, user.firstName)
    return text ? summarizeTranscriptText(text) : null
  }).catch(() => null)
  return c.json({ summary })
})

// ── Follows (non-YouTube sources; yt_subscriptions stays authoritative for YouTube) ──

videosRoute.get('/follows', async (c) => {
  const user = c.get('user')
  const rows = await db.select().from(videoFollows)
    .where(eq(videoFollows.userId, user.id)).orderBy(desc(videoFollows.addedAt))
  return c.json({ follows: rows })
})

videosRoute.post('/follows', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ source?: string; externalId?: string }>().catch(() => ({}) as Record<string, never>)
  const source = body.source ?? ''
  let externalId = body.externalId?.trim()
  if (!isGenericSource(source) || !externalId) return c.json({ error: 'source and externalId required' }, 400)
  const provider = getProvider(source)
  if (!provider?.getCreator) return c.json({ error: 'source does not support follows' }, 400)

  // Accept a pasted profile URL, not just a bare handle/id.
  const matched = /^https?:\/\//i.test(externalId) ? matchUrlToProvider(externalId) : null
  if (matched && matched.provider.source === source && matched.match.kind === 'creator') externalId = matched.match.id
  const cleanId = externalId.replace(/^@/, '')

  // Resolve creator details best-effort: a slow/flaky extraction (TikTok especially) must NOT
  // block the follow. Fall back to the handle so the follow always lands; the poller fills in
  // the real title/avatar on its next tick.
  const creator = await provider.getCreator(cleanId).then((r) => r.creator).catch(() => null)
  if (creator?.isAdult && !(await allowAdultVideos(user.id))) {
    return c.json({ error: 'This community is not available on your content profile.' }, 403)
  }
  const kind = creator?.kind === 'subreddit' ? 'subreddit' : creator?.kind === 'channel' ? 'channel' : 'creator'
  const now = new Date()
  const id = randomUUID()
  await db.insert(videoFollows).values({
    id, userId: user.id, source, kind,
    externalId: creator?.id ?? cleanId,
    title: creator?.name ?? (source === 'tiktok' ? `@${cleanId}` : cleanId),
    handle: creator?.handle ?? (source === 'tiktok' ? `@${cleanId}` : null),
    thumbnailUrl: creator?.avatarUrl ?? null, description: creator?.description ?? null,
    isAdult: !!creator?.isAdult, lastFetchedAt: null, addedAt: now,
  }).onConflictDoNothing()
  return c.json({ ok: true, id })
})

videosRoute.patch('/follows/:id', async (c) => {
  const user = c.get('user')
  const body: { autoSave?: boolean; autoSaveKind?: 'audio' | 'video'; autoSaveKeep?: number | null; removeWatched?: boolean } =
    await c.req.json().catch(() => ({}))
  const patch: Record<string, unknown> = {}
  if (typeof body.autoSave === 'boolean') patch.autoSave = body.autoSave
  if (body.autoSaveKind === 'audio' || body.autoSaveKind === 'video') patch.autoSaveKind = body.autoSaveKind
  if (body.autoSaveKeep === null || typeof body.autoSaveKeep === 'number') patch.autoSaveKeep = body.autoSaveKeep
  if (typeof body.removeWatched === 'boolean') patch.removeWatched = body.removeWatched
  if (Object.keys(patch).length === 0) return c.json({ error: 'nothing to update' }, 400)
  await db.update(videoFollows).set(patch)
    .where(and(eq(videoFollows.id, c.req.param('id')), eq(videoFollows.userId, user.id)))
  return c.json({ ok: true })
})

videosRoute.delete('/follows/:id', async (c) => {
  const user = c.get('user')
  await db.delete(videoFollows)
    .where(and(eq(videoFollows.id, c.req.param('id')), eq(videoFollows.userId, user.id)))
  return c.json({ ok: true })
})

// ── Watch state (non-YouTube sources) ───────────────────────────────────────────

videosRoute.put('/watch-state', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{
    source?: string; videoId?: string; positionSec?: number; completed?: boolean
    // Optional item snapshot: the caller already has this in memory (from getSourceItem),
    // so it's cheapest to carry it here rather than re-resolve it server-side. Without
    // this, "Continue watching" can only show a title/thumbnail for videos that happen
    // to already be cached in video_items by the followed-creator feed poller — anything
    // watched directly (search, a pasted link, browsing a non-followed feed) had no such
    // row, so the join fell back to displaying the raw video id.
    title?: string; thumbnailUrl?: string | null; creatorId?: string | null; creatorName?: string | null
    durationSec?: number | null; isAdult?: boolean
  }>().catch(() => ({}) as Record<string, never>)
  const source = body.source ?? ''
  if (!isGenericSource(source) || !body.videoId) return c.json({ error: 'source and videoId required' }, 400)
  const now = new Date()
  await db.insert(videoWatchState).values({
    id: randomUUID(), userId: user.id, source, videoId: body.videoId,
    positionSec: body.positionSec ?? 0, completed: !!body.completed, updatedAt: now,
  }).onConflictDoUpdate({
    target: [videoWatchState.userId, videoWatchState.source, videoWatchState.videoId],
    set: { positionSec: body.positionSec ?? 0, completed: !!body.completed, updatedAt: now },
  })
  if (body.title) {
    await db.insert(videoItems).values({
      id: randomUUID(), source, externalId: body.videoId, title: body.title,
      creatorId: body.creatorId ?? null, creatorName: body.creatorName ?? null,
      thumbnailUrl: body.thumbnailUrl ?? null, durationSec: body.durationSec ?? null,
      isAdult: !!body.isAdult, createdAt: now,
    }).onConflictDoUpdate({
      target: [videoItems.source, videoItems.externalId],
      set: {
        title: body.title, creatorId: body.creatorId ?? null, creatorName: body.creatorName ?? null,
        thumbnailUrl: body.thumbnailUrl ?? null, durationSec: body.durationSec ?? null, isAdult: !!body.isAdult,
      },
    })
  }
  // Time budget metering + gate: each heartbeat counts toward today's minutes, and the
  // response tells the player when the budget runs out so it can wind down mid-video.
  recordWatchBeat(user.id)
  // Watched videos join the semantic search index organically (fire and forget).
  ensureVideoIndexed(source, body.videoId, {
    userId: user.id, userFirstName: user.firstName,
    title: body.title ?? null, creatorName: body.creatorName ?? null,
  })
  const timeGate = await checkVideoTime(user.id)
  return c.json({ ok: true, timeLimit: timeGate.remainingSec != null || !timeGate.allowed ? timeGate : undefined })
})

// ── Ask the video: grounded Q&A over the current video's transcript ──────────────

videosRoute.post('/:source/ask/:id', async (c) => {
  const source = c.req.param('source')
  const id = c.req.param('id')
  const user = c.get('user')
  const body = await c.req.json().catch(() => ({})) as {
    question?: string
    history?: Array<{ role: 'user' | 'assistant'; content: string }>
  }
  if (!body.question?.trim()) return c.json({ error: 'question required' }, 400)
  const history = Array.isArray(body.history)
    ? body.history.filter((t) => (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string')
    : []

  // Same content gates as watching: ceiling/allowlist verdicts apply to asking too.
  let title: string | null = null
  let creatorName: string | null = null
  let url: string | null = null
  if (source === 'youtube') {
    const [v] = await db.select({ title: ytVideosTable.title, author: ytVideosTable.author, channelId: ytVideosTable.channelId })
      .from(ytVideosTable).where(eq(ytVideosTable.videoId, id)).limit(1)
    title = v?.title ?? null
    creatorName = v?.author ?? null
    if (v?.title && !(await videoAllowedForUser(user.id, {
      source: 'youtube', id, url: `https://www.youtube.com/watch?v=${id}`,
      title: v.title, creator: v.channelId ? { id: v.channelId, name: v.author ?? '' } : null,
    }))) return c.json({ error: 'not available' }, 403)
  } else {
    const provider = getProvider(source)
    if (!provider) return c.json({ error: 'unknown source' }, 404)
    const item = await provider.getItem(id, user.id).catch(() => null)
    if (!item) return c.json({ error: 'not found' }, 404)
    if (!(await videoAllowedForUser(user.id, item))) return c.json({ error: 'not available' }, 403)
    title = item.title
    creatorName = item.creator?.name ?? null
    url = item.url
  }

  const result = await askVideo({
    source, videoId: id, question: body.question, history,
    title, creatorName, url,
    userId: user.id, userFirstName: user.firstName,
  })
  if (!result) return c.json({ error: 'The companion could not answer right now.' }, 503)
  return c.json(result)
})

// ── Semantic search: "find the video where..." across everything the household watched ──

videosRoute.get('/semantic-search', async (c) => {
  const user = c.get('user')
  const q = (c.req.query('q') ?? '').trim()
  if (q.length < 3) return c.json({ hits: [] })
  const hits = await semanticSearch(user.id, q, 20)
  return c.json({ hits })
})

// ── Saves: offline downloads for non-YouTube sources ────────────────────────────

videosRoute.get('/saves', async (c) => {
  const user = c.get('user')
  const source = c.req.query('source')
  const where = source && isGenericSource(source)
    ? and(eq(videoSaves.userId, user.id), eq(videoSaves.source, source))
    : eq(videoSaves.userId, user.id)
  const rows = await db.select().from(videoSaves).where(where).orderBy(desc(videoSaves.createdAt))
  const allowAdult = await allowAdultVideos(user.id)
  return c.json({ saves: allowAdult ? rows : rows.filter((r) => !r.isAdult) })
})

/** Shared save write path (manual single-save + creator backfill): upsert the videoSaves
 *  ref, attach instantly when the household already holds the rendition, else enqueue the
 *  download. `auto` rows belong to the rolling keep-N window; a conflict never flips an
 *  existing manual row to auto (manual saves must stay prune-exempt). */
async function saveVideoItem(
  userId: string, source: GenericSource, providerLabel: string,
  item: VideoItem, kind: 'audio' | 'video', maxHeight: number | null, auto: boolean,
): Promise<string> {
  const now = new Date()
  const id = randomUUID()
  await db.insert(videoSaves).values({
    id, userId, source, videoId: item.id, title: item.title, kind,
    status: 'pending', assetId: null, sizeBytes: null, maxHeight,
    thumbnailUrl: item.thumbnailUrl ?? null, creatorName: item.creator?.name ?? null,
    durationSec: item.durationSec ?? null, sourceUrl: item.url, auto,
    isAdult: !!item.isAdult, error: null, createdAt: now, updatedAt: now,
  }).onConflictDoUpdate({
    target: [videoSaves.userId, videoSaves.source, videoSaves.videoId, videoSaves.kind],
    set: { status: 'pending', error: null, updatedAt: now, ...(auto ? {} : { auto: false }) },
  })

  // Someone else in the household may already hold this rendition — attach instantly.
  const format = kind === 'audio' ? 'mp3' : 'mp4'
  const [ready] = await db.select().from(mediaAssets).where(and(
    eq(mediaAssets.sourceType, source), eq(mediaAssets.sourceId, item.id),
    eq(mediaAssets.kind, kind), eq(mediaAssets.format, format), eq(mediaAssets.status, 'ready'),
  )).limit(1)
  if (ready?.blobHash) {
    await db.update(videoSaves)
      .set({ status: 'ready', assetId: ready.id, sizeBytes: ready.sizeBytes, updatedAt: new Date() })
      .where(and(eq(videoSaves.userId, userId), eq(videoSaves.source, source), eq(videoSaves.videoId, item.id), eq(videoSaves.kind, kind)))
    // Dedup-satisfied saves never pass through completeVideoAsset's fan-out — enqueue the
    // Plex placement directly (no-ops unless this user has a ready library for the source).
    if (kind === 'video') {
      const { enqueuePlexSync } = await import('@/lib/downloadJobs')
      void enqueuePlexSync(userId, item.id, 'add', source).catch(() => {})
    }
  } else {
    await enqueueVideoMedia({ source, videoId: item.id, kind, maxHeight }, `${providerLabel}: ${item.title}`)
  }
  return id
}

videosRoute.post('/:source/save', async (c) => {
  const user = c.get('user')
  const source = c.req.param('source')
  if (!isGenericSource(source)) return c.json({ error: 'unknown source' }, 404)
  const provider = getProvider(source)
  if (!provider) return c.json({ error: 'unknown source' }, 404)
  const body = await c.req.json<{ videoId?: string; kind?: 'audio' | 'video'; maxHeight?: number | null }>().catch(() => ({}) as Record<string, never>)
  if (!body.videoId) return c.json({ error: 'videoId required' }, 400)
  const kind: 'audio' | 'video' = body.kind === 'audio' ? 'audio' : 'video'
  if (!provider.capabilities.downloadKinds.includes(kind)) return c.json({ error: `${kind} not supported for ${source}` }, 400)

  const item = await provider.getItem(body.videoId, user.id)
  if (!item) return c.json({ error: 'not found' }, 404)
  if (item.isAdult && !(await allowAdultVideos(user.id))) return c.json({ error: 'not available' }, 403)

  // Per-source quality tiers (lib/videos/quality.ts): an explicit request is clamped to
  // the admin cap; no request → the user's effective height (preference ∧ cap).
  let maxHeight: number | null = null
  if (kind === 'video') {
    const { effectiveSaveHeight, getEffectiveSourceCap } = await import('@/lib/videos/quality')
    maxHeight = typeof body.maxHeight === 'number'
      ? Math.min(body.maxHeight, await getEffectiveSourceCap(user.id, source))
      : await effectiveSaveHeight(user.id, source)
  }

  const id = await saveVideoItem(user.id, source, provider.label, item, kind, maxHeight, false)
  return c.json({ ok: true, id })
})

// Back-catalogue grab for a creator, used by the "Configure for offline" popover: enabling
// the rolling rules PATCHes the follow, then calls this with auto:true so keep-last-N is
// true immediately (backfilled rows join the same prune window as poller auto-saves).
// Also upserts video_items rows so the pruner and watched-sweep can join on followId and
// order by real publishedAt.
videosRoute.post('/:source/creator/:creatorId/save-now', async (c) => {
  const user = c.get('user')
  const source = c.req.param('source')
  const creatorId = c.req.param('creatorId')
  if (!isGenericSource(source)) return c.json({ error: 'unknown source' }, 404)
  const provider = getProvider(source)
  if (!provider?.getCreator) return c.json({ error: 'source does not support creators' }, 400)
  const body = await c.req.json<{ kind?: 'audio' | 'video'; count?: number; auto?: boolean }>().catch(() => ({}) as Record<string, never>)
  const kind: 'audio' | 'video' = body.kind === 'audio' ? 'audio' : 'video'
  if (!provider.capabilities.downloadKinds.includes(kind)) return c.json({ error: `${kind} not supported for ${source}` }, 400)
  const count = Math.max(1, Math.min(50, Math.trunc(body.count ?? 10)))
  const auto = body.auto !== false

  const [follow] = await db.select().from(videoFollows).where(and(
    eq(videoFollows.userId, user.id), eq(videoFollows.source, source), eq(videoFollows.externalId, creatorId),
  )).limit(1)
  if (auto && !follow) return c.json({ error: 'follow this creator first' }, 400)

  let items: VideoItem[] = []
  try { items = (await provider.getCreator(creatorId, user.id)).videos?.items ?? [] } catch { /* fall through */ }
  if (!items.length && provider.fetchCreatorFeed) {
    items = await provider.fetchCreatorFeed(creatorId, new Set()).catch(() => [])
  }

  // Auto backfill never pulls adult-flagged content (mirrors the poller, feed.ts); a manual
  // grab honors the user's content profile like single-save does.
  const allowAdult = !auto && (await allowAdultVideos(user.id))
  const wanted = items.filter((it) => allowAdult || !it.isAdult).slice(0, count)
  if (!wanted.length) return c.json({ ok: true, queued: 0, total: 0 })

  const maxHeight = kind === 'video'
    ? await (await import('@/lib/videos/quality')).effectiveSaveHeight(user.id, source)
    : null
  const now = new Date()
  for (const item of wanted) {
    if (follow) {
      await db.insert(videoItems).values({
        id: randomUUID(), source, externalId: item.id, followId: follow.id,
        title: item.title, creatorId: item.creator?.id ?? null, creatorName: item.creator?.name ?? null,
        url: item.url, thumbnailUrl: item.thumbnailUrl ?? null, durationSec: item.durationSec ?? null,
        viewsText: item.viewsText ?? null,
        publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
        isAdult: !!item.isAdult, metaJson: item.meta ? JSON.stringify(item.meta) : null, createdAt: now,
      }).onConflictDoNothing()
    }
    await saveVideoItem(user.id, source, provider.label, item, kind, maxHeight, auto)
  }
  return c.json({ ok: true, queued: wanted.length, total: wanted.length })
})

// Manual (re)sync of every ready generic-source save into this user's per-source Plex
// libraries — the non-YouTube companion to /api/youtube/plex/sync-all. Fails loudly when
// no generic library is provisioned (see that route's note on why silent no-op misleads).
videosRoute.post('/plex/sync-all', async (c) => {
  const user = c.get('user')
  const { plexLibrarySections } = await import('@/db/schema')
  const sections = await db.select().from(plexLibrarySections).where(and(
    eq(plexLibrarySections.userId, user.id), eq(plexLibrarySections.status, 'ready'),
    inArray(plexLibrarySections.contentType, ['reddit', 'tiktok', 'vimeo']),
  ))
  if (!sections.length) {
    return c.json({ ok: false, error: 'No Plex library is provisioned for these sources yet — ask an admin to set one up in Admin → Plex first.' }, 400)
  }
  const readySources = new Set(sections.map((s) => s.contentType))
  const rows = await db.select({ source: videoSaves.source, videoId: videoSaves.videoId }).from(videoSaves)
    .where(and(eq(videoSaves.userId, user.id), eq(videoSaves.kind, 'video'), eq(videoSaves.status, 'ready')))
  const { enqueuePlexSync } = await import('@/lib/downloadJobs')
  let enqueued = 0
  for (const r of rows) {
    if (!readySources.has(r.source)) continue
    await enqueuePlexSync(user.id, r.videoId, 'add', r.source)
    enqueued++
  }
  return c.json({ ok: true, enqueued })
})

videosRoute.delete('/saves/:id', async (c) => {
  const user = c.get('user')
  const [row] = await db.select().from(videoSaves)
    .where(and(eq(videoSaves.id, c.req.param('id')), eq(videoSaves.userId, user.id)))
    .limit(1)
  if (row) {
    await db.delete(videoSaves).where(eq(videoSaves.id, row.id))
    // Placement-only removal: pulls the episode from the user's Plex tree if placed.
    if (row.kind === 'video') {
      const { enqueuePlexSync } = await import('@/lib/downloadJobs')
      void enqueuePlexSync(user.id, row.videoId, 'remove', row.source).catch(() => {})
    }
  }
  return c.json({ ok: true })  // orphaned assets are reclaimed by the store's GC sweep
})

// ── Serve a saved rendition (Range-capable, mirrors clipper's /file) ─────────────

videosRoute.get('/:source/file/:videoId/:kind', async (c) => {
  const user = c.get('user')
  const source = c.req.param('source')
  const kind = c.req.param('kind')
  if (!isGenericSource(source) || (kind !== 'audio' && kind !== 'video')) return c.json({ error: 'not found' }, 404)

  const [save] = await db.select().from(videoSaves).where(and(
    eq(videoSaves.userId, user.id), eq(videoSaves.source, source),
    eq(videoSaves.videoId, c.req.param('videoId')), eq(videoSaves.kind, kind),
  )).limit(1)
  if (!save || save.status !== 'ready' || !save.assetId) return c.json({ error: 'not found' }, 404)

  const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, save.assetId)).limit(1)
  if (!asset?.blobHash || asset.status !== 'ready') return c.json({ error: 'not found' }, 404)
  const absPath = await blobAbsPath(asset.blobHash)
  if (!existsSync(absPath)) return c.json({ error: 'file missing' }, 404)

  const contentType = asset.format === 'mp3' ? 'audio/mpeg' : 'video/mp4'
  const hash = asset.blobHash
  const fileStat = await stat(absPath)
  const rangeMatch = /^bytes=(\d*)-(\d*)$/.exec((c.req.header('range') ?? '').trim())
  if (rangeMatch) {
    const size = fileStat.size
    let start = rangeMatch[1] ? parseInt(rangeMatch[1], 10) : 0
    let end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : size - 1
    if (Number.isNaN(start) || start < 0) start = 0
    if (Number.isNaN(end) || end >= size) end = size - 1
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    acquireRead(hash)
    const { createReadStream } = await import('node:fs')
    const stream = createReadStream(absPath, { start, end })
    const release = () => releaseRead(hash)
    stream.once('close', release)
    stream.once('error', release)
    return new Response(stream as unknown as BodyInit, {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${end}/${fileStat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        'Content-Type': contentType,
      },
    })
  }
  const buf = await readFile(absPath)
  return new Response(buf, {
    headers: { 'Content-Type': contentType, 'Content-Length': String(fileStat.size), 'Accept-Ranges': 'bytes' },
  })
})

// ── Reddit HLS proxy (v.redd.it only) ───────────────────────────────────────────
// hls.js loads /api/videos/reddit/hls/:postId/manifest.m3u8; child playlist/segment
// URIs inside the manifest are relative, so the browser resolves them under the same
// proxy prefix and we forward each subpath to the post's v.redd.it base.

videosRoute.get('/reddit/hls/:postId/:path{.+}', async (c) => {
  const post = await redditPost(c.req.param('postId')).catch(() => null)
  const hls = post?.meta?.hlsUrl as string | undefined
  if (!hls) return c.json({ error: 'not found' }, 404)
  const user = c.get('user')
  if (post?.isAdult && !(await allowAdultVideos(user.id))) return c.json({ error: 'not available' }, 403)

  const base = new URL(hls)
  if (base.hostname !== 'v.redd.it') return c.json({ error: 'unsupported host' }, 502)

  const sub = c.req.param('path')
  // manifest.m3u8 is our alias for the post's actual manifest (keeps its auth query);
  // any other subpath is resolved relative to the manifest's directory.
  const upstream = sub === 'manifest.m3u8'
    ? base
    : new URL(sub + (c.req.url.includes('?') ? `?${c.req.url.split('?')[1]}` : ''), base)
  if (upstream.hostname !== 'v.redd.it') return c.json({ error: 'unsupported host' }, 502)

  const ac = new AbortController()
  c.req.raw.signal.addEventListener('abort', () => ac.abort(), { once: true })
  try {
    const res = await fetch(upstream, { signal: AbortSignal.any([ac.signal, AbortSignal.timeout(30_000)]) })
    if (!res.ok) return c.json({ error: `upstream ${res.status}` }, 502)
    const headers = new Headers()
    for (const h of ['content-type', 'content-length']) {
      const v = res.headers.get(h)
      if (v) headers.set(h, v)
    }
    headers.set('cache-control', 'private, max-age=30')
    return new Response(res.body, { status: 200, headers })
  } catch {
    if (ac.signal.aborted) return new Response(null, { status: 499 })
    return c.json({ error: 'stream failed' }, 502)
  }
})

// ── Source config (admin): Reddit app client id, Vimeo API token ────────────────

videosRoute.get('/config/reddit', requireAdmin, async (c) => {
  const clientId = await getRedditClientId()
  return c.json({ configured: !!clientId, clientId: clientId ?? '' })
})

videosRoute.put('/config/reddit', requireAdmin, async (c) => {
  const body: { clientId?: string } = await c.req.json().catch(() => ({}))
  await setAppSetting(REDDIT_CLIENT_ID_KEY, (body.clientId ?? '').trim())
  return c.json({ ok: true })
})

videosRoute.get('/config/vimeo', requireAdmin, async (c) => {
  const token = await getVimeoToken()
  return c.json({ configured: !!token, token: token ?? '' })
})

videosRoute.put('/config/vimeo', requireAdmin, async (c) => {
  const body: { token?: string } = await c.req.json().catch(() => ({}))
  await setAppSetting(VIMEO_TOKEN_KEY, (body.token ?? '').trim())
  return c.json({ ok: true })
})

// ── Per-source save quality + auto-enhance (mirrors /api/youtube/save-quality) ────
// User preferences (videos.save_quality.<source>, media.enhance_mode.<source>) are
// written through the generic /preferences endpoint like YouTube's; only the admin caps
// need dedicated routes since appSettings are not user-writable.

const QUALITY_SOURCES = ['tiktok', 'vimeo', 'reddit'] as const

videosRoute.get('/quality', async (c) => {
  const user = c.get('user')
  const { SAVE_HEIGHTS, getEffectiveSourceCap, getSourcePreference, effectiveSaveHeight } = await import('@/lib/videos/quality')
  const { getEnhanceModeFor, getEnhanceDefaultFor, shouldEnhanceFor, getEnhanceDefault } = await import('@/lib/media/enhancePolicy')
  const sources = await Promise.all(QUALITY_SOURCES.map(async (source) => ({
    source,
    cap: await getEffectiveSourceCap(user.id, source),
    pref: await getSourcePreference(user.id, source),
    effective: await effectiveSaveHeight(user.id, source),
    enhanceMode: await getEnhanceModeFor(user.id, source),         // user per-source override
    enhanceDefault: await getEnhanceDefaultFor(source),            // admin per-source default (null = household)
    enhanceEffective: await shouldEnhanceFor(user.id, source),
  })))
  return c.json({ tiers: SAVE_HEIGHTS, householdEnhanceDefault: await getEnhanceDefault(), sources })
})

videosRoute.put('/quality/caps', requireAdmin, async (c) => {
  const body: { source?: string; height?: number | null; userId?: string } = await c.req.json().catch(() => ({}))
  if (!body.source || !(QUALITY_SOURCES as readonly string[]).includes(body.source)) return c.json({ error: 'unknown source' }, 400)
  const { SAVE_HEIGHTS, sourceCapKey, sourceUserCapKey } = await import('@/lib/videos/quality')
  if (body.height != null && !(SAVE_HEIGHTS as readonly number[]).includes(body.height)) return c.json({ error: 'invalid height' }, 400)
  const key = body.userId ? sourceUserCapKey(body.source, body.userId) : sourceCapKey(body.source)
  await setAppSetting(key, body.height ?? null)
  return c.json({ ok: true })
})

videosRoute.put('/enhance/default', requireAdmin, async (c) => {
  const body: { source?: string; value?: boolean | null } = await c.req.json().catch(() => ({}))
  const validSources: readonly string[] = ['youtube', ...QUALITY_SOURCES]
  if (!body.source || !validSources.includes(body.source)) return c.json({ error: 'unknown source' }, 400)
  if (body.value !== null && typeof body.value !== 'boolean') return c.json({ error: 'value must be boolean or null (inherit household)' }, 400)
  const { enhanceDefaultKeyFor } = await import('@/lib/media/enhancePolicy')
  await setAppSetting(enhanceDefaultKeyFor(body.source), body.value)
  return c.json({ ok: true })
})

export { videosRoute }

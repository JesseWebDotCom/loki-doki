// TikTok provider: yt-dlp does all extraction (no official API). Creator profiles come
// from flat-playlist dumps; individual videos from -J on the canonical URL. Trending is
// deliberately not offered (scrape-based and flaky), so the TikTok area is a
// followed-creators feed plus paste-a-link. Playback pipes a live yt-dlp subprocess
// (see getPlayback) rather than proxying a resolved CDN URL: TikTok's CDN 403s a bare
// server-side fetch even given yt-dlp's own exact headers, but yt-dlp's process itself
// gets through. Cookies (the shared yt-dlp cookies.txt admins can upload) improve reliability.

import { cachedLookup, cachedLookupStale } from '@/lib/lookupCache'
import { ytDlpJson } from '@/lib/videos/ytdlpJson'
import { ensureSmartTitle, heuristicTitle, isSmartTitlesEnabled } from '@/lib/videos/smartTitle'
import type { VideoProvider } from '@/lib/videos/provider'
import type { Pager, Playlist, VideoItem } from '@/lib/videos/types'

const compact = (n: number) => Intl.NumberFormat('en', { notation: 'compact' }).format(n)

const ITEM_TTL = 10 * 60_000       // full -J extraction is slow; cache aggressively
// Cold profile extraction takes 5-15s, so this is kept warm by feed.ts's background
// poller (every 15 min) rather than ever running inline on a request path. TTL must
// outlive that cadence with margin, or a slow/skipped poll tick leaves a request-path
// caller (a direct creator-profile visit) staring at an expired row and paying the full
// yt-dlp cold start synchronously — which is exactly what made the hub home 30-60s slow
// before the poller warmed every browse group + known creator profile (see feed.ts).
const PROFILE_TTL = 20 * 60_000

const VIDEO_ID = /^\d{15,21}$/
const HANDLE = /^@?[A-Za-z0-9_.]{2,24}$/
// Prefer h264 (plays everywhere); used by downloadSpec (yt-dlp -f) only — playback is an embed.
const H264_FORMAT_SELECTOR = 'bv*[vcodec^=h264]+ba/b[vcodec^=h264]/bv*+ba/b'
// TikTok's official embed player. Playback is this iframe, not a server-proxied stream:
// TikTok's CDN 403s any bare server fetch of the video bytes (TLS/HTTP2 fingerprinting),
// so the old path had to pipe a live yt-dlp subprocess — slow to first byte and paying
// yt-dlp's cold start. The embed loads in ~0.1s and lets the browser satisfy the CDN.
const PLAYER_BASE = 'https://www.tiktok.com/player/v1'

interface TikTokEntry {
  id?: string
  title?: string
  description?: string
  uploader?: string
  uploader_id?: string
  channel?: string
  duration?: number
  thumbnail?: string
  thumbnails?: Array<{ url?: string }>
  timestamp?: number
  view_count?: number
  width?: number
  height?: number
  webpage_url?: string
  url?: string
}

function canonicalUrl(id: string, uploader?: string | null): string {
  // TikTok redirects to the right owner for any handle, so a placeholder works when we
  // only know the numeric id (e.g. a pasted short link the clipper resolved earlier).
  return `https://www.tiktok.com/@${uploader?.replace(/^@/, '') || 'tiktok'}/video/${id}`
}

// TikTok's own "title" is the caption (see fetchItem's comment) — heuristicTitle keeps grid
// cards from rendering a multi-sentence caption as if it were a title. warmSmartTitles (below)
// fills in a real AI title for these in the background; this is just the instant baseline.
function toItem(e: TikTokEntry): VideoItem | null {
  if (!e.id) return null
  // Full -J extraction puts the numeric account id in uploader_id and the @handle in
  // uploader; flat playlist entries only carry uploader. Prefer the human handle.
  const uploader = e.uploader ?? e.channel ?? e.uploader_id ?? null
  const caption = (e.title ?? e.description)?.trim() || null
  return {
    source: 'tiktok',
    id: e.id,
    url: e.webpage_url ?? canonicalUrl(e.id, uploader),
    title: caption ? heuristicTitle(caption) : 'TikTok video',
    creator: uploader ? { id: uploader.replace(/^@/, ''), name: `@${uploader.replace(/^@/, '')}` } : null,
    thumbnailUrl: e.thumbnail ?? e.thumbnails?.at(-1)?.url ?? null,
    durationSec: e.duration ?? null,
    publishedAt: e.timestamp ? e.timestamp * 1000 : null,
    viewsText: typeof e.view_count === 'number' ? `${compact(e.view_count)} views` : null,
    vertical: !e.width || !e.height ? true : e.height >= e.width,
    meta: { uploader },
  }
}

// Background-only Smart Title generation for a batch of grid entries (browse/creator/feed
// extraction) — same "never on the request path" rule as warmCreator/warmAvatar below, since
// this pays an LLM call per never-seen-before video. Small batches so a burst of new uploads
// doesn't pile a big concurrent request-fan-out onto the local Ollama instance; each call is
// itself 30-day cached, so re-warming already-covered creators costs cheap DB reads only.
const SMART_TITLE_WARM_BATCH = 4
function warmSmartTitles(entries: TikTokEntry[]): void {
  const todo = entries
    .map((e) => (e.id ? { id: e.id, caption: (e.title ?? e.description)?.trim() || null, author: e.uploader ?? e.channel ?? null } : null))
    .filter((e): e is { id: string; caption: string; author: string | null } => !!e?.caption)
  if (todo.length === 0) return
  void (async () => {
    for (let i = 0; i < todo.length; i += SMART_TITLE_WARM_BATCH) {
      const batch = todo.slice(i, i + SMART_TITLE_WARM_BATCH)
      await Promise.all(batch.map((e) => ensureSmartTitle('tiktok', e.id, e.caption, e.author).catch(() => null)))
    }
  })()
}

interface TikTokOembed {
  title?: string
  author_name?: string
  author_url?: string
  thumbnail_url?: string
  thumbnail_width?: number
  thumbnail_height?: number
}

function handleFromAuthorUrl(url?: string): string | null {
  const m = url ? /@([A-Za-z0-9_.]+)/.exec(url) : null
  return m ? m[1]! : null
}

// Watch-page metadata via TikTok's oEmbed endpoint: one ~300ms fetch (title, author,
// thumbnail), no yt-dlp. The full yt-dlp -J extraction (which also carries duration/views)
// is reserved for downloads — the watch page renders fine without those, and dropping the
// per-click subprocess is what makes opening a TikTok instant instead of ~10s+.
//
// TikTok has no separate title field — oEmbed's "title" IS the caption, usually written as a
// hook/question aimed at engagement rather than a description of what the video shows (see
// live example: "Is this the cutest mealtime you've ever seen? These meerkat pups..."). So the
// raw caption becomes `description` here, and `title` is only ever the instant heuristic
// fallback (first sentence / truncation) — the real Smart Title is stamped on afterward in
// getItem(), per-request, using the caller's userId (see smartTitle.ts). Keeping AI title
// resolution OUT of this cachedLookup entry matters: this entry is shared by every caller
// regardless of who's asking, but Smart Titles is a per-user preference — baking a generated
// title into the shared 10-minute oEmbed cache would leak one user's setting onto everyone
// else's requests until the entry expired.
async function fetchItem(id: string): Promise<(VideoItem & { description?: string | null }) | null> {
  if (!VIDEO_ID.test(id)) return null
  return cachedLookup('tiktok:item', id, ITEM_TTL, async () => {
    const res = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(canonicalUrl(id))}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const o = await res.json() as TikTokOembed
    const handle = handleFromAuthorUrl(o.author_url)
    const caption = o.title?.trim() || null
    return {
      source: 'tiktok' as const,
      id,
      url: canonicalUrl(id, handle),
      title: caption ? heuristicTitle(caption) : 'TikTok video',
      // oEmbed's author_name is the real display name ("National Geographic"), not the
      // @handle — prefer it so the watch page matches the browse cards' stamped nickname.
      creator: handle ? { id: handle, name: o.author_name || `@${handle}` } : o.author_name ? { id: '', name: o.author_name } : null,
      thumbnailUrl: o.thumbnail_url ?? null,
      durationSec: null,
      publishedAt: null,
      // Portrait unless the thumbnail says otherwise (TikTok is vertical by default).
      vertical: !o.thumbnail_width || !o.thumbnail_height ? true : o.thumbnail_height >= o.thumbnail_width,
      description: caption,
    }
  })
}

// Zero-setup browse surface: TikTok's trending page is scrape-hostile, but profile
// extraction is reliable, so "browse" is a rotating pull from broadly popular creators.
// Follows personalize it; this makes the source alive out of the box.
const STARTER_CREATORS = ['khaby.lame', 'zachking', 'mrbeast', 'gordonramsayofficial', 'natgeo', 'nasa', 'dude.perfect', 'jamieoliver']
const CREATOR_GROUPS: Record<string, { label: string; creators: string[] }> = {
  popular: { label: 'Popular', creators: STARTER_CREATORS },
  comedy: { label: 'Comedy', creators: ['khaby.lame', 'zachking', 'brittany_broski'] },
  food: { label: 'Food', creators: ['gordonramsayofficial', 'jamieoliver', 'cookingwithlynja'] },
  science: { label: 'Science & Space', creators: ['nasa', 'natgeo', 'hankgreen1'] },
  sports: { label: 'Sports', creators: ['dude.perfect', 'espn', 'f1'] },
}

// LIVE extraction (background yt-dlp priority) — writes the tiktok:browse cache. Runs ONLY
// off the request path: the feed.ts poller and the on-miss/stale background warmer below.
// The managed yt-dlp is a PyInstaller onefile that cold-unpacks on every call (~10s each on
// macOS), so 8 of these inline is exactly what made browse hang; keeping them off the
// request path entirely is the point.
async function extractCreatorRecent(handle: string, count: number): Promise<VideoItem[]> {
  const items = await cachedLookup('tiktok:browse', `${handle}:${count}`, PROFILE_TTL, async () => {
    const data = await ytDlpJson<{ entries?: TikTokEntry[] }>(
      `https://www.tiktok.com/@${handle}`, ['--flat-playlist', '-I', `1:${count}`], { background: true })
    warmSmartTitles(data.entries ?? [])
    return (data.entries ?? []).map(toItem).filter((x): x is VideoItem => x !== null)
      .map((it) => ({ ...it, creator: it.creator ?? { id: handle, name: `@${handle}` } }))
  })
  // Avatar/name have their own cache (the browse cache stays avatar-free so each refreshes on its own).
  const profile = await extractCreatorProfile(handle).catch(() => null)
  return withCreatorInfo(items, handle, profile)
}

// One in-flight background warm per creator, so a burst of concurrent home loads that all
// miss the same creator only spawns one yt-dlp.
const warming = new Set<string>()
function warmCreator(handle: string, count: number): void {
  const k = `${handle}:${count}`
  if (warming.has(k)) return
  warming.add(k)
  void extractCreatorRecent(handle, count).catch(() => {}).finally(() => warming.delete(k))
}

// REQUEST path: stale-while-revalidate, never spawns yt-dlp inline. Serves the last-known
// uploads instantly (even if the 20-min TTL lapsed) and kicks a background refresh when
// stale; a creator we've never warmed returns empty and schedules its first warm. This is
// why the hub home and the TikTok source page are instant instead of blocking on ~10s
// extractions — and why TikTok still shows content once it's been warmed even once.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

interface TikTokProfile {
  avatarUrl: string | null
  nickname: string | null
  signature: string | null
  /** Opaque id TikTok's own web API (playlists) keys on; not exposed by yt-dlp or oEmbed. */
  secUid: string | null
  followerCount: number | null
  followingCount: number | null
  heartCount: number | null
  videoCount: number | null
}

// TikTok exposes none of nickname/bio/follower-following-like counts/secUid via yt-dlp or
// oEmbed, but the profile page's SSR payload (a JSON <script> tag) carries all of it in one
// shot — same page fetch the old avatar-only scrape used, just parsed properly instead of a
// regex pull for one field. Cached hard (24h): profile meta rarely changes and this backs
// both the creator page header and the playlists tab (via secUid).
const PROFILE_META_TTL = 24 * 60 * 60_000
async function extractCreatorProfile(handle: string): Promise<TikTokProfile | null> {
  return cachedLookup('tiktok:profile-meta', handle, PROFILE_META_TTL, async () => {
    try {
      const res = await fetch(`https://www.tiktok.com/@${handle}`, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(10_000) })
      if (!res.ok) return null
      const html = await res.text()
      const m = /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)<\/script>/s.exec(html)
      if (!m) return null
      const data = JSON.parse(m[1]!) as {
        __DEFAULT_SCOPE__?: {
          'webapp.user-detail'?: {
            userInfo?: {
              user?: { nickname?: string; signature?: string; avatarLarger?: string; secUid?: string }
              stats?: { followerCount?: number; followingCount?: number; heart?: number; heartCount?: number; videoCount?: number }
            }
          }
        }
      }
      const ui = data.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo
      if (!ui) return null
      const u = ui.user ?? {}
      const s = ui.stats ?? {}
      return {
        avatarUrl: u.avatarLarger ?? null,
        nickname: u.nickname || null,
        signature: u.signature || null,
        secUid: u.secUid ?? null,
        followerCount: s.followerCount ?? null,
        followingCount: s.followingCount ?? null,
        heartCount: s.heartCount ?? s.heart ?? null,
        videoCount: s.videoCount ?? null,
      }
    } catch { return null }
  })
}
const profileWarming = new Set<string>()
function warmAvatar(handle: string): void {
  if (profileWarming.has(handle)) return
  profileWarming.add(handle)
  void extractCreatorProfile(handle).catch(() => {}).finally(() => profileWarming.delete(handle))
}
/** Stamp the creator's display name + avatar onto each item — yt-dlp's flat-playlist dump
 *  (toItem) only ever has the @handle, never the real name ("National Geographic" vs
 *  "@natgeo"), so cards default to it until the separately-fetched profile lands here. */
function withCreatorInfo(items: VideoItem[], handle: string, profile: TikTokProfile | null): VideoItem[] {
  const name = profile?.nickname || `@${handle}`
  const avatarUrl = profile?.avatarUrl ?? null
  return items.map((it) => ({ ...it, creator: { id: handle, ...it.creator, name, avatarUrl: avatarUrl ?? it.creator?.avatarUrl ?? null } }))
}

async function creatorRecentCached(handle: string, count: number): Promise<VideoItem[]> {
  const [cached, profile] = await Promise.all([
    cachedLookupStale<VideoItem[]>('tiktok:browse', `${handle}:${count}`),
    cachedLookupStale<TikTokProfile | null>('tiktok:profile-meta', handle),
  ])
  if (!profile.fresh) warmAvatar(handle)   // refresh the profile meta in the background
  if (cached.value !== undefined) {
    if (!cached.fresh) warmCreator(handle, count)
    return withCreatorInfo(cached.value, handle, profile.value ?? null)
  }
  warmCreator(handle, count)
  return []
}

// ── Playlists tab: TikTok's own web API (yt-dlp has no playlist support). Public profiles
// need no auth for these; secUid (from the profile scrape above) is the only key required. ──
const PLAYLISTS_TTL = 20 * 60_000

async function tiktokApiJson<T>(path: string): Promise<T> {
  const res = await fetch(`https://www.tiktok.com${path}`, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`tiktok api ${res.status}`)
  return res.json() as Promise<T>
}

interface TikTokPlaylistEntry {
  id?: string
  mixId?: string
  name?: string
  mixName?: string
  cover?: string
  videoCount?: number
}

async function fetchCreatorPlaylists(handle: string, cursor: string): Promise<Pager<Playlist>> {
  return cachedLookup('tiktok:playlists', `${handle}:${cursor}`, PLAYLISTS_TTL, async () => {
    const profile = await extractCreatorProfile(handle)
    if (!profile?.secUid) return { items: [], cursor: null }
    const data = await tiktokApiJson<{ playList?: TikTokPlaylistEntry[]; hasMore?: boolean; cursor?: string }>(
      `/api/user/playlist/?aid=1988&secUid=${encodeURIComponent(profile.secUid)}&count=20&cursor=${cursor}`)
    const items = (data.playList ?? []).map((p): Playlist | null => {
      const id = p.mixId ?? p.id
      return id ? { id, title: p.name || p.mixName || 'Playlist', thumbnailUrl: p.cover ?? null, videoCount: p.videoCount ?? null } : null
    }).filter((x): x is Playlist => x !== null)
    return { items, cursor: data.hasMore ? (data.cursor ?? null) : null }
  })
}

interface TikTokMixItem {
  id?: string
  desc?: string
  createTime?: number
  author?: { uniqueId?: string; nickname?: string; avatarLarger?: string }
  video?: { cover?: string; duration?: number; width?: number; height?: number }
  stats?: { playCount?: number }
}

async function fetchPlaylistItems(playlistId: string, cursor: string): Promise<Pager<VideoItem>> {
  return cachedLookup('tiktok:mix-items', `${playlistId}:${cursor}`, PLAYLISTS_TTL, async () => {
    const data = await tiktokApiJson<{ itemList?: TikTokMixItem[]; hasMore?: boolean; cursor?: string }>(
      `/api/mix/item_list/?aid=1988&mixId=${encodeURIComponent(playlistId)}&cursor=${cursor}&count=20`)
    const items = (data.itemList ?? []).map((it): VideoItem | null => {
      if (!it.id) return null
      const handle = it.author?.uniqueId
      const v = it.video ?? {}
      return {
        source: 'tiktok',
        id: it.id,
        url: canonicalUrl(it.id, handle),
        title: it.desc || 'TikTok video',
        creator: handle ? { id: handle, name: it.author?.nickname || `@${handle}`, avatarUrl: it.author?.avatarLarger ?? null } : null,
        thumbnailUrl: v.cover ?? null,
        durationSec: v.duration ?? null,
        publishedAt: it.createTime ? it.createTime * 1000 : null,
        viewsText: typeof it.stats?.playCount === 'number' ? `${compact(it.stats.playCount)} views` : null,
        vertical: !v.width || !v.height ? true : v.height >= v.width,
      }
    }).filter((x): x is VideoItem => x !== null)
    return { items, cursor: data.hasMore ? (data.cursor ?? null) : null }
  })
}

export const tiktokProvider: VideoProvider = {
  source: 'tiktok',
  label: 'TikTok',
  capabilities: {
    browse: true,
    search: false,
    creators: true,
    comments: false,
    live: false,
    downloadKinds: ['audio', 'video'],
    authConfig: 'cookies',
    playlists: true,
    transcript: false,   // TikTok videos carry no fetchable captions/subtitles
  },
  // Only "popular" (a curated pull from broadly-popular creators); TikTok has no public
  // trending API. feed='popular' already maps to the CREATOR_GROUPS popular set.
  discovery: ['popular'],
  browseFeeds: Object.entries(CREATOR_GROUPS).map(([id, g]) => ({ id, label: g.label })),

  async browse({ feed, cursor, warm }) {
    if (cursor) return { items: [], cursor: null }   // single page; profiles rotate via cache TTL
    const group = (feed && CREATOR_GROUPS[feed]) ? CREATOR_GROUPS[feed]! : CREATOR_GROUPS['popular']!
    // Poller passes warm → live extraction to (re)populate the cache. Request paths (home,
    // category chips) read cache-only + stale, so they never block on yt-dlp.
    const feeds = await Promise.all(group.creators.map((h) =>
      (warm ? extractCreatorRecent(h, 5) : creatorRecentCached(h, 5)).catch(() => [] as VideoItem[])))
    const items: VideoItem[] = []
    for (let i = 0; feeds.some((f) => i < f.length); i++) {
      for (const feed of feeds) if (feed[i]) items.push(feed[i]!)
    }
    return { items, cursor: null }
  },

  matchUrl(url) {
    const host = url.hostname.replace(/^www\.|^m\./, '')
    if (host !== 'tiktok.com') return null   // vm.tiktok.com short links fall to the clipper
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[0]?.startsWith('@') && parts[1] === 'video' && parts[2] && VIDEO_ID.test(parts[2])) {
      return { kind: 'video', id: parts[2] }
    }
    if (parts[0] === 'v' && parts[1] && VIDEO_ID.test(parts[1].replace(/\.html$/, ''))) {
      return { kind: 'video', id: parts[1].replace(/\.html$/, '') }
    }
    if (parts.length === 1 && parts[0]!.startsWith('@') && HANDLE.test(parts[0]!)) {
      return { kind: 'creator', id: parts[0]!.slice(1) }
    }
    return null
  },

  async getCreator(id, cursor, opts) {
    const handle = id.replace(/^@/, '')
    if (!HANDLE.test(handle)) throw new Error('invalid TikTok handle')
    // Cursor = index window into the profile's flat playlist (30 per page). Served from the
    // profile cache instantly on repeat visits; a first visit extracts once (bounded by
    // ytDlpJson's timeout). The poller passes warm → background priority so pre-warming
    // never contends with a foreground resolve; a direct visit runs interactive.
    const start = cursor ? Math.max(1, parseInt(cursor, 10) || 1) : 1
    const end = start + 29
    const data = await cachedLookup('tiktok:profile', `${handle}:${start}`, PROFILE_TTL, async () => {
      const d = await ytDlpJson<{ entries?: TikTokEntry[]; uploader?: string; channel?: string; title?: string; thumbnails?: Array<{ url?: string }> }>(
        `https://www.tiktok.com/@${handle}`, ['--flat-playlist', '-I', `${start}:${end}`], { background: opts?.warm })
      warmSmartTitles(d.entries ?? [])
      return d
    })
    const profile = await extractCreatorProfile(handle).catch(() => null)
    const entries = withCreatorInfo(
      (data.entries ?? []).map(toItem).filter((x): x is VideoItem => x !== null)
        .map((it) => ({ ...it, creator: it.creator ?? { id: handle, name: `@${handle}` } })),
      handle, profile)
    return {
      creator: {
        source: 'tiktok',
        kind: 'user',
        id: handle,
        name: profile?.nickname || `@${handle}`,
        handle: `@${handle}`,
        avatarUrl: profile?.avatarUrl ?? data.thumbnails?.at(-1)?.url ?? null,
        description: profile?.signature ?? null,
        subscriberText: profile?.followerCount != null ? `${compact(profile.followerCount)} followers` : null,
        followingText: profile?.followingCount != null ? `${compact(profile.followingCount)} following` : null,
        likesText: profile?.heartCount != null ? `${compact(profile.heartCount)} likes` : null,
        videoCount: profile?.videoCount != null ? `${compact(profile.videoCount)} videos` : null,
      },
      videos: { items: entries, cursor: entries.length === 30 ? String(end + 1) : null },
    }
  },

  async getCreatorPlaylists(id, cursor) {
    const handle = id.replace(/^@/, '')
    if (!HANDLE.test(handle)) throw new Error('invalid TikTok handle')
    return fetchCreatorPlaylists(handle, cursor || '0')
  },

  async getPlaylistItems(id, cursor) {
    return fetchPlaylistItems(id, cursor || '0')
  },

  async getItem(id, userId) {
    const item = await fetchItem(id)
    if (!item) return item

    // Stamp the avatar outside fetchItem's cache entry (oEmbed never carries one) so the
    // watch page's creator header matches the browse cards. Awaited, not stale-read: this
    // is one item, the profile cache is 24h (usually warm from browse), and a rare ~1s
    // profile fetch on a cold creator beats an avatar that only appears on reload.
    const profile = item.creator?.id ? await extractCreatorProfile(item.creator.id).catch(() => null) : null
    const creator = profile && item.creator
      ? { ...item.creator, name: profile.nickname || item.creator.name, avatarUrl: profile.avatarUrl ?? item.creator.avatarUrl }
      : item.creator

    // Smart Title stamp — kept out of fetchItem's shared cache (see comment there); this
    // is per-request because Smart Titles is a per-user preference. No userId (unauthenticated
    // warm passes) just keeps the heuristic title already on `item`. Checking the preference
    // here (rather than leaving it to ensureSmartTitle) means a viewer with the toggle off
    // never pays for a generation their own request wouldn't get to see anyway.
    const smartTitle = userId && item.description && await isSmartTitlesEnabled(userId)
      ? await ensureSmartTitle('tiktok', id, item.description, creator?.name ?? null)
      : null

    return { ...item, creator, title: smartTitle || item.title }
  },

  async getPlayback(id) {
    if (!VIDEO_ID.test(id)) throw new Error('video not found')
    // Play via TikTok's official embed player (an <iframe>). The browser satisfies TikTok's
    // CDN auth/fingerprinting that 403s any server-side byte fetch — the reason the old path
    // piped a live yt-dlp subprocess (slow first byte + yt-dlp cold start). No yt-dlp here;
    // it now runs only for downloads (downloadSpec).
    // controls=0 hides TikTok's native chrome (play/pause/volume/fullscreen) the same way
    // Vimeo's does; the frontend drives its own minimal controls over TikTok's postMessage
    // embed-player API instead (see frontend/src/lib/tiktok/api.ts).
    return { mode: 'embed', embedUrl: `${PLAYER_BASE}/${id}?autoplay=1&controls=0&music_info=0&description=0&rel=0` }
  },

  async fetchCreatorFeed(externalId) {
    const handle = externalId.replace(/^@/, '')
    if (!HANDLE.test(handle)) return []
    const data = await ytDlpJson<{ entries?: TikTokEntry[] }>(
      `https://www.tiktok.com/@${handle}`, ['--flat-playlist', '-I', '1:10'], { background: true })
    warmSmartTitles(data.entries ?? [])
    const items = (data.entries ?? []).map(toItem).filter((x): x is VideoItem => x !== null)
      .map((it) => ({ ...it, creator: it.creator ?? { id: handle, name: `@${handle}` } }))
    const profile = await extractCreatorProfile(handle).catch(() => null)
    return withCreatorInfo(items, handle, profile)
  },

  async downloadSpec(id, kind) {
    // Downloads still go through yt-dlp (the only reliable way past TikTok's CDN). oEmbed
    // gives the owner handle for a proper canonical URL; the placeholder URL also works
    // (TikTok redirects) so a failed metadata fetch never blocks a download.
    const item = await fetchItem(id).catch(() => null)
    return {
      method: 'ytdlp',
      url: item?.url ?? canonicalUrl(id),
      ytdlpArgs: kind === 'video' ? ['-f', H264_FORMAT_SELECTOR] : [],
    }
  },
}

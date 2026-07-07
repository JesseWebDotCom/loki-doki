// TikTok provider: yt-dlp does all extraction (no official API). Creator profiles come
// from flat-playlist dumps; individual videos from -J on the canonical URL. Trending is
// deliberately not offered (scrape-based and flaky), so the TikTok area is a
// followed-creators feed plus paste-a-link. Playback pipes a live yt-dlp subprocess
// (see getPlayback) rather than proxying a resolved CDN URL: TikTok's CDN 403s a bare
// server-side fetch even given yt-dlp's own exact headers, but yt-dlp's process itself
// gets through. Cookies (the shared yt-dlp cookies.txt admins can upload) improve reliability.

import { cachedLookup, cachedLookupStale } from '@/lib/lookupCache'
import { ytDlpJson } from '@/lib/videos/ytdlpJson'
import type { VideoProvider } from '@/lib/videos/provider'
import type { VideoItem } from '@/lib/videos/types'

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

function toItem(e: TikTokEntry): VideoItem | null {
  if (!e.id) return null
  // Full -J extraction puts the numeric account id in uploader_id and the @handle in
  // uploader; flat playlist entries only carry uploader. Prefer the human handle.
  const uploader = e.uploader ?? e.channel ?? e.uploader_id ?? null
  return {
    source: 'tiktok',
    id: e.id,
    url: e.webpage_url ?? canonicalUrl(e.id, uploader),
    title: e.title ?? e.description ?? 'TikTok video',
    creator: uploader ? { id: uploader.replace(/^@/, ''), name: `@${uploader.replace(/^@/, '')}` } : null,
    thumbnailUrl: e.thumbnail ?? e.thumbnails?.at(-1)?.url ?? null,
    durationSec: e.duration ?? null,
    publishedAt: e.timestamp ? e.timestamp * 1000 : null,
    viewsText: typeof e.view_count === 'number'
      ? `${Intl.NumberFormat('en', { notation: 'compact' }).format(e.view_count)} views` : null,
    vertical: !e.width || !e.height ? true : e.height >= e.width,
    meta: { uploader },
  }
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
    return {
      source: 'tiktok' as const,
      id,
      url: canonicalUrl(id, handle),
      title: o.title || 'TikTok video',
      creator: handle ? { id: handle, name: `@${handle}` } : o.author_name ? { id: '', name: o.author_name } : null,
      thumbnailUrl: o.thumbnail_url ?? null,
      durationSec: null,
      publishedAt: null,
      // Portrait unless the thumbnail says otherwise (TikTok is vertical by default).
      vertical: !o.thumbnail_width || !o.thumbnail_height ? true : o.thumbnail_height >= o.thumbnail_width,
      description: null,
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
  return cachedLookup('tiktok:browse', `${handle}:${count}`, PROFILE_TTL, async () => {
    const data = await ytDlpJson<{ entries?: TikTokEntry[] }>(
      `https://www.tiktok.com/@${handle}`, ['--flat-playlist', '-I', `1:${count}`], { background: true })
    return (data.entries ?? []).map(toItem).filter((x): x is VideoItem => x !== null)
      .map((it) => ({ ...it, creator: it.creator ?? { id: handle, name: `@${handle}` } }))
  })
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
async function creatorRecentCached(handle: string, count: number): Promise<VideoItem[]> {
  const cached = await cachedLookupStale<VideoItem[]>('tiktok:browse', `${handle}:${count}`)
  if (cached.value !== undefined) {
    if (!cached.fresh) warmCreator(handle, count)
    return cached.value
  }
  warmCreator(handle, count)
  return []
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
    const data = await cachedLookup('tiktok:profile', `${handle}:${start}`, PROFILE_TTL, () =>
      ytDlpJson<{ entries?: TikTokEntry[]; uploader?: string; channel?: string; title?: string; thumbnails?: Array<{ url?: string }> }>(
        `https://www.tiktok.com/@${handle}`, ['--flat-playlist', '-I', `${start}:${end}`], { background: opts?.warm }))
    const entries = (data.entries ?? []).map(toItem).filter((x): x is VideoItem => x !== null)
      .map((it) => ({ ...it, creator: it.creator ?? { id: handle, name: `@${handle}` } }))
    return {
      creator: {
        source: 'tiktok',
        kind: 'user',
        id: handle,
        name: `@${handle}`,
        handle: `@${handle}`,
        avatarUrl: data.thumbnails?.at(-1)?.url ?? null,
        description: null,
      },
      videos: { items: entries, cursor: entries.length === 30 ? String(end + 1) : null },
    }
  },

  async getItem(id) {
    return fetchItem(id)
  },

  async getPlayback(id) {
    if (!VIDEO_ID.test(id)) throw new Error('video not found')
    // Play via TikTok's official embed player (an <iframe>). The browser satisfies TikTok's
    // CDN auth/fingerprinting that 403s any server-side byte fetch — the reason the old path
    // piped a live yt-dlp subprocess (slow first byte + yt-dlp cold start). No yt-dlp here;
    // it now runs only for downloads (downloadSpec).
    return { mode: 'embed', embedUrl: `${PLAYER_BASE}/${id}?autoplay=1&controls=1&music_info=0&description=0&rel=0` }
  },

  async fetchCreatorFeed(externalId) {
    const handle = externalId.replace(/^@/, '')
    if (!HANDLE.test(handle)) return []
    const data = await ytDlpJson<{ entries?: TikTokEntry[] }>(
      `https://www.tiktok.com/@${handle}`, ['--flat-playlist', '-I', '1:10'], { background: true })
    return (data.entries ?? []).map(toItem).filter((x): x is VideoItem => x !== null)
      .map((it) => ({ ...it, creator: it.creator ?? { id: handle, name: `@${handle}` } }))
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

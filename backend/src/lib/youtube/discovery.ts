// Discovery feed ("Popular / Trending") for the YouTube app's Home page.
//
// YouTube retired its anonymous Trending page: the `FEtrending` InnerTube browse now
// returns HTTP 400, and the logged-out home feed (`FEwhat_to_watch`) comes back empty.
// So there is no first-party keyless way to list "what's hot right now" anymore.
//
// Instead we aggregate from privacy front-ends that still expose a popular feed — the
// same thing Invidious shows at /feed/popular. We try a small pool of public Invidious
// instances (`/api/v1/popular`, the richest source), then fall back to Piped's
// `/trending`, then to a stale cache. Everything is best-effort and never throws; an
// empty list just means the Home page hides the shelf. Results are cached in-process so
// we hit the network at most once per TTL regardless of how many users load Home.

import { logger } from '@/lib/logger'
import { innertubeChannelAvatar, tryInnertube, type ItVideo } from './innertube'

// A browser-like UA is required — most Invidious instances serve a Cloudflare/bot
// challenge (HTML, not JSON) to non-browser agents.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'

// Public instances exposing /api/v1/popular. Tried in order; first JSON wins.
const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://yewtu.be',
  'https://invidious.privacyredirect.com',
  'https://invidious.jing.rocks',
]

// Piped fallback (region trending) — different shape, used only if Invidious is down.
const PIPED_INSTANCES = [
  'https://api.piped.private.coffee',
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
]

const TTL_MS = 30 * 60 * 1000 // 30 minutes
let popularCache: { at: number; videos: ItVideo[] } | null = null
let trendingCache: { at: number; videos: ItVideo[] } | null = null

const ytThumb = (videoId: string) => `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`

// Invidious /api/v1/popular item → ItVideo.
function invidiousToItVideo(v: any): ItVideo | null {
  const videoId = v?.videoId
  if (!videoId || typeof videoId !== 'string' || !v?.title) return null
  const len = typeof v?.lengthSeconds === 'number' ? v.lengthSeconds : 0
  const views = typeof v?.viewCount === 'number' ? `${v.viewCount.toLocaleString()} views` : null
  return {
    videoId,
    title: v.title,
    author: v.author ?? null,
    channelId: v.authorId ?? null,
    channelThumb: null,
    thumbnailUrl: ytThumb(videoId),
    durationSec: len > 0 ? len : null,
    publishedText: v.publishedText ?? null,
    views,
  }
}

// Piped /trending item → ItVideo.
function pipedToItVideo(v: any): ItVideo | null {
  const videoId = (v?.url ?? '').match(/[?&]v=([\w-]{11})/)?.[1]
  if (!videoId || !v?.title) return null
  const channelId = (v?.uploaderUrl ?? '').match(/channel\/([\w-]+)/)?.[1] ?? null
  const len = typeof v?.duration === 'number' ? v.duration : 0
  const views = typeof v?.views === 'number' ? `${v.views.toLocaleString()} views` : null
  return {
    videoId,
    title: v.title,
    author: v.uploaderName ?? null,
    channelId,
    channelThumb: typeof v.uploaderAvatar === 'string' ? v.uploaderAvatar : null,
    thumbnailUrl: ytThumb(videoId),
    durationSec: len > 0 ? len : null,
    publishedText: v.uploadedDate ?? null,
    views,
  }
}

// Channel avatars rarely change, so cache them indefinitely across popular refreshes.
// Invidious /popular omits channel thumbnails and its channel endpoint is bot-blocked,
// so we resolve them via InnerTube (reliable, direct URLs).
const avatarCache = new Map<string, string>()

/** Fill in missing channelThumb on any list of items (discovery videos, history rows…)
 *  via InnerTube, cached + time-boxed so a cold cache doesn't stall the response
 *  (unresolved ones fill in on the next load once the cache warms). Mutates in place. */
export async function enrichChannelThumbs<T extends { channelId: string | null; channelThumb: string | null }>(items: T[]): Promise<void> {
  const apply = () => { for (const v of items) if (!v.channelThumb && v.channelId) v.channelThumb = avatarCache.get(v.channelId) ?? null }
  apply()
  const todo = [...new Set(items.filter(v => !v.channelThumb && v.channelId).map(v => v.channelId!))]
  if (!todo.length) return

  const deadline = Date.now() + 4500
  let i = 0
  const worker = async () => {
    while (i < todo.length && Date.now() < deadline) {
      const id = todo[i++]!
      const url = await tryInnertube('channelAvatar', () => innertubeChannelAvatar(id), null)
      if (url) avatarCache.set(id, url)
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, todo.length) }, worker))
  apply()
}

async function fetchJson(url: string, timeout = 7000): Promise<any | null> {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeout),
    })
    if (!r.ok) return null
    if (!(r.headers.get('content-type') ?? '').includes('json')) return null // bot-challenge HTML
    return await r.json()
  } catch {
    return null
  }
}

async function invidiousPopular(): Promise<ItVideo[]> {
  for (const base of INVIDIOUS_INSTANCES) {
    const arr = await fetchJson(`${base}/api/v1/popular`)
    if (!Array.isArray(arr) || !arr.length) continue
    const videos = arr.map(invidiousToItVideo).filter((v): v is ItVideo => !!v)
    if (videos.length) return videos
  }
  return []
}

async function pipedTrending(): Promise<ItVideo[]> {
  for (const base of PIPED_INSTANCES) {
    const arr = await fetchJson(`${base}/trending?region=US`)
    if (!Array.isArray(arr) || !arr.length) continue
    const videos = arr.map(pipedToItVideo).filter((v): v is ItVideo => !!v)
    if (videos.length) return videos
  }
  return []
}

async function invidiousTrending(): Promise<ItVideo[]> {
  for (const base of INVIDIOUS_INSTANCES) {
    const arr = await fetchJson(`${base}/api/v1/trending?region=US`)
    if (!Array.isArray(arr) || !arr.length) continue
    const videos = arr.map(invidiousToItVideo).filter((v): v is ItVideo => !!v)
    if (videos.length) return videos
  }
  return []
}

/** "Popular right now" — the most-watched videos (Invidious /popular, ~150 items). The
 *  reliable discovery shelf. Best-effort, cached, never throws; falls back to trending
 *  sources, then a stale cache. */
export async function fetchPopular(limit = 40): Promise<ItVideo[]> {
  if (popularCache && Date.now() - popularCache.at < TTL_MS) return popularCache.videos.slice(0, limit)
  const videos = (await invidiousPopular()) || []
  const out = videos.length ? videos : await pipedTrending()
  if (out.length) {
    // Invidious /popular has no channel thumbnails — backfill the ones we'll show.
    // Mutates the shared objects, so the cache keeps the resolved avatars.
    await enrichChannelThumbs(out.slice(0, 48))
    popularCache = { at: Date.now(), videos: out }
    return out.slice(0, limit)
  }
  logger.warn('[youtube/discovery] popular sources unavailable')
  return popularCache?.videos.slice(0, limit) ?? []
}

/** "Trending" — YouTube's trending tab, sourced from Piped /trending (Invidious mostly
 *  disables it). Thinner and flakier than Popular, so callers should treat an empty list
 *  as "hide the shelf". Best-effort, cached, never throws. */
export async function fetchTrending(limit = 40): Promise<ItVideo[]> {
  if (trendingCache && Date.now() - trendingCache.at < TTL_MS) return trendingCache.videos.slice(0, limit)
  const videos = await pipedTrending()
  const out = videos.length ? videos : await invidiousTrending()
  if (out.length) { trendingCache = { at: Date.now(), videos: out }; return out.slice(0, limit) }
  return trendingCache?.videos.slice(0, limit) ?? []
}

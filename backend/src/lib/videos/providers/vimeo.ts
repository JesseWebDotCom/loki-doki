// Vimeo provider. With an admin API token (free at developer.vimeo.com/apps, personal
// access token with the public scope) the official API powers browse (Staff Picks),
// search, and channels. Without one it degrades honestly to resolve-only: pasted
// links still work via oEmbed metadata + yt-dlp playback, but there's no browsing.

import { cachedLookup } from '@/lib/lookupCache'
import { getAppSetting } from '@/lib/settings'
import type { VideoProvider } from '@/lib/videos/provider'
import type { Creator, Pager, VideoItem } from '@/lib/videos/types'

export const VIMEO_TOKEN_KEY = 'videos.vimeo_token'

const LIST_TTL = 5 * 60_000
const ITEM_TTL = 10 * 60_000

const VIDEO_ID = /^\d{6,12}$/
const CHANNEL_ID = /^[a-z0-9]+$/i

// Curated channels double as category chips; every slug verified to serve RSS.
const VIMEO_CHANNELS: Record<string, { label: string; slug: string }> = {
  staffpicks: { label: 'Staff Picks', slug: 'staffpicks' },
  animation: { label: 'Animation', slug: 'animation' },
  documentary: { label: 'Documentaries', slug: 'documentaryfilm' },
  comedy: { label: 'Comedy', slug: 'comedy' },
  music: { label: 'Music Videos', slug: 'musicvideos' },
  travel: { label: 'Travel', slug: 'travel' },
  experimental: { label: 'Experimental', slug: 'experimental' },
  sports: { label: 'Sports', slug: 'sports' },
  shorts: { label: 'Short Films', slug: 'shortfilms' },
}

export async function getVimeoToken(): Promise<string | null> {
  const v = await getAppSetting(VIMEO_TOKEN_KEY)
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

interface VimeoApiVideo {
  uri?: string
  name?: string
  description?: string
  duration?: number
  release_time?: string
  pictures?: { sizes?: Array<{ width?: number; link?: string }> }
  stats?: { plays?: number | null }
  user?: { uri?: string; name?: string; pictures?: { sizes?: Array<{ link?: string }> } }
  width?: number
  height?: number
}

async function vimeoApi<T>(path: string, ttl: number): Promise<T> {
  const token = await getVimeoToken()
  if (!token) throw new Error('Vimeo needs an API token to browse. Add one in Videos settings.')
  return cachedLookup('vimeo', path, ttl, async () => {
    const res = await fetch(`https://api.vimeo.com${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.vimeo.*+json;version=3.4',
      },
    })
    if (!res.ok) throw new Error(`vimeo ${res.status} for ${path}`)
    return res.json() as Promise<T>
  })
}

function apiToItem(v: VimeoApiVideo): VideoItem | null {
  const id = v.uri?.split('/').pop()
  if (!id || !VIDEO_ID.test(id)) return null
  const thumb = v.pictures?.sizes?.reduce<{ width: number; link: string } | null>((best, s) =>
    s.link && (s.width ?? 0) > (best?.width ?? 0) && (s.width ?? 0) <= 1280
      ? { width: s.width ?? 0, link: s.link } : best, null)
  return {
    source: 'vimeo',
    id,
    url: `https://vimeo.com/${id}`,
    title: v.name ?? 'Vimeo video',
    creator: v.user?.name ? {
      id: v.user.uri?.split('/').pop() ?? '',
      name: v.user.name,
      avatarUrl: v.user.pictures?.sizes?.at(-1)?.link ?? null,
    } : null,
    thumbnailUrl: thumb?.link ?? null,
    durationSec: v.duration ?? null,
    publishedAt: v.release_time ? Date.parse(v.release_time) : null,
    viewsText: typeof v.stats?.plays === 'number'
      ? `${Intl.NumberFormat('en', { notation: 'compact' }).format(v.stats.plays)} plays` : null,
    vertical: !!(v.width && v.height && v.height > v.width),
  }
}

function pageParams(cursor?: string | null): string {
  const page = cursor ? Math.max(1, parseInt(cursor, 10) || 1) : 1
  return `page=${page}&per_page=25`
}

function listToPager(data: { data?: VimeoApiVideo[]; paging?: { next?: string | null } }, cursor?: string | null): Pager<VideoItem> {
  const items = (data.data ?? []).map(apiToItem).filter((x): x is VideoItem => x !== null)
  const page = cursor ? parseInt(cursor, 10) || 1 : 1
  return { items, cursor: data.paging?.next ? String(page + 1) : null }
}

/** Keyless listings via Vimeo's native RSS (one ~300ms fetch: title, link with id,
 *  thumbnail, duration, pubDate) — far cheaper than yt-dlp + per-item oEmbed. */
async function vimeoRssItems(feedPath: string, ttl: number): Promise<VideoItem[]> {
  return cachedLookup('vimeo:rss', feedPath, ttl, async () => {
    const res = await fetch(`https://vimeo.com${feedPath}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`vimeo rss ${res.status} for ${feedPath}`)
    const xml = await res.text()
    const items: VideoItem[] = []
    for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const block = m[1]!
      const link = /<link>([^<]+)<\/link>/.exec(block)?.[1] ?? ''
      const id = link.split('/').pop() ?? ''
      if (!VIDEO_ID.test(id)) continue
      const title = /<title>([\s\S]*?)<\/title>/.exec(block)?.[1]?.trim() ?? 'Vimeo video'
      const thumb = /<media:thumbnail[^>]*url="([^"]+)"/.exec(block)?.[1] ?? null
      const duration = /<media:content[^>]*duration="(\d+)"/.exec(block)?.[1]
      const pub = /<pubDate>([^<]+)<\/pubDate>/.exec(block)?.[1]
      // Every RSS item carries the uploader in <media:credit role="author">; fall back to a
      // leading "by …" line in the description only if that's somehow absent.
      const credit = /<media:credit[^>]*>([^<]+)<\/media:credit>/.exec(block)?.[1]?.trim()
        || /<description>(?:\s*by\s+)([^.<]{2,60})/i.exec(block)?.[1]?.trim()
      items.push({
        source: 'vimeo',
        id,
        url: `https://vimeo.com/${id}`,
        title: title.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'"),
        creator: credit ? { id: '', name: credit.replace(/&amp;/g, '&') } : null,
        thumbnailUrl: thumb,
        durationSec: duration ? parseInt(duration, 10) : null,
        publishedAt: pub ? Date.parse(pub) : null,
      })
    }
    return items
  })
}

/** Keyless item metadata via oEmbed (title/author/thumbnail/duration). */
async function oembedItem(id: string): Promise<(VideoItem & { description?: string | null }) | null> {
  return cachedLookup('vimeo:oembed', id, ITEM_TTL, async () => {
    const res = await fetch(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(`https://vimeo.com/${id}`)}`)
    if (!res.ok) return null
    const o = await res.json() as { title?: string; author_name?: string; thumbnail_url?: string; duration?: number; width?: number; height?: number }
    return {
      source: 'vimeo' as const,
      id,
      url: `https://vimeo.com/${id}`,
      title: o.title ?? 'Vimeo video',
      creator: o.author_name ? { id: '', name: o.author_name } : null,
      thumbnailUrl: o.thumbnail_url ?? null,
      durationSec: o.duration ?? null,
      vertical: !!(o.width && o.height && o.height > o.width),
    }
  })
}

export const vimeoProvider: VideoProvider = {
  source: 'vimeo',
  label: 'Vimeo',
  capabilities: {
    browse: true,           // token-gated; status() drives the UI nudge
    search: true,
    creators: true,
    comments: false,
    live: false,
    downloadKinds: ['audio', 'video'],
    authConfig: 'apiKey',
  },
  // Only "popular" (Staff Picks); Vimeo exposes no trending ranking. browse() already
  // falls back to staffpicks for any feed id it doesn't recognize, incl. 'popular'.
  discovery: ['popular'],
  browseFeeds: Object.entries(VIMEO_CHANNELS).map(([id, ch]) => ({ id, label: ch.label })),

  async status() {
    // Staff Picks browse works keyless (yt-dlp + oEmbed); a token only adds search
    // and richer channel pages, so the source counts as configured either way.
    const hasToken = !!(await getVimeoToken())
    return hasToken
      ? { configured: true }
      : { configured: true, note: 'Optional: a free Vimeo API token (developer.vimeo.com/apps) adds search and channel browsing.' }
  },

  matchUrl(url) {
    const host = url.hostname.replace(/^www\.|^player\./, '')
    if (host !== 'vimeo.com') return null
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[0] === 'video' && parts[1] && VIDEO_ID.test(parts[1])) return { kind: 'video', id: parts[1] }
    if (parts[0] && VIDEO_ID.test(parts[0])) return { kind: 'video', id: parts[0] }
    if (parts[0] === 'channels' && parts[1] && CHANNEL_ID.test(parts[1])) return { kind: 'creator', id: parts[1] }
    return null
  },

  async browse({ feed, cursor }) {
    // Curated channels are the discovery surface (Staff Picks default). API pages
    // when a token exists; otherwise the channel's native RSS, keyless.
    const channel = (feed && VIMEO_CHANNELS[feed]) ? VIMEO_CHANNELS[feed]! : VIMEO_CHANNELS['staffpicks']!
    if (await getVimeoToken()) {
      const data = await vimeoApi<{ data?: VimeoApiVideo[]; paging?: { next?: string | null } }>(
        `/channels/${channel.slug}/videos?${pageParams(cursor)}&sort=added`, LIST_TTL)
      return listToPager(data, cursor)
    }
    if (cursor) return { items: [], cursor: null }   // keyless: single page
    return { items: await vimeoRssItems(`/channels/${channel.slug}/videos/rss`, LIST_TTL), cursor: null }
  },

  async search(q, { cursor }) {
    const data = await vimeoApi<{ data?: VimeoApiVideo[]; paging?: { next?: string | null } }>(
      `/videos?query=${encodeURIComponent(q)}&${pageParams(cursor)}`, LIST_TTL)
    return listToPager(data, cursor)
  },

  async getCreator(id, cursor) {
    if (!CHANNEL_ID.test(id)) throw new Error('invalid vimeo channel')
    const [info, listing] = await Promise.all([
      vimeoApi<{ name?: string; description?: string; pictures?: { sizes?: Array<{ link?: string }> }; header?: { sizes?: Array<{ link?: string }> }; metadata?: { connections?: { users?: { total?: number } } } }>(
        `/channels/${id}`, 60 * 60_000),
      vimeoApi<{ data?: VimeoApiVideo[]; paging?: { next?: string | null } }>(
        `/channels/${id}/videos?${pageParams(cursor)}`, LIST_TTL),
    ])
    const creator: Creator = {
      source: 'vimeo',
      kind: 'channel',
      id,
      name: info.name ?? id,
      avatarUrl: info.pictures?.sizes?.at(-1)?.link ?? null,
      bannerUrl: info.header?.sizes?.at(-1)?.link ?? null,
      description: info.description ?? null,
      subscriberText: info.metadata?.connections?.users?.total != null
        ? `${Intl.NumberFormat('en', { notation: 'compact' }).format(info.metadata.connections.users.total)} followers` : null,
    }
    return { creator, videos: listToPager(listing, cursor) }
  },

  async getItem(id) {
    if (!VIDEO_ID.test(id)) return null
    if (await getVimeoToken()) {
      const v = await vimeoApi<VimeoApiVideo>(`/videos/${id}`, ITEM_TTL).catch(() => null)
      const item = v && apiToItem(v)
      if (item) return { ...item, description: v!.description ?? null }
      // Token path failed (private/deleted, or a transient API error) — fall through to the
      // keyless metadata + minimal fallback below rather than 404ing a maybe-playable video.
    }
    // Keyless: oEmbed metadata (title/author/thumbnail/duration). oEmbed is IP-rate-limited
    // and can hard-block a whole network, which would 404 EVERY Vimeo video even though the
    // iframe player still works. So a metadata miss degrades to a minimal item (id is enough
    // for getPlayback's embed) instead of null — the watch page renders and plays, and Vimeo
    // itself shows an "unavailable" notice for the rare genuinely-dead video.
    return (await oembedItem(id).catch(() => null)) ?? {
      source: 'vimeo' as const,
      id,
      url: `https://vimeo.com/${id}`,
      title: 'Vimeo video',
      creator: null,
      thumbnailUrl: null,
      durationSec: null,
      description: null,
    }
  },

  async getPlayback(id) {
    if (!VIDEO_ID.test(id)) throw new Error('no playable stream for this video')
    // Play via Vimeo's official embed player (an <iframe>): instant, no yt-dlp. Replaces the
    // old yt-dlp -J resolve + progressive byte-proxy, which worked but paid yt-dlp's ~10s
    // cold start on every click. yt-dlp now runs only for downloads (downloadSpec).
    return { mode: 'embed', embedUrl: `https://player.vimeo.com/video/${id}?autoplay=1` }
  },

  async fetchCreatorFeed(externalId) {
    if (!CHANNEL_ID.test(externalId)) return []
    if (await getVimeoToken()) {
      const data = await vimeoApi<{ data?: VimeoApiVideo[] }>(
        `/channels/${externalId}/videos?page=1&per_page=10&sort=added`, LIST_TTL)
      return (data.data ?? []).map(apiToItem).filter((x): x is VideoItem => x !== null)
    }
    // Keyless: channel RSS gives the same listing shape.
    return vimeoRssItems(`/channels/${externalId}/videos/rss`, LIST_TTL).catch(() => [])
  },

  async downloadSpec(id) {
    return { method: 'ytdlp', url: `https://vimeo.com/${id}` }
  },
}

// TikTok provider: yt-dlp does all extraction (no official API). Creator profiles come
// from flat-playlist dumps; individual videos from -J on the canonical URL. Trending is
// deliberately not offered (scrape-based and flaky), so the TikTok area is a
// followed-creators feed plus paste-a-link. Playback goes through the hub's progressive
// stream proxy because TikTok's CDN URLs are signed, expire, and require a Referer.
// Cookies (the shared yt-dlp cookies.txt admins can upload) improve reliability.

import { cachedLookup } from '@/lib/lookupCache'
import { ytDlpJson } from '@/lib/videos/ytdlpJson'
import type { VideoProvider } from '@/lib/videos/provider'
import type { VideoItem } from '@/lib/videos/types'

const ITEM_TTL = 10 * 60_000       // full -J extraction is slow; cache aggressively
const PROFILE_TTL = 10 * 60_000    // cold profile extraction takes 5-15s
const STREAM_TTL = 25 * 60_000     // signed CDN URLs expire around the 30-min mark

const VIDEO_ID = /^\d{15,21}$/
const HANDLE = /^@?[A-Za-z0-9_.]{2,24}$/

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
  formats?: Array<{ url?: string; ext?: string; vcodec?: string; acodec?: string; protocol?: string; format_note?: string; height?: number; http_headers?: Record<string, string> }>
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

async function fetchItem(id: string): Promise<(VideoItem & { description?: string | null }) | null> {
  if (!VIDEO_ID.test(id)) return null
  return cachedLookup('tiktok:item', id, ITEM_TTL, async () => {
    const data = await ytDlpJson<TikTokEntry>(canonicalUrl(id), ['--no-playlist'])
    const item = toItem(data)
    return item ? { ...item, description: data.description ?? null } : null
  })
}

/** Best progressive stream URL + the headers TikTok's CDN insists on. Cached briefly;
 *  exported for the hub's generic stream proxy. */
export async function tiktokStreamSource(id: string): Promise<{ url: string; headers: Record<string, string> } | null> {
  if (!VIDEO_ID.test(id)) return null
  return cachedLookup('tiktok:stream', id, STREAM_TTL, async () => {
    const data = await ytDlpJson<TikTokEntry>(canonicalUrl(id), ['--no-playlist'])
    const formats = (data.formats ?? []).filter((f) =>
      f.url && f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' && (f.protocol ?? '').startsWith('http'))
    // Prefer h264 (plays everywhere) and the un-watermarked API formats yt-dlp surfaces.
    const pick = formats.find((f) => f.vcodec!.startsWith('h264') && !/watermark/i.test(f.format_note ?? ''))
      ?? formats.find((f) => !/watermark/i.test(f.format_note ?? ''))
      ?? formats.at(-1)
    if (!pick?.url) return null
    return {
      url: pick.url,
      headers: { Referer: 'https://www.tiktok.com/', ...(pick.http_headers ?? {}) },
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

async function creatorRecent(handle: string, count: number): Promise<VideoItem[]> {
  return cachedLookup('tiktok:browse', `${handle}:${count}`, PROFILE_TTL, async () => {
    const data = await ytDlpJson<{ entries?: TikTokEntry[] }>(
      `https://www.tiktok.com/@${handle}`, ['--flat-playlist', '-I', `1:${count}`])
    return (data.entries ?? []).map(toItem).filter((x): x is VideoItem => x !== null)
      .map((it) => ({ ...it, creator: it.creator ?? { id: handle, name: `@${handle}` } }))
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
  },
  browseFeeds: Object.entries(CREATOR_GROUPS).map(([id, g]) => ({ id, label: g.label })),

  async browse({ feed, cursor }) {
    if (cursor) return { items: [], cursor: null }   // single page; profiles rotate via cache TTL
    const group = (feed && CREATOR_GROUPS[feed]) ? CREATOR_GROUPS[feed]! : CREATOR_GROUPS['popular']!
    const feeds = await Promise.all(group.creators.map((h) => creatorRecent(h, 5).catch(() => [] as VideoItem[])))
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

  async getCreator(id, cursor) {
    const handle = id.replace(/^@/, '')
    if (!HANDLE.test(handle)) throw new Error('invalid TikTok handle')
    // Cursor = index window into the profile's flat playlist (30 per page).
    const start = cursor ? Math.max(1, parseInt(cursor, 10) || 1) : 1
    const end = start + 29
    const data = await cachedLookup('tiktok:profile', `${handle}:${start}`, PROFILE_TTL, () =>
      ytDlpJson<{ entries?: TikTokEntry[]; uploader?: string; channel?: string; title?: string; thumbnails?: Array<{ url?: string }> }>(
        `https://www.tiktok.com/@${handle}`, ['--flat-playlist', '-I', `${start}:${end}`]))
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
    const src = await tiktokStreamSource(id)
    if (!src) throw new Error('no playable stream for this video')
    return { mode: 'proxy-progressive', upstreamUrl: src.url, headers: src.headers }
  },

  async fetchCreatorFeed(externalId) {
    const handle = externalId.replace(/^@/, '')
    if (!HANDLE.test(handle)) return []
    const data = await ytDlpJson<{ entries?: TikTokEntry[] }>(
      `https://www.tiktok.com/@${handle}`, ['--flat-playlist', '-I', '1:10'])
    return (data.entries ?? []).map(toItem).filter((x): x is VideoItem => x !== null)
      .map((it) => ({ ...it, creator: it.creator ?? { id: handle, name: `@${handle}` } }))
  },

  async downloadSpec(id, kind) {
    const item = await fetchItem(id)
    if (!item) throw new Error('video not found')
    return {
      method: 'ytdlp',
      url: item.url,
      // Prefer h264 + the un-watermarked API rendition when TikTok offers one.
      ytdlpArgs: kind === 'video' ? ['-f', 'bv*[vcodec^=h264]+ba/b[vcodec^=h264]/bv*+ba/b'] : [],
    }
  },
}

// TikTok provider: yt-dlp does all extraction (no official API). Creator profiles come
// from flat-playlist dumps; individual videos from -J on the canonical URL. Trending is
// deliberately not offered (scrape-based and flaky), so the TikTok area is a
// followed-creators feed plus paste-a-link. Playback pipes a live yt-dlp subprocess
// (see getPlayback) rather than proxying a resolved CDN URL: TikTok's CDN 403s a bare
// server-side fetch even given yt-dlp's own exact headers, but yt-dlp's process itself
// gets through. Cookies (the shared yt-dlp cookies.txt admins can upload) improve reliability.

import { cachedLookup } from '@/lib/lookupCache'
import { ytDlpJson } from '@/lib/videos/ytdlpJson'
import type { VideoProvider } from '@/lib/videos/provider'
import type { VideoItem } from '@/lib/videos/types'

const ITEM_TTL = 10 * 60_000       // full -J extraction is slow; cache aggressively
const PROFILE_TTL = 10 * 60_000    // cold profile extraction takes 5-15s

const VIDEO_ID = /^\d{15,21}$/
const HANDLE = /^@?[A-Za-z0-9_.]{2,24}$/
// Prefer h264 (plays everywhere); shared by playback (yt-dlp -f) and downloadSpec.
const H264_FORMAT_SELECTOR = 'bv*[vcodec^=h264]+ba/b[vcodec^=h264]/bv*+ba/b'

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

async function fetchItem(id: string): Promise<(VideoItem & { description?: string | null }) | null> {
  if (!VIDEO_ID.test(id)) return null
  return cachedLookup('tiktok:item', id, ITEM_TTL, async () => {
    const data = await ytDlpJson<TikTokEntry>(canonicalUrl(id), ['--no-playlist'])
    const item = toItem(data)
    return item ? { ...item, description: data.description ?? null } : null
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
    const item = await fetchItem(id)
    if (!item) throw new Error('video not found')
    // TikTok's CDN 403s a bare server-side fetch even with yt-dlp's own exact headers
    // (verified: same headers, same URL, still 403 — almost certainly TLS/HTTP2
    // fingerprinting on their edge, not a header the client can fake). yt-dlp's own
    // process succeeds where a raw fetch doesn't, so the stream route pipes its stdout
    // live instead of proxying a resolved CDN URL.
    return { mode: 'ytdlp-pipe', pageUrl: item.url, formatSelector: H264_FORMAT_SELECTOR }
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
      ytdlpArgs: kind === 'video' ? ['-f', H264_FORMAT_SELECTOR] : [],
    }
  },
}

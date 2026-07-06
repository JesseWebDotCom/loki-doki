// Vimeo provider. With an admin API token (free at developer.vimeo.com/apps, personal
// access token with the public scope) the official API powers browse (Staff Picks),
// search, and channels. Without one it degrades honestly to resolve-only: pasted
// links still work via oEmbed metadata + yt-dlp playback, but there's no browsing.

import { cachedLookup } from '@/lib/lookupCache'
import { getAppSetting } from '@/lib/settings'
import { ytDlpJson } from '@/lib/videos/ytdlpJson'
import type { VideoProvider } from '@/lib/videos/provider'
import type { Creator, Pager, VideoItem } from '@/lib/videos/types'

export const VIMEO_TOKEN_KEY = 'videos.vimeo_token'

const LIST_TTL = 5 * 60_000
const ITEM_TTL = 10 * 60_000
const STREAM_TTL = 25 * 60_000

const VIDEO_ID = /^\d{6,12}$/
const CHANNEL_ID = /^[a-z0-9]+$/i

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

/** Progressive stream via yt-dlp (works with or without a token). Exported for the proxy. */
export async function vimeoStreamSource(id: string): Promise<{ url: string; headers: Record<string, string> } | null> {
  if (!VIDEO_ID.test(id)) return null
  return cachedLookup('vimeo:stream', id, STREAM_TTL, async () => {
    const data = await ytDlpJson<{ formats?: Array<{ url?: string; vcodec?: string; acodec?: string; protocol?: string; height?: number }> }>(
      `https://vimeo.com/${id}`, ['--no-playlist'])
    const progressive = (data.formats ?? []).filter((f) =>
      f.url && f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' && (f.protocol ?? '').startsWith('http'))
    const pick = progressive.sort((a, b) => (b.height ?? 0) - (a.height ?? 0))
      .find((f) => (f.height ?? 0) <= 1080) ?? progressive[0]
    if (!pick?.url) return null
    return { url: pick.url, headers: { Referer: 'https://vimeo.com/' } }
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

  async status() {
    const configured = !!(await getVimeoToken())
    return configured
      ? { configured }
      : { configured, note: 'Add a free Vimeo API token (developer.vimeo.com/apps) to enable browsing.' }
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

  async browse({ cursor }) {
    // Staff Picks is Vimeo's canonical discovery surface.
    const data = await vimeoApi<{ data?: VimeoApiVideo[]; paging?: { next?: string | null } }>(
      `/channels/staffpicks/videos?${pageParams(cursor)}&sort=added`, LIST_TTL)
    return listToPager(data, cursor)
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
      const v = await vimeoApi<VimeoApiVideo>(`/videos/${id}`, ITEM_TTL)
      const item = apiToItem(v)
      return item ? { ...item, description: v.description ?? null } : null
    }
    // Keyless: oEmbed metadata (title/author/thumbnail/duration), no API needed.
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
  },

  async getPlayback(id) {
    const src = await vimeoStreamSource(id)
    if (!src) throw new Error('no playable stream for this video')
    return { mode: 'proxy-progressive', upstreamUrl: src.url, headers: src.headers }
  },

  async fetchCreatorFeed(externalId) {
    if (!CHANNEL_ID.test(externalId)) return []
    const data = await vimeoApi<{ data?: VimeoApiVideo[] }>(
      `/channels/${externalId}/videos?page=1&per_page=10&sort=added`, LIST_TTL)
    return (data.data ?? []).map(apiToItem).filter((x): x is VideoItem => x !== null)
  },

  async downloadSpec(id) {
    return { method: 'ytdlp', url: `https://vimeo.com/${id}` }
  },
}

// InnerTube client — YouTube's internal `youtubei/v1` JSON API, the same surface the
// official web/mobile clients use. No API key from Google Cloud, no login. This is the
// stable replacement for HTML/`ytInitialData` scraping and most yt-dlp metadata calls:
// the markup YouTube ships to browsers changes constantly, but this JSON contract does
// not. We cover search, channel browse (with continuation paging — so we can list a
// channel's full back-catalogue, not just the 15 latest RSS items), related videos
// (the real watch-page "Up next"), trending, handle/URL resolution, and player metadata.

import { logger } from '@/lib/logger'
import { decodeEntities } from '@/lib/htmlText'
import { parseStoryboardSpec, type StoryboardLevel } from '@/lib/youtube/storyboard'

// ── Wire protocol ──────────────────────────────────────────────────────────────

const BASE = 'https://www.youtube.com/youtubei/v1'
// The public WEB InnerTube key. It is not a secret — it ships in youtube.com's own
// page source and is identical for every visitor.
const WEB_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'
const CLIENT = { clientName: 'WEB', clientVersion: '2.20240701.00.00', hl: 'en', gl: 'US' }
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// Per-tab `params` (base64 protobuf the web client sends) that land a channel browse on a
// specific tab instead of its Home tab. These are stable constants shared by every client.
const CHANNEL_TAB_PARAMS = {
  videos: 'EgZ2aWRlb3PyBgQKAjoA',
  shorts: 'EgZzaG9ydHPyBgUKA5oBAA==',
  live: 'EgdzdHJlYW1z8gYECgJ6AA==',
  playlists: 'EglwbGF5bGlzdHPyBgQKAkIA',
} as const

async function call(endpoint: string, body: Record<string, unknown>, timeout = 8000): Promise<any> {
  const res = await fetch(`${BASE}/${endpoint}?key=${WEB_KEY}&prettyPrint=false`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      'Accept-Language': 'en-US,en;q=0.9',
      'X-Youtube-Client-Name': '1',
      'X-Youtube-Client-Version': CLIENT.clientVersion,
      Origin: 'https://www.youtube.com',
    },
    body: JSON.stringify({ context: { client: CLIENT }, ...body }),
    signal: AbortSignal.timeout(timeout),
  })
  if (!res.ok) throw new Error(`innertube ${endpoint} → ${res.status}`)
  return res.json()
}

// ── Shared parse helpers ────────────────────────────────────────────────────────

export interface ItVideo {
  videoId: string
  title: string
  author: string | null
  channelId: string | null
  channelThumb: string | null
  thumbnailUrl: string | null
  durationSec: number | null
  publishedText: string | null
  views: string | null
}

export interface ItChannel {
  channelId: string
  title: string
  handle: string | null
  thumbnailUrl: string | null
  subscribers: string | null
}

const runsToText = (runs?: Array<{ text?: string }>): string => (runs ?? []).map(r => r.text ?? '').join('')
const textOf = (node: any): string => decodeEntities(node?.simpleText ?? runsToText(node?.runs) ?? '')

function fixProtoRelative(url: string | null | undefined): string | null {
  if (!url) return null
  return url.startsWith('//') ? `https:${url}` : url
}

// "12:34" / "1:02:03" → seconds. null for live / unknown lengths.
function parseClock(text?: string | null): number | null {
  if (!text) return null
  const parts = text.trim().split(':').map(p => parseInt(p, 10))
  if (!parts.length || parts.some(n => Number.isNaN(n))) return null
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

// Pull a duration out of the thumbnail overlay badge when lengthText is absent
// (grid/compact renderers carry it there).
function durationFromOverlays(r: any): number | null {
  const overlays: any[] = r?.thumbnailOverlays ?? []
  for (const o of overlays) {
    const t = o?.thumbnailOverlayTimeStatusRenderer?.text
    const sec = parseClock(textOf(t))
    if (sec != null) return sec
  }
  return null
}

function ownerOf(r: any): { author: string | null; channelId: string | null } {
  const run =
    r?.ownerText?.runs?.[0] ??
    r?.longBylineText?.runs?.[0] ??
    r?.shortBylineText?.runs?.[0]
  return {
    author: run?.text ? decodeEntities(run.text) : null,
    channelId: run?.navigationEndpoint?.browseEndpoint?.browseId ?? null,
  }
}

function channelThumbOf(r: any): string | null {
  const thumbs =
    r?.channelThumbnailSupportedRenderers?.channelThumbnailWithLinkRenderer?.thumbnail?.thumbnails ??
    r?.channelThumbnail?.thumbnails ??
    r?.channelThumbnailWithLinkRenderer?.thumbnail?.thumbnails
  const last = Array.isArray(thumbs) && thumbs.length ? thumbs[thumbs.length - 1]?.url : null
  return fixProtoRelative(last)
}

// Normalise any of YouTube's video renderer variants (videoRenderer,
// compactVideoRenderer, gridVideoRenderer, playlistVideoRenderer) to ItVideo.
function parseVideoRenderer(r: any): ItVideo | null {
  const videoId = r?.videoId
  if (!videoId || typeof videoId !== 'string') return null
  const title = decodeEntities(r?.title?.runs?.[0]?.text ?? r?.title?.simpleText ?? r?.headline?.simpleText ?? '')
  if (!title) return null
  const { author, channelId } = ownerOf(r)
  return {
    videoId,
    title,
    author,
    channelId,
    channelThumb: channelThumbOf(r),
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    durationSec: parseClock(textOf(r?.lengthText)) ?? durationFromOverlays(r),
    publishedText: r?.publishedTimeText?.simpleText ?? null,
    views: r?.viewCountText?.simpleText ?? r?.shortViewCountText?.simpleText ?? null,
  }
}

function parseChannelRenderer(r: any): ItChannel | null {
  const channelId = r?.channelId
  if (!channelId || typeof channelId !== 'string') return null
  const title = textOf(r?.title)
  if (!title) return null
  const thumbs: any[] = r?.thumbnail?.thumbnails ?? []
  const handle = r?.subscriberCountText?.simpleText ?? null   // YouTube stores the @handle here
  return {
    channelId,
    title,
    handle: typeof handle === 'string' && handle.startsWith('@') ? handle : null,
    thumbnailUrl: fixProtoRelative(thumbs.length ? thumbs[thumbs.length - 1]?.url : null),
    subscribers: r?.videoCountText?.simpleText ?? null,   // …and the sub count here
  }
}

// Depth-first walk that collects every node carrying `key`, in document order.
function collect(node: any, key: string, out: any[], limit: number): void {
  if (out.length >= limit || !node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) { collect(item, key, out, limit); if (out.length >= limit) return }
    return
  }
  const r = node[key]
  if (r && typeof r === 'object') out.push(r)
  for (const k in node) {
    if (k === key) continue
    collect(node[k], key, out, limit)
    if (out.length >= limit) return
  }
}

// The newer `lockupViewModel` shape (contentType LOCKUP_CONTENT_TYPE_VIDEO). YouTube has
// migrated channel "Videos" tabs and various grids to this — the old videoRenderer keys
// are absent there, so without this a channel page comes back with zero videos.
function parseLockupVideo(r: any): ItVideo | null {
  if (r?.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') return null
  const videoId = r?.contentId
  if (!videoId || typeof videoId !== 'string') return null
  const lm = r?.metadata?.lockupMetadataViewModel
  const title = lm?.title?.content
  if (!title) return null

  // metadataRows: on home/search the first row is the channel name, then a row of
  // [views • published]. On a channel's own page there's no channel row.
  const rows: any[] = lm?.metadata?.contentMetadataViewModel?.metadataRows ?? []
  const parts: any[] = rows.flatMap((row: any) => row?.metadataParts ?? [])
  let views: string | null = null
  let published: string | null = null
  for (const p of parts) {
    const t = p?.text?.content
    if (typeof t !== 'string') continue
    if (/view|watching/i.test(t)) views = t
    else if (/ago$|premiere|streamed|Scheduled/i.test(t)) published = t
  }
  // Author is the first metadata row when present (a channel grid omits it).
  const author = rows.length >= 2 ? (rows[0]?.metadataParts?.[0]?.text?.content ?? null) : null

  // Duration is the thumbnail overlay badge text ("13:54").
  let durationSec: number | null = null
  const overlays: any[] = r?.contentImage?.thumbnailViewModel?.overlays ?? []
  for (const o of overlays) {
    for (const b of o?.thumbnailBottomOverlayViewModel?.badges ?? []) {
      const sec = parseClock(b?.thumbnailBadgeViewModel?.text)
      if (sec != null) { durationSec = sec; break }
    }
    if (durationSec != null) break
  }

  // channelId: any channel browseEndpoint carried inside the lockup.
  let channelId: string | null = null
  collectBrowseId(r, id => { if (!channelId && id.startsWith('UC')) channelId = id })

  return {
    videoId,
    title,
    author,
    channelId,
    channelThumb: null,
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    durationSec,
    publishedText: published,
    views,
  }
}

// Walk a subtree invoking `cb` for every browseEndpoint browseId found (used to recover
// a video's channelId from the lockup shape, which buries it in a tap command).
function collectBrowseId(node: any, cb: (id: string) => void): void {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const n of node) collectBrowseId(n, cb); return }
  const id = node?.browseEndpoint?.browseId
  if (typeof id === 'string') cb(id)
  for (const k in node) collectBrowseId(node[k], cb)
}

function collectVideos(data: any, limit: number): ItVideo[] {
  const out: ItVideo[] = []
  const seen = new Set<string>()
  for (const rendererKey of ['videoRenderer', 'gridVideoRenderer', 'compactVideoRenderer', 'playlistVideoRenderer', 'richItemRenderer', 'lockupViewModel']) {
    const raw: any[] = []
    collect(data, rendererKey, raw, limit * 3)
    for (const r of raw) {
      const v = rendererKey === 'lockupViewModel'
        ? parseLockupVideo(r)
        // richItemRenderer wraps the real renderer under `.content`.
        : parseVideoRenderer(rendererKey === 'richItemRenderer' ? (r.content?.videoRenderer ?? r.content?.reelItemRenderer) : r)
      if (v && !seen.has(v.videoId)) { seen.add(v.videoId); out.push(v); if (out.length >= limit) return out }
    }
  }
  return out
}

// ── Shorts ──────────────────────────────────────────────────────────────────────
// A channel's Shorts tab uses different renderers than its Videos tab. Modern YouTube
// ships `shortsLockupViewModel`; older responses use `reelItemRenderer`; some grids wrap
// a short in a `lockupViewModel` with contentType …_SHORTS. Shorts carry no duration
// (the UI renders them 9:16 by tab, not by length), so durationSec stays null.
function parseShortLockup(r: any): ItVideo | null {
  const videoId =
    r?.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId ??
    r?.entityId?.match(/([\w-]{11})$/)?.[1]
  if (!videoId || typeof videoId !== 'string') return null
  const meta = r?.overlayMetadata
  const title = meta?.primaryText?.content ?? r?.accessibilityText ?? ''
  if (!title) return null
  return {
    videoId,
    title,
    author: null,
    channelId: null,
    channelThumb: null,
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    durationSec: null,
    publishedText: null,
    views: meta?.secondaryText?.content ?? null,
  }
}

function shortFromVideoId(videoId: string, title: string): ItVideo {
  return {
    videoId, title, author: null, channelId: null, channelThumb: null,
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    durationSec: null, publishedText: null, views: null,
  }
}

function collectShorts(data: any, limit: number): ItVideo[] {
  const out: ItVideo[] = []
  const seen = new Set<string>()
  const push = (v: ItVideo | null) => { if (v && !seen.has(v.videoId)) { seen.add(v.videoId); out.push(v) } }

  for (const key of ['shortsLockupViewModel', 'reelItemRenderer']) {
    const raw: any[] = []
    collect(data, key, raw, limit * 3)
    for (const r of raw) {
      push(key === 'shortsLockupViewModel' ? parseShortLockup(r) : parseVideoRenderer(r))
      if (out.length >= limit) return out
    }
  }
  // Some channels surface shorts inside a generic lockupViewModel (contentType …_SHORTS).
  const lk: any[] = []
  collect(data, 'lockupViewModel', lk, limit * 3)
  for (const r of lk) {
    if (r?.contentType === 'LOCKUP_CONTENT_TYPE_SHORTS') {
      const id = r?.contentId
      const title = r?.metadata?.lockupMetadataViewModel?.title?.content
      if (id && title) push(shortFromVideoId(id, title))
    }
    if (out.length >= limit) return out
  }
  return out
}

// ── Playlists ─────────────────────────────────────────────────────────────────────

export interface ItPlaylist {
  playlistId: string
  title: string
  videoCount: number | null
  thumbnailUrl: string | null
  author: string | null
  channelId: string | null
}

function parsePlaylistRenderer(r: any): ItPlaylist | null {
  const playlistId = r?.playlistId
  if (!playlistId || typeof playlistId !== 'string') return null
  const title = textOf(r?.title)
  if (!title) return null
  const thumbs = r?.thumbnails?.[0]?.thumbnails ?? r?.thumbnail?.thumbnails ?? []
  const owner = r?.shortBylineText?.runs?.[0] ?? r?.longBylineText?.runs?.[0]
  const vcRaw = String(r?.videoCount ?? r?.videoCountText?.runs?.[0]?.text ?? r?.videoCountShortText?.simpleText ?? '').replace(/[^\d]/g, '')
  const vc = parseInt(vcRaw, 10)
  return {
    playlistId,
    title,
    videoCount: Number.isFinite(vc) ? vc : null,
    thumbnailUrl: fixProtoRelative(thumbs.length ? thumbs[thumbs.length - 1]?.url : null),
    author: owner?.text ?? null,
    channelId: owner?.navigationEndpoint?.browseEndpoint?.browseId ?? null,
  }
}

// Deep-search a lockup for its "N videos" count text (it lives in a thumbnail overlay
// badge — "3 videos" — not in the metadata rows).
function lockupVideoCount(node: any): number | null {
  let found: number | null = null
  const rec = (x: any): void => {
    if (found != null || !x || typeof x !== 'object') return
    if (Array.isArray(x)) { x.forEach(rec); return }
    const t = x.content
    if (typeof t === 'string') {
      const m = /([\d,]+)\s+videos?/i.exec(t)
      if (m) { const n = parseInt(m[1].replace(/,/g, ''), 10); if (Number.isFinite(n)) { found = n; return } }
    }
    for (const k in x) rec(x[k])
  }
  rec(node)
  return found
}

// The first metadata row of a channel's own playlist lockup is a CTA ("View full
// playlist"/"Play all"), not the owner — so it must not become the subtitle.
const PLAYLIST_CTA = /^(view full playlist|play all)$/i

// YouTube increasingly returns playlists as the newer lockupViewModel shape.
function parseLockupPlaylist(r: any): ItPlaylist | null {
  if (r?.contentType !== 'LOCKUP_CONTENT_TYPE_PLAYLIST') return null
  const playlistId = r?.contentId
  if (!playlistId || typeof playlistId !== 'string') return null
  const title = r?.metadata?.lockupMetadataViewModel?.title?.content
  if (!title) return null
  const thumbSources = r?.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.image?.sources ?? []
  const rows = r?.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows ?? []
  const ownerText = rows?.[0]?.metadataParts?.[0]?.text?.content ?? null
  const author = ownerText && !PLAYLIST_CTA.test(ownerText) && !/\d+\s*videos?/i.test(ownerText) ? ownerText : null
  return {
    playlistId,
    title,
    videoCount: lockupVideoCount(r),
    thumbnailUrl: fixProtoRelative(thumbSources.length ? thumbSources[thumbSources.length - 1]?.url : null),
    author,
    channelId: null,
  }
}

function collectPlaylists(data: any, limit: number): ItPlaylist[] {
  if (limit <= 0) return []
  const out: ItPlaylist[] = []
  const seen = new Set<string>()
  for (const key of ['playlistRenderer', 'gridPlaylistRenderer', 'lockupViewModel']) {
    const raw: any[] = []
    collect(data, key, raw, limit * 3)
    for (const r of raw) {
      const pl = key === 'lockupViewModel' ? parseLockupPlaylist(r) : parsePlaylistRenderer(r)
      if (pl && !seen.has(pl.playlistId)) { seen.add(pl.playlistId); out.push(pl); if (out.length >= limit) return out }
    }
  }
  return out
}

// ── Search ──────────────────────────────────────────────────────────────────────

export interface ItSearch { videos: ItVideo[]; channels: ItChannel[]; playlists: ItPlaylist[]; continuation: string | null }

// Search filter tokens (base64 protobuf) for the InnerTube `params` field — restrict
// results to a single result type. Used by the browse UI's type chips.
export const SEARCH_FILTERS = {
  videos: 'EgIQAQ==',
  channels: 'EgIQAg==',
  playlists: 'EgIQAw==',
  shorts: 'EgIYAQ==',   // "short" duration (<4 min); we further narrow to Shorts client-side
} as const

function collectChannels(data: any, channelLimit: number): ItChannel[] {
  const channels: ItChannel[] = []
  if (channelLimit <= 0) return channels
  const raw: any[] = []
  collect(data, 'channelRenderer', raw, channelLimit * 2)
  const seen = new Set<string>()
  for (const r of raw) {
    const ch = parseChannelRenderer(r)
    if (ch && !seen.has(ch.channelId)) { seen.add(ch.channelId); channels.push(ch); if (channels.length >= channelLimit) break }
  }
  return channels
}

export async function innertubeSearch(query: string, limit = 12, channelLimit = 0, timeout = 8000, playlistLimit = 0, params?: string): Promise<ItSearch> {
  const data = await call('search', params ? { query, params } : { query }, timeout)
  return { videos: collectVideos(data, limit), channels: collectChannels(data, channelLimit), playlists: collectPlaylists(data, playlistLimit), continuation: findContinuation(data) }
}

export interface ItPlaylistOwner { channelId: string | null; name: string | null; thumbnailUrl: string | null }

// The playlist's owning channel — from the modern videoOwnerRenderer (carries the avatar)
// or the legacy playlistHeaderRenderer.ownerText.
function parsePlaylistOwner(data: any): ItPlaylistOwner | null {
  const arr: any[] = []
  collect(data, 'videoOwnerRenderer', arr, 1)
  const r = arr[0]
  if (r) {
    const run = r?.title?.runs?.[0]
    const thumbs: any[] = r?.thumbnail?.thumbnails ?? []
    return {
      channelId: run?.navigationEndpoint?.browseEndpoint?.browseId ?? null,
      name: run?.text ?? null,
      thumbnailUrl: fixProtoRelative(thumbs.length ? thumbs[thumbs.length - 1]?.url : null),
    }
  }
  const run = data?.header?.playlistHeaderRenderer?.ownerText?.runs?.[0]
  if (run) return { channelId: run?.navigationEndpoint?.browseEndpoint?.browseId ?? null, name: run?.text ?? null, thumbnailUrl: null }
  return null
}

/** Browse a playlist's videos (browseId `VL<playlistId>`), plus its owning channel. */
export async function innertubePlaylist(playlistId: string, limit = 50, timeout = 8000): Promise<{ title: string | null; description: string | null; owner: ItPlaylistOwner | null; videos: ItVideo[] }> {
  const id = playlistId.startsWith('VL') ? playlistId : `VL${playlistId}`
  const data = await call('browse', { browseId: id }, timeout)
  const title = data?.metadata?.playlistMetadataRenderer?.title
    ?? data?.header?.playlistHeaderRenderer?.title?.simpleText
    ?? null
  const description = textOf(data?.metadata?.playlistMetadataRenderer?.description)
    || textOf(data?.header?.playlistHeaderRenderer?.descriptionText)
    || null
  return { title, description, owner: parsePlaylistOwner(data), videos: collectVideos(data, limit) }
}

/** Fetch the next page of search results from a continuation token. Pass channelLimit/playlistLimit
 *  > 0 when paging a Channels/Playlists-filtered search so those pages keep filling in too — a
 *  continuation token only replays the same result type as the search it came from. */
export async function innertubeSearchMore(token: string, limit = 20, timeout = 8000, channelLimit = 0, playlistLimit = 0): Promise<ItSearch> {
  const data = await call('search', { continuation: token }, timeout)
  return { videos: collectVideos(data, limit), channels: collectChannels(data, channelLimit), playlists: collectPlaylists(data, playlistLimit), continuation: findContinuation(data) }
}

// ── Channel browse (with continuation paging) ────────────────────────────────────

export interface ItChannelMeta {
  channelId: string
  title: string
  handle: string | null
  description: string | null
  thumbnailUrl: string | null
  bannerUrl: string | null
  subscribers: string | null
  videoCount: string | null
  availableTabs: string[]   // tab titles the channel actually publishes ("Videos","Shorts",…)
}

export interface ItChannelPage {
  meta: ItChannelMeta | null
  videos: ItVideo[]
  continuation: string | null
}

function parseChannelMeta(data: any): ItChannelMeta | null {
  const m = data?.metadata?.channelMetadataRenderer
  const header =
    data?.header?.c4TabbedHeaderRenderer ??
    data?.header?.pageHeaderRenderer
  const channelId = m?.externalId ?? header?.channelId
  if (!channelId) return null

  // Avatar: the legacy header / channelMetadata expose avatar.thumbnails directly; the modern
  // pageHeader nests it as ...decoratedAvatarViewModel.avatar.avatarViewModel.image.sources.
  // Missing this path is why modern channels rendered a placeholder letter even though search
  // (which reads channelRenderer.thumbnail) showed the logo fine.
  let avatars: any[] = m?.avatar?.thumbnails ?? header?.avatar?.thumbnails ?? []
  if (!avatars.length) {
    const av: any[] = []
    collect(header, 'avatarViewModel', av, 1)
    avatars = av[0]?.image?.sources ?? []
  }

  // Banner: the legacy c4 header exposes header.banner.thumbnails; the modern pageHeader
  // nests it inside an imageBannerViewModel (image.sources, ascending by width).
  let banners: any[] = header?.banner?.thumbnails ?? []
  if (!banners.length) {
    const ib: any[] = []
    collect(header, 'imageBannerViewModel', ib, 1)
    banners = ib[0]?.image?.sources ?? []
  }

  // Subscriber / video counts: the legacy header has dedicated text fields; the modern
  // pageHeader keeps them as metadata-row text parts ("5.69M subscribers", "2.2K videos").
  let subscribers = textOf(header?.subscriberCountText) || null
  let videoCount = textOf(header?.videosCountText) || null
  const rowArrays: any[] = []
  collect(header, 'metadataRows', rowArrays, 4)
  for (const arr of rowArrays) {
    for (const row of Array.isArray(arr) ? arr : []) {
      for (const part of row?.metadataParts ?? []) {
        const t = part?.text?.content
        if (typeof t !== 'string') continue
        if (/subscriber/i.test(t)) subscribers ??= t
        else if (/video/i.test(t)) videoCount ??= t
      }
    }
  }

  // Which tabs the channel actually has — the browse response always lists them all, so we
  // can hide tabs (Live/Playlists/Shorts) the channel doesn't publish instead of showing an
  // empty grid that silently falls back to its Home content.
  const availableTabs: string[] = []
  for (const t of data?.contents?.twoColumnBrowseResultsRenderer?.tabs ?? []) {
    const title = t?.tabRenderer?.title ?? t?.expandableTabRenderer?.title
    if (typeof title === 'string' && title) availableTabs.push(title)
  }

  return {
    channelId,
    title: m?.title ?? textOf(header?.title) ?? '',
    handle: m?.vanityChannelUrl ? `@${m.vanityChannelUrl.split('/@')[1] ?? ''}`.replace(/@$/, '') || null : null,
    description: m?.description ?? null,
    thumbnailUrl: fixProtoRelative(avatars.length ? avatars[avatars.length - 1]?.url : null),
    bannerUrl: fixProtoRelative(banners.length ? banners[banners.length - 1]?.url : null),
    subscribers,
    videoCount,
    availableTabs,
  }
}

function findContinuation(data: any): string | null {
  const out: any[] = []
  collect(data, 'continuationItemRenderer', out, 1)
  return out[0]?.continuationEndpoint?.continuationCommand?.token ?? null
}

export type ChannelVideoTab = 'videos' | 'shorts' | 'live'

/** Browse a channel's Videos / Shorts / Live tab. Pass `continuation` to page deeper; the
 *  returned `continuation` token feeds the next call (null when the catalogue is exhausted).
 *  `tab` must match across paged calls so continuations parse with the right renderer. */
export async function innertubeChannel(channelId: string, continuation?: string | null, limit = 30, timeout = 8000, tab: ChannelVideoTab = 'videos'): Promise<ItChannelPage> {
  const data = continuation
    ? await call('browse', { continuation }, timeout)
    : await call('browse', { browseId: channelId, params: CHANNEL_TAB_PARAMS[tab] }, timeout)
  return {
    meta: continuation ? null : parseChannelMeta(data),
    videos: tab === 'shorts' ? collectShorts(data, limit) : collectVideos(data, limit),
    continuation: findContinuation(data),
  }
}

export interface ItChannelPlaylistsPage {
  meta: ItChannelMeta | null
  playlists: ItPlaylist[]
  continuation: string | null
}

/** Browse a channel's Playlists tab (the playlists it created), with continuation paging. */
export async function innertubeChannelPlaylists(channelId: string, continuation?: string | null, limit = 50, timeout = 8000): Promise<ItChannelPlaylistsPage> {
  const data = continuation
    ? await call('browse', { continuation }, timeout)
    : await call('browse', { browseId: channelId, params: CHANNEL_TAB_PARAMS.playlists }, timeout)
  return {
    meta: continuation ? null : parseChannelMeta(data),
    playlists: collectPlaylists(data, limit),
    continuation: findContinuation(data),
  }
}

export interface ItChannelLink { title: string; url: string }
export interface ItChannelAbout {
  description: string | null
  subscribers: string | null
  videoCount: string | null
  viewCount: string | null
  joined: string | null
  country: string | null
  links: ItChannelLink[]
}

// Channel link URLs come back as youtube.com/redirect?q=… wrappers; unwrap to the target.
function cleanRedirect(url: string): string {
  try {
    const u = new URL(url)
    if (u.hostname.endsWith('youtube.com') && u.pathname === '/redirect') {
      const q = u.searchParams.get('q')
      if (q) return q
    }
  } catch { /* not a parseable URL — return as-is */ }
  return url
}

function linkUrlFromVM(l: any): string | null {
  const cmd =
    l?.link?.commandRuns?.[0]?.onTap?.innertubeCommand?.urlEndpoint?.url ??
    l?.navigationEndpoint?.urlEndpoint?.url
  if (typeof cmd === 'string') return cleanRedirect(cmd)
  const disp = l?.link?.content
  if (typeof disp === 'string' && disp) return disp.startsWith('http') ? disp : `https://${disp}`
  return null
}

/** A channel's About details: full description, subscriber/video/view counts, joined
 *  date, country, and external links. Returns null when nothing parses.
 *
 *  YouTube no longer serves About as a browse tab — its `aboutChannelViewModel` loads
 *  lazily through an engagement-panel continuation token embedded in the channel's home
 *  browse. So we fetch home, harvest the engagement-panel tokens, and resolve the first
 *  one that yields the About view-model (usually the first or second). */
export async function innertubeChannelAbout(channelId: string, timeout = 8000): Promise<ItChannelAbout | null> {
  const home = await call('browse', { browseId: channelId }, timeout)

  const panels: any[] = []
  collect(home, 'engagementPanelSectionListRenderer', panels, 8)
  collect(home, 'showEngagementPanelEndpoint', panels, 8)
  const tokens: string[] = []
  const seenTok = new Set<string>()
  for (const p of panels) {
    const cmds: any[] = []
    collect(p, 'continuationCommand', cmds, 4)
    for (const cmd of cmds) {
      const t = cmd?.token
      if (typeof t === 'string' && !seenTok.has(t)) { seenTok.add(t); tokens.push(t) }
    }
  }

  let vm: any = null
  for (const t of tokens.slice(0, 4)) {
    const data = await call('browse', { continuation: t }, timeout)
    const arr: any[] = []
    collect(data, 'aboutChannelViewModel', arr, 1)
    if (arr[0]) { vm = arr[0]; break }
  }
  if (!vm) return null

  const links: ItChannelLink[] = []
  const linkArr: any[] = []
  collect(vm, 'channelExternalLinkViewModel', linkArr, 30)
  for (const l of linkArr) {
    const url = linkUrlFromVM(l)
    if (url) links.push({ title: l?.title?.content || url, url })
  }
  return {
    description: vm?.description ?? null,
    subscribers: vm?.subscriberCountText ?? null,
    videoCount: vm?.videoCountText ?? null,
    viewCount: vm?.viewCountText ?? null,
    joined: vm?.joinedDateText?.content ?? null,
    country: vm?.country ?? null,
    links,
  }
}

/** Just a channel's avatar URL — for enriching discovery feeds (Invidious /popular) that
 *  omit channel thumbnails. A minimal browse; reliable (direct YouTube, no Cloudflare). */
export async function innertubeChannelAvatar(channelId: string, timeout = 6000): Promise<string | null> {
  const data = await call('browse', { browseId: channelId }, timeout)
  return parseChannelMeta(data)?.thumbnailUrl ?? null
}

/** Resolve an @handle / custom URL / channel URL to its canonical channel id + meta. */
export async function innertubeResolveChannel(url: string, timeout = 8000): Promise<ItChannelMeta | null> {
  const nav = await call('navigation/resolve_url', { url }, timeout)
  const browseId = nav?.endpoint?.browseEndpoint?.browseId
  if (!browseId || !browseId.startsWith('UC')) return null
  const page = await innertubeChannel(browseId, null, 1, timeout)
  return page.meta ?? { channelId: browseId, title: '', handle: null, description: null, thumbnailUrl: null, bannerUrl: null, subscribers: null, videoCount: null, availableTabs: [] }
}

// ── Related / "Up next" ──────────────────────────────────────────────────────────

export async function innertubeRelated(videoId: string, limit = 20, timeout = 8000): Promise<ItVideo[]> {
  const data = await call('next', { videoId }, timeout)
  const results = data?.contents?.twoColumnWatchNextResults?.secondaryResults?.secondaryResults?.results ?? data
  const out: ItVideo[] = []
  const raw: any[] = []
  collect(results, 'compactVideoRenderer', raw, limit * 2)
  const seen = new Set<string>([videoId])
  for (const r of raw) {
    const v = parseVideoRenderer(r)
    if (v && !seen.has(v.videoId)) { seen.add(v.videoId); out.push(v); if (out.length >= limit) break }
  }
  return out
}

// ── Chapters ───────────────────────────────────────────────────────────────────
// YouTube's authoritative chapter list (creator-set or auto-generated) lives in the
// `next` response's player bar markers — more reliable than scraping timestamps out of
// the description, and it carries the official titles. We walk for `chapterRenderer`
// rather than the deep markersMap path so it survives YouTube reshuffling the tree.

export interface ItChapter { start: number; title: string }

export async function innertubeChapters(videoId: string, timeout = 8000): Promise<ItChapter[]> {
  const data = await call('next', { videoId }, timeout)
  const raw: any[] = []
  collect(data, 'chapterRenderer', raw, 200)
  const out: ItChapter[] = []
  for (const ch of raw) {
    const ms = ch?.timeRangeStartMillis
    if (typeof ms !== 'number') continue
    const title = textOf(ch?.title)
    if (!title) continue
    out.push({ start: Math.round(ms / 1000), title })
  }
  out.sort((a, b) => a.start - b.start)
  // Drop duplicate start times (the markersMap sometimes carries two marker sets).
  return out.filter((ch, i) => i === 0 || ch.start !== out[i - 1]!.start)
}

// ── Comments ───────────────────────────────────────────────────────────────────
// Two-step: the first `next` call carries a continuation token for the comments
// section; a second `next` with that token returns the actual threads. Modern WEB
// stores comment *data* in `frameworkUpdates` mutations keyed by an entity key that
// each thread's view-model references — with a fallback to the legacy commentRenderer.

export interface ItComment {
  author: string
  authorThumb: string | null
  text: string
  likeCount: string | null
  publishedText: string | null
  replyCount: number | null
  pinned: boolean
}

function findCommentsToken(data: any): string | null {
  const sections = data?.contents?.twoColumnWatchNextResults?.results?.results?.contents
  if (Array.isArray(sections)) {
    for (const s of sections) {
      const isr = s?.itemSectionRenderer
      if (isr?.sectionIdentifier === 'comment-item-section') {
        const tok = isr.contents?.find((x: any) => x?.continuationItemRenderer)
          ?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token
        if (typeof tok === 'string') return tok
      }
    }
  }
  return null
}

export async function innertubeComments(videoId: string, limit = 20, timeout = 8000): Promise<ItComment[]> {
  const first = await call('next', { videoId }, timeout)
  const token = findCommentsToken(first)
  if (!token) return []   // comments disabled, or YouTube changed the shape
  const data = await call('next', { continuation: token }, timeout)

  // Build entity-key → payload map from the framework mutations (current WEB shape).
  const payloads = new Map<string, any>()
  const muts = data?.frameworkUpdates?.entityBatchUpdate?.mutations
  if (Array.isArray(muts)) {
    for (const m of muts) {
      const p = m?.payload?.commentEntityPayload
      if (p?.key) payloads.set(p.key, p)
    }
  }

  const threads: any[] = []
  collect(data, 'commentThreadRenderer', threads, limit * 2)
  const out: ItComment[] = []
  for (const t of threads) {
    const vm = t?.commentViewModel?.commentViewModel ?? t?.commentViewModel
    const p = vm?.commentKey ? payloads.get(vm.commentKey) : null
    if (p) {
      const text = p?.properties?.content?.content
      if (!text) continue
      const reply = p?.toolbar?.replyCount
      out.push({
        author: p?.author?.displayName ?? '',
        authorThumb: fixProtoRelative(p?.author?.avatarThumbnailUrl ?? p?.avatar?.image?.sources?.[0]?.url),
        text,
        likeCount: p?.toolbar?.likeCountNotliked || null,
        publishedText: p?.properties?.publishedTime ?? null,
        replyCount: reply ? (parseInt(String(reply).replace(/\D/g, ''), 10) || null) : null,
        pinned: !!vm?.pinnedText,
      })
    } else {
      // Legacy commentRenderer fallback (older InnerTube responses).
      const cr = t?.comment?.commentRenderer
      const text = runsToText(cr?.contentText?.runs) || textOf(cr?.contentText)
      if (!cr || !text) continue
      out.push({
        author: textOf(cr?.authorText),
        authorThumb: fixProtoRelative(cr?.authorThumbnail?.thumbnails?.slice(-1)?.[0]?.url),
        text,
        likeCount: textOf(cr?.voteCount) || null,
        publishedText: textOf(cr?.publishedTimeText) || null,
        replyCount: null,
        pinned: !!cr?.pinnedCommentBadge,
      })
    }
    if (out.length >= limit) break
  }
  return out
}

// Note: YouTube retired the anonymous Trending feed (FEtrending now returns HTTP 400),
// so there is no InnerTube trending call. Discovery is sourced via lib/youtube/discovery.ts.

// ── Player metadata ────────────────────────────────────────────────────────────────

export interface ItPlayerMeta {
  videoId: string
  title: string
  author: string | null
  channelId: string | null
  description: string | null
  durationSec: number | null
  views: string | null
  /** Cheap "is this currently live" signal for the Record-from-start button. Backed by the
   *  same player response this call already fetches — no extra request. yt-dlp's `-J` (see
   *  live.ts's getLiveStatus) is the authoritative check right before a recording starts. */
  isLive: boolean
}

/** Fast video metadata (title/author/description/length) without spawning yt-dlp. */
export async function innertubePlayerMeta(videoId: string, timeout = 8000): Promise<ItPlayerMeta | null> {
  const data = await call('player', { videoId }, timeout)
  const d = data?.videoDetails
  if (!d?.videoId) return null
  const len = parseInt(d.lengthSeconds ?? '', 10)
  return {
    videoId: d.videoId,
    title: d.title ?? '',
    author: d.author ?? null,
    channelId: d.channelId ?? null,
    description: d.shortDescription ?? null,
    durationSec: Number.isFinite(len) && len > 0 ? len : null,
    views: d.viewCount ?? null,
    isLive: !!d.isLive,
  }
}

// ── Stream resolution (fast path) ────────────────────────────────────────────────
// The ANDROID_VR InnerTube client hands back directly-playable stream URLs with no
// signature cipher to solve — so the privacy proxy can resolve a stream with a single
// JSON call instead of spawning yt-dlp (seconds faster). (The plain WEB/ANDROID clients
// no longer return usable streams without an attestation token; ANDROID_VR still does.)
// Not every video cooperates — some have no progressive format, some come back non-OK —
// so callers fall back to yt-dlp when this returns null.

// Client version + device fields must match a current real ANDROID_VR build (kept in step with
// yt-dlp's config) or YouTube replies LOGIN_REQUIRED. CRITICALLY, the request must also carry a
// `visitorData` token — without it, music/"topic" tracks come back LOGIN_REQUIRED and we'd fall to
// a slow cold yt-dlp spawn for every song. With it, they return status OK + an unciphered
// progressive (itag 18) URL the proxy can serve directly (~150ms vs ~10–30s).
const VR_CLIENT = { clientName: 'ANDROID_VR', clientVersion: '1.71.26', deviceMake: 'Oculus', deviceModel: 'Quest 3', androidSdkVersion: 32, osName: 'Android', osVersion: '12L', hl: 'en', gl: 'US' }
const VR_UA = 'com.google.android.apps.youtube.vr.oculus/1.71.26 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip'

// visitorData is stable for a long time; fetch once and reuse. Coalesce concurrent fetches.
let _visitorData: string | null = null
let _visitorPending: Promise<string | null> | null = null
async function getVisitorData(): Promise<string | null> {
  if (_visitorData) return _visitorData
  if (_visitorPending) return _visitorPending
  _visitorPending = (async () => {
    try {
      const res = await fetch(`${BASE}/visitor_id?key=${WEB_KEY}&prettyPrint=false`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': VR_UA, 'X-Youtube-Client-Name': '28', 'X-Youtube-Client-Version': VR_CLIENT.clientVersion },
        body: JSON.stringify({ context: { client: VR_CLIENT } }),
        signal: AbortSignal.timeout(5000),
      })
      const data: any = await res.json()
      _visitorData = data?.responseContext?.visitorData ?? null
    } catch { _visitorData = null }
    finally { _visitorPending = null }
    return _visitorData
  })()
  return _visitorPending
}

export interface ItStreamFormat { itag: number; url: string; height: number | null; bitrate: number | null; mime: string }
export interface ItStreams { progressive: ItStreamFormat[]; audio: ItStreamFormat[] }

export async function innertubePlayerStreams(videoId: string, timeout = 6000): Promise<ItStreams | null> {
  const visitorData = await getVisitorData()
  const res = await fetch(`${BASE}/player?key=${WEB_KEY}&prettyPrint=false`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': VR_UA,
      'X-Youtube-Client-Name': '28',
      'X-Youtube-Client-Version': VR_CLIENT.clientVersion,
      Origin: 'https://www.youtube.com',
    },
    body: JSON.stringify({ context: { client: { ...VR_CLIENT, ...(visitorData ? { visitorData } : {}) } }, videoId, contentCheckOk: true, racyCheckOk: true }),
    signal: AbortSignal.timeout(timeout),
  })
  if (!res.ok) throw new Error(`innertube player(vr) → ${res.status}`)
  const data: any = await res.json()
  const status = data?.playabilityStatus?.status
  // LOGIN_REQUIRED almost always means our visitorData went stale — drop it so the next call
  // refetches a fresh token and recovers the fast path instead of permanently falling to yt-dlp.
  if (status === 'LOGIN_REQUIRED') { _visitorData = null }
  if (status && status !== 'OK') return null   // login/age/region gated → let yt-dlp try
  const sd = data?.streamingData
  if (!sd) return null
  const toFmt = (f: any): ItStreamFormat | null => {
    // Skip ciphered formats (signatureCipher instead of a plain url) — those need the
    // player JS we're trying to avoid; yt-dlp handles them on the fallback path.
    if (!f?.url || typeof f.url !== 'string') return null
    const itag = typeof f.itag === 'number' ? f.itag : parseInt(f.itag, 10)
    return { itag, url: f.url, height: f.height ?? null, bitrate: f.bitrate ?? null, mime: f.mimeType ?? '' }
  }
  const progressive = ((sd.formats ?? []).map(toFmt).filter(Boolean)) as ItStreamFormat[]
  const audio = ((sd.adaptiveFormats ?? []).filter((f: any) => String(f?.mimeType ?? '').startsWith('audio/')).map(toFmt).filter(Boolean)) as ItStreamFormat[]
  return { progressive, audio }
}

// Storyboard (scrub-preview sprite sheet) levels for a video. The plain WEB `player` call
// used by innertubePlayerMeta comes back playabilityStatus UNPLAYABLE (no storyboards,
// no streamingData) without the same VR-client + visitorData trick innertubePlayerStreams
// uses — verified against a live response before writing this. Fetched lazily on first
// scrub-hover rather than on every page load, so this deliberately makes its own request
// instead of sharing innertubePlayerMeta's.
export async function innertubePlayerStoryboards(videoId: string, timeout = 6000): Promise<StoryboardLevel[] | null> {
  const visitorData = await getVisitorData()
  const res = await fetch(`${BASE}/player?key=${WEB_KEY}&prettyPrint=false`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': VR_UA,
      'X-Youtube-Client-Name': '28',
      'X-Youtube-Client-Version': VR_CLIENT.clientVersion,
      Origin: 'https://www.youtube.com',
    },
    body: JSON.stringify({ context: { client: { ...VR_CLIENT, ...(visitorData ? { visitorData } : {}) } }, videoId, contentCheckOk: true, racyCheckOk: true }),
    signal: AbortSignal.timeout(timeout),
  })
  if (!res.ok) throw new Error(`innertube player(vr, storyboards) → ${res.status}`)
  const data: any = await res.json()
  const status = data?.playabilityStatus?.status
  if (status === 'LOGIN_REQUIRED') { _visitorData = null }
  if (status && status !== 'OK') return null
  const spec = data?.storyboards?.playerStoryboardSpecRenderer?.spec
  if (typeof spec !== 'string' || !spec) return null
  try { return parseStoryboardSpec(spec) } catch { return null }
}

// Best-effort wrappers — never throw; callers treat InnerTube as an optional fast path.
export async function tryInnertube<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    logger.warn(`[youtube/innertube] ${label} failed: ${err}`)
    return fallback
  }
}

/** Like tryInnertube, but retries transient failures (rate-limit/timeout) with a
 *  short backoff before giving up. Returns `null` only when every attempt failed,
 *  so callers can fall back to a cache instead of showing an empty result. */
export async function tryInnertubeRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      logger.warn(`[youtube/innertube] ${label} attempt ${i + 1}/${attempts} failed: ${err}`)
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1)))
    }
  }
  return null
}

// Authenticated InnerTube — the TV-client surface. Google only accepts the device-flow
// OAuth tokens (account.ts) on the TVHTML5 client, so every account-scoped call lives
// here, separate from innertube.ts (which stays anonymous WEB/ANDROID_VR and carries all
// public browsing/playback — zero account-flagging exposure). Keep it that way: this
// module is for low-volume account sync and explicit user actions only, never playback.
//
// TV responses render differently from WEB (tileRenderer instead of videoRenderer, guide
// rows, plus the same lockupViewModel migration). We can't fixture these shapes without a
// live login, so every parser here is a defensive multi-shape walk: try all known
// renderer spellings, dedupe by id, and treat "nothing matched" as an empty page rather
// than an error.

import { logger } from '@/lib/logger'
import { decodeEntities } from '@/lib/htmlText'
import { statsFromMetadataRows } from '@/lib/youtube/innertube'

const BASE = 'https://www.youtube.com/youtubei/v1'
const TV_CLIENT = { clientName: 'TVHTML5', clientVersion: '7.20260311.12.00', hl: 'en', gl: 'US' }
const TV_UA = 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version'

/** 401/403 from an authed call — the access token is bad. Callers refresh-and-retry once. */
export class TvAuthError extends Error {
  constructor(endpoint: string, status: number) {
    super(`innertube-tv ${endpoint} → ${status}`)
    this.name = 'TvAuthError'
  }
}

async function tvCall(endpoint: string, accessToken: string, body: Record<string, unknown>, timeout = 12000): Promise<any> {
  // No ?key= param: API keys and OAuth are mutually exclusive on this API.
  const res = await fetch(`${BASE}/${endpoint}?prettyPrint=false`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': TV_UA,
      Authorization: `Bearer ${accessToken}`,
      'X-Youtube-Client-Name': '7',
      'X-Youtube-Client-Version': TV_CLIENT.clientVersion,
      Origin: 'https://www.youtube.com',
    },
    body: JSON.stringify({ context: { client: TV_CLIENT }, ...body }),
    signal: AbortSignal.timeout(timeout),
  })
  if (res.status === 401 || res.status === 403) throw new TvAuthError(endpoint, res.status)
  if (!res.ok) throw new Error(`innertube-tv ${endpoint} → ${res.status}`)
  return res.json()
}

// ── Generic walkers ────────────────────────────────────────────────────────────

// Depth-first collect of every node carrying `key` (same contract as innertube.ts's
// collect(), local so the anonymous module keeps zero coupling to this one).
function collectKey(node: any, key: string, out: any[], limit = 5000): void {
  if (out.length >= limit || !node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) { collectKey(item, key, out, limit); if (out.length >= limit) return }
    return
  }
  const r = node[key]
  if (r && typeof r === 'object') out.push(r)
  for (const k in node) {
    if (k === key) continue
    collectKey(node[k], key, out, limit)
    if (out.length >= limit) return
  }
}

const textOf = (node: any): string =>
  decodeEntities(node?.simpleText ?? (node?.runs ?? []).map((r: any) => r?.text ?? '').join('') ?? node?.content ?? '')

function lastThumb(thumbs: any): string | null {
  const arr = thumbs?.thumbnails ?? thumbs?.sources ?? thumbs
  if (!Array.isArray(arr) || !arr.length) return null
  const url = arr[arr.length - 1]?.url
  if (typeof url !== 'string') return null
  return url.startsWith('//') ? `https:${url}` : url
}

// "12:34" / "1:02:03" → seconds.
function parseClock(text?: string | null): number | null {
  if (!text) return null
  const parts = text.trim().split(':').map(p => parseInt(p, 10))
  if (!parts.length || parts.some(n => Number.isNaN(n))) return null
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

// Every continuation spelling seen across InnerTube clients — modern token commands and
// the legacy `continuations` array TV responses still carry in places.
function findTvContinuation(data: any): string | null {
  const modern: any[] = []
  collectKey(data, 'continuationCommand', modern, 1)
  if (typeof modern[0]?.token === 'string') return modern[0].token
  const legacy: any[] = []
  collectKey(data, 'nextContinuationData', legacy, 1)
  if (typeof legacy[0]?.continuation === 'string') return legacy[0].continuation
  return null
}

function firstBrowseId(node: any, prefix: string): string | null {
  let found: string | null = null
  const rec = (x: any): void => {
    if (found || !x || typeof x !== 'object') return
    if (Array.isArray(x)) { x.forEach(rec); return }
    const id = x?.browseEndpoint?.browseId
    if (typeof id === 'string' && id.startsWith(prefix)) { found = id; return }
    for (const k in x) rec(x[k])
  }
  rec(node)
  return found
}

// ── Account identity ───────────────────────────────────────────────────────────

export interface TvAccountInfo { title: string | null; handle: string | null; avatarUrl: string | null }

/** Signed-in account's display identity (name / @handle / avatar), for the settings card. */
export async function fetchAccountInfo(accessToken: string): Promise<TvAccountInfo | null> {
  const data = await tvCall('account/account_menu', accessToken, {})
  const items: any[] = []
  collectKey(data, 'accountItem', items, 4)
  const item = items[0]
  if (!item) return null
  const handleText = textOf(item.channelHandle) || textOf(item.accountByline)
  return {
    title: textOf(item.accountName) || null,
    handle: handleText.startsWith('@') ? handleText : null,
    avatarUrl: lastThumb(item.accountPhoto),
  }
}

// ── Subscribed channels ────────────────────────────────────────────────────────

export interface TvChannel {
  channelId: string
  title: string
  handle: string | null
  thumbnailUrl: string | null
}

// Pull channels out of any response subtree: every renderer spelling that can carry a
// subscribed channel across TV/WEB response generations.
function collectChannelsDeep(data: any, into: Map<string, TvChannel>): void {
  for (const key of ['channelRenderer', 'gridChannelRenderer']) {
    const raw: any[] = []
    collectKey(data, key, raw)
    for (const r of raw) {
      const channelId = r?.channelId
      if (typeof channelId !== 'string' || !channelId.startsWith('UC')) continue
      const title = textOf(r?.title)
      if (!title || into.has(channelId)) continue
      into.set(channelId, { channelId, title, handle: null, thumbnailUrl: lastThumb(r?.thumbnail) })
    }
  }

  // guideEntryRenderer — the WEB sidebar / guide feed shape.
  const guides: any[] = []
  collectKey(data, 'guideEntryRenderer', guides)
  for (const g of guides) {
    const channelId = g?.navigationEndpoint?.browseEndpoint?.browseId
    if (typeof channelId !== 'string' || !channelId.startsWith('UC') || into.has(channelId)) continue
    const title = textOf(g?.formattedTitle) || textOf(g?.title)
    if (!title) continue
    into.set(channelId, { channelId, title, handle: null, thumbnailUrl: lastThumb(g?.thumbnail) })
  }

  // tileRenderer — the TV app's native card (contentType CHANNEL).
  const tiles: any[] = []
  collectKey(data, 'tileRenderer', tiles)
  for (const t of tiles) {
    if (t?.contentType && t.contentType !== 'TILE_CONTENT_TYPE_CHANNEL') continue
    const channelId = t?.contentId ?? firstBrowseId(t?.onSelectCommand, 'UC')
    if (typeof channelId !== 'string' || !channelId.startsWith('UC') || into.has(channelId)) continue
    const title = textOf(t?.metadata?.tileMetadataRenderer?.title)
    if (!title) continue
    into.set(channelId, {
      channelId, title, handle: null,
      thumbnailUrl: lastThumb(t?.header?.tileHeaderRenderer?.thumbnail),
    })
  }

  // lockupViewModel — the newest cross-client shape.
  const lockups: any[] = []
  collectKey(data, 'lockupViewModel', lockups)
  for (const l of lockups) {
    if (l?.contentType !== 'LOCKUP_CONTENT_TYPE_CHANNEL') continue
    const channelId = l?.contentId
    if (typeof channelId !== 'string' || !channelId.startsWith('UC') || into.has(channelId)) continue
    const title = l?.metadata?.lockupMetadataViewModel?.title?.content
    if (typeof title !== 'string' || !title) continue
    into.set(channelId, { channelId, title, handle: null, thumbnailUrl: lastThumb(l?.contentImage?.thumbnailViewModel?.image) })
  }
}

const MAX_PAGES = 20

/**
 * The account's full subscribed-channel list. Sources, most- to least-structured:
 * FEchannels (the "All subscriptions" page), then the guide feed, then — as a floor —
 * channels derived from the FEsubscriptions video feed (only channels with recent
 * uploads, but never empty for an account that has any activity).
 */
/** The linked account's watch history (FEhistory browse), newest first. */
export async function fetchWatchHistory(accessToken: string, limit = 60): Promise<TvVideo[]> {
  const data = await tvCall('browse', accessToken, { browseId: 'FEhistory' })
  return collectVideosDeep(data).slice(0, limit)
}

/** The linked account's REAL YouTube home feed (what Google's recommender picked for
 *  this user right now). Used as a seed/calibration source for our own suggestions:
 *  Google sees signals we never will, so its picks are a strong variety prior. */
export async function fetchHomeFeed(accessToken: string, limit = 60): Promise<TvVideo[]> {
  const data = await tvCall('browse', accessToken, { browseId: 'FEwhat_to_watch' })
  return collectVideosDeep(data).slice(0, limit)
}

/** First page of the account's Watch Later playlist (VLWL browse), newest saves first.
 *  Lighter than fetchAccountPlaylist: one call, no paging, for signal/merge surfaces. */
export async function fetchAccountWatchLater(accessToken: string, limit = 60): Promise<TvVideo[]> {
  const data = await tvCall('browse', accessToken, { browseId: 'VLWL' })
  return collectVideosDeep(data).slice(0, limit)
}

/** First page of the account's Liked videos playlist (VLLL browse), newest likes first. */
export async function fetchAccountLiked(accessToken: string, limit = 60): Promise<TvVideo[]> {
  const data = await tvCall('browse', accessToken, { browseId: 'VLLL' })
  return collectVideosDeep(data).slice(0, limit)
}

/** The account's real Subscriptions feed (FEsubscriptions browse): Google's own
 *  newest-uploads roll across every subscribed channel, richer than our RSS poller
 *  (it includes channels the poller has not caught up on and respects the account's
 *  own ordering). */
export async function fetchSubscriptionsFeed(accessToken: string, limit = 60): Promise<TvVideo[]> {
  const data = await tvCall('browse', accessToken, { browseId: 'FEsubscriptions' })
  return collectVideosDeep(data).slice(0, limit)
}

/** The account's personalized watch-next rail for one video ('next' endpoint): what
 *  Google would queue after this video FOR THIS ACCOUNT. The response interleaves
 *  secondaryResults / autoplay sets whose items render as compactVideoRenderer,
 *  playlistPanelVideoRenderer, tileRenderer, or lockupViewModel depending on client
 *  generation; collectVideosDeep already walks all of those, so no dedicated
 *  collector is needed. The subject video itself is filtered out. */
export async function fetchAccountNext(accessToken: string, videoId: string, limit = 20): Promise<TvVideo[]> {
  const data = await tvCall('next', accessToken, { videoId })
  return collectVideosDeep(data).filter(v => v.videoId !== videoId).slice(0, limit)
}

export async function fetchSubscribedChannels(accessToken: string): Promise<TvChannel[]> {
  const channels = new Map<string, TvChannel>()

  // Source 1: the "All subscriptions" browse page, with paging.
  try {
    let data = await tvCall('browse', accessToken, { browseId: 'FEchannels' })
    collectChannelsDeep(data, channels)
    for (let page = 0; page < MAX_PAGES; page++) {
      const token = findTvContinuation(data)
      if (!token) break
      const before = channels.size
      data = await tvCall('browse', accessToken, { continuation: token })
      collectChannelsDeep(data, channels)
      if (channels.size === before) break   // page added nothing — stop paging
    }
  } catch (err) {
    if (err instanceof TvAuthError) throw err
    logger.warn({ err: String(err) }, '[yt-tv] FEchannels channel list failed')
  }
  if (channels.size > 0) return [...channels.values()]

  // Source 2: the guide (sidebar) — its own endpoint, one shot, no paging.
  try {
    const data = await tvCall('guide', accessToken, {})
    collectChannelsDeep(data, channels)
  } catch (err) {
    if (err instanceof TvAuthError) throw err
    logger.warn({ err: String(err) }, '[yt-tv] guide channel list failed')
  }
  if (channels.size > 0) return [...channels.values()]

  // Floor: infer channels from the subscriptions video feed.
  try {
    for (const v of await fetchSubscriptionsFeed(accessToken, 200)) {
      if (v.channelId && v.author && !channels.has(v.channelId)) {
        channels.set(v.channelId, { channelId: v.channelId, title: v.author, handle: null, thumbnailUrl: null })
      }
    }
  } catch (err) {
    if (err instanceof TvAuthError) throw err
    logger.warn({ err: String(err) }, '[yt-tv] subscriptions feed fallback failed')
  }
  return [...channels.values()]
}

// ── Playlist contents (Watch Later = WL, Liked = LL) ───────────────────────────

export interface TvVideo {
  videoId: string
  title: string
  author: string | null
  channelId: string | null
  durationSec: number | null
  views: string | null
  publishedText: string | null
}

function collectVideosDeep(data: any): TvVideo[] {
  const out = new Map<string, TvVideo>()

  // playlistPanelVideoRenderer: the watch-next / autoplay panel shape 'next' returns.
  for (const key of ['playlistVideoRenderer', 'videoRenderer', 'gridVideoRenderer', 'compactVideoRenderer', 'playlistPanelVideoRenderer']) {
    const raw: any[] = []
    collectKey(data, key, raw)
    for (const r of raw) {
      const videoId = r?.videoId
      if (typeof videoId !== 'string' || out.has(videoId)) continue
      const title = textOf(r?.title)
      if (!title) continue
      const byline = r?.shortBylineText?.runs?.[0] ?? r?.longBylineText?.runs?.[0] ?? r?.ownerText?.runs?.[0]
      const lengthSeconds = parseInt(r?.lengthSeconds ?? '', 10)
      out.set(videoId, {
        videoId,
        title,
        author: byline?.text ? decodeEntities(byline.text) : null,
        channelId: byline?.navigationEndpoint?.browseEndpoint?.browseId ?? null,
        durationSec: Number.isFinite(lengthSeconds) ? lengthSeconds : parseClock(textOf(r?.lengthText)),
        views: textOf(r?.viewCountText ?? r?.shortViewCountText) || null,
        publishedText: textOf(r?.publishedTimeText) || null,
      })
    }
  }

  // tileRenderer (TV native).
  const tiles: any[] = []
  collectKey(data, 'tileRenderer', tiles)
  for (const t of tiles) {
    if (t?.contentType && t.contentType !== 'TILE_CONTENT_TYPE_VIDEO') continue
    const videoId = t?.onSelectCommand?.watchEndpoint?.videoId ?? t?.contentId
    if (typeof videoId !== 'string' || videoId.length !== 11 || out.has(videoId)) continue
    const meta = t?.metadata?.tileMetadataRenderer
    const title = textOf(meta?.title)
    if (!title) continue
    // TV tile metadata lines carry author + stats as loose text rows; first line ≈ channel.
    const firstLine = meta?.lines?.[0]?.lineRenderer?.items?.[0]?.lineItemRenderer?.text
    out.set(videoId, {
      videoId,
      title,
      author: textOf(firstLine) || null,
      channelId: firstBrowseId(t, 'UC'),
      durationSec: null,
      views: null,
      publishedText: null,
    })
  }

  // lockupViewModel videos.
  const lockups: any[] = []
  collectKey(data, 'lockupViewModel', lockups)
  for (const l of lockups) {
    if (l?.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') continue
    const videoId = l?.contentId
    if (typeof videoId !== 'string' || out.has(videoId)) continue
    const lm = l?.metadata?.lockupMetadataViewModel
    const title = lm?.title?.content
    if (typeof title !== 'string' || !title) continue
    const rows: any[] = lm?.metadata?.contentMetadataViewModel?.metadataRows ?? []
    const stats = statsFromMetadataRows(rows)
    out.set(videoId, {
      videoId,
      title,
      author: rows[0]?.metadataParts?.[0]?.text?.content ?? null,
      channelId: firstBrowseId(l, 'UC'),
      durationSec: null,
      views: stats.views,
      publishedText: stats.published,
    })
  }

  return [...out.values()]
}

/** Full contents of one of the account's playlists: 'WL' watch-later, 'LL' liked,
 *  or any playlist id the account can see (its own playlists included, private ones too,
 *  since the call is authenticated). */
export async function fetchAccountPlaylist(accessToken: string, playlistId: string, max = 1000): Promise<TvVideo[]> {
  const videos = new Map<string, TvVideo>()
  let data = await tvCall('browse', accessToken, { browseId: `VL${playlistId}` })
  for (let page = 0; page <= MAX_PAGES; page++) {
    for (const v of collectVideosDeep(data)) {
      if (!videos.has(v.videoId)) videos.set(v.videoId, v)
      if (videos.size >= max) return [...videos.values()]
    }
    const token = findTvContinuation(data)
    if (!token) break
    const before = videos.size
    data = await tvCall('browse', accessToken, { continuation: token })
    if (collectVideosDeep(data).every(v => videos.has(v.videoId)) && before === videos.size) {
      // Defensive: identical page (some TV continuations loop) — bail.
      break
    }
  }
  return [...videos.values()]
}

// ── The account's own playlists ────────────────────────────────────────────────

export interface TvPlaylist {
  playlistId: string
  title: string
  videoCount: number | null
  thumbnailUrl: string | null
}

function collectPlaylistsDeep(data: any, into: Map<string, TvPlaylist>): void {
  const put = (rawId: unknown, title: string, videoCount: number | null, thumbnailUrl: string | null): void => {
    if (typeof rawId !== 'string' || !rawId || !title) return
    // Browse ids arrive as VL<id>; WL and LL are the fixed lists with their own
    // sync, and RD* ids are radio mixes, not real playlists.
    const playlistId = rawId.replace(/^VL/, '')
    if (playlistId === 'WL' || playlistId === 'LL' || playlistId.startsWith('RD')) return
    if (into.has(playlistId)) return
    into.set(playlistId, { playlistId, title, videoCount, thumbnailUrl })
  }

  // Classic renderers, across client generations.
  for (const key of ['gridPlaylistRenderer', 'compactPlaylistRenderer', 'playlistRenderer']) {
    const raw: any[] = []
    collectKey(data, key, raw)
    for (const r of raw) {
      const count = parseInt(textOf(r?.videoCountText ?? r?.videoCountShortText).replace(/[^0-9]/g, ''), 10)
      put(r?.playlistId, textOf(r?.title), Number.isFinite(count) ? count : null,
          lastThumb(r?.thumbnail ?? r?.thumbnails?.[0]))
    }
  }

  // tileRenderer playlists (TV native shell).
  const tiles: any[] = []
  collectKey(data, 'tileRenderer', tiles)
  for (const t of tiles) {
    if (t?.contentType !== 'TILE_CONTENT_TYPE_PLAYLIST') continue
    const id = t?.onSelectCommand?.watchPlaylistEndpoint?.playlistId
      ?? t?.onSelectCommand?.browseEndpoint?.browseId
      ?? t?.contentId
    put(id, textOf(t?.metadata?.tileMetadataRenderer?.title), null,
        lastThumb(t?.header?.tileHeaderRenderer?.thumbnail))
  }

  // lockupViewModel playlists (current viewmodel shell).
  const lockups: any[] = []
  collectKey(data, 'lockupViewModel', lockups)
  for (const l of lockups) {
    if (l?.contentType !== 'LOCKUP_CONTENT_TYPE_PLAYLIST') continue
    const lm = l?.metadata?.lockupMetadataViewModel
    const title = typeof lm?.title?.content === 'string' ? lm.title.content : ''
    put(l?.contentId, title, null,
        lastThumb(l?.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.image
          ?? l?.contentImage?.thumbnailViewModel?.image))
  }
}

/** Every playlist the account owns or saved. FEplaylist_aggregation is the dedicated
 *  playlists surface; FElibrary is the fallback (older shells put playlist shelves
 *  there instead). Same shape as fetchSubscribedChannels: first source that yields
 *  anything wins. */
export async function fetchAccountPlaylists(accessToken: string): Promise<TvPlaylist[]> {
  const found = new Map<string, TvPlaylist>()
  for (const browseId of ['FEplaylist_aggregation', 'FElibrary']) {
    try {
      let data = await tvCall('browse', accessToken, { browseId })
      collectPlaylistsDeep(data, found)
      for (let page = 0; page < MAX_PAGES; page++) {
        const token = findTvContinuation(data)
        if (!token) break
        const before = found.size
        data = await tvCall('browse', accessToken, { continuation: token })
        collectPlaylistsDeep(data, found)
        if (found.size === before) break
      }
    } catch (err) {
      if (err instanceof TvAuthError) throw err
      logger.warn({ browseId, err: String(err) }, '[yt-tv] account playlists browse failed')
    }
    if (found.size > 0) break
  }
  return [...found.values()]
}

// ── Mutations (push) ───────────────────────────────────────────────────────────
// All idempotent server-side: subscribing twice / removing an absent video is a no-op
// for Google, so callers can fire-and-forget without read-back checks.

export async function tvSubscribe(accessToken: string, channelId: string): Promise<void> {
  await tvCall('subscription/subscribe', accessToken, { channelIds: [channelId] })
}

export async function tvUnsubscribe(accessToken: string, channelId: string): Promise<void> {
  await tvCall('subscription/unsubscribe', accessToken, { channelIds: [channelId] })
}

export async function tvPlaylistAdd(accessToken: string, playlistId: 'WL' | 'LL', videoId: string): Promise<void> {
  await tvCall('browse/edit_playlist', accessToken, {
    playlistId,
    actions: [{ action: 'ACTION_ADD_VIDEO', addedVideoId: videoId }],
  })
}

export async function tvPlaylistRemove(accessToken: string, playlistId: 'WL' | 'LL', videoId: string): Promise<void> {
  await tvCall('browse/edit_playlist', accessToken, {
    playlistId,
    actions: [{ action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: videoId }],
  })
}

export async function tvLike(accessToken: string, videoId: string): Promise<void> {
  await tvCall('like/like', accessToken, { target: { videoId } })
}

export async function tvRemoveLike(accessToken: string, videoId: string): Promise<void> {
  await tvCall('like/removelike', accessToken, { target: { videoId } })
}

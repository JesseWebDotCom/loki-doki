// Resolve a user-pasted YouTube URL / @handle / channel URL into a
// { kind, externalId, title, handle, thumbnailUrl } record using yt-dlp.
// No API key, no login required.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { innertubeResolveChannel } from '@/lib/youtube/innertube'
import { ytDlpBin } from '@/lib/youtube/ytdlp'
import { decodeEntities } from '@/lib/htmlText'

const execFileAsync = promisify(execFile)

export type SubscriptionKind = 'channel' | 'playlist'

export interface ResolvedSubscription {
  kind: SubscriptionKind
  externalId: string    // channel_id (UC…) or playlist_id (PL…)
  title: string
  handle: string | null
  thumbnailUrl: string | null
  description: string | null
}

/** True if this looks like a YouTube playlist URL or PL-prefixed ID. */
function isPlaylist(input: string): boolean {
  return input.includes('list=') || /^PL[A-Za-z0-9_-]{16,}/.test(input)
}

/** Normalize a user input to a resolvable yt-dlp URL. */
function toYtUrl(input: string): string {
  const t = input.trim()
  if (t.startsWith('http://') || t.startsWith('https://')) return t
  if (t.startsWith('@')) return `https://www.youtube.com/${t}`
  if (/^UC[A-Za-z0-9_-]{22}$/.test(t)) return `https://www.youtube.com/channel/${t}`
  if (/^PL[A-Za-z0-9_-]{16,}/.test(t)) return `https://www.youtube.com/playlist?list=${t}`
  if (/^[A-Za-z0-9_-]+$/.test(t)) return `https://www.youtube.com/@${t}`
  return t
}

/** Extract channel_id from a channel URL yt-dlp prints. */
function extractChannelId(url: string | undefined): string | null {
  if (!url) return null
  const m = url.match(/channel\/(UC[A-Za-z0-9_-]{22})/)
  return m ? m[1]! : null
}

/** Resolve a pasted URL / @handle to a subscription record.
 *  Uses `yt-dlp --flat-playlist -I 0 --print channel_url` for channels,
 *  or `--print playlist_id` for playlists. Falls back to HTML scrape on failure. */
export async function resolveYouTubeInput(input: string): Promise<ResolvedSubscription> {
  const url = toYtUrl(input.trim())
  const kind: SubscriptionKind = isPlaylist(url) ? 'playlist' : 'channel'

  // Fast path: InnerTube's resolve_url returns the canonical channel id + metadata as
  // structured JSON. Far more stable than the yt-dlp subprocess / HTML scrape, which we
  // keep as fallbacks. Playlists still go through yt-dlp (no clean InnerTube equivalent).
  if (kind === 'channel') {
    try {
      const meta = await innertubeResolveChannel(url)
      if (meta?.channelId && meta.title) {
        return {
          kind: 'channel',
          externalId: meta.channelId,
          title: meta.title,
          handle: meta.handle,
          thumbnailUrl: meta.thumbnailUrl,
          description: meta.description,
        }
      }
    } catch { /* fall through to yt-dlp */ }
  }

  try {
    if (kind === 'playlist') {
      return await resolvePlaylist(url)
    } else {
      return await resolveChannel(url)
    }
  } catch (err) {
    // Fallback: try HTML scrape for channel_id
    if (kind === 'channel') {
      return await resolveChannelHtml(url)
    }
    throw err
  }
}

interface YtThumb { url?: string; width?: number; height?: number; id?: string }

// `--print` evaluates per *entry*, so `--playlist-items 0` (zero entries) prints
// nothing — which is why channel name/thumbnail used to come back empty and the
// title fell back to the raw URL. `-J` instead dumps the channel/playlist info dict
// itself, which carries the real metadata even with zero entries fetched.
async function ytJson(url: string): Promise<Record<string, any>> {
  const { stdout } = await execFileAsync(ytDlpBin(), [
    '-J', '--flat-playlist', '--playlist-items', '0',
    '--no-warnings', '--quiet', url,
  ], { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 })
  return JSON.parse(stdout) as Record<string, any>
}

// Channel avatars are square; banners are wide. Pick the largest square thumbnail,
// falling back to the explicitly-named uncropped avatar.
function pickAvatar(thumbnails: YtThumb[] | undefined): string | null {
  if (!Array.isArray(thumbnails)) return null
  const squares = thumbnails.filter(t => t?.url && t.width && t.height && t.width === t.height)
  if (squares.length) {
    squares.sort((a, b) => (b.width ?? 0) - (a.width ?? 0))
    return squares[0]!.url!
  }
  return thumbnails.find(t => t?.id === 'avatar_uncropped' && t.url)?.url ?? null
}

async function resolveChannel(url: string): Promise<ResolvedSubscription> {
  const j = await ytJson(url)
  const channelId = (typeof j.channel_id === 'string' && j.channel_id) || extractChannelId(j.channel_url) || extractChannelId(url)
  if (!channelId) throw new Error(`Could not resolve channel_id from: ${url}`)

  const title = decodeEntities((j.channel || j.uploader || j.title || '').toString().trim())
  const uploaderId = (j.uploader_id || '').toString().trim()
  const handle = uploaderId.startsWith('@') ? uploaderId : (uploaderId ? `@${uploaderId}` : null)

  return {
    kind: 'channel',
    externalId: channelId,
    title: title || url,
    handle,
    thumbnailUrl: pickAvatar(j.thumbnails as YtThumb[] | undefined),
    description: (j.description || '').toString().trim() || null,
  }
}

async function resolvePlaylist(url: string): Promise<ResolvedSubscription> {
  const j = await ytJson(url)
  const playlistId = (j.id || '').toString().trim()
  if (!playlistId) throw new Error(`Could not resolve playlist_id from: ${url}`)

  const thumbs = (j.thumbnails as YtThumb[] | undefined) ?? []
  const thumbnailUrl = thumbs.length ? (thumbs[thumbs.length - 1]!.url ?? null) : null

  return {
    kind: 'playlist',
    externalId: playlistId,
    title: decodeEntities((j.title || '').toString().trim()) || url,
    handle: null,
    thumbnailUrl,
    description: (j.description || '').toString().trim() || null,
  }
}

/** Fallback: fetch the channel page HTML and scrape channel_id from it. */
async function resolveChannelHtml(url: string): Promise<ResolvedSubscription> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(10_000),
  })
  const html = await res.text()

  // The channel ID appears as "browseId":"UC..." in the initial page JSON
  const browseMatch = html.match(/"browseId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/)
  const channelId = browseMatch?.[1] ?? null
  if (!channelId) throw new Error(`Could not scrape channel_id from: ${url}`)

  // Best-effort title
  const titleMatch = html.match(/<title>([^<]+)<\/title>/)
  const rawTitle = decodeEntities(titleMatch?.[1]?.replace(' - YouTube', '').trim() ?? url)

  // Avatar URL lives in ytInitialData under "avatar" > "thumbnails"
  const avatarMatch = html.match(/"avatar"\s*:\s*\{"thumbnails"\s*:\s*\[\{"url"\s*:\s*"([^"]+)"/)
  const thumbnailUrl = avatarMatch?.[1]?.replace(/\\u0026/g, '&') ?? null

  // og:description carries the channel's about blurb.
  const descMatch = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i)
    ?? html.match(/<meta\s+property="og:description"\s+content="([^"]*)"/i)
  const description = descMatch?.[1]?.trim() || null

  return {
    kind: 'channel',
    externalId: channelId,
    title: rawTitle,
    handle: null,
    thumbnailUrl,
    description,
  }
}

/** Parse a Google Takeout subscriptions.csv and return channel records. */
export function parseTakeoutCsv(csv: string): ResolvedSubscription[] {
  const lines = csv.split('\n').filter(Boolean)
  const results: ResolvedSubscription[] = []
  for (const line of lines) {
    // Format: Channel Id,Channel Url,Channel Title
    const parts = line.split(',').map(s => s.trim().replace(/^"|"$/g, ''))
    const channelId = parts[0] ?? ''
    const title = parts[2] ?? parts[1] ?? ''
    if (/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) {
      results.push({
        kind: 'channel',
        externalId: channelId,
        title,
        handle: null,
        thumbnailUrl: null,
        description: null,
      })
    }
  }
  return results
}

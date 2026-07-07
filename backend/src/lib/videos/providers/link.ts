// Universal "paste any URL" source. Where the curated providers (YouTube/Reddit/TikTok/
// Vimeo) each know one site, this one leans entirely on yt-dlp's ~1800-site support: paste
// a link from Instagram, X, Bluesky, Twitch clips, a news site's embedded player, a raw
// .mp4 — anything yt-dlp extracts — and it resolves + plays through the unified watch page.
//
// It is NOT part of the URL-sniffing registry (matchUrl returns null): every other provider
// gets first claim on a pasted link, and only what nobody else recognizes falls here — the
// same fall-through the clipper already used, now surfaced as a real hub source so the item
// plays, saves, and downloads like any other. The item id IS the source URL (base64url), so
// there is nothing to persist to resolve it back.

import { cachedLookup } from '@/lib/lookupCache'
import { resolveClip } from '@/lib/clipper/resolve'
import type { VideoProvider } from '@/lib/videos/provider'
import type { PlaybackInfo, VideoItem } from '@/lib/videos/types'

const ITEM_TTL = 30 * 60_000   // resolveClip runs yt-dlp (slow); cache the metadata per URL

// base64url so the URL survives as a path segment (no '/', '+', '=' to escape). The id
// round-trips the full link, so getItem/getPlayback/downloadSpec need no lookup table.
function encodeId(url: string): string {
  return Buffer.from(url, 'utf8').toString('base64url')
}
function decodeId(id: string): string | null {
  try {
    const url = Buffer.from(id, 'base64url').toString('utf8')
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

/** Build a hub item from a resolved arbitrary link. Exported so /resolve can hand the same
 *  shape straight to the client without a second round-trip. */
export async function linkItemFromUrl(url: string): Promise<(VideoItem & { description?: string | null }) | null> {
  return cachedLookup('link:item', url, ITEM_TTL, async () => {
    const meta = await resolveClip(url).catch(() => null)
    if (!meta) return null
    return {
      source: 'link' as const,
      id: encodeId(url),
      url,
      title: meta.title || new URL(url).hostname.replace(/^www\./, ''),
      // The extractor name (e.g. "Instagram", "Twitter") stands in for a creator/badge.
      creator: meta.extractor ? { id: '', name: meta.extractor } : null,
      thumbnailUrl: meta.thumbnailUrl,
      durationSec: meta.durationSeconds,
      meta: { extractor: meta.extractor },
      description: null,
    }
  })
}

export const linkProvider: VideoProvider = {
  source: 'link',
  label: 'Other sites',
  capabilities: {
    browse: false,
    search: false,
    creators: false,
    comments: false,
    live: false,
    downloadKinds: ['audio', 'video'],
    authConfig: 'none',
  },

  // Never sniff-claims a URL: the registry tries the curated providers first, and the
  // /resolve fallback routes anything unclaimed here explicitly.
  matchUrl() {
    return null
  },

  async getItem(id) {
    const url = decodeId(id)
    return url ? linkItemFromUrl(url) : null
  },

  async getPlayback(id): Promise<PlaybackInfo> {
    const url = decodeId(id)
    if (!url) throw new Error('no playable stream for this link')
    // Live yt-dlp pipe: the one strategy that works across arbitrary CDNs (many reject a
    // bare server fetch). The /:source/stream endpoint rewrites this to a stream URL.
    return { mode: 'ytdlp-pipe', pageUrl: url }
  },

  async downloadSpec(id) {
    const url = decodeId(id)
    if (!url) throw new Error('invalid link')
    return { method: 'ytdlp', url }
  },
}

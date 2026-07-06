// Provider registry: the single place the hub learns which sources exist.
// Adding a source = write a provider module + register it here; routes, the
// universal clipper, and the rail all pick it up from this map.

import type { UrlMatch, VideoProvider } from '@/lib/videos/provider'
import type { VideoSource } from '@/lib/videos/types'
import { youtubeProvider } from '@/lib/videos/providers/youtube'
import { redditProvider } from '@/lib/videos/providers/reddit'
import { tiktokProvider } from '@/lib/videos/providers/tiktok'
import { vimeoProvider } from '@/lib/videos/providers/vimeo'

const providers = new Map<VideoSource, VideoProvider>([
  ['youtube', youtubeProvider],
  ['reddit', redditProvider],
  ['tiktok', tiktokProvider],
  ['vimeo', vimeoProvider],
])

export function listProviders(): VideoProvider[] {
  return [...providers.values()]
}

export function getProvider(source: string): VideoProvider | null {
  return providers.get(source as VideoSource) ?? null
}

/** Sniff a pasted URL against every provider (no network). First match wins;
 *  URLs nobody claims fall through to the yt-dlp clipper path. */
export function matchUrlToProvider(raw: string): { provider: VideoProvider; match: UrlMatch } | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  for (const provider of providers.values()) {
    const match = provider.matchUrl(url)
    if (match) return { provider, match }
  }
  return null
}

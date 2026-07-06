// Provider registry: the single place the hub learns which sources exist.
// Adding a source = write a provider module + register it here; routes, the
// universal clipper, and the rail all pick it up from this map.

import type { UrlMatch, VideoProvider } from '@/lib/videos/provider'
import type { VideoSource } from '@/lib/videos/types'
import { getAppSetting, setAppSetting } from '@/lib/settings'
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

// ── Admin: which sources show up on discovery surfaces (rail, home feed, browse) ──
// Disabling a source only hides it from discovery; already-followed/saved items and
// direct playback still work (getProvider/getItem/getPlayback are never gated here).

export const ENABLED_SOURCES_KEY = 'videos.enabled_sources'
// Reddit needs a registered app id before it does anything useful, so it starts off;
// every other source works with zero setup.
const DEFAULT_ENABLED_SOURCES: VideoSource[] = ['youtube', 'tiktok', 'vimeo']

export async function getEnabledSources(): Promise<VideoSource[]> {
  const stored = await getAppSetting(ENABLED_SOURCES_KEY)
  return Array.isArray(stored) ? stored.filter((s): s is VideoSource => providers.has(s as VideoSource)) : DEFAULT_ENABLED_SOURCES
}

export async function setEnabledSources(sources: VideoSource[]): Promise<void> {
  await setAppSetting(ENABLED_SOURCES_KEY, sources.filter((s) => providers.has(s)))
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

// Per-user video view limits (admin-set, kid-focused): switch off up-next autoplay, the
// Shorts feed, and suggestion rails for a specific person. Softer siblings of
// allowlist-only mode (allowlist.ts): these shape HOW the apps behave, the allowlist
// shapes WHAT can be seen. Stored as userPreferences keys, surfaced to the client on
// GET /api/videos/sources, and enforced server-side where a dedicated endpoint exists
// (the suggestions feed returns empty).

import { getUserPref } from '@/lib/contentPolicy'
import { logger } from '@/lib/logger'

export interface VideoViewFlags {
  /** No "Playing next in Ns" countdown; watching ends when the video ends. */
  noAutoplay: boolean
  /** Hide the Shorts vertical feed and Shorts shelves/filters. */
  noShorts: boolean
  /** Hide "Suggested for you" and Popular/Trending discovery rails. */
  noSuggestions: boolean
}

export const VIDEO_FLAG_PREFS: Record<keyof VideoViewFlags, string> = {
  noAutoplay: 'videos.noAutoplay',
  noShorts: 'videos.noShorts',
  noSuggestions: 'videos.noSuggestions',
}

export const DEFAULT_VIDEO_VIEW_FLAGS: VideoViewFlags = { noAutoplay: false, noShorts: false, noSuggestions: false }

const cache = new Map<string, { at: number; flags: VideoViewFlags }>()
const CACHE_MS = 15_000

export function invalidateVideoViewFlags(userId?: string): void {
  if (userId) cache.delete(userId)
  else cache.clear()
}

export async function getVideoViewFlags(userId: string): Promise<VideoViewFlags> {
  const hit = cache.get(userId)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.flags
  const flags = { ...DEFAULT_VIDEO_VIEW_FLAGS }
  try {
    const values = await Promise.all(
      (Object.keys(VIDEO_FLAG_PREFS) as Array<keyof VideoViewFlags>)
        .map(async (k) => [k, await getUserPref(userId, VIDEO_FLAG_PREFS[k])] as const),
    )
    for (const [k, v] of values) flags[k] = v === true
  } catch (err) {
    logger.debug(`[videos/viewFlags] read failed (defaults): ${String(err)}`)
  }
  cache.set(userId, { at: Date.now(), flags })
  return flags
}

// Return YouTube Dislike — YouTube removed the public dislike count in 2021; this
// community service estimates it from extension users + its archived pre-removal data.
// We proxy it server-side (like SponsorBlock) so the browser never reveals which videos
// the user watches to a third party. Public API, no key.

import { logger } from '@/lib/logger'

const API = 'https://returnyoutubedislikeapi.com/votes'

export interface VideoVotes {
  likes: number
  dislikes: number
  rating: number      // 1–5 average
  viewCount: number
}

export async function getVotes(videoId: string, timeout = 6000): Promise<VideoVotes | null> {
  try {
    const res = await fetch(`${API}?videoId=${encodeURIComponent(videoId)}`, {
      headers: { 'User-Agent': 'LokiDoki/1.0' },
      signal: AbortSignal.timeout(timeout),
    })
    if (!res.ok) return null
    const d = (await res.json()) as { likes?: number; dislikes?: number; rating?: number; viewCount?: number }
    if (typeof d?.dislikes !== 'number') return null
    return {
      likes: d.likes ?? 0,
      dislikes: d.dislikes ?? 0,
      rating: d.rating ?? 0,
      viewCount: d.viewCount ?? 0,
    }
  } catch (err) {
    logger.warn(`[youtube/returndislike] lookup failed for ${videoId}: ${err}`)
    return null
  }
}

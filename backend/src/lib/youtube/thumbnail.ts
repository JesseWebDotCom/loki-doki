// Resolve the best REAL thumbnail YouTube actually has for a video. YouTube doesn't
// generate a maxresdefault.jpg (1280x720) for every video — when it doesn't exist,
// i.ytimg.com still returns HTTP 200, but with a tiny (~1-2KB) grey placeholder image
// instead of a 404. So "does maxres exist" has to be answered by checking the real
// response size, not just the status code. hqdefault.jpg (480x360) always exists for
// every video and is the safe floor.

import { logger } from '@/lib/logger'

const MAXRES_URL = (videoId: string) => `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`
const HQ_URL = (videoId: string) => `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`

// The real placeholder is ~1120 bytes; any genuine maxres photo is tens of KB at minimum.
// Exported for the img-proxy cache, which applies the same detection to fetched bytes.
export const PLACEHOLDER_MAX_BYTES = 4000

/** Best-available thumbnail URL for `videoId` — maxresdefault when YouTube actually
 *  generated one, hqdefault otherwise. Costs one HEAD request; call this at points that
 *  happen once per video (a save), not on every browse/search render. */
export async function resolveBestThumbnailUrl(videoId: string): Promise<string> {
  try {
    const res = await fetch(MAXRES_URL(videoId), { method: 'HEAD', signal: AbortSignal.timeout(5000) })
    const len = parseInt(res.headers.get('content-length') ?? '0', 10)
    if (res.ok && len > PLACEHOLDER_MAX_BYTES) return MAXRES_URL(videoId)
  } catch (err) {
    logger.warn(`[youtube] maxres thumbnail check failed for ${videoId}: ${err}`)
  }
  return HQ_URL(videoId)
}

// Pre-fill the image caches for a hub feed the client is about to render.
//
// The hub's mixed home is computed live per request, so there is no "feed refreshed"
// event to hang a warm off - the response itself is the signal. Handlers fire this and
// forget it: the JSON goes out immediately and the server pulls the art while the browser
// is still parsing and laying out the page, so the cards find it cached.
//
// CONTRACT: these must be the exact cache keys the frontend's URLs resolve to.
//   • YouTube items → /api/youtube/img?u=i.ytimg.com/vi/<id>/mqdefault.jpg
//     (lib/prefetch/cardImageUrls → thumbUrl(id, 'mq'), NOT the feed's own thumbnailUrl)
//   • every other source → /api/img?u=<thumbnailUrl>&w=640  (HUB_THUMB_W)
//   • creator avatars → whichever proxy the URL's host selects (proxyImgAuto), so Google
//     avatars go through the YouTube cache at the width the card asks for.
// Get one of these wrong and the warm fills a key nothing ever reads.

import { logger } from '@/lib/logger'
import { warmProxyImages } from '@/lib/imageProxy'
import { warmYoutubeCardImages } from '@/lib/youtube/imageCache'

/** Mirrors HUB_THUMB_W in frontend/src/lib/prefetch/cardImageUrls.ts. */
const HUB_THUMB_W = '640'

const GOOGLE_IMG_HOST = /(^|\.)(ytimg\.com|ggpht\.com|googleusercontent\.com|youtube\.com)$/i

const isGoogleHosted = (url: string): boolean => {
  try { return GOOGLE_IMG_HOST.test(new URL(url).hostname) } catch { return false }
}

type WarmableItem = {
  source: string
  id: string
  thumbnailUrl?: string | null
  creator?: { avatarUrl?: string | null } | null
}

/** Warm a page of hub feed items. Never throws; safe to `void`. */
export async function warmHubCardImages(items: readonly WarmableItem[], limit = 40): Promise<void> {
  try {
    const slice = items.slice(0, limit)
    const ytVideoIds: string[] = []
    const ytAvatars: string[] = []
    const genericThumbs: string[] = []
    const genericAvatars: string[] = []

    for (const it of slice) {
      if (it.source === 'youtube') ytVideoIds.push(it.id)
      else if (it.thumbnailUrl) genericThumbs.push(it.thumbnailUrl)
      const avatar = it.creator?.avatarUrl
      if (avatar) (isGoogleHosted(avatar) ? ytAvatars : genericAvatars).push(avatar)
    }

    await Promise.allSettled([
      warmYoutubeCardImages(ytVideoIds, ytAvatars),
      warmProxyImages(genericThumbs, HUB_THUMB_W),
      // Card avatars are requested at 96 device px (lib/img AVATAR_W).
      warmProxyImages(genericAvatars, '96'),
    ])
  } catch (err) {
    logger.warn(`[videos] hub image warm failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

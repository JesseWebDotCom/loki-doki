// The exact image URLs a rendered feed will request, in render order.
//
// useScrollAheadImages only helps if it warms the SAME URL the card asks for - proxy,
// width and all. Rather than have every page hand-roll that (and silently drift from the
// card the next time a width changes), the mapping lives here, next to nothing else, and
// mirrors what HubCard/HubRow actually render:
//   • non-YouTube items → HubVideoCard/HubVideoListRow → proxyImg(thumbnailUrl, HUB_THUMB_W)
//   • YouTube items     → VideoCard → VideoThumb → ytImageProxy(thumbUrl(videoId, 'mq'))
//   • creator avatars   → CreatorAvatar → avatarImgUrl(avatarUrl)
//
// Not covered: DeArrow's community thumbnails. Those are resolved per video by a hook
// after the card mounts, so a list-level warmer can't know them; the YouTube thumbnail we
// warm is what the card falls back to (and what it shows outright when DeArrow is off).

import { avatarImgUrl, proxyImg } from '@/lib/img'
import { ytImageProxy } from '@/lib/youtube/api'
import { thumbUrl } from '@/lib/youtube/format'
import type { HubVideoItem } from '@/lib/videos/api'
import type { VideoItem } from '@/lib/youtube/types'

/** How many cards at the top of a surface load eagerly instead of lazily. Sized for the
 *  tallest phone's first screen (a 2-up grid shows ~4, a rail ~3) with a little slack. */
export const EAGER_CARDS = 6

/** Same, for a horizontal rail: only two or three cards are on screen at once, and a page
 *  stacks several rails, so this stays small. Lazy loading hurts most here - a browser's
 *  lazy lookahead barely extends past the right edge of a horizontal scroller, which is
 *  why rail art seemed to appear exactly as you swiped to it. */
export const EAGER_RAIL_CARDS = 3

/** Device-pixel width every hub thumbnail is requested at. Card and list row share it so
 *  switching views reuses the warmed bytes instead of fetching a second size. */
export const HUB_THUMB_W = 640

/** Thumbnail + avatar for each hub item, thumbnail first so the top cards complete first. */
export function hubItemImageUrls(items: readonly HubVideoItem[]): string[] {
  const out: string[] = []
  for (const it of items) {
    if (it.source === 'youtube') out.push(ytImageProxy(thumbUrl(it.id, 'mq')))
    else if (it.thumbnailUrl) out.push(proxyImg(it.thumbnailUrl, HUB_THUMB_W))
    if (it.creator?.avatarUrl) out.push(avatarImgUrl(it.creator.avatarUrl))
  }
  return out
}

/** Same, for surfaces that render YouTube's own VideoCard from VideoItem[]. */
export function ytItemImageUrls(items: readonly VideoItem[]): string[] {
  const out: string[] = []
  for (const it of items) {
    out.push(ytImageProxy(thumbUrl(it.videoId, 'mq')))
    if (it.channelThumb) out.push(avatarImgUrl(it.channelThumb))
  }
  return out
}

import { VideoCard, VideoListRow } from '@/components/youtube/VideoCard'
import { HubVideoCard } from '@/components/videos/HubVideoCard'
import { HubVideoListRow } from '@/components/videos/HubVideoListRow'
import { SOURCE_META } from '@/lib/videos/sources'
import type { HubHistoryRow, HubVideoItem } from '@/lib/videos/api'
import type { VideoItem } from '@/lib/youtube/types'

/** Map a hub item onto the YouTube card's shape so YouTube items keep the richer VideoCard
 *  (hover-preview clip, one-click save, watch-progress) inside mixed hub surfaces. */
export function hubToYtItem(it: HubVideoItem): VideoItem {
  return {
    videoId: it.id,
    title: it.title,
    author: it.creator?.name ?? null,
    channelId: it.creator?.id ?? null,
    channelThumb: it.creator?.avatarUrl ?? null,
    durationSec: it.durationSec ?? null,
    ageLabel: it.publishedText ?? undefined,
    // Popular/Trending sometimes omit publishedText but carry a raw timestamp — VideoCard's
    // fmtAge(publishedAt) fallback covers it so the date isn't just silently missing.
    publishedAt: it.publishedAt ?? null,
    views: it.viewsText ?? null,
    watch: it.watch ?? undefined,
  }
}

/** The inverse of `hubToYtItem`: lifts a YouTube feed item into the hub's source-agnostic
 *  shape so it can merge with Reddit/TikTok/Vimeo items into one mixed list (e.g. the
 *  unified Subscriptions feed) and render through HubCard/HubRow like everything else. */
export function ytItemToHub(it: VideoItem): HubVideoItem {
  return {
    source: 'youtube',
    id: it.videoId,
    url: `https://www.youtube.com/watch?v=${it.videoId}`,
    title: it.title,
    creator: it.channelId || it.author
      ? { id: it.channelId ?? '', name: it.author ?? '', avatarUrl: it.channelThumb ?? null }
      : null,
    durationSec: it.durationSec ?? null,
    publishedAt: it.publishedAt ?? null,
    publishedText: it.ageLabel ?? null,
    viewsText: it.views ?? null,
    watch: it.watch ?? null,
  }
}

/** Non-YouTube watch-history row → hub item, for the merged Continue-watching shelf.
 *  `url` is left blank: the shelf card navigates by source+id, and the watch page resolves
 *  the real external url itself. */
export function hubHistoryToItem(h: HubHistoryRow): HubVideoItem {
  return {
    source: h.source,
    id: h.videoId,
    url: '',
    title: h.title,
    creator: h.creatorName ? { id: h.creatorId ?? '', name: h.creatorName, avatarUrl: h.creatorAvatarUrl } : null,
    thumbnailUrl: h.thumbnailUrl,
    durationSec: h.durationSec,
    watch: { positionSec: h.positionSec, completed: h.completed },
  }
}

/** One card for any mixed hub surface (home feed, shelves, search). YouTube items render as
 *  the full VideoCard — so hover-to-preview works everywhere, not just the main grid — with
 *  a source badge added (VideoCard has none of its own); every other source uses HubVideoCard.
 *  `shape` keeps them the same size. */
export function HubCard({ item, shape, showSource = true, eager }: { item: HubVideoItem; shape?: 'wide' | 'tall'; showSource?: boolean; eager?: boolean }) {
  if (item.source !== 'youtube') return <HubVideoCard item={item} shape={shape} showSource={showSource} eager={eager} />
  return (
    <div className="relative">
      {showSource && (
        <span className={`pointer-events-none absolute left-1.5 top-1.5 z-10 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${SOURCE_META.youtube.badgeClass}`}>
          <SOURCE_META.youtube.icon className="size-2.5" aria-hidden /> YouTube
        </span>
      )}
      <VideoCard item={hubToYtItem(item)} shape={shape} eager={eager} />
    </div>
  )
}

/** List-row counterpart of HubCard. */
export function HubRow({ item, showSource = true, eager }: { item: HubVideoItem; showSource?: boolean; eager?: boolean }) {
  return item.source === 'youtube'
    ? <VideoListRow item={hubToYtItem(item)} eager={eager} />
    : <HubVideoListRow item={item} showSource={showSource} eager={eager} />
}

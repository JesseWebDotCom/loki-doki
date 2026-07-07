import { VideoCard, VideoListRow } from '@/components/youtube/VideoCard'
import { HubVideoCard } from '@/components/videos/HubVideoCard'
import { HubVideoListRow } from '@/components/videos/HubVideoListRow'
import { SOURCE_META } from '@/lib/videos/sources'
import type { HubVideoItem } from '@/lib/videos/api'
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
    views: it.viewsText ?? null,
  }
}

/** One card for any mixed hub surface (home feed, shelves, search). YouTube items render as
 *  the full VideoCard — so hover-to-preview works everywhere, not just the main grid — with
 *  a source badge added (VideoCard has none of its own); every other source uses HubVideoCard.
 *  `shape` keeps them the same size. */
export function HubCard({ item, shape, showSource = true }: { item: HubVideoItem; shape?: 'wide' | 'tall'; showSource?: boolean }) {
  if (item.source !== 'youtube') return <HubVideoCard item={item} shape={shape} showSource={showSource} />
  return (
    <div className="relative">
      {showSource && (
        <span className={`pointer-events-none absolute left-1.5 top-1.5 z-10 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${SOURCE_META.youtube.badgeClass}`}>
          <SOURCE_META.youtube.icon className="size-2.5" aria-hidden /> YouTube
        </span>
      )}
      <VideoCard item={hubToYtItem(item)} shape={shape} />
    </div>
  )
}

/** List-row counterpart of HubCard. */
export function HubRow({ item, showSource = true }: { item: HubVideoItem; showSource?: boolean }) {
  return item.source === 'youtube'
    ? <VideoListRow item={hubToYtItem(item)} />
    : <HubVideoListRow item={item} showSource={showSource} />
}

import { Link } from 'react-router-dom'
import { Film } from 'lucide-react'
import { cn } from '@/lib/cn'
import { proxyImg } from '@/lib/img'
import { fmtAge, fmtDur } from '@/lib/youtube/format'
import { toast } from '@/lib/toast'
import type { HubVideoItem } from '@/lib/videos/api'
import { SOURCE_META } from '@/lib/videos/sources'
import { CardMetaBlock, DurationBadge, OnlineOnlyBadge, WatchProgressBar } from '@/components/videos/cardParts'
import { HUB_PATHS, useOfflineSet } from '@/components/videos/HubVideoCard'
import { useYoutubeModeOptional } from '@/components/videos/VideosLayout'

/** Full-width horizontal list row, matching HubVideoCard's grid card layout: the list
 *  counterpart used when the view toggle is set to "list" (mirrors youtube's VideoListRow). */
export function HubVideoListRow({ item, showSource = true }: { item: HubVideoItem; showSource?: boolean }) {
  const dur = fmtDur(item.durationSec)
  const progress = item.watch && !item.watch.completed && item.durationSec ? Math.min(1, item.watch.positionSec / item.durationSec) : 0
  // Kept apart (not one joined+truncated string) so a very long creator name only eats
  // into itself — views/date stay fully visible instead of getting truncated away with it.
  const creatorName = item.creator?.name ?? null
  const metaSuffix = [item.viewsText, item.publishedText ?? fmtAge(item.publishedAt)].filter(Boolean).join(' · ')
  const badge = SOURCE_META[item.source]
  const mode = useYoutubeModeOptional()
  const offline = useOfflineSet()
  const ghosted = mode === 'offline' && !offline.has(`${item.source}:${item.id}`)

  return (
    <Link
      to={HUB_PATHS[item.source].watch(item.id)}
      className={cn('group flex gap-3 rounded-card p-1.5 transition-colors hover:bg-accent/50 sm:gap-4', ghosted && 'opacity-45 saturate-50')}
      onClick={(e) => {
        if (ghosted) { e.preventDefault(); toast.info('Online only. Switch to Online or save it offline first.') }
      }}
    >
      {/* List rows are always small horizontal (16:9) cards, uniform across sources — a
          vertical item's thumbnail simply crops to fit (matches youtube's VideoListRow). */}
      <div className="relative aspect-video w-40 shrink-0 overflow-hidden rounded-card bg-muted sm:w-56">
        {item.thumbnailUrl ? (
          <img src={proxyImg(item.thumbnailUrl)} alt="" loading="lazy" className="size-full object-cover transition group-hover:scale-105" />
        ) : (
          <div className="flex size-full items-center justify-center"><Film className="size-8 text-muted-foreground/40" /></div>
        )}
        {showSource && (
          <span className={cn('absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold', badge.badgeClass)}>
            <badge.icon className="size-2.5" aria-hidden /> {badge.label}
          </span>
        )}
        {ghosted && <OnlineOnlyBadge />}
        <DurationBadge label={dur} />
        <WatchProgressBar progress={progress} completed={item.watch?.completed} />
      </div>
      <CardMetaBlock layout="row" title={item.title} creatorName={creatorName} creatorAvatarUrl={item.creator?.avatarUrl} metaSuffix={metaSuffix} ghosted={ghosted} />
    </Link>
  )
}

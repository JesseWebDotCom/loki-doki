import { Link } from 'react-router-dom'
import { CloudOff, Film } from 'lucide-react'
import { cn } from '@/lib/cn'
import { proxyImg } from '@/lib/img'
import { toast } from '@/lib/toast'
import type { HubVideoItem } from '@/lib/videos/api'
import { SOURCE_META } from '@/lib/videos/sources'
import { HUB_PATHS, useOfflineSet } from '@/components/videos/HubVideoCard'
import { useYoutubeModeOptional } from '@/components/videos/VideosLayout'

function fmtDur(sec?: number | null): string | null {
  if (sec == null || sec <= 0) return null
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60)
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

/** Full-width horizontal list row, matching HubVideoCard's grid card layout: the list
 *  counterpart used when the view toggle is set to "list" (mirrors youtube's VideoListRow). */
export function HubVideoListRow({ item, showSource = true }: { item: HubVideoItem; showSource?: boolean }) {
  const dur = fmtDur(item.durationSec)
  const metaLine = [item.creator?.name, item.viewsText, item.publishedText].filter(Boolean).join(' · ')
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
      <div className={cn('relative shrink-0 overflow-hidden rounded-card bg-muted', item.vertical ? 'w-24 aspect-[9/16] sm:w-28' : 'w-40 aspect-video sm:w-56')}>
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
        {ghosted && (
          <span className="absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-semibold text-white">
            <CloudOff className="size-2.5" aria-hidden /> Online only
          </span>
        )}
        {dur && (
          <span className="absolute bottom-1.5 right-1.5 rounded-full bg-black/80 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white">{dur}</span>
        )}
      </div>
      <div className="min-w-0 flex-1 py-0.5">
        <p className="line-clamp-2 text-sm font-semibold leading-snug sm:text-[15px]">{item.title}</p>
        {metaLine && <p className="mt-1 truncate text-xs text-muted-foreground">{metaLine}</p>}
      </div>
    </Link>
  )
}

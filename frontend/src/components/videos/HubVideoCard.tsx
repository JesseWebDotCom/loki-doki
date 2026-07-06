import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { CloudOff, Film } from 'lucide-react'
import { cn } from '@/lib/cn'
import { proxyImg } from '@/lib/img'
import { toast } from '@/lib/toast'
import { listSaves, type HubVideoItem } from '@/lib/videos/api'
import { SOURCE_META } from '@/lib/videos/sources'
import { useYoutubeModeOptional } from '@/components/videos/VideosLayout'

/** Ready offline renditions keyed source:videoId (one shared query, cached). */
function useOfflineSet(): Set<string> {
  const { data } = useQuery({ queryKey: ['videos-saves', 'all'], queryFn: () => listSaves(), staleTime: 30_000 })
  return new Set((data?.saves ?? []).filter((s) => s.status === 'ready').map((s) => `${s.source}:${s.videoId}`))
}

/** Deep-link targets per source (creator paths differ per source vocabulary). */
export const HUB_PATHS = {
  youtube: { watch: (id: string) => `/videos/youtube/watch/${encodeURIComponent(id)}`, creator: (id: string) => `/videos/youtube/channel/${encodeURIComponent(id)}` },
  reddit: { watch: (id: string) => `/videos/reddit/watch/${encodeURIComponent(id)}`, creator: (id: string) => `/videos/reddit/r/${encodeURIComponent(id)}` },
  tiktok: { watch: (id: string) => `/videos/tiktok/watch/${encodeURIComponent(id)}`, creator: (id: string) => `/videos/tiktok/creator/${encodeURIComponent(id)}` },
  vimeo: { watch: (id: string) => `/videos/vimeo/watch/${encodeURIComponent(id)}`, creator: (id: string) => `/videos/vimeo/channel/${encodeURIComponent(id)}` },
} as const


function fmtDur(sec?: number | null): string | null {
  if (sec == null || sec <= 0) return null
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60)
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

function fmtAge(ms?: number | null): string | null {
  if (!ms) return null
  const days = Math.floor((Date.now() - ms) / 86_400_000)
  if (days < 1) return 'today'
  if (days < 30) return `${days}d ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

/** Card for non-YouTube hub items (YouTube items keep the richer VideoCard). Shows a
 *  source badge in mixed contexts; omit it inside a single source's own browse area. */
export function HubVideoCard({ item, showSource = true }: { item: HubVideoItem; showSource?: boolean }) {
  const dur = fmtDur(item.durationSec)
  const metaLine = [item.creator?.name, item.viewsText, item.publishedText ?? fmtAge(item.publishedAt)]
    .filter(Boolean).join(' · ')
  const badge = SOURCE_META[item.source]
  // Offline mode: items without a ready local save ghost out instead of dead-ending.
  const mode = useYoutubeModeOptional()
  const offline = useOfflineSet()
  const ghosted = mode === 'offline' && !offline.has(`${item.source}:${item.id}`)

  return (
    <Link
      to={HUB_PATHS[item.source].watch(item.id)}
      className={cn('group flex flex-col gap-2.5', ghosted && 'opacity-45 saturate-50')}
      onClick={(e) => {
        if (ghosted) { e.preventDefault(); toast.info('Online only. Switch to Online or save it offline first.') }
      }}
    >
      <div className={cn(
        'relative w-full overflow-hidden rounded-card bg-muted',
        item.vertical ? 'aspect-[9/16] max-h-72' : 'aspect-video',
      )}>
        {item.thumbnailUrl ? (
          <img src={proxyImg(item.thumbnailUrl)} alt="" loading="lazy"
            className="size-full object-cover transition-transform duration-200 group-hover:scale-[1.03]" />
        ) : (
          <div className="flex size-full items-center justify-center">
            <Film className="size-8 text-muted-foreground/50" />
          </div>
        )}
        {ghosted && (
          <span className="absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-semibold text-white">
            <CloudOff className="size-2.5" aria-hidden /> Online only
          </span>
        )}
        {showSource && (
          <span className={cn('absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold', badge.badgeClass)}>
            <badge.icon className="size-2.5" aria-hidden /> {badge.label}
          </span>
        )}
        {dur && (
          <span className="absolute bottom-1.5 right-1.5 rounded-full bg-black/80 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white">{dur}</span>
        )}
      </div>
      <div className="min-w-0">
        <p className="line-clamp-2 text-sm font-semibold leading-snug text-foreground">{item.title}</p>
        {metaLine && <p className="mt-1 truncate text-xs text-muted-foreground">{metaLine}</p>}
      </div>
    </Link>
  )
}

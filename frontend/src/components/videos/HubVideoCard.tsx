import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, CloudOff, Film, HardDriveDownload } from 'lucide-react'
import { cn } from '@/lib/cn'
import { proxyImg } from '@/lib/img'
import { Spinner } from '@/components/ui/spinner'
import { CreatorAvatar } from '@/components/videos/CreatorAvatar'
import { toast } from '@/lib/toast'
import { listSaves, saveVideo, type HubVideoItem } from '@/lib/videos/api'
import { SOURCE_META } from '@/lib/videos/sources'
import { useYoutubeModeOptional } from '@/components/videos/VideosLayout'

/** Ready offline renditions keyed source:videoId (one shared query, cached). */
export function useOfflineSet(): Set<string> {
  const { data } = useQuery({ queryKey: ['videos-saves', 'all'], queryFn: () => listSaves(), staleTime: 30_000 })
  return new Set((data?.saves ?? []).filter((s) => s.status === 'ready').map((s) => `${s.source}:${s.videoId}`))
}

/** Deep-link targets per source (creator paths differ per source vocabulary). */
export const HUB_PATHS = {
  youtube: { watch: (id: string) => `/videos/youtube/watch/${encodeURIComponent(id)}`, creator: (id: string) => `/videos/youtube/channel/${encodeURIComponent(id)}` },
  reddit: { watch: (id: string) => `/videos/reddit/watch/${encodeURIComponent(id)}`, creator: (id: string) => `/videos/reddit/r/${encodeURIComponent(id)}` },
  tiktok: { watch: (id: string) => `/videos/tiktok/watch/${encodeURIComponent(id)}`, creator: (id: string) => `/videos/tiktok/creator/${encodeURIComponent(id)}` },
  vimeo: { watch: (id: string) => `/videos/vimeo/watch/${encodeURIComponent(id)}`, creator: (id: string) => `/videos/vimeo/channel/${encodeURIComponent(id)}` },
  // 'link' items deep-link to the unified watch page; they have no creator pages.
  link: { watch: (id: string) => `/videos/link/watch/${encodeURIComponent(id)}`, creator: (id: string) => `/videos/link/watch/${encodeURIComponent(id)}` },
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
export function HubVideoCard({ item, showSource = true, shape, interactive = true, savingLabel }: {
  item: HubVideoItem
  showSource?: boolean
  shape?: 'wide' | 'tall'
  /** Show the hover preview + one-click Save. Off where the card is display-only (e.g. the
   *  Offline page, which manages its own saving/remove state). */
  interactive?: boolean
  /** When set, the card renders as a still-downloading item: grayscale with a centered
   *  spinner + this label over the thumbnail, matching the YouTube "Downloading…" card. */
  savingLabel?: string
}) {
  const dur = fmtDur(item.durationSec)
  const metaLine = [item.creator?.name, item.viewsText, item.publishedText ?? fmtAge(item.publishedAt)]
    .filter(Boolean).join(' · ')
  const badge = SOURCE_META[item.source]
  // Offline mode: items without a ready local save ghost out instead of dead-ending.
  const mode = useYoutubeModeOptional()
  const offline = useOfflineSet()
  const ghosted = mode === 'offline' && !offline.has(`${item.source}:${item.id}`)
  const saved = offline.has(`${item.source}:${item.id}`)
  const qc = useQueryClient()
  const saveMutation = useMutation({
    mutationFn: () => saveVideo(item.source, item.id, 'video'),
    onSuccess: () => { toast.success('Saving offline'); void qc.invalidateQueries({ queryKey: ['videos-saves'] }) },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not save'),
  })
  // A landscape item forced into a tall card is letterboxed over a blurred fill of itself,
  // so it reads as a normal video and not a vertical short.
  const letterbox = shape === 'tall' && !item.vertical

  // Hover-to-preview via each source's official embed. Vimeo's "background" player is muted
  // by design; TikTok's player autoplays (the browser forces muted autoplay without a user
  // gesture, so it won't blast audio). Reddit would need its HLS stream, so it's skipped.
  const previewUrl = ghosted || !interactive ? null
    : item.source === 'vimeo' ? `https://player.vimeo.com/video/${encodeURIComponent(item.id)}?background=1&autoplay=1`
    : item.source === 'tiktok' ? `https://www.tiktok.com/player/v1/${encodeURIComponent(item.id)}?autoplay=1&loop=1&controls=0&music_info=0&description=0&rel=0`
    : null
  const [previewing, setPreviewing] = useState(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startPreview = () => { if (previewUrl) hoverTimer.current = setTimeout(() => setPreviewing(true), 450) }
  const stopPreview = () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); setPreviewing(false) }

  return (
    <Link
      to={HUB_PATHS[item.source].watch(item.id)}
      className={cn('group flex flex-col gap-2.5', ghosted && 'opacity-45 saturate-50', savingLabel && 'grayscale')}
      onMouseEnter={startPreview}
      onMouseLeave={stopPreview}
      onClick={(e) => {
        if (ghosted) { e.preventDefault(); toast.info('Online only. Switch to Online or save it offline first.') }
      }}
    >
      <div className={cn(
        'relative w-full overflow-hidden rounded-card bg-muted',
        // The uniform view toggle forces one shape on EVERY source (object-cover crops to fit);
        // with no toggle context we fall back to the item's native orientation.
        shape === 'tall' ? 'aspect-[9/16]'
          : shape === 'wide' ? 'aspect-video'
          : item.vertical ? 'aspect-[9/16] max-h-72' : 'aspect-video',
      )}>
        {item.thumbnailUrl ? (
          letterbox ? (
            <>
              <img src={proxyImg(item.thumbnailUrl)} aria-hidden alt="" loading="lazy"
                className="absolute inset-0 size-full scale-125 object-cover blur-2xl" />
              <div className="pointer-events-none absolute inset-0 bg-black/20" />
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="relative aspect-video w-full overflow-hidden">
                  <img src={proxyImg(item.thumbnailUrl)} alt="" loading="lazy"
                    className="size-full object-cover transition-transform duration-200 group-hover:scale-[1.03]" />
                </div>
              </div>
            </>
          ) : (
            <img src={proxyImg(item.thumbnailUrl)} alt="" loading="lazy"
              className="size-full object-cover transition-transform duration-200 group-hover:scale-[1.03]" />
          )
        ) : (
          <div className="flex size-full items-center justify-center">
            <Film className="size-8 text-muted-foreground/50" />
          </div>
        )}
        {previewUrl && previewing && (
          // pointer-events-none so a click still falls through to the card's watch link.
          <iframe src={previewUrl} title="" allow="autoplay" loading="lazy"
            className="pointer-events-none absolute inset-0 size-full border-0" />
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
        {savingLabel && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/40 text-white">
            <Spinner size="sm" className="text-white" />
            <span className="text-xs font-medium">{savingLabel}</span>
          </div>
        )}
        {!ghosted && interactive && (
          // One-click Save to the Offline library (hover-revealed; stays visible once saved).
          <button type="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (!saved && !saveMutation.isPending) saveMutation.mutate() }}
            title={saved ? 'Saved offline' : 'Save offline'}
            aria-label={saved ? 'Saved offline' : 'Save offline'}
            className={cn('absolute right-1.5 top-1.5 grid size-7 place-items-center rounded-full text-white transition-all',
              saved ? 'bg-[var(--yt-accent)] opacity-100'
                : saveMutation.isPending ? 'bg-black/75 opacity-100'
                : 'bg-black/75 opacity-0 hover:bg-black/90 group-hover:opacity-100')}>
            {saveMutation.isPending ? <Spinner className="size-3.5 text-white" /> : saved ? <Check className="size-3.5" /> : <HardDriveDownload className="size-3.5" />}
          </button>
        )}
      </div>
      <div className="flex gap-2.5">
        {item.creator?.avatarUrl && (
          <CreatorAvatar title={item.creator.name} src={item.creator.avatarUrl}
            className={cn('mt-0.5 size-8 shrink-0 text-[10px] ring-1 ring-border/40', ghosted && 'grayscale')} />
        )}
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm font-semibold leading-snug text-foreground">{item.title}</p>
          {metaLine && <p className="mt-1 truncate text-xs text-muted-foreground">{metaLine}</p>}
        </div>
      </div>
    </Link>
  )
}

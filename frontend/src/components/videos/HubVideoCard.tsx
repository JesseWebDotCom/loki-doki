import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { cn } from '@/lib/cn'
import { proxyImg } from '@/lib/img'
import { fmtAge, fmtDur } from '@/lib/youtube/format'
import { Spinner } from '@/components/ui/spinner'
import { CardMetaBlock, DurationBadge, OnlineOnlyBadge, SaveOfflineButton, WatchProgressBar } from '@/components/videos/cardParts'
import { VideoPlaceholderArt } from '@/components/videos/VideoPlaceholderArt'
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
  const progress = item.watch && !item.watch.completed && item.durationSec ? Math.min(1, item.watch.positionSec / item.durationSec) : 0
  // Kept apart (not one joined+truncated string) so a very long creator name only eats
  // into itself — views/date stay fully visible instead of getting truncated away with it.
  const creatorName = item.creator?.name ?? null
  const metaSuffix = [item.viewsText, item.publishedText ?? fmtAge(item.publishedAt)].filter(Boolean).join(' · ')
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
  // Hold the iframe transparent until it finishes loading; an iframe paints an opaque white
  // background while its embed boots, which would otherwise flash over the thumbnail.
  const [previewReady, setPreviewReady] = useState(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startPreview = () => { if (previewUrl) hoverTimer.current = setTimeout(() => setPreviewing(true), 450) }
  const stopPreview = () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); setPreviewing(false); setPreviewReady(false) }

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
        'relative w-full overflow-hidden rounded-card shadow-md ring-1 ring-white/10 transition duration-200 group-hover:shadow-xl group-hover:ring-white/20',
        // The uniform view toggle forces one shape on EVERY source (object-cover crops to fit);
        // with no toggle context we fall back to the item's native orientation.
        shape === 'tall' ? 'aspect-[9/16]'
          : shape === 'wide' ? 'aspect-video'
          : item.vertical ? 'aspect-[9/16] max-h-72' : 'aspect-video',
      )}>
        {/* Bottom of the stack: source-identity art so loading/missing thumbs never show a hole. */}
        <VideoPlaceholderArt source={item.source} />
        {item.thumbnailUrl && (
          letterbox ? (
            <>
              <img src={proxyImg(item.thumbnailUrl, 640)} aria-hidden alt="" loading="lazy"
                className="absolute inset-0 size-full scale-125 object-cover blur-2xl" />
              <div className="pointer-events-none absolute inset-0 bg-black/20" />
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="relative aspect-video w-full overflow-hidden">
                  <img src={proxyImg(item.thumbnailUrl, 640)} alt="" loading="lazy"
                    className="size-full object-cover transition-transform duration-200 group-hover:scale-[1.03]" />
                </div>
              </div>
            </>
          ) : (
            <img src={proxyImg(item.thumbnailUrl, 640)} alt="" loading="lazy"
              className="relative size-full object-cover transition-transform duration-200 group-hover:scale-[1.03]" />
          )
        )}
        {previewUrl && previewing && (
          // pointer-events-none so a click still falls through to the card's watch link.
          // Fades in on load so the thumbnail shows through instead of a white flash.
          <iframe src={previewUrl} title="" allow="autoplay" loading="lazy"
            onLoad={() => setPreviewReady(true)}
            className={cn('pointer-events-none absolute inset-0 size-full border-0 transition-opacity duration-200',
              previewReady ? 'opacity-100' : 'opacity-0')} />
        )}
        {ghosted && <OnlineOnlyBadge />}
        {showSource && (
          <span className={cn('absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold', badge.badgeClass)}>
            <badge.icon className="size-2.5" aria-hidden /> {badge.label}
          </span>
        )}
        <DurationBadge label={dur} />
        <WatchProgressBar progress={progress} completed={item.watch?.completed} />
        {savingLabel && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/40 text-white">
            <Spinner size="sm" className="text-white" />
            <span className="text-xs font-medium">{savingLabel}</span>
          </div>
        )}
        {!ghosted && interactive && (
          // One-click Save to the Offline library (hover-revealed; stays visible once saved).
          <SaveOfflineButton
            state={saved ? 'saved' : saveMutation.isPending ? 'saving' : null}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (!saved && !saveMutation.isPending) saveMutation.mutate() }}
          />
        )}
      </div>
      <CardMetaBlock title={item.title} creatorName={creatorName} creatorAvatarUrl={item.creator?.avatarUrl} metaSuffix={metaSuffix} ghosted={ghosted} />
    </Link>
  )
}

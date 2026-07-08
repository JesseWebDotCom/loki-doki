import { useState, type MouseEvent } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, CloudOff, Download, Sparkles } from 'lucide-react'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { Spinner } from '@/components/ui/spinner'
import { fmtAge, fmtDur, fmtViews } from '@/lib/youtube/format'
import { watchProgress, type VideoItem } from '@/lib/youtube/types'
import { saveOffline, cancelDownloads } from '@/lib/youtube/api'
import { useSavedState, useYtDownloads } from '@/lib/youtube/useData'
import { VideoThumb } from '@/components/youtube/media'
import { CardMetaBlock, DurationBadge, SaveOfflineButton, WatchProgressBar } from '@/components/videos/cardParts'
import { useYoutubeModeOptional, useYoutubeUIOptional } from '@/components/videos/VideosLayout'
import { useDeArrow } from '@/lib/youtube/dearrow'
import { useCardHoverPreview } from '@/hooks/use-card-hover-preview'
import { AddToPlaylistButton } from '@/components/youtube/AddToPlaylistButton'

/** Where a card navigates: the full-page watch route, preserving offline kind. */
export function watchHref(i: Pick<VideoItem, 'videoId' | 'localKind'>) {
  return i.localKind ? `/videos/youtube/watch/${i.videoId}?k=${i.localKind}` : `/videos/youtube/watch/${i.videoId}`
}

/** Offline mode + no local copy means the card is "ghosted": shown for continuity
 *  (history, related rows) but greyed out and non-navigating, since it can't play.
 *  Tapping it offers to queue a download instead (saved when back online). */
function useGhost(item: Pick<VideoItem, 'videoId' | 'title' | 'localKind'>) {
  const ghosted = useYoutubeModeOptional() === 'offline' && !item.localKind
  const ui = useYoutubeUIOptional()
  const onClick = () => ui ? ui.openSave(item.videoId, item.title) : toast.info('Not available offline')
  return { ghosted, onClick }
}

/** One-click "Save offline": queues a server-side yt-dlp download of this video at the user's
 *  default Save quality — no dialog. Returns `onSave: undefined` when the item is already a local
 *  file (nothing to save). Reflects live progress via the shared downloads cache. */
function useCardSave(item: Pick<VideoItem, 'videoId' | 'localKind'>, title: string) {
  const qc = useQueryClient()
  const { data: downloads } = useYtDownloads()
  const saved = useSavedState(item.videoId)
  const [saving, setSaving] = useState(false)
  const saveState: 'saved' | 'saving' | null = saving ? 'saving' : saved
  // Already-offline items (local files) have nothing to save.
  if (item.localKind) return { saveState: 'saved' as const, onSave: undefined }
  const onSave = async (e: MouseEvent) => {
    // The card body is a <Link>; keep the click from navigating.
    e.preventDefault(); e.stopPropagation()
    if (saveState === 'saved') return
    // Clicking while a save is in flight cancels it (SIGTERM the download, drop the ref).
    if (saveState === 'saving') {
      const row = downloads?.find(r => r.videoId === item.videoId && (r.status === 'pending' || r.status === 'downloading'))
      if (!row) return
      try {
        await cancelDownloads([row.id])
        toast.success('Save canceled')
        qc.invalidateQueries({ queryKey: ['yt-downloads'] })
      } catch { toast.error('Could not cancel') }
      return
    }
    setSaving(true)
    try {
      const d = await saveOffline({ videoId: item.videoId, title, kind: 'video' })
      if (d.error) { toast.error(d.error); return }
      toast.success(d.status === 'already-saved' ? 'Already saved offline' : 'Saving offline — find it under Offline')
      qc.invalidateQueries({ queryKey: ['yt-downloads'] })
    } catch { toast.error('Could not save') } finally { setSaving(false) }
  }
  return { saveState, onSave }
}

function Thumb({ i, aspect, shape, ghosted, overrideSrc, previewSrc, saveState, onSave }: { i: VideoItem; aspect: 'video' | 'short'; shape?: 'wide' | 'tall'; ghosted?: boolean; overrideSrc?: string | null; previewSrc?: string | null; saveState?: 'saved' | 'saving' | null; onSave?: (e: MouseEvent) => void }) {
  const dur = fmtDur(i.durationSec)
  const progress = watchProgress(i)
  // Fades in once the preview clip is actually decoding a frame, rather than the instant
  // its <video> mounts, so there's no flash of a black/blank box while it buffers.
  const [previewReady, setPreviewReady] = useState(false)
  // The uniform toggle forces the card shape; `aspect` still marks true Shorts (9:16 content).
  const cardTall = shape === 'tall' || (shape === undefined && aspect === 'short')
  // A regular (landscape) video shown in a tall card is letterboxed over a blurred fill of
  // itself, so it reads clearly as a normal video and NOT a Short.
  const letterbox = cardTall && aspect !== 'short'
  const media = (
    <>
      <VideoThumb videoId={i.videoId} title={i.title} overrideSrc={overrideSrc} className={cn('size-full transition-transform duration-500', ghosted ? 'grayscale' : 'group-hover:scale-[1.03]')} />
      {previewSrc && !ghosted && (
        <video
          key={previewSrc} src={previewSrc} muted autoPlay loop playsInline preload="auto"
          className={cn('absolute inset-0 size-full object-cover transition-opacity duration-200', previewReady ? 'opacity-100' : 'opacity-0')}
          onPlaying={() => setPreviewReady(true)}
          onError={() => setPreviewReady(false)}
        />
      )}
    </>
  )
  return (
    <div className={cn('relative overflow-hidden rounded-card bg-muted', cardTall ? 'aspect-[9/16]' : 'aspect-video')}>
      {letterbox ? (
        <>
          <VideoThumb videoId={i.videoId} title="" overrideSrc={overrideSrc} className="absolute inset-0 size-full scale-125 object-cover blur-2xl" />
          <div className="pointer-events-none absolute inset-0 bg-black/20" />
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="relative aspect-video w-full overflow-hidden">{media}</div>
          </div>
        </>
      ) : media}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
      {i.watch?.completed && (
        <div className="pointer-events-none absolute inset-0 bg-black/40" />
      )}
      {ghosted ? (
        <>
          <span className="absolute left-2 top-2 flex items-center gap-1 rounded-full bg-black/75 px-1.5 py-0.5 text-[10px] font-semibold text-white">
            <CloudOff className="size-3" /> Online only
          </span>
          {/* The card itself is the button; this is just the visible "you can save it" cue. */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
            <span className="flex items-center gap-1.5 rounded-full bg-[var(--yt-accent)] px-3 py-1.5 text-xs font-semibold text-white shadow-lg">
              <Download className="size-3.5" /> Save offline
            </span>
          </div>
        </>
      ) : i.qualityBadge && (
        <span className="absolute left-2 top-2 rounded-full bg-black/75 px-1.5 py-0.5 text-[10px] font-semibold text-white">{i.qualityBadge}</span>
      )}
      {i.watch?.completed && (
        // design-ok(raw-palette-semantic): status tint on a theme-invariant black chip over the thumbnail
        <span className="absolute left-2 top-2 flex items-center gap-1 rounded-full bg-black/75 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-400">
          <CheckCircle2 className="size-3" /> Watched
        </span>
      )}
      {!ghosted && i.enhance && (
        <span className="absolute bottom-2 left-2 flex items-center gap-1 rounded-full bg-black/75 px-1.5 py-0.5 text-[10px] font-semibold text-white">
          {i.enhance === 'enhancing' ? <Spinner size="sm" /> : <Sparkles className="size-3" />}
          {i.enhance === 'enhancing'
            ? (i.enhanceProgress != null ? `Enhancing ${Math.round(i.enhanceProgress * 100)}%` : 'Enhancing…')
            : 'Enhanced'}
        </span>
      )}
      {onSave && !ghosted && (
        // One-click Save: yt-dlp downloads this to the Offline library for later viewing.
        <SaveOfflineButton state={saveState ?? null} onClick={onSave} cancelable />
      )}
      <DurationBadge label={dur} />
      <WatchProgressBar progress={progress} completed={i.watch?.completed} />
    </div>
  )
}

/** Vertical video card: thumbnail, title, channel · age. Click opens the watch (or Shorts) page. */
export function VideoCard({ item, aspect = 'video', shape }: { item: VideoItem; aspect?: 'video' | 'short'; shape?: 'wide' | 'tall' }) {
  const age = item.ageLabel ?? fmtAge(item.publishedAt)
  // Kept apart (not one joined+truncated string) so a very long channel name only eats
  // into itself — views/age stay fully visible instead of getting truncated away with it.
  const metaSuffix = [fmtViews(item.views), age].filter(Boolean).join(' · ')
  const { ghosted, onClick } = useGhost(item)
  // DeArrow swaps clickbait titles/thumbnails for community-voted ones (no-op when off).
  const da = useDeArrow(item.videoId)
  const title = da?.title || item.title
  const { previewSrc, bind } = useCardHoverPreview(item)
  const { saveState, onSave } = useCardSave(item, title)
  // Online shorts open in the vertical Shorts feed; everything else (and offline
  // shorts, which need local playback) goes to the standard watch page.
  const to = aspect === 'short' && !item.localKind ? `/videos/youtube/shorts/${item.videoId}` : watchHref(item)
  const body = (
    <>
      <Thumb i={item} aspect={aspect} shape={shape} ghosted={ghosted} overrideSrc={da?.thumbnailUrl} previewSrc={previewSrc} saveState={saveState} onSave={onSave} />
      <CardMetaBlock title={title} creatorName={item.author} creatorAvatarUrl={item.channelThumb} metaSuffix={metaSuffix} ghosted={ghosted} />
    </>
  )
  if (ghosted) {
    return (
      <button type="button" onClick={onClick} className="group flex flex-col gap-2.5 text-left">
        {body}
      </button>
    )
  }
  return (
    <Link to={to} state={{ title, author: item.author, channelThumb: item.channelThumb }} className="group flex flex-col gap-2.5" {...bind}>
      {body}
    </Link>
  )
}

/** Full-width horizontal list row: wide thumbnail + title, channel · age. Used by the
 *  channel page's list view; mirrors VideoCard's ghost/save/navigation behavior. */
export function VideoListRow({ item, aspect = 'video' }: { item: VideoItem; aspect?: 'video' | 'short' }) {
  const age = item.ageLabel ?? fmtAge(item.publishedAt)
  // Kept apart (not one joined+truncated string) so a very long channel name only eats
  // into itself — views/age stay fully visible instead of getting truncated away with it.
  const metaSuffix = [fmtViews(item.views), age].filter(Boolean).join(' · ')
  const { ghosted, onClick } = useGhost(item)
  const da = useDeArrow(item.videoId)
  const title = da?.title || item.title
  const { previewSrc, bind } = useCardHoverPreview(item)
  const { saveState, onSave } = useCardSave(item, title)
  const to = aspect === 'short' && !item.localKind ? `/videos/youtube/shorts/${item.videoId}` : watchHref(item)
  const body = (
    <>
      <div className={cn('shrink-0', aspect === 'short' ? 'w-24 sm:w-28' : 'w-40 sm:w-56')}>
        <Thumb i={item} aspect={aspect} ghosted={ghosted} overrideSrc={da?.thumbnailUrl} previewSrc={previewSrc} saveState={saveState} onSave={onSave} />
      </div>
      <CardMetaBlock layout="row" title={title} creatorName={item.author} creatorAvatarUrl={item.channelThumb} metaSuffix={metaSuffix} ghosted={ghosted} />
    </>
  )
  if (ghosted) {
    return (
      // design-ok(hand-styled-button): the whole media row is the tap target (card-shaped ghost row)
      <button type="button" onClick={onClick} className="group flex w-full gap-3 rounded-card p-1.5 text-left transition-colors hover:bg-accent/50 sm:gap-4">
        {body}
      </button>
    )
  }
  return (
    <Link to={to} state={{ title, author: item.author, channelThumb: item.channelThumb }}
      className="group flex gap-3 rounded-card p-1.5 transition-colors hover:bg-accent/50 sm:gap-4" {...bind}>
      {body}
    </Link>
  )
}

/** Compact horizontal row, used in the watch page "Up next" column. */
export function UpNextRow({ item, active }: { item: VideoItem; active?: boolean }) {
  const age = item.ageLabel ?? fmtAge(item.publishedAt)
  const stats = [fmtViews(item.views), age].filter(Boolean).join(' · ')
  const { ghosted, onClick } = useGhost(item)
  const da = useDeArrow(item.videoId)
  const title = da?.title || item.title
  const { previewSrc, bind } = useCardHoverPreview(item)
  const body = (
    <>
      <div className="relative w-[150px] shrink-0">
        <Thumb i={item} aspect="video" ghosted={ghosted} overrideSrc={da?.thumbnailUrl} previewSrc={previewSrc} />
      </div>
      <div className="min-w-0 flex-1 py-0.5">
        <p className={cn('line-clamp-2 text-[13px] font-semibold leading-snug', ghosted && 'text-muted-foreground')}>{title}</p>
        {item.author && <p className="mt-1 truncate text-xs text-muted-foreground">{item.author}</p>}
        {stats && <p className="truncate text-xs text-muted-foreground">{stats}</p>}
      </div>
    </>
  )
  const addBtn = (
    <AddToPlaylistButton
      video={{ videoId: item.videoId, title, author: item.author ?? undefined, durationSec: item.durationSec ?? undefined }}
      className="self-center opacity-0 group-hover:opacity-100"
    />
  )
  if (ghosted) {
    return (
      <div className="group flex w-full items-center gap-1">
        {/* design-ok(hand-styled-button): the whole media row is the tap target (card-shaped ghost row) */}
        <button type="button" onClick={onClick} className="flex min-w-0 flex-1 gap-2.5 rounded-control p-1.5 text-left transition-colors hover:bg-accent/50">
          {body}
        </button>
        {addBtn}
      </div>
    )
  }
  return (
    <div className="group flex items-center gap-1">
      <Link to={watchHref(item)} state={{ title, author: item.author, channelThumb: item.channelThumb }}
        className={cn('flex min-w-0 flex-1 gap-2.5 rounded-control p-1.5 transition-colors', active ? 'bg-accent' : 'hover:bg-accent/50')} {...bind}>
        {body}
      </Link>
      {addBtn}
    </div>
  )
}

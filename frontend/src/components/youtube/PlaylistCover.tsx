import { ListVideo } from 'lucide-react'
import { cn } from '@/lib/cn'
import { VideoThumb } from '@/components/youtube/media'

/** YouTube-style playlist cover: the leading video's thumbnail topped by two faint
 *  "stacked card" bars and a video-count pill, falling back to an accent placeholder
 *  when the playlist is empty. Shared by the playlist grid cards and the detail hero. */
export function PlaylistCover({ videoIds, title, count, className }: {
  videoIds: string[]
  title: string
  count?: number
  className?: string
}) {
  const first = videoIds[0]
  return (
    <div className={cn('flex flex-col gap-0.5', className)}>
      {/* Stacked-cards effect: two progressively wider bars peeking above the cover. */}
      <div className="mx-3 h-1 rounded-full bg-foreground/12" aria-hidden />
      <div className="mx-1.5 h-1 rounded-full bg-foreground/20" aria-hidden />
      <div className="relative aspect-video overflow-hidden rounded-control bg-gradient-to-br from-[var(--yt-accent)]/30 to-[var(--yt-accent)]/10">
        {first
          ? <VideoThumb videoId={first} title={title} quality="hq" className="size-full object-cover" />
          : <div className="grid size-full place-items-center"><ListVideo className="size-8 text-[var(--yt-accent)]" /></div>}
        {count != null && count > 0 && (
          <span className="absolute bottom-1.5 right-1.5 flex items-center gap-1 rounded-full bg-black/80 px-1.5 py-0.5 text-[11px] font-semibold text-white">
            <ListVideo className="size-3" /> {count}
          </span>
        )}
      </div>
    </div>
  )
}

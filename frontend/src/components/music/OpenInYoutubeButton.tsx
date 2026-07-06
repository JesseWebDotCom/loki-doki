import { MonitorPlay } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/cn'

/** "See the real video" - opens a music track's source in our own YouTube app (the in-app watch
 *  page). Every music item maps to a YouTube videoId, so this is just a navigation. */
export function OpenInYoutubeButton({ videoId, title, className }: { videoId: string; title?: string; className?: string }) {
  const navigate = useNavigate()
  return (
    <button type="button" aria-label="Watch the original video" title="Watch the original video on YouTube"
      onClick={e => { e.stopPropagation(); navigate(`/videos/youtube/watch/${videoId}`, { state: { title } }) }}
      className={cn('flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition',
        'opacity-0 hover:bg-accent/60 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100', className)}>
      <MonitorPlay className="size-4" />
    </button>
  )
}

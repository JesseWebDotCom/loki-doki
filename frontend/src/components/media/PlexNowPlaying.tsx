import { useQuery } from '@tanstack/react-query'
import { Play, Pause } from 'lucide-react'
import { getPlexSessions } from '@/lib/plex/api'

// Ambient "what's streaming on Plex right now" strip. Polls sessions while mounted and renders
// nothing when the server is idle. Caller gates on Plex being configured.
export function PlexNowPlaying() {
  const { data: sessions } = useQuery({
    queryKey: ['plex-sessions'],
    queryFn: getPlexSessions,
    refetchInterval: 30 * 1000,
    staleTime: 20 * 1000,
  })
  if (!sessions?.length) return null

  return (
    <section className="space-y-2.5">
      <h2 className="px-0.5 text-base font-semibold">Playing on Plex now</h2>
      <div className="flex gap-3 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {sessions.map((s, i) => (
          <div
            key={`${s.title}-${i}`}
            className="flex w-[260px] shrink-0 items-center gap-3 rounded-card bg-warning/10 p-2.5 ring-1 ring-warning/20"
          >
            <div className="relative size-14 shrink-0 overflow-hidden rounded-control bg-muted">
              {s.thumb && (
                <img src={`/api/plex/img?path=${encodeURIComponent(s.thumb)}`} alt={s.title} className="size-full object-cover" />
              )}
              <span className="absolute bottom-1 right-1 rounded-full bg-black/70 p-0.5 text-warning">
                {s.state === 'paused' ? <Pause className="size-3" /> : <Play className="size-3 fill-warning" />}
              </span>
            </div>
            <div className="min-w-0">
              <p className="line-clamp-1 text-sm font-medium">{s.showTitle ? `${s.showTitle}` : s.title}</p>
              {s.showTitle && <p className="line-clamp-1 text-xs text-muted-foreground">{s.title}</p>}
              <p className="line-clamp-1 text-[11px] text-muted-foreground">
                {[s.user, s.player].filter(Boolean).join(' · ')}
              </p>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

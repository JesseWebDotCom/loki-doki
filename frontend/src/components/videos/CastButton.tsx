import { useQuery } from '@tanstack/react-query'
import { Cast, Tv } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/cn'
import { toast } from 'sonner'
import { castTo, listCastTargets, type VideoSource } from '@/lib/videos/api'

// "Play this on the living room TV": casting inside the household with no Chromecast. A
// target is another of your signed-in screens holding its command stream open; the cast is
// a navigate command down that channel. Hidden entirely when nothing else is connected.
export function CastButton({ source, videoId, title, atSec, className }: {
  source: VideoSource | 'youtube'
  videoId: string
  title: string
  /** Hand the current position over so the other screen picks up where this one is. */
  atSec?: number
  className?: string
}) {
  const { data } = useQuery({
    queryKey: ['cast-targets'],
    queryFn: listCastTargets,
    refetchInterval: 30_000,
  })
  const targets = data?.targets ?? []
  if (targets.length === 0) return null

  async function send(deviceId: string, label: string) {
    try {
      await castTo({ source, videoId, title }, deviceId, atSec)
      toast.success(`Playing on ${label}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not reach that screen')
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* design-ok(glass-on-plain-bg): icon rail over the UltraBlur cinema backdrop */}
        <Button size="icon" title="Play on another screen" aria-label="Play on another screen"
          className={cn('size-10 rounded-full bg-white/10 text-foreground/85 shadow-none hover:bg-white/15', className)}>
          <Cast className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Play on</DropdownMenuLabel>
        {targets.map((t) => (
          <DropdownMenuItem key={t.deviceId} onClick={() => void send(t.deviceId, t.label)}>
            {t.isTv ? <Tv className="size-4" /> : <Cast className="size-4" />}
            <span className="truncate">{t.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// Home-screen Downloads widget. Admins see the household SABnzbd queue (speed, top
// items, pause state); everyone sees their own in-flight media requests. Fed by
// /api/media-integrations/downloads/summary; hidden entirely when nothing to show.

import { useQuery } from '@tanstack/react-query'
import { Download, PauseCircle } from 'lucide-react'
import { cardVariants } from '@/components/ui/card'
import { cn } from '@/lib/cn'

const opts: RequestInit = { credentials: 'include' }

interface MineItem {
  id: string
  title: string
  year: number | null
  status: 'requested' | 'downloading' | 'ready' | 'failed'
  progress: number | null
}
interface SummaryPayload {
  configured: boolean
  admin: boolean
  mine: MineItem[]
  queue: {
    paused: boolean
    speed: string
    sizeLeft: string
    count: number
    top: Array<{ nzoId: string; filename: string; percentage: number; timeLeft: string }>
  } | null
}

function Bar({ pct }: { pct: number }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full bg-brand" style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  )
}

export function DownloadsWidget() {
  const { data } = useQuery({
    queryKey: ['downloads-summary'],
    queryFn: async () => {
      const r = await fetch('/api/media-integrations/downloads/summary', opts)
      if (!r.ok) return null
      return (await r.json()) as SummaryPayload
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  })

  const queue = data?.admin ? data.queue : null
  const mine = data?.mine ?? []
  const hasQueue = !!queue && (queue.count > 0 || queue.paused)

  return (
    <div className={cn(cardVariants(), 'p-4 h-full flex flex-col gap-2')}>
      <div className="flex items-center gap-1.5 text-overline text-muted-foreground/60">
        <Download className="size-3" />
        <span>Downloads</span>
        {queue?.paused && <PauseCircle className="size-3 text-warning" />}
      </div>

      {!data?.configured && <p className="text-[12px] text-muted-foreground/60">Downloads are not set up.</p>}

      {data?.configured && !hasQueue && mine.length === 0 && (
        <p className="text-[12px] text-muted-foreground/60">Nothing downloading right now.</p>
      )}

      {hasQueue && queue && (
        <div className="space-y-2">
          <p className="text-[12px] text-muted-foreground">
            {queue.paused ? 'Queue paused' : `${queue.count} item${queue.count === 1 ? '' : 's'} · ${queue.speed}B/s`}
          </p>
          {queue.top.map((s) => (
            <div key={s.nzoId} className="space-y-1">
              <div className="flex items-baseline justify-between gap-2">
                <p className="min-w-0 flex-1 truncate text-[13px] font-medium">{s.filename}</p>
                <span className="shrink-0 text-[11px] text-muted-foreground">{s.percentage}%</span>
              </div>
              <Bar pct={s.percentage} />
            </div>
          ))}
        </div>
      )}

      {mine.length > 0 && (
        <div className="space-y-2">
          {queue && hasQueue && <p className="pt-1 text-[11px] font-semibold text-muted-foreground/60">My requests</p>}
          {mine.slice(0, 3).map((r) => (
            <div key={r.id} className="space-y-1">
              <div className="flex items-baseline justify-between gap-2">
                <p className="min-w-0 flex-1 truncate text-[13px] font-medium">
                  {r.title}{r.year ? ` (${r.year})` : ''}
                </p>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {r.status === 'downloading' && r.progress != null ? `${Math.round(r.progress)}%` : 'Requested'}
                </span>
              </div>
              {r.status === 'downloading' && r.progress != null && <Bar pct={r.progress} />}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

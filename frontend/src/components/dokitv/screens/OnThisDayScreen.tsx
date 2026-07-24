// Documentary channel: one moment from history at a time in a big headline,
// auto-advancing every 10 seconds, with a side rail of what comes next.

import { useQuery } from '@tanstack/react-query'
import { BookOpen } from 'lucide-react'
import type { TvScreenProps } from './index'
import { ScreenFrame, StatusPanel, channelBarStyle, getJson, useCycle } from './shared'

interface OtdResponse {
  events: { title: string }[]
  births: { title: string }[]
  deaths: { title: string }[]
  month: number
  day: number
  offline?: boolean
}

type Category = 'Event' | 'Birth' | 'Death'

interface OtdEntry {
  category: Category
  title: string
}

function buildEntries(data: OtdResponse): OtdEntry[] {
  const tagged: OtdEntry[][] = [
    data.events.map((e) => ({ category: 'Event' as const, title: e.title })),
    data.births.map((e) => ({ category: 'Birth' as const, title: e.title })),
    data.deaths.map((e) => ({ category: 'Death' as const, title: e.title })),
  ]
  // Interleave categories so consecutive cards vary: event, birth, death, event...
  const out: OtdEntry[] = []
  const max = Math.max(...tagged.map((t) => t.length))
  for (let i = 0; i < max; i++) for (const t of tagged) if (t[i]) out.push(t[i])
  return out
}

export function OnThisDayScreen({ channel, title, subtitle }: TvScreenProps) {
  const otd = useQuery({
    queryKey: ['dokitv', 'onthisday'],
    queryFn: () => getJson<OtdResponse>('/api/on-this-day'),
    refetchInterval: 60 * 60_000,
  })

  const entries = otd.data ? buildEntries(otd.data) : []
  const idx = useCycle(entries.length, 10_000)

  if (otd.isPending) {
    return (
      <ScreenFrame channel={channel} title={title} subtitle={subtitle}>
        <StatusPanel channel={channel} icon={BookOpen} headline="Opening the archive" note="Waiting for data" />
      </ScreenFrame>
    )
  }
  if (otd.isError || entries.length === 0) {
    return (
      <ScreenFrame channel={channel} title={title} subtitle={subtitle}>
        <StatusPanel channel={channel} icon={BookOpen} headline="Nothing in the archive today" note="History returns when the house is back online" />
      </ScreenFrame>
    )
  }

  const data = otd.data
  const dateHeading = new Date(2000, data.month - 1, data.day).toLocaleDateString([], { month: 'long', day: 'numeric' })
  const current = entries[idx]
  const upNext = Array.from({ length: Math.min(5, entries.length - 1) }, (_, i) => entries[(idx + 1 + i) % entries.length])

  return (
    <ScreenFrame channel={channel} title={title} subtitle={subtitle ?? dateHeading}>
      <div className="flex h-full gap-10">
        <div key={`${current.category}-${current.title}`} className="flex min-w-0 flex-1 flex-col justify-center gap-6">
          <span className="flex items-center gap-4">
            <span aria-hidden className="h-8 w-1.5 rounded-full" style={channelBarStyle(channel)} />
            <span className="text-lg font-bold uppercase tracking-[0.35em]" style={{ color: channel.color }}>
              {current.category}
            </span>
            <span className="text-lg uppercase tracking-[0.35em] text-muted-foreground">{dateHeading}</span>
          </span>
          {/* design-ok(font-black): 10-foot documentary headline on the TV surface */}
          <p className="line-clamp-5 text-5xl font-black leading-tight tracking-tight xl:text-6xl">{current.title}</p>
        </div>

        {upNext.length > 0 ? (
          <div className="hidden w-96 shrink-0 flex-col overflow-hidden rounded-sheet border border-border/50 bg-card/40 lg:flex">
            <p className="border-b border-border/60 px-6 py-4 text-sm font-bold uppercase tracking-[0.3em] text-muted-foreground">
              Also on this day
            </p>
            <div className="min-h-0 flex-1 overflow-hidden px-6">
              {upNext.map((e, i) => (
                <div key={`${e.category}-${e.title}-${i}`} className="border-b border-border/40 py-4 last:border-b-0">
                  <p className="text-sm font-bold uppercase tracking-widest" style={{ color: channel.color }}>{e.category}</p>
                  <p className="mt-1 line-clamp-2 text-lg font-medium text-foreground/85">{e.title}</p>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </ScreenFrame>
  )
}

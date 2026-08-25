// Scores board: today's games as a ticker-style list with a slow featured
// cycle spotlighting one matchup at a time.

import { useQuery } from '@tanstack/react-query'
import { Trophy } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { TvScreenProps } from './index'
import { ScreenFrame, StatusPanel, channelBarStyle, channelPanelStyle, getJson, useCycle } from './shared'

interface SportsResponse {
  games: { title: string }[]
  offline?: boolean
}

export function SportsScreen({ channel, title, subtitle }: TvScreenProps) {
  const sports = useQuery({
    queryKey: ['maipaitv', 'sports'],
    queryFn: () => getJson<SportsResponse>('/api/sports/today'),
    refetchInterval: 15 * 60_000,
  })
  const games = sports.data?.games ?? []
  const featured = useCycle(games.length, 6_000)

  if (sports.isPending) {
    return (
      <ScreenFrame channel={channel} title={title} subtitle={subtitle}>
        <StatusPanel channel={channel} icon={Trophy} headline="Warming up" note="Waiting for data" />
      </ScreenFrame>
    )
  }
  if (sports.isError || games.length === 0) {
    return (
      <ScreenFrame channel={channel} title={title} subtitle={subtitle}>
        <StatusPanel
          channel={channel}
          icon={Trophy}
          headline="No games on the slate"
          note={sports.data?.offline ? 'Scores return when the house is back online' : 'Check back when games are on'}
        />
      </ScreenFrame>
    )
  }

  return (
    <ScreenFrame channel={channel} title={title} subtitle={subtitle}>
      <div className="flex h-full flex-col gap-6">
        <div className="flex items-center gap-8 rounded-sheet border border-border/50 p-10" style={channelPanelStyle(channel)}>
          <span className="flex size-20 shrink-0 items-center justify-center rounded-card bg-black/40">
            <Trophy className="size-10" style={{ color: channel.color }} />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-bold uppercase tracking-[0.3em] text-foreground/70">In the spotlight</p>
            <p className="mt-2 text-4xl font-bold tracking-tight lg:text-5xl">{games[featured].title}</p>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden rounded-sheet border border-border/50 bg-card/40">
          {games.slice(0, 10).map((g, i) => (
            <div
              key={`${g.title}-${i}`}
              className={cn(
                'flex items-center gap-5 border-b border-border/40 px-7 py-4 transition-colors duration-700 last:border-b-0',
                i === featured && 'bg-card/80',
              )}
            >
              <span
                aria-hidden
                className={cn('h-8 w-1.5 shrink-0 rounded-full transition-opacity duration-700', i !== featured && 'opacity-20')}
                style={channelBarStyle(channel)}
              />
              <span className="w-10 shrink-0 text-xl font-bold tabular-nums text-muted-foreground">{i + 1}</span>
              <span className={cn('truncate text-2xl', i === featured ? 'font-bold' : 'font-medium text-foreground/85')}>
                {g.title}
              </span>
            </div>
          ))}
        </div>
      </div>
    </ScreenFrame>
  )
}

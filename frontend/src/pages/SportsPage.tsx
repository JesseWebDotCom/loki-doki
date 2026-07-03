import { useState } from 'react'
import { Trophy } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { PageShell } from '@/components/shared/PageShell'
import { PageHeader } from '@/components/shared/PageHeader'
import { PageContainer } from '@/components/shared/PageContainer'
import { ChipRow, Chip } from '@/components/shared/ChipRow'
import { StatusDot } from '@/components/shared/StatusDot'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { usePublishUIContext } from '@/context/UIContextProvider'

type LeagueFilter = 'all' | 'mlb' | 'nfl' | 'nba' | 'nhl' | 'mls' | 'world-cup'

interface GameItem {
  title: string
}

interface SportsResponse {
  games: GameItem[]
  league: string | null
  offline?: boolean
  error?: string
}

const CHIPS: { value: LeagueFilter; label: string }[] = [
  { value: 'all',       label: 'All' },
  { value: 'mlb',       label: 'MLB' },
  { value: 'nfl',       label: 'NFL' },
  { value: 'nba',       label: 'NBA' },
  { value: 'nhl',       label: 'NHL' },
  { value: 'mls',       label: 'MLS' },
  { value: 'world-cup', label: 'World Cup' },
]

function buildUrl(league: LeagueFilter): string {
  if (league === 'all') return '/api/sports'
  return `/api/sports?league=${league}`
}

async function fetchSports(league: LeagueFilter): Promise<SportsResponse> {
  const r = await fetch(buildUrl(league), { credentials: 'include' })
  if (!r.ok) return { games: [], league: null, error: 'unavailable' }
  return r.json() as Promise<SportsResponse>
}

// Parse "MLB: NYY 3 - BOS 2 (Final)" into { badge, line, status }
function parseGameTitle(title: string): { badge: string; line: string; status: 'final' | 'live' | 'upcoming' } {
  const colonIdx = title.indexOf(':')
  const badge = colonIdx !== -1 ? title.slice(0, colonIdx).trim() : ''
  const rest = colonIdx !== -1 ? title.slice(colonIdx + 1).trim() : title

  let status: 'final' | 'live' | 'upcoming' = 'upcoming'
  if (/\(final\)/i.test(rest)) status = 'final'
  else if (/\(live\)/i.test(rest) || /\bin\b/i.test(rest.match(/\([^)]+\)/)?.[0] ?? '')) status = 'live'

  return { badge, line: rest, status }
}

function StatusPill({ status }: { status: 'final' | 'live' | 'upcoming' }) {
  if (status === 'final') {
    return (
      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Final
      </span>
    )
  }
  if (status === 'live') {
    return (
      <span className="flex shrink-0 items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-success">
        <StatusDot status="ok" pulse className="size-2" />
        Live
      </span>
    )
  }
  return (
    <span className="shrink-0 rounded-full bg-info/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-info">
      Upcoming
    </span>
  )
}

function GameRow({ game }: { game: GameItem }) {
  const { badge, line, status } = parseGameTitle(game.title)
  return (
    <Card className="flex items-center gap-3 border-border/40 bg-card/50 px-4 py-3">
      {badge && (
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          {badge}
        </span>
      )}
      <p className="min-w-0 flex-1 text-sm font-medium">{line}</p>
      <StatusPill status={status} />
    </Card>
  )
}

function SkeletonRow() {
  return (
    <Card className="flex items-center gap-3 border-border/40 bg-card/50 px-4 py-3">
      <Skeleton className="h-5 w-10" />
      <Skeleton className="h-4 flex-1" />
      <Skeleton className="h-5 w-16 rounded-full" />
    </Card>
  )
}

export function SportsPage() {
  const [league, setLeague] = useState<LeagueFilter>('all')

  usePublishUIContext({ label: 'Sports', description: `User is viewing ${league === 'all' ? 'all sports scores' : `${league.toUpperCase()} scores`}.` })

  const { data, isLoading } = useQuery<SportsResponse>({
    queryKey: ['sports', league],
    queryFn: () => fetchSports(league),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })

  const games = data?.games ?? []

  return (
    <PageShell>
      <PageContainer className="pb-10">
        <PageHeader subtitle="Live scores and upcoming games across major leagues." />

        {/* League filter chips */}
        <ChipRow className="flex-wrap pb-4">
          {CHIPS.map((chip) => (
            <Chip
              key={chip.value}
              label={chip.label}
              active={league === chip.value}
              onClick={() => setLeague(chip.value)}
            />
          ))}
        </ChipRow>

        {isLoading && (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => <SkeletonRow key={i} />)}
          </div>
        )}

        {!isLoading && data?.offline && (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <Trophy className="size-10 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">You're offline. Scores unavailable.</p>
          </div>
        )}

        {!isLoading && !data?.offline && games.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <Trophy className="size-10 text-muted-foreground/30" />
            <p className="text-sm font-medium text-muted-foreground">No games today</p>
            <p className="text-xs text-muted-foreground/60">Check back later or try a different league.</p>
          </div>
        )}

        {!isLoading && games.length > 0 && (
          <div className="space-y-2">
            {games.map((game, i) => (
              <GameRow key={i} game={game} />
            ))}
          </div>
        )}
      </PageContainer>
    </PageShell>
  )
}

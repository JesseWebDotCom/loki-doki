import { useState } from 'react'
import { Trophy, Circle } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { PageShell } from '@/components/shared/PageShell'
import { PageHeader } from '@/components/shared/PageHeader'
import { cn } from '@/lib/cn'
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
      <span className="flex shrink-0 items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-green-400">
        <Circle className="size-2 animate-pulse fill-green-400 text-green-400" />
        Live
      </span>
    )
  }
  return (
    <span className="shrink-0 rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-400">
      Upcoming
    </span>
  )
}

function GameRow({ game }: { game: GameItem }) {
  const { badge, line, status } = parseGameTitle(game.title)
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border/40 bg-card/50 px-4 py-3">
      {badge && (
        <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          {badge}
        </span>
      )}
      <p className="min-w-0 flex-1 text-sm font-medium">{line}</p>
      <StatusPill status={status} />
    </div>
  )
}

function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border/40 bg-card/50 px-4 py-3">
      <div className="h-5 w-10 animate-pulse rounded-md bg-muted" />
      <div className="h-4 flex-1 animate-pulse rounded-md bg-muted" />
      <div className="h-5 w-16 animate-pulse rounded-full bg-muted" />
    </div>
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
    <PageShell gradient="linear-gradient(135deg,#14532d,#16a34a)" GhostIcon={Trophy}>
      <PageHeader
        variant="compact"
        title="Sports"
        subtitle="Live scores and upcoming games across major leagues."
        gradient="linear-gradient(135deg,#14532d,#16a34a)"
        icon={<Trophy className="size-7 text-white" />}
      />

      {/* League filter chips */}
      <div className="px-5 pb-3">
        <div className="flex flex-wrap gap-2">
          {CHIPS.map((chip) => (
            <button
              key={chip.value}
              onClick={() => setLeague(chip.value)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-semibold transition-colors',
                league === chip.value
                  ? 'border-brand bg-brand text-white'
                  : 'border-border/60 bg-muted/40 text-muted-foreground hover:border-brand/60 hover:text-foreground',
              )}
            >
              {chip.label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-5 pb-10">
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
      </div>
    </PageShell>
  )
}

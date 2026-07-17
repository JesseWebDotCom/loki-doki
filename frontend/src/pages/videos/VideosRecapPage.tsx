import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CalendarDays, Flame, Sparkles, Users } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { Card, cardVariants } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { ChipRow, Chip } from '@/components/shared/ChipRow'
import { cn } from '@/lib/cn'
import { getRecap, type Recap } from '@/lib/videos/api'

// Year in Review: the private Wrapped. Trakt's and Letterboxd's are the most-shared things
// those products ship; ours is the household one, computed from watch history that never
// leaves the server. Two scopes: just you, or everyone folded together.

const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D']

function fmtHours(min: number): string {
  const h = Math.floor(min / 60)
  return h > 0 ? `${h}h ${min % 60}m` : `${min}m`
}

export function VideosRecapPage() {
  const thisYear = new Date().getFullYear()
  const [year, setYear] = useState(thisYear)
  const [scope, setScope] = useState<'me' | 'household'>('me')
  const { data, isLoading } = useQuery({
    queryKey: ['videos-recap', year, scope],
    queryFn: () => getRecap(year, scope),
    staleTime: 10 * 60_000,
  })
  const recap = data?.recap

  return (
    <PageContainer width="wide" className="pb-6">
      <PageHeader
        eyebrow={`${year} in review`}
        title={scope === 'household' ? 'Your family’s year in video' : 'Your year in video'}
        subtitle="Built from your own watch history, on your own server. Nobody else sees it."
        className="pt-6 pb-5" />

      <ChipRow className="mb-6">
        <Chip label="Just me" active={scope === 'me'} onClick={() => setScope('me')} />
        <Chip label="Whole family" active={scope === 'household'} onClick={() => setScope('household')} />
        <div aria-hidden className="mx-1 h-4 w-px shrink-0 self-center bg-border" />
        {[thisYear, thisYear - 1, thisYear - 2].map((y) => (
          <Chip key={y} label={String(y)} active={year === y} onClick={() => setYear(y)} />
        ))}
      </ChipRow>

      {isLoading ? (
        <div className="flex justify-center py-24"><Spinner /></div>
      ) : !recap || recap.videoCount === 0 ? (
        <Card variant="dashed" className="p-10 text-center text-sm text-muted-foreground">
          Nothing watched in {year} yet. Come back once there's a year to look back on.
        </Card>
      ) : (
        <RecapBody recap={recap} />
      )}
    </PageContainer>
  )
}

function RecapBody({ recap }: { recap: Recap }) {
  const maxMonth = Math.max(1, ...recap.byMonth)
  return (
    <div className="space-y-6">
      {recap.note && (
        <Card className="flex gap-3 p-4">
          <Sparkles className="mt-0.5 size-4 shrink-0 text-brand" />
          <p className="text-sm leading-relaxed">{recap.note}</p>
        </Card>
      )}

      {/* The headline numbers. */}
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Watch time" value={fmtHours(recap.totalMinutes)} icon={CalendarDays} />
        <StatTile label="Videos" value={String(recap.videoCount)} icon={CalendarDays} />
        <StatTile label="Longest streak" value={recap.longestStreak > 0 ? `${recap.longestStreak} days` : '-'} icon={Flame} />
      </div>

      {/* The shape of the year. */}
      <Card className="p-4">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Across the year</p>
        <div className="flex items-end gap-1.5">
          {recap.byMonth.map((m, i) => (
            <div key={i} className="flex flex-1 flex-col items-center gap-1" title={`${MONTHS[i]}: ${fmtHours(m)}`}>
              <div className="w-full rounded-t bg-brand/70" style={{ height: `${Math.max(2, (m / maxMonth) * 90)}px` }} />
              <span className="text-[10px] text-muted-foreground">{MONTHS[i]}</span>
            </div>
          ))}
        </div>
        {recap.busiestDay && (
          <p className="mt-3 text-xs text-muted-foreground">
            Busiest day: {recap.busiestDay.day} ({fmtHours(recap.busiestDay.minutes)}).
          </p>
        )}
      </Card>

      {recap.topCreators.length > 0 && (
        <Card className="p-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">On repeat</p>
          <div className="space-y-2">
            {recap.topCreators.map((c, i) => (
              <div key={c.name} className="flex items-center gap-3">
                <span className="w-4 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.name}</span>
                <div className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-brand" style={{ width: `${(c.count / recap.topCreators[0]!.count) * 100}%` }} />
                </div>
                <span className="w-8 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{c.count}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {recap.scope === 'household' && recap.people.length > 1 && (
        <Card className="p-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Everyone</p>
          <div className="space-y-2.5">
            {recap.people.map((p) => (
              <div key={p.userId} className="flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</span>
                {p.topCreator && (
                  <span className="hidden truncate text-xs text-muted-foreground sm:block">
                    mostly {p.topCreator}
                    {p.topCreatorShare > 0.4 && ' (a lot)'}
                  </span>
                )}
                <span className="shrink-0 text-sm tabular-nums">{fmtHours(p.minutes)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {recap.sharedCreators.length > 0 && (
        <Card className="p-4">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <Users className="size-3.5" /> You all watch these
          </p>
          <div className="flex flex-wrap gap-1.5">
            {recap.sharedCreators.map((name) => (
              <span key={name} className="rounded-full bg-muted/60 px-2.5 py-1 text-xs">{name}</span>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}

function StatTile({ label, value, icon: Icon }: { label: string; value: string; icon: typeof CalendarDays }) {
  return (
    <div className={cn(cardVariants(), 'p-4')}>
      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className="size-3.5" /> {label}
      </p>
      <p className="mt-1 text-2xl font-bold tabular-nums tracking-tight">{value}</p>
    </div>
  )
}

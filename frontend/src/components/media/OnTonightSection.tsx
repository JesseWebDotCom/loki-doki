import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Tv, Radio } from 'lucide-react'
import { mediaImg, getOnTvToday, type ScheduleEntry } from '@/lib/shows/api'

// Current local time as "HH:MM", used to flag what's airing in the current hour. TVMaze
// airtimes are in the network's local zone (US broadcast is mostly ET), so this is a
// best-effort "on now" cue rather than an exact guarantee.
function nowHhmm(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function OnTonightCard({ e, live }: { e: ScheduleEntry; live: boolean }) {
  const epLabel =
    e.season != null && e.number != null
      ? `S${e.season}E${e.number}`
      : e.episode || null
  return (
    <Link to={`/shows/${e.show.id}`} className="group flex w-[150px] shrink-0 flex-col sm:w-[168px]">
      <div className="relative aspect-[2/3] overflow-hidden rounded-card bg-muted shadow-sm ring-1 ring-border/40 transition-transform group-hover:scale-[1.03] group-active:scale-[0.99]">
        {e.show.poster ? (
          <img src={mediaImg(e.show.poster, 480)} alt={e.show.name} loading="lazy" className="size-full object-cover" />
        ) : (
          <div className="flex size-full items-center justify-center">
            <Tv className="size-7 text-muted-foreground/40" />
          </div>
        )}
        {live ? (
          <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-full bg-destructive px-1.5 py-0.5 text-[10px] font-semibold text-white">
            {/* design-ok(adhoc-pulse): live on-air indicator dot, not a loading state */}
            <span className="size-1.5 animate-pulse rounded-full bg-white" /> ON NOW
          </span>
        ) : e.airtimeLabel ? (
          <span className="absolute left-1.5 top-1.5 rounded-full bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white">
            {e.airtimeLabel}
          </span>
        ) : null}
        {e.streaming && (
          <span className="absolute right-1.5 top-1.5 inline-flex items-center gap-0.5 rounded-full bg-brand/85 px-1.5 py-0.5 text-[10px] font-medium text-white">
            <Radio className="size-2.5" /> Stream
          </span>
        )}
      </div>
      <p className="mt-1.5 line-clamp-1 text-sm font-medium leading-tight">{e.show.name}</p>
      <p className="line-clamp-1 text-xs text-muted-foreground">
        {[e.show.network, epLabel].filter(Boolean).join(' · ') || (e.streaming ? 'Streaming premiere' : ' ')}
      </p>
    </Link>
  )
}

// "On TV Tonight": what's airing this evening (broadcast/cable) plus streaming premieres today.
// Focuses on tonight (primetime onward) but falls back to the full day's schedule if that's thin.
export function OnTonightSection() {
  const { data, isLoading } = useQuery({
    queryKey: ['shows-on-tv'],
    queryFn: getOnTvToday,
    staleTime: 30 * 60 * 1000,
  })

  if (isLoading) return null
  const all = data?.entries ?? []
  if (!all.length) return null

  // "Tonight" = evening broadcast airings (>= 5pm) + any streaming premiere. If that's too
  // sparse, show the whole schedule so the section never looks empty.
  const tonight = all.filter((e) => e.streaming || (e.airtime != null && e.airtime >= '17:00'))
  const entries = (tonight.length >= 6 ? tonight : all).slice(0, 30)
  if (!entries.length) return null

  const now = nowHhmm()
  const isLive = (e: ScheduleEntry) => !e.streaming && e.airtime != null && e.airtime.slice(0, 2) === now.slice(0, 2)

  return (
    <section className="space-y-2.5">
      <h2 className="px-0.5 text-base font-semibold">On TV Tonight</h2>
      <div className="flex gap-3 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {entries.map((e, i) => (
          <OnTonightCard key={`${e.show.id}-${e.season ?? ''}-${e.number ?? ''}-${i}`} e={e} live={isLive(e)} />
        ))}
      </div>
    </section>
  )
}

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Clapperboard, Clock, MapPin, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { mediaImg } from '@/lib/shows/api'
import { RatingBadge } from '@/components/media/RatingBadge'
import { getShowtimesNearMe, setMovieZip, movieTo, type ShowMovie } from '@/lib/movies/api'

// Inline 5-digit ZIP entry, shared by the "set a ZIP" prompt and the "change ZIP" control.
function ZipInput({
  draft,
  setDraft,
  onSave,
  autoFocus,
}: {
  draft: string
  setDraft: (v: string) => void
  onSave: () => void
  autoFocus?: boolean
}) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="relative">
        <MapPin className="absolute left-2 top-1/2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          autoFocus={autoFocus}
          value={draft}
          onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, '').slice(0, 5))}
          onKeyDown={(e) => e.key === 'Enter' && onSave()}
          placeholder="ZIP code"
          inputMode="numeric"
          className="w-28 pl-7"
        />
      </div>
      <Button type="button" size="sm" variant="secondary" onClick={onSave} className="bg-foreground/10 hover:bg-foreground/15">
        Save
      </Button>
    </div>
  )
}

function MovieShowtimeCard({ m }: { m: ShowMovie }) {
  return (
    <Link to={movieTo({ title: m.title, year: null })} className="group flex w-[150px] shrink-0 flex-col sm:w-[168px]">
      <div className="relative aspect-[2/3] overflow-hidden rounded-card bg-muted shadow-sm ring-1 ring-border/40 transition-transform group-hover:scale-[1.03] group-active:scale-[0.99]">
        {m.poster_url ? (
          <img src={mediaImg(m.poster_url)} alt={m.title} loading="lazy" className="size-full object-cover" />
        ) : (
          <div className="flex size-full items-center justify-center">
            <Clapperboard className="size-7 text-muted-foreground/40" />
          </div>
        )}
        {m.rating && <RatingBadge rating={m.rating} className="absolute left-1.5 top-1.5" />}
      </div>
      <p className="mt-1.5 line-clamp-1 text-sm font-medium leading-tight">{m.title}</p>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {m.times.slice(0, 4).map((t, i) => (
          <span
            key={i}
            className="inline-flex items-center gap-0.5 rounded-full bg-foreground/8 px-1.5 py-0.5 text-[10px] text-muted-foreground"
          >
            <Clock className="size-2.5" />
            {t}
          </span>
        ))}
        {m.times.length > 4 && <span className="text-[10px] text-muted-foreground">+{m.times.length - 4}</span>}
      </div>
    </Link>
  )
}

// "In Theaters Near You": the local showtimes discovery row on the Movies home page. Auto-loads
// with the household ZIP (geocoded from the user's location), falls back to an inline ZIP prompt
// when none is resolvable, and lets the user change it in place.
export function InTheatersSection() {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['movies-near-me'],
    queryFn: () => getShowtimesNearMe(),
    staleTime: 30 * 60 * 1000,
  })

  const saveZip = async () => {
    const z = draft.trim()
    if (!/^\d{5}$/.test(z)) return
    await setMovieZip(z)
    setEditing(false)
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['movies-near-me'] }),
      qc.invalidateQueries({ queryKey: ['movies-home'] }),
    ])
  }

  if (isLoading) return null // fill in beneath the shelves rather than block first paint

  const zip = data?.zip ?? null
  const movies = data?.data?.movies ?? []

  // No ZIP resolvable yet → inline prompt (surface the prerequisite in place).
  if (!zip) {
    return (
      <section className="space-y-2.5">
        <h2 className="px-0.5 text-base font-semibold">In Theaters Near You</h2>
        <div className="flex flex-wrap items-center gap-3 rounded-card border border-border/50 bg-card/40 p-4">
          <span className="text-sm text-muted-foreground">Set your ZIP code to see what&rsquo;s playing at nearby theaters.</span>
          <ZipInput draft={draft} setDraft={setDraft} onSave={saveZip} />
        </div>
      </section>
    )
  }

  if (!movies.length) return null

  return (
    <section className="space-y-2.5">
      <div className="flex items-center justify-between gap-2 px-0.5">
        <h2 className="text-base font-semibold">In Theaters Near You</h2>
        {editing ? (
          <ZipInput draft={draft} setDraft={setDraft} onSave={saveZip} autoFocus />
        ) : (
          <button
            onClick={() => {
              setDraft(zip)
              setEditing(true)
            }}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            title="Change ZIP code"
          >
            <MapPin className="size-3.5" /> {zip} <Pencil className="size-3" />
          </button>
        )}
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {movies.map((m, i) => (
          <MovieShowtimeCard key={`${m.title}-${i}`} m={m} />
        ))}
      </div>
    </section>
  )
}

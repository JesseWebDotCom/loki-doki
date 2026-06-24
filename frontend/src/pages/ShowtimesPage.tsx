import { useCallback, useEffect, useState } from 'react'
import { Clapperboard, ChevronDown, ChevronUp, ExternalLink, Loader2, PlayCircle, WifiOff } from 'lucide-react'
import { PageShell } from '@/components/shared/PageShell'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'

interface TheaterGroup { theater_name: string; times: string[] }
interface ShowMovie {
  title: string
  slug: string | null
  url: string | null
  rating: string | null
  runtime_minutes: number | null
  poster_url: string | null
  times: string[]
  trailer_url: string
  theater_groups: TheaterGroup[]
}
interface ShowtimesData {
  zip: string
  date: string
  theater_count: number
  movies: ShowMovie[]
  source_url: string
}

const ZIP_KEY = 'showtimes.lastZip'

async function fetchShowtimes(zip: string): Promise<ShowtimesData> {
  const r = await fetch(`/api/showtimes?zip=${encodeURIComponent(zip)}`, { credentials: 'include' })
  if (!r.ok) throw new Error(`Error ${r.status}`)
  return r.json() as Promise<ShowtimesData>
}

function MovieCard({ movie }: { movie: ShowMovie }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="overflow-hidden rounded-2xl border border-border/60 bg-card">
      <div className="flex gap-3 p-3">
        {movie.poster_url ? (
          <img src={movie.poster_url} alt={movie.title} className="h-32 w-22 shrink-0 rounded-lg object-cover" />
        ) : (
          <div className="flex h-32 w-22 shrink-0 items-center justify-center rounded-lg bg-muted">
            <Clapperboard className="size-6 text-muted-foreground/40" />
          </div>
        )}
        <div className="min-w-0 flex-1 space-y-1.5">
          <h3 className="font-bold leading-tight">{movie.title}</h3>
          <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
            {movie.rating && <span className="rounded-full border border-border px-2 py-0.5">{movie.rating}</span>}
            {movie.runtime_minutes ? <span className="rounded-full border border-border px-2 py-0.5">{movie.runtime_minutes} min</span> : null}
          </div>
          <div className="flex flex-wrap gap-1 pt-1">
            {movie.times.slice(0, 8).map((t, i) => (
              <span key={i} className="rounded-md bg-muted/70 px-2 py-0.5 text-xs font-medium">{t}</span>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 pt-1.5">
            {movie.url && (
              <a href={movie.url} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-brand hover:underline">
                <ExternalLink className="size-3" /> Tickets
              </a>
            )}
            <a href={movie.trailer_url} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-red-500 hover:underline">
              <PlayCircle className="size-3" /> Trailer
            </a>
            {movie.theater_groups.length > 0 && (
              <button onClick={() => setOpen((v) => !v)}
                className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                {movie.theater_groups.length} theater{movie.theater_groups.length !== 1 ? 's' : ''}
                {open ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
              </button>
            )}
          </div>
        </div>
      </div>
      {open && (
        <div className="space-y-2 border-t border-border/60 bg-muted/30 p-3">
          {movie.theater_groups.map((g, i) => (
            <div key={i}>
              <p className="text-xs font-semibold">{g.theater_name}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {g.times.map((t, j) => (
                  <span key={j} className="rounded-md bg-card px-2 py-0.5 text-xs">{t}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function ShowtimesPage() {
  const [zip, setZip] = useState(() => localStorage.getItem(ZIP_KEY) ?? '')
  const [query, setQuery] = useState(() => localStorage.getItem(ZIP_KEY) ?? '')
  const [data, setData] = useState<ShowtimesData | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'empty' | 'error'>('idle')

  usePublishUIContext({
    label: 'Movie Showtimes',
    description: data
      ? `User is viewing movie showtimes near ${data.zip} (${data.movies.length} movies).`
      : 'User is on the Movie Showtimes page.',
  })

  const load = useCallback(async (z: string) => {
    const trimmed = z.trim()
    if (!/^\d{5}$/.test(trimmed)) { setStatus('idle'); return }
    setStatus('loading')
    setData(null)
    localStorage.setItem(ZIP_KEY, trimmed)
    setZip(trimmed)
    try {
      const d = await fetchShowtimes(trimmed)
      setData(d)
      setStatus(d.movies.length ? 'ready' : 'empty')
    } catch {
      setStatus('error')
    }
  }, [])

  useEffect(() => { if (zip) void load(zip) /* eslint-disable-next-line */ }, [])

  const onSubmit = useCallback(() => { void load(query) }, [load, query])
  useAppHeader({
    query,
    setQuery,
    onSubmit,
    placeholder: 'Enter ZIP code...',
    loading: status === 'loading',
    externalHref: 'https://www.fandango.com',
    settingsHref: '/admin/features?tool=showtimes',
  })

  return (
    <PageShell gradient="linear-gradient(135deg,#1e1b4b,#6d28d9)" GhostIcon={Clapperboard}>
      <div className="flex items-center justify-between px-5 pt-5 pb-2 shrink-0">
        <div>
          <h1 className="text-xl font-black tracking-tight">Showtimes</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">Movie showtimes at theaters near you.</p>
        </div>
        {data && <span className="text-xs text-muted-foreground">{data.theater_count} theaters near {data.zip}</span>}
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-8 space-y-3 sm:px-5">
        {status === 'idle' && (
          <p className="py-16 text-center text-sm text-muted-foreground">Enter a 5-digit ZIP code to find showtimes near you.</p>
        )}
        {status === 'loading' && (
          <div className="flex items-center justify-center py-20 text-muted-foreground"><Loader2 className="size-6 animate-spin" /></div>
        )}
        {status === 'empty' && (
          <p className="py-16 text-center text-sm text-muted-foreground">No showtimes found near {zip}.</p>
        )}
        {status === 'error' && (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <WifiOff className="size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">Couldn't load showtimes right now.</p>
          </div>
        )}
        {status === 'ready' && data?.movies.map((m, i) => <MovieCard key={i} movie={m} />)}
      </div>
    </PageShell>
  )
}

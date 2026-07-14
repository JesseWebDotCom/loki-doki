import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Clock, MapPin, Ticket } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { Button } from '@/components/ui/button'
import { getMovieShowtimes, getMovieZip } from '@/lib/movies/api'

const ZIP_KEY = 'showtimes.lastZip'

export function readSavedZip(): string {
  try {
    return localStorage.getItem(ZIP_KEY) ?? ''
  } catch {
    return ''
  }
}

function saveZip(zip: string) {
  try {
    localStorage.setItem(ZIP_KEY, zip)
  } catch {
    /* ignore */
  }
}

// Per-movie local showtimes panel, backed by the existing Fandango integration. Prompts for a
// ZIP if none is saved (shared with the Movie Showtimes app via the same localStorage key).
export function ShowtimesPanel({ title }: { title: string }) {
  const saved = readSavedZip()
  const [zip, setZip] = useState(saved)
  const [draft, setDraft] = useState(saved)
  const valid = /^\d{5}$/.test(zip)

  // No manually-entered ZIP → adopt the household ZIP (geocoded from the user's location) so the
  // panel works without prompting. A manual entry always wins.
  const { data: zipInfo } = useQuery({ queryKey: ['movie-zip'], queryFn: getMovieZip, staleTime: 60 * 60 * 1000, enabled: !saved })
  useEffect(() => {
    const fallback = zipInfo?.zip
    if (!zip && fallback && /^\d{5}$/.test(fallback)) {
      setZip(fallback)
      setDraft(fallback)
    }
  }, [zipInfo, zip])

  const { data, isLoading } = useQuery({
    queryKey: ['movie-showtimes', title, zip],
    queryFn: () => getMovieShowtimes(title, zip),
    enabled: valid,
    staleTime: 60 * 60 * 1000,
  })

  const submit = () => {
    const t = draft.trim()
    if (/^\d{5}$/.test(t)) {
      saveZip(t)
      setZip(t)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-[220px]">
          <MapPin className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, '').slice(0, 5))}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="ZIP code"
            inputMode="numeric"
            className="w-full rounded-control border border-border bg-background py-2 pl-8 pr-3 text-sm outline-none focus:border-brand"
          />
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={submit}
          className="bg-foreground/10 hover:bg-foreground/15"
        >
          Find
        </Button>
      </div>

      {!valid && <p className="text-sm text-muted-foreground">Enter a ZIP code to see local showtimes.</p>}
      {valid && isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="text-current" /> Checking theaters near {zip}…
        </div>
      )}
      {valid && !isLoading && !data && (
        <p className="text-sm text-muted-foreground">Not playing in theaters near {zip} right now.</p>
      )}
      {data && (
        <div className="space-y-3">
          {data.url && (
            <a
              href={data.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-brand hover:underline"
            >
              <Ticket className="size-4" /> Tickets on Fandango
            </a>
          )}
          {data.theater_groups.map((g, i) => (
            <div key={`${g.theater_name}-${i}`} className="rounded-card border border-border/50 p-3">
              <p className="text-sm font-medium">{g.theater_name}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {g.times.map((t, j) => (
                  <span
                    key={j}
                    className="inline-flex items-center gap-1 rounded-full bg-foreground/8 px-2 py-1 text-xs"
                  >
                    <Clock className="size-3 text-muted-foreground" />
                    {t}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

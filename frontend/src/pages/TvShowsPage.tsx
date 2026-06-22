import { useCallback, useState } from 'react'
import { Loader2, Monitor, Star } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { PageShell } from '@/components/shared/PageShell'
import { cn } from '@/lib/cn'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useBreadcrumbSearch } from '@/context/BreadcrumbSearchContext'

interface ShowData {
  found: boolean
  name?: string
  summary?: string
  premiered?: string
  ended?: string
  status?: string
  network?: string
  language?: string
  genres?: string[]
  rating?: number | null
  runtime?: number
  season_count?: number
  cast_line?: string
  url?: string
  image?: string
}

function statusVariant(status: string): 'default' | 'secondary' | 'outline' {
  if (status === 'Running') return 'default'
  if (status === 'Ended') return 'secondary'
  return 'outline'
}

function statusClass(status: string): string {
  if (status === 'Running') return 'bg-emerald-600/20 text-emerald-400 border-emerald-600/30 hover:bg-emerald-600/20'
  return ''
}

function ShowCard({ show }: { show: ShowData }) {
  const [expanded, setExpanded] = useState(false)
  const [imgOk, setImgOk] = useState(true)

  const year = show.premiered ? show.premiered.slice(0, 4) : null
  const network = show.network || null

  return (
    <Card
      className="cursor-pointer transition-all hover:border-brand/40 hover:shadow-md active:scale-[0.99]"
      onClick={() => setExpanded((v) => !v)}
    >
      <CardContent className="flex gap-4 p-4">
        {/* Poster */}
        <div className="shrink-0">
          {show.image && imgOk ? (
            <img
              src={show.image}
              alt={show.name ?? ''}
              className="h-[90px] w-[60px] rounded-md object-cover"
              loading="lazy"
              onError={() => setImgOk(false)}
            />
          ) : (
            <div className="flex h-[90px] w-[60px] items-center justify-center rounded-md bg-muted">
              <Monitor className="size-5 text-muted-foreground/50" />
            </div>
          )}
        </div>

        {/* Info */}
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="font-semibold leading-tight">{show.name}</p>

          <p className="text-xs text-muted-foreground">
            {[network, year].filter(Boolean).join(' · ')}
          </p>

          {show.status && (
            <Badge
              variant={statusVariant(show.status)}
              className={cn('text-[10px]', statusClass(show.status))}
            >
              {show.status}
            </Badge>
          )}

          {show.rating != null && (
            <p className="flex items-center gap-1 text-xs text-amber-400">
              <Star className="size-3 fill-amber-400" />
              {Number(show.rating).toFixed(1)}
            </p>
          )}

          {show.summary && (
            <p
              className={cn(
                'text-xs text-muted-foreground',
                !expanded && 'line-clamp-3',
              )}
            >
              {show.summary}
            </p>
          )}

          {show.season_count ? (
            <p className="text-xs text-muted-foreground">
              {show.season_count} season{show.season_count !== 1 ? 's' : ''}
              {show.genres?.length ? ` · ${show.genres.join(', ')}` : ''}
            </p>
          ) : show.genres?.length ? (
            <p className="text-xs text-muted-foreground">{show.genres.join(', ')}</p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}

export function TvShowsPage() {
  const [query, setQuery] = useState('')
  const [show, setShow] = useState<ShowData | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'notfound' | 'error' | 'ready'>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  usePublishUIContext({
    label: 'TV Shows',
    description: show?.name
      ? `User is looking at TV show info for ${show.name}.`
      : 'User is on the TV Shows search page.',
  })

  const search = useCallback(async (q: string) => {
    const trimmed = q.trim()
    if (!trimmed) return
    setStatus('loading')
    setShow(null)
    setErrorMsg('')
    try {
      const res = await fetch(`/api/tv-shows?q=${encodeURIComponent(trimmed)}`, {
        credentials: 'include',
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setErrorMsg(body.error ?? 'Something went wrong')
        setStatus('error')
        return
      }
      const data = (await res.json()) as ShowData
      if (!data.found) {
        setStatus('notfound')
        return
      }
      setShow(data)
      setStatus('ready')
    } catch {
      setErrorMsg('Could not reach the server. Check your connection.')
      setStatus('error')
    }
  }, [])

  const onSubmit = useCallback(() => { void search(query) }, [search, query])
  useBreadcrumbSearch({
    query,
    setQuery,
    onSubmit,
    placeholder: 'Search TV shows...',
    loading: status === 'loading',
    externalHref: 'https://www.tvmaze.com',
    settingsHref: '/admin/features?tool=tvshows',
  })

  return (
    <PageShell
      gradient="linear-gradient(135deg,#0c4a6e,#0284c7)"
      GhostIcon={Monitor}
    >
      <div className="px-5 pb-10 pt-5">
        {/* States */}
        {status === 'idle' && (
          <div className="flex flex-col items-center gap-3 py-24 text-center text-muted-foreground">
            <Monitor className="size-10 opacity-20" />
            <p className="text-sm">Search for a TV show</p>
          </div>
        )}

        {status === 'loading' && (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {status === 'notfound' && (
          <div className="flex flex-col items-center gap-2 py-24 text-center text-muted-foreground">
            <Monitor className="size-10 opacity-20" />
            <p className="text-sm">No show found for &ldquo;{query}&rdquo;.</p>
          </div>
        )}

        {status === 'error' && (
          <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {errorMsg}
          </div>
        )}

        {status === 'ready' && show && (
          <div className="mt-5 grid gap-3">
            <ShowCard show={show} />
          </div>
        )}
      </div>
    </PageShell>
  )
}

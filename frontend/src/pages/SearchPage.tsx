import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Globe, SearchIcon } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { PageShell } from '@/components/shared/PageShell'
import { PageContainer } from '@/components/shared/PageContainer'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'
import { AiOverviewCard } from '@/components/search/AiOverviewCard'

interface WebResult {
  title: string
  snippet: string
  url: string
  engine?: string
}

interface ImageResult {
  title: string
  imageUrl: string
  thumbnailUrl: string
  source: string
  width: number | null
  height: number | null
}

interface WebSearchResponse {
  web: WebResult[]
  images: ImageResult[]
}

async function fetchWebSearch(query: string): Promise<WebSearchResponse> {
  const r = await fetch(`/api/search/web?q=${encodeURIComponent(query)}`, { credentials: 'include' })
  if (!r.ok) throw new Error('Request failed')
  return r.json() as Promise<WebSearchResponse>
}

function displayUrl(url: string): string {
  try {
    const u = new URL(url)
    return u.hostname.replace(/^www\./, '') + (u.pathname !== '/' ? u.pathname : '')
  } catch {
    return url
  }
}

function SkeletonLines() {
  return (
    <div className="space-y-6 pt-2">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-5 w-full max-w-lg" />
          <Skeleton className="h-4 w-4/5 max-w-md" />
        </div>
      ))}
    </div>
  )
}

export function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const initialQuery = searchParams.get('q') ?? ''
  const [inputValue, setInputValue] = useState(initialQuery)
  const [submittedQuery, setSubmittedQuery] = useState(initialQuery)
  const [view, setView] = useState<'web' | 'images'>('web')

  const { data, isFetching } = useQuery<WebSearchResponse>({
    queryKey: ['websearch', submittedQuery],
    queryFn: () => fetchWebSearch(submittedQuery),
    enabled: submittedQuery.length > 0,
    staleTime: 5 * 60 * 1000,
  })

  const handleSubmit = useCallback((q?: string) => {
    const word = (q ?? inputValue).trim()
    if (!word) return
    setSubmittedQuery(word)
    setView('web')
    setSearchParams({ q: word }, { replace: true })
  }, [inputValue, setSearchParams])

  // Keep the page in sync if the query string changes from outside (e.g. a fresh
  // Spotlight "see all results" navigation while this page is already mounted).
  useEffect(() => {
    const q = searchParams.get('q') ?? ''
    if (q && q !== submittedQuery) {
      setInputValue(q)
      setSubmittedQuery(q)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  const hasImages = (data?.images.length ?? 0) > 0

  useAppHeader({
    query: inputValue,
    setQuery: setInputValue,
    onSubmit: handleSubmit,
    placeholder: 'Search the web...',
    loading: isFetching,
    rightSlot: submittedQuery && hasImages ? (
      <div className="flex items-center gap-1 rounded-full bg-muted/50 p-1">
        <Button
          type="button"
          variant={view === 'web' ? 'tinted' : 'ghost'}
          size="sm"
          className="h-7 rounded-full px-3"
          onClick={() => setView('web')}
        >
          Web
        </Button>
        <Button
          type="button"
          variant={view === 'images' ? 'tinted' : 'ghost'}
          size="sm"
          className="h-7 rounded-full px-3"
          onClick={() => setView('images')}
        >
          Images
        </Button>
      </div>
    ) : undefined,
  })

  const showEmpty = !submittedQuery
  const showLoading = isFetching && !!submittedQuery
  const showNoResults = !isFetching && submittedQuery && data && data.web.length === 0 && data.images.length === 0
  const showResults = !isFetching && data && (data.web.length > 0 || data.images.length > 0)

  return (
    <PageShell>
      <PageContainer width="narrow" className="flex flex-col gap-6 pt-6 pb-10">

        {/* Empty state */}
        {showEmpty && (
          <div className="flex flex-col items-center gap-3 py-24 text-center">
            <div className="flex size-14 items-center justify-center rounded-card bg-brand/15">
              <Globe className="size-7 text-brand" />
            </div>
            <p className="text-base font-semibold">Search</p>
            <p className="max-w-xs text-sm text-muted-foreground">
              Search the web across privacy-respecting engines, with nothing you search
              tracked or profiled.
            </p>
          </div>
        )}

        {/* AI Overview: streams independently of the plain link list below, so it
            never waits on (or blocks) the rest of the page. */}
        {submittedQuery && <AiOverviewCard query={submittedQuery} />}

        {/* Loading skeleton */}
        {showLoading && <SkeletonLines />}

        {/* No results */}
        {showNoResults && (
          <div className="flex flex-col items-center gap-3 py-24 text-center">
            <SearchIcon className="size-12 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">
              No results for <span className="font-semibold text-foreground">{submittedQuery}</span>
            </p>
          </div>
        )}

        {/* Results */}
        {showResults && data && (
          <div className="animate-in fade-in space-y-6 duration-300">
            {view === 'web' && (
              <ul className="space-y-6">
                {data.web.map((r, i) => (
                  <li key={i} className="space-y-1">
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block text-lg font-medium text-brand hover:underline"
                    >
                      {r.title}
                    </a>
                    <p className="text-xs text-muted-foreground">{displayUrl(r.url)}</p>
                    {r.snippet && <p className="text-sm leading-relaxed text-foreground/90">{r.snippet}</p>}
                  </li>
                ))}
              </ul>
            )}

            {view === 'images' && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                {data.images.map((img, i) => (
                  <a
                    key={i}
                    href={img.imageUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group overflow-hidden rounded-card border bg-muted/30 shadow-sm transition-shadow hover:shadow-md"
                  >
                    <img
                      src={img.thumbnailUrl}
                      alt={img.title}
                      loading="lazy"
                      className="aspect-square w-full object-cover transition-transform duration-300 group-hover:scale-105"
                    />
                  </a>
                ))}
              </div>
            )}
          </div>
        )}
      </PageContainer>
    </PageShell>
  )
}

import { useCallback, useEffect, useState } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { Globe, SearchIcon, Play, Mic, BookMarked, Music, type LucideIcon } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { PageShell } from '@/components/shared/PageShell'
import { PageContainer } from '@/components/shared/PageContainer'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'
import { AiOverviewCard } from '@/components/search/AiOverviewCard'
import { SearchResultRow } from '@/components/search/SearchResultRow'

interface WebResult {
  title: string
  snippet: string
  url: string
  engine?: string
  thumbnail?: string
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

// "From Loki Doki" rail: your own library (videos/podcasts/books/music stations +
// playlists) related to the query, via the existing local-content search
// (routes/search.ts, the same endpoint Spotlight already uses). Fetched as its own
// independent query so a slow/absent match here never holds up the web results or
// the AI Overview.
type RelatedType = 'youtube' | 'video' | 'podcast' | 'book' | 'music'
interface RelatedHit {
  type: RelatedType | string
  id: string
  title: string
  subtitle: string | null
  icon: string | null
  route: string
  group: string
}
const RELATED_TYPES = new Set<string>(['youtube', 'video', 'podcast', 'book', 'music'])
const RELATED_ICON: Record<RelatedType, LucideIcon> = { youtube: Play, video: Play, podcast: Mic, book: BookMarked, music: Music }

async function fetchRelated(query: string): Promise<RelatedHit[]> {
  const r = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { credentials: 'include' })
  if (!r.ok) return []
  const d = await r.json() as { hits?: RelatedHit[] }
  return (d.hits ?? []).filter((h) => RELATED_TYPES.has(h.type)).slice(0, 6)
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

  const { data: related } = useQuery<RelatedHit[]>({
    queryKey: ['websearch-related', submittedQuery],
    queryFn: () => fetchRelated(submittedQuery),
    enabled: submittedQuery.length > 1,
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
  const railImages = data ? data.images.slice(0, 9) : []

  return (
    <PageShell>
      <PageContainer width="default" className="pt-6 pb-10">

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

        {/* Two-column layout once a search is underway: the right-hand rail (same
            grid+sticky-aside pattern as the video watch page) holds the AI Overview
            plus a filled-in images grid below it, so the rail reads as one full
            column instead of a small card floating over empty space; the plain
            results sit in the main column. The aside is FIRST in DOM (mobile shows
            the AI answer above the results) and only moves visually to column 2 at
            the `xl` breakpoint via explicit grid placement. */}
        {submittedQuery && (
          <div className="grid grid-cols-1 gap-x-8 gap-y-4 xl:grid-cols-[1fr_400px]">
            <aside className="min-w-0 space-y-4 xl:sticky xl:top-6 xl:col-start-2 xl:row-start-1 xl:self-start">
              <AiOverviewCard query={submittedQuery} />

              {railImages.length > 0 && (
                <div className="rounded-card border border-border/60 bg-card p-3">
                  <div className="mb-2 flex items-center justify-between px-1">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Images</p>
                    <button
                      type="button"
                      onClick={() => setView('images')}
                      className="text-xs font-medium text-brand hover:underline"
                    >
                      See all
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {railImages.map((img, i) => (
                      <a
                        key={i}
                        href={img.imageUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="group aspect-square overflow-hidden rounded-control bg-muted/30"
                      >
                        <img
                          src={img.thumbnailUrl}
                          alt={img.title}
                          loading="lazy"
                          className="size-full object-cover transition-transform duration-300 group-hover:scale-105"
                        />
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {related && related.length > 0 && (
                <div className="rounded-card border border-border/60 bg-card p-3">
                  <p className="mb-1.5 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    From Loki Doki
                  </p>
                  <div className="flex flex-col">
                    {related.map((hit) => {
                      const Fallback = RELATED_ICON[hit.type as RelatedType] ?? Play
                      return (
                        <Link
                          key={`${hit.type}:${hit.id}`}
                          to={hit.route}
                          className="group flex items-center gap-3 rounded-control p-1.5 transition-colors hover:bg-foreground/5"
                        >
                          <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-control bg-muted/50">
                            {hit.icon ? (
                              <img src={hit.icon} alt="" loading="lazy" className="size-full object-cover" />
                            ) : (
                              <Fallback className="size-4 text-muted-foreground" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[13px] font-medium leading-snug group-hover:text-brand">{hit.title}</p>
                            <p className="truncate text-xs text-muted-foreground">{hit.subtitle || hit.group}</p>
                          </div>
                        </Link>
                      )
                    })}
                  </div>
                </div>
              )}
            </aside>

            <div className="min-w-0 space-y-6 xl:col-start-1 xl:row-start-1">
              {showLoading && <SkeletonLines />}

              {showNoResults && (
                <div className="flex flex-col items-center gap-3 py-24 text-center">
                  <SearchIcon className="size-12 text-muted-foreground/30" />
                  <p className="text-sm text-muted-foreground">
                    No results for <span className="font-semibold text-foreground">{submittedQuery}</span>
                  </p>
                </div>
              )}

              {showResults && data && (
                <div className="animate-in fade-in space-y-6 duration-300">
                  {view === 'web' && (
                    <ul className="divide-y divide-border/40">
                      {data.web.map((r, i) => (
                        <li key={i} className="py-4 first:pt-0">
                          <SearchResultRow title={r.title} url={r.url} snippet={r.snippet} thumbnail={r.thumbnail} />
                        </li>
                      ))}
                    </ul>
                  )}

                  {view === 'images' && (
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-3">
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
            </div>
          </div>
        )}
      </PageContainer>
    </PageShell>
  )
}

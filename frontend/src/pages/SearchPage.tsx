import { useCallback, useEffect, useState } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { Globe, SearchIcon, Play, Mic, BookMarked, Music, ImageOff, X, type LucideIcon } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { cn } from '@/lib/cn'
import { proxyImg } from '@/lib/img'
import { PageShell } from '@/components/shared/PageShell'
import { PageContainer } from '@/components/shared/PageContainer'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'
import { AiOverviewCard } from '@/components/search/AiOverviewCard'
import { SearchResultRow } from '@/components/search/SearchResultRow'

/** Image tile that loads through the same-origin image proxy (engine thumbnail hosts
 *  routinely block cross-origin hotlinking, which showed as broken/placeholder tiles)
 *  and swaps to a muted placeholder if it still fails (404s, expired CDN links). */
function SafeThumb({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <div className={cn('grid place-items-center bg-muted/50', className)}>
        <ImageOff className="size-5 text-muted-foreground/40" />
      </div>
    )
  }
  return (
    <img
      src={proxyImg(src)}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn('object-cover', className)}
    />
  )
}

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
const RELATED_LABEL: Record<RelatedType, string> = { youtube: 'Video', video: 'Video', podcast: 'Podcast', book: 'Book', music: 'Music' }

// Quick-jump filter chips for the rail: youtube+video collapse into one "Videos"
// bucket (both are just "a video" to the user), the rest map 1:1 to their type.
const RELATED_BUCKETS: { key: string; label: string; types: RelatedType[] }[] = [
  { key: 'video', label: 'Videos', types: ['youtube', 'video'] },
  { key: 'podcast', label: 'Podcasts', types: ['podcast'] },
  { key: 'music', label: 'Music', types: ['music'] },
  { key: 'book', label: 'Books', types: ['book'] },
]

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
  const [relatedFilter, setRelatedFilter] = useState<string | null>(null)
  // "More results" pagination: extra pages fetched on demand and appended.
  const [extraWeb, setExtraWeb] = useState<WebResult[]>([])
  const [webPage, setWebPage] = useState(1)
  const [loadingMore, setLoadingMore] = useState(false)
  const [noMoreWeb, setNoMoreWeb] = useState(false)

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
    setRelatedFilter(null)
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

  // Reset pagination whenever the effective query changes (covers both submit
  // paths above).
  useEffect(() => {
    setExtraWeb([])
    setWebPage(1)
    setNoMoreWeb(false)
    setLoadingMore(false)
  }, [submittedQuery])

  const loadMoreWeb = useCallback(async () => {
    if (loadingMore) return
    setLoadingMore(true)
    const nextPage = webPage + 1
    try {
      const r = await fetch(`/api/search/web?q=${encodeURIComponent(submittedQuery)}&page=${nextPage}`, { credentials: 'include' })
      if (!r.ok) throw new Error('failed')
      const d = await r.json() as { web?: WebResult[] }
      const seen = new Set([...(data?.web ?? []), ...extraWeb].map((w) => w.url))
      const fresh = (d.web ?? []).filter((w) => !seen.has(w.url))
      setExtraWeb((prev) => [...prev, ...fresh])
      setWebPage(nextPage)
      if (fresh.length < 3 || nextPage >= 5) setNoMoreWeb(true)
    } catch {
      setNoMoreWeb(true)
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, webPage, submittedQuery, data, extraWeb])

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
  const allWeb = data ? [...data.web, ...extraWeb] : []
  const availableBuckets = related
    ? RELATED_BUCKETS.filter((b) => related.some((h) => b.types.includes(h.type as RelatedType)))
    : []
  const filteredRelated = related
    ? relatedFilter
      ? related.filter((h) => RELATED_BUCKETS.find((b) => b.key === relatedFilter)?.types.includes(h.type as RelatedType))
      : related
    : []

  return (
    <PageShell>
      <PageContainer width="wide" className="pt-6 pb-10">

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

        {/* Two-column layout once a search is underway: a right-hand rail (AI Overview +
            images + related library) and the main results column. On `xl`+ each column
            gets its OWN capped-height scroll area (like a split pane) so scrolling
            through a long result list never carries the rail out of view with it,
            instead of relying on `position: sticky` (which is finicky inside a shell
            that owns its own scroll container). The aside is FIRST in DOM (mobile shows
            the AI answer above the results) and only moves visually to column 2 at the
            `xl` breakpoint via explicit grid placement; below `xl` both columns fall
            back to normal, un-capped page flow. */}
        {submittedQuery && (
          <div className="grid grid-cols-1 gap-x-8 gap-y-4 xl:grid-cols-[1fr_340px] xl:items-start">
            <aside className="min-w-0 space-y-4 xl:sticky xl:top-6 xl:col-start-2 xl:row-start-1 xl:max-h-[calc(100dvh-6rem)] xl:overflow-y-auto xl:self-start">
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
                        <SafeThumb
                          src={img.thumbnailUrl}
                          alt={img.title}
                          className="size-full transition-transform duration-300 group-hover:scale-105"
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

                  {availableBuckets.length > 1 && (
                    <div className="mb-1.5 flex flex-wrap gap-1 px-1">
                      <Button
                        type="button"
                        variant={relatedFilter === null ? 'tinted' : 'ghost'}
                        size="sm"
                        className="h-6 rounded-full px-2.5 text-xs"
                        onClick={() => setRelatedFilter(null)}
                      >
                        All
                      </Button>
                      {availableBuckets.map((b) => (
                        <Button
                          key={b.key}
                          type="button"
                          variant={relatedFilter === b.key ? 'tinted' : 'ghost'}
                          size="sm"
                          className="h-6 rounded-full px-2.5 text-xs"
                          onClick={() => setRelatedFilter(b.key)}
                        >
                          {b.label}
                        </Button>
                      ))}
                    </div>
                  )}

                  <div className="flex flex-col">
                    {filteredRelated.map((hit) => {
                      const Fallback = RELATED_ICON[hit.type as RelatedType] ?? Play
                      return (
                        <Link
                          key={`${hit.type}:${hit.id}`}
                          to={hit.route}
                          className="group flex items-center gap-3 rounded-control p-1.5 transition-colors hover:bg-foreground/5"
                        >
                          <div className="relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-control bg-muted/50">
                            {hit.icon ? (
                              <img src={hit.icon} alt="" loading="lazy" className="size-full object-cover" />
                            ) : (
                              <Fallback className="size-4 text-muted-foreground" />
                            )}
                            {/* Persistent type badge so it's clear which kind of item this is
                                even when a real thumbnail (icon) hides the fallback glyph above. */}
                            {hit.icon && (
                              <div className="absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-background ring-1 ring-border">
                                <Fallback className="size-2.5 text-muted-foreground" />
                              </div>
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[13px] font-medium leading-snug group-hover:text-brand">{hit.title}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              <span className="font-semibold text-foreground/50">
                                {RELATED_LABEL[hit.type as RelatedType] ?? hit.group}
                              </span>
                              {(hit.subtitle || hit.group) && <span> · {hit.subtitle || hit.group}</span>}
                            </p>
                          </div>
                        </Link>
                      )
                    })}
                  </div>
                </div>
              )}
            </aside>

            <div className="min-w-0 space-y-6 xl:col-start-1 xl:row-start-1 xl:max-h-[calc(100dvh-6rem)] xl:overflow-y-auto xl:pr-2">
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
                    <>
                      <ul className="divide-y divide-border/40">
                        {allWeb.map((r) => (
                          <li key={r.url} className="py-4 first:pt-0">
                            <SearchResultRow title={r.title} url={r.url} snippet={r.snippet} thumbnail={r.thumbnail} />
                          </li>
                        ))}
                      </ul>
                      {allWeb.length > 0 && !noMoreWeb && (
                        <div className="flex justify-center pt-2">
                          <Button type="button" variant="tinted" size="sm" disabled={loadingMore} onClick={() => void loadMoreWeb()}>
                            {loadingMore ? 'Loading…' : 'More results'}
                          </Button>
                        </div>
                      )}
                    </>
                  )}

                  {view === 'images' && (
                    <>
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-semibold">Images for &ldquo;{submittedQuery}&rdquo;</p>
                        <button
                          type="button"
                          onClick={() => setView('web')}
                          aria-label="Back to search results"
                          title="Back to search results"
                          className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                        >
                          <X className="size-4" />
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-3">
                        {data.images.map((img, i) => (
                          <a
                            key={i}
                            href={img.imageUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="group overflow-hidden rounded-card border bg-muted/30 shadow-sm transition-shadow hover:shadow-md"
                          >
                            <SafeThumb
                              src={img.thumbnailUrl}
                              alt={img.title}
                              className="aspect-square w-full transition-transform duration-300 group-hover:scale-105"
                            />
                          </a>
                        ))}
                      </div>
                    </>
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

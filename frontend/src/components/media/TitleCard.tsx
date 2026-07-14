import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { Star, Tv } from 'lucide-react'
import { cn } from '@/lib/cn'
import { DismissableCard } from '@/components/shared/DismissableCard'
import { mediaImg, getShow, getShowOverview, getShowParentsGuide, getShowTrivia } from '@/lib/shows/api'
import { getMovie, getMovieOverview, getMovieParentsGuide, getMovieTrivia } from '@/lib/movies/api'

// A poster card for a show or movie. Generic over both apps via the `to` link target.
export interface PosterItem {
  to: string
  title: string
  subtitle?: string | null
  poster: string | null
  rating?: number | null
  badge?: string | null
  /** Interest-engine ref (suggestion rails only): the key MediaShelfRow's onDismiss
   *  callback identifies the item by. */
  ref?: string
}

// Hover-intent prefetch: the About-tab enrichments (parents guide, trivia) take 5-10s of
// server work on a title's FIRST view (scrapes + an LLM pass; 30-day server cache after).
// Warming them the moment the pointer settles on a card means that work starts seconds
// before the click instead of after the detail page mounts. Keys/staleTime must mirror the
// detail pages' own useQuery calls so these dedupe into the same cache entries.
const PREFETCH_STALE_MS = 30 * 60 * 1000
function prefetchTitle(qc: QueryClient, to: string): void {
  const movie = to.match(/^\/movies\/([^/?]+)(?:\?year=(\d{4}))?$/)
  if (movie) {
    const title = decodeURIComponent(movie[1]!)
    const year = movie[2] ? Number(movie[2]) : null
    void qc.prefetchQuery({ queryKey: ['movie', title, year], queryFn: () => getMovie(title, year), staleTime: PREFETCH_STALE_MS })
    void qc.prefetchQuery({ queryKey: ['movie-overview', title, year], queryFn: () => getMovieOverview(title, year), staleTime: PREFETCH_STALE_MS })
    void qc.prefetchQuery({ queryKey: ['movie-parents-guide', title, year], queryFn: () => getMovieParentsGuide(title, year), staleTime: PREFETCH_STALE_MS })
    void qc.prefetchQuery({ queryKey: ['movie-trivia', title, year], queryFn: () => getMovieTrivia(title, year), staleTime: PREFETCH_STALE_MS })
    return
  }
  const show = to.match(/^\/shows\/(\d+)$/)
  if (show) {
    const id = show[1]!
    void qc.prefetchQuery({ queryKey: ['show', id], queryFn: () => getShow(id), staleTime: PREFETCH_STALE_MS })
    void qc.prefetchQuery({ queryKey: ['show-overview', id], queryFn: () => getShowOverview(id), staleTime: PREFETCH_STALE_MS })
    void qc.prefetchQuery({ queryKey: ['show-parents-guide', id], queryFn: () => getShowParentsGuide(id), staleTime: PREFETCH_STALE_MS })
    void qc.prefetchQuery({ queryKey: ['show-trivia', id], queryFn: () => getShowTrivia(id), staleTime: PREFETCH_STALE_MS })
  }
}

export function TitleCard({ item, fluid, className }: { item: PosterItem; fluid?: boolean; className?: string }) {
  const [ok, setOk] = useState(true)
  const qc = useQueryClient()
  // Fire once per card after the pointer settles for 150ms (a brush-past shouldn't cost a scrape).
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fired = useRef(false)
  const onEnter = () => {
    if (fired.current) return
    timer.current = setTimeout(() => { fired.current = true; prefetchTitle(qc, item.to) }, 150)
  }
  const onLeave = () => { if (timer.current) clearTimeout(timer.current) }
  return (
    <Link
      to={item.to}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onTouchStart={onEnter}
      className={cn(
        'group block',
        fluid ? 'w-full' : 'w-[140px] shrink-0 sm:w-[160px]',
        className,
      )}
    >
      <div className="relative aspect-[2/3] overflow-hidden rounded-card bg-muted shadow-sm ring-1 ring-border/40 transition-transform group-hover:scale-[1.03] group-active:scale-[0.99]">
        {item.poster && ok ? (
          <img
            src={mediaImg(item.poster)}
            alt={item.title}
            loading="lazy"
            className="size-full object-cover"
            onError={() => setOk(false)}
          />
        ) : (
          <div className="flex size-full items-center justify-center">
            <Tv className="size-7 text-muted-foreground/40" />
          </div>
        )}
        {item.badge && (
          <span className="absolute left-1.5 top-1.5 rounded-full bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white">
            {item.badge}
          </span>
        )}
        {item.rating != null && item.rating > 0 && (
          <span className="absolute bottom-1.5 right-1.5 flex items-center gap-0.5 rounded-full bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-warning">
            <Star className="size-2.5 fill-warning" />
            {item.rating.toFixed(1)}
          </span>
        )}
      </div>
      <p className="mt-1.5 line-clamp-1 text-sm font-medium leading-tight">{item.title}</p>
      {item.subtitle && <p className="line-clamp-1 text-xs text-muted-foreground">{item.subtitle}</p>}
    </Link>
  )
}

// A horizontally-scrolling shelf of poster cards with a heading. `onDismiss` (suggestion
// rails) adds a "Not interested" X to each card via the shared DismissableCard wrapper.
export function MediaShelfRow({ title, items, onDismiss }: {
  title: string
  items: PosterItem[]
  onDismiss?: (item: PosterItem) => void
}) {
  if (!items.length) return null
  return (
    <section className="space-y-2.5">
      <h2 className="px-0.5 text-base font-semibold">{title}</h2>
      <div className="flex gap-3 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((item, i) => (
          onDismiss ? (
            <DismissableCard key={`${item.to}-${i}`} onDismiss={() => onDismiss(item)}>
              <TitleCard item={item} />
            </DismissableCard>
          ) : (
            <TitleCard key={`${item.to}-${i}`} item={item} />
          )
        ))}
      </div>
    </section>
  )
}

// A small section heading used across detail-page sections.
export function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-3 text-lg font-semibold">{children}</h2>
}

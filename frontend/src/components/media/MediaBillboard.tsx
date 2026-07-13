// The Movies/Shows hub focal point: a full-width editorial billboard, same
// Apple-TV/Netflix pattern as the Videos billboard, but poster-first: each slide
// upgrades from the item's poster to a proper widescreen backdrop once the backdrop
// endpoint answers, and dissolves into an accent extracted from the art itself (one of
// this hub's sanctioned dynamic-palette surfaces: hub billboard, detail pages).
// Clicking a slide opens the title's detail page.

import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Info } from 'lucide-react'
import { cn } from '@/lib/cn'
import { accentOf, useArtPalette } from '@/lib/artPalette'
import { BlendedHeroBackdrop } from '@/components/shared/BlendedHeroBackdrop'
import { getShowBackdrop, mediaImg } from '@/lib/shows/api'
import { getMovieBackdrop } from '@/lib/movies/api'

const ROTATE_MS = 7000

export type BillboardItem = {
  to: string
  title: string
  subtitle?: string | null
  poster?: string | null
} & (
  | { kind: 'show'; id: number | string }
  | { kind: 'movie'; year: number | null }
)

/** Backdrop art keyed exactly like the detail pages so the cache is shared. */
function useBillboardArt(item: BillboardItem): string | null {
  const { data: backdrop } = useQuery({
    queryKey: item.kind === 'show'
      ? ['show-backdrop', String(item.id)]
      : ['movie-backdrop', item.title, item.year],
    queryFn: () => (item.kind === 'show' ? getShowBackdrop(item.id) : getMovieBackdrop(item.title, item.year)),
    staleTime: 60 * 60 * 1000,
  })
  const raw = backdrop ?? item.poster ?? null
  return raw ? mediaImg(raw) : null
}

function BillboardSlide({ item, eyebrow }: { item: BillboardItem; eyebrow: string }) {
  const art = useBillboardArt(item)
  const palette = useArtPalette(art)
  const accent = accentOf(palette)

  return (
    <Link to={item.to} draggable={false}
      className="group relative w-full shrink-0 snap-center overflow-hidden text-left">
      {/* Taller on phones: eyebrow + 2-line title + meta + pill need the extra height. */}
      <div className="relative aspect-[5/3] w-full overflow-hidden sm:aspect-auto sm:h-64 lg:h-72 xl:h-80">
        <BlendedHeroBackdrop art={art} color={accent} colorDark={palette.dark} />
      </div>
      <div className="absolute inset-y-0 left-0 flex max-w-xl flex-col justify-center gap-2 p-5 sm:p-9">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-white/60">{eyebrow}</span>
        <span className="line-clamp-2 text-xl font-extrabold tracking-tight text-white sm:text-4xl">{item.title}</span>
        {item.subtitle && <span className="line-clamp-1 max-w-md text-sm text-white/70">{item.subtitle}</span>}
        <span className="mt-2 inline-flex w-fit items-center gap-2 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-black shadow-lg transition group-hover:scale-105 group-active:scale-95">
          <Info className="size-4" /> Details
        </span>
      </div>
    </Link>
  )
}

export function MediaBillboard({ items, eyebrow }: {
  /** Featured slides, best first (a single item renders without dots or rotation). */
  items: BillboardItem[]
  /** Editorial label, e.g. "Trending this week". */
  eyebrow: string
}) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  // A manual swipe/scroll parks the timer for one cycle so it doesn't fight the user.
  const holdUntil = useRef(0)

  const count = items.length
  const goTo = (i: number, smooth = true) => {
    const el = scrollerRef.current
    if (!el) return
    el.scrollTo({ left: i * el.clientWidth, behavior: smooth ? 'smooth' : 'auto' })
  }

  useEffect(() => {
    if (count < 2) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) return
    const iv = setInterval(() => {
      if (paused || document.hidden || Date.now() < holdUntil.current) return
      const el = scrollerRef.current
      if (!el) return
      const cur = Math.round(el.scrollLeft / el.clientWidth)
      goTo((cur + 1) % count)
    }, ROTATE_MS)
    return () => clearInterval(iv)
  }, [count, paused])

  if (count === 0) return null

  return (
    <div className="group/billboard relative mb-8 overflow-hidden rounded-sheet shadow-xl"
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <div ref={scrollerRef}
        className="no-scrollbar flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain"
        onScroll={(e) => {
          const el = e.currentTarget
          const i = Math.round(el.scrollLeft / el.clientWidth)
          if (i !== index) setIndex(Math.max(0, Math.min(count - 1, i)))
        }}
        onTouchStart={() => { holdUntil.current = Date.now() + ROTATE_MS * 2 }}
        onWheel={() => { holdUntil.current = Date.now() + ROTATE_MS * 2 }}>
        {items.map((item) => (
          <BillboardSlide key={item.to} item={item} eyebrow={eyebrow} />
        ))}
      </div>
      {count > 1 && (
        <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5">
          {items.map((item, i) => (
            <button key={item.to} type="button"
              aria-label={`Show slide ${i + 1} of ${count}`}
              onClick={() => { holdUntil.current = Date.now() + ROTATE_MS * 2; goTo(i) }}
              className={cn('h-1.5 rounded-full transition-all',
                i === index ? 'w-5 bg-white' : 'w-1.5 bg-white/40 hover:bg-white/70')} />
          ))}
        </div>
      )}
    </div>
  )
}

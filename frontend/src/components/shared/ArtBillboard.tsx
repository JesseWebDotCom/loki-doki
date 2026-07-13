// Generic editorial billboard for app hubs: up to six featured items in a scroll-snap
// carousel that auto-rotates (paused on hover, hidden tab, reduced motion; a swipe or
// wheel parks it for a cycle). Each slide's artwork anchors the right edge and
// dissolves into an accent extracted from the art itself via BlendedHeroBackdrop.
// The app-neutral sibling of the Videos/Media billboards: pass same-origin art and a
// per-item link or click action; the caller owns data shape and eyebrow copy.

import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'
import { accentOf, useArtPalette } from '@/lib/artPalette'
import { BlendedHeroBackdrop } from '@/components/shared/BlendedHeroBackdrop'

const ROTATE_MS = 7000

export interface ArtBillboardItem {
  key: string
  title: string
  subtitle?: string | null
  /** Same-origin/proxied art URL (palette extraction needs it) or null for accent-only. */
  art: string | null
  /** Link target; ignored when onClick is set. */
  to?: string
  state?: unknown
  onClick?: () => void
  pillLabel: string
  PillIcon: LucideIcon
}

function BillboardSlide({ item, eyebrow }: { item: ArtBillboardItem; eyebrow: string }) {
  const palette = useArtPalette(item.art)
  const accent = accentOf(palette)

  const body = (
    <>
      {/* Taller on phones: eyebrow + 2-line title + meta + pill need the extra height. */}
      <div className="relative aspect-[5/3] w-full overflow-hidden sm:aspect-auto sm:h-64 lg:h-72 xl:h-80">
        <BlendedHeroBackdrop art={item.art} color={accent} colorDark={palette.dark} />
      </div>
      <div className="absolute inset-y-0 left-0 flex max-w-xl flex-col justify-center gap-2 p-5 sm:p-9">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-white/60">{eyebrow}</span>
        <span className="line-clamp-2 text-xl font-extrabold tracking-tight text-white sm:text-4xl">{item.title}</span>
        {item.subtitle && <span className="line-clamp-1 max-w-md text-sm text-white/70">{item.subtitle}</span>}
        <span className="mt-2 inline-flex w-fit items-center gap-2 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-black shadow-lg transition group-hover:scale-105 group-active:scale-95">
          <item.PillIcon className="size-4" /> {item.pillLabel}
        </span>
      </div>
    </>
  )
  const cls = 'group relative w-full shrink-0 snap-center overflow-hidden text-left'

  if (item.onClick) {
    return <button type="button" onClick={item.onClick} className={cls}>{body}</button>
  }
  return <Link to={item.to ?? '#'} state={item.state} draggable={false} className={cls}>{body}</Link>
}

export function ArtBillboard({ items, eyebrow, className }: {
  /** Featured slides, best first (a single item renders without dots or rotation). */
  items: ArtBillboardItem[]
  /** Editorial label, e.g. "Continue listening". */
  eyebrow: string
  className?: string
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
    <div className={cn('group/billboard relative overflow-hidden rounded-sheet shadow-xl', className)}
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
          <BillboardSlide key={item.key} item={item} eyebrow={eyebrow} />
        ))}
      </div>
      {count > 1 && (
        <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5">
          {items.map((item, i) => (
            <button key={item.key} type="button"
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

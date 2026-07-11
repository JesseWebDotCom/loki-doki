// The hub home's focal point: a full-width editorial billboard, the same
// Apple-Music/Netflix pattern as Music's StationBillboard, but multi-page: up to six
// featured videos in a scroll-snap carousel that auto-rotates (paused on hover, on a
// hidden tab, and under prefers-reduced-motion; a swipe/drag pauses it briefly too).
// Each slide's thumbnail anchors the right edge and DISSOLVES into an accent extracted
// from the art itself (one of the three sanctioned dynamic-palette surfaces: watch page,
// channel pages, home billboard). Clicking anywhere opens the watch page.

import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Play } from 'lucide-react'
import { cn } from '@/lib/cn'
import { proxyImg } from '@/lib/img'
import { thumbUrl } from '@/lib/youtube/format'
import { ytImageProxy } from '@/lib/youtube/api'
import { accentOf, useArtPalette } from '@/lib/artPalette'
import { BlendedHeroBackdrop } from '@/components/shared/BlendedHeroBackdrop'
import { SOURCE_META } from '@/lib/videos/sources'
import { HUB_PATHS } from '@/components/videos/HubVideoCard'
import { VideoPlaceholderArt } from '@/components/videos/VideoPlaceholderArt'
import type { HubVideoItem } from '@/lib/videos/api'

const ROTATE_MS = 7000

/** Billboard art: YouTube gets the sharper hqdefault straight from the yt image cache
 *  (mq looks soft at billboard size; maxres has no onError path here so we don't chase it);
 *  other sources proxy whatever thumbnail the provider gave us. Same-origin either way,
 *  so the palette extraction below never taints the canvas. */
function billboardArt(item: HubVideoItem): string | null {
  if (item.source === 'youtube') return ytImageProxy(thumbUrl(item.id, 'hq'))
  return item.thumbnailUrl ? proxyImg(item.thumbnailUrl) : null
}

function BillboardSlide({ item, eyebrow, resume }: { item: HubVideoItem; eyebrow: string; resume?: boolean }) {
  const art = billboardArt(item)
  const palette = useArtPalette(art)
  const accent = accentOf(palette)
  const badge = SOURCE_META[item.source]
  const meta = [item.creator?.name, item.viewsText].filter(Boolean).join(' · ')

  return (
    <Link to={HUB_PATHS[item.source].watch(item.id)} draggable={false}
      className="group relative w-full shrink-0 snap-center overflow-hidden text-left">
      {/* Taller on phones: eyebrow + 2-line title + meta + pill need the extra height. */}
      <div className="relative aspect-[5/3] w-full overflow-hidden sm:aspect-[21/6]">
        <BlendedHeroBackdrop art={art} color={accent} colorDark={palette.dark}
          fallback={<VideoPlaceholderArt source={item.source} />} />
      </div>
      <div className="absolute inset-y-0 left-0 flex max-w-xl flex-col justify-center gap-2 p-5 sm:p-9">
        <span className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-white/60">{eyebrow}</span>
          <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold', badge.badgeClass)}>
            <badge.icon className="size-2.5" aria-hidden /> {badge.label}
          </span>
        </span>
        <span className="line-clamp-2 text-xl font-extrabold tracking-tight text-white sm:text-4xl">{item.title}</span>
        {meta && <span className="line-clamp-1 max-w-md text-sm text-white/70">{meta}</span>}
        <span className="mt-2 inline-flex w-fit items-center gap-2 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-black shadow-lg transition group-hover:scale-105 group-active:scale-95">
          <Play className="size-4 fill-current" /> {resume ? 'Resume' : 'Play'}
        </span>
      </div>
    </Link>
  )
}

export function VideoBillboard({ items, eyebrow, resume }: {
  /** Featured slides, best first (a single item renders without dots or rotation). */
  items: HubVideoItem[]
  /** Editorial label, e.g. "Featured today" or "Continue watching". */
  eyebrow: string
  /** Renders the pill as "Resume" (the watch page picks up the saved position). */
  resume?: boolean
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
          <BillboardSlide key={`${item.source}:${item.id}`} item={item} eyebrow={eyebrow} resume={resume} />
        ))}
      </div>
      {count > 1 && (
        <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5">
          {items.map((item, i) => (
            <button key={`${item.source}:${item.id}`} type="button"
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

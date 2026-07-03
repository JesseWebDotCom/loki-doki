import { useEffect, useState } from 'react'
import { Lightbulb } from 'lucide-react'
import { cn } from '@/lib/cn'
import { PROMO_SLIDES, PROMO_TIPS } from './promoContent'

const HERO_INTERVAL_MS = 11000
const TIP_INTERVAL_MS  = 16000

// Install-screen promo: a rotating hero showcase of features, with a separate,
// faster ticker of learnable usage tips below it (à la OS / game installers).
export function InstallPromo({ className }: { className?: string }) {
  const [heroIdx, setHeroIdx] = useState(0)
  const [tipIdx, setTipIdx]   = useState(0)
  const [paused, setPaused]   = useState(false)

  // Hero auto-advance - pauses while the user is hovering/reading.
  useEffect(() => {
    if (paused) return
    const id = setInterval(() => {
      setHeroIdx((i) => (i + 1) % PROMO_SLIDES.length)
    }, HERO_INTERVAL_MS)
    return () => clearInterval(id)
  }, [paused])

  // Tips rotate on their own timer, independent of the hero.
  useEffect(() => {
    const id = setInterval(() => {
      setTipIdx((i) => (i + 1) % PROMO_TIPS.length)
    }, TIP_INTERVAL_MS)
    return () => clearInterval(id)
  }, [])

  const slide = PROMO_SLIDES[heroIdx]
  const Icon  = slide.Icon

  return (
    <div
      className={cn('overflow-hidden rounded-sheet border border-border/60 bg-card', className)}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* Hero */}
      <div className="relative px-6 py-7 text-white" style={{ background: slide.gradient }}>
        {/* Soft glow accent. design-ok(glass-on-plain-bg): white glow over the slide's own
            rotating gradient artwork, not a plain surface. */}
        <div className="pointer-events-none absolute -right-10 -top-10 size-40 rounded-full bg-white/10 blur-2xl" />

        <div key={heroIdx} className="relative animate-in fade-in slide-in-from-bottom-2 duration-500">
          <div className="mb-4 flex items-center gap-4">
            {/* design-ok(backdrop-blur-outside-chrome): icon chip glass sits over the gradient artwork, not a plain surface. */}
            <div className="flex size-11 shrink-0 items-center justify-center rounded-control bg-white/15 backdrop-blur-sm">
              <Icon className="size-6" />
            </div>
            <div>
              <p className="mb-0.5 text-[11px] font-bold uppercase tracking-[0.12em] text-white/75">{slide.app}</p>
              <h3 className="text-lg font-bold tracking-tight leading-tight">{slide.headline}</h3>
            </div>
          </div>
          {/* Fixed floor for blurb so rotating slides don't resize the card. */}
          <div className="min-h-[3.5rem]">
            <p className="text-sm leading-relaxed text-white/85">{slide.blurb}</p>
          </div>
        </div>

        {/* Dots */}
        <div className="relative mt-5 flex items-center gap-1.5">
          {PROMO_SLIDES.map((_, i) => (
            <button
              key={i}
              type="button"
              aria-label={`Show highlight ${i + 1}`}
              onClick={() => setHeroIdx(i)}
              className={cn(
                'h-1.5 rounded-full transition-all',
                i === heroIdx ? 'w-5 bg-white' : 'w-1.5 bg-white/40 hover:bg-white/70',
              )}
            />
          ))}
        </div>
      </div>

      {/* Tips ticker */}
      <div className="flex items-center gap-2.5 px-5 py-3">
        <Lightbulb className="size-4 shrink-0 text-brand" />
        <p key={tipIdx} className="min-w-0 flex-1 truncate text-xs text-muted-foreground animate-in fade-in duration-500">
          <span className="font-semibold text-foreground/70">Did you know?</span>{' '}
          {PROMO_TIPS[tipIdx]}
        </p>
      </div>
    </div>
  )
}

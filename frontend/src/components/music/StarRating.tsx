// Apple-Music-style 5-star rating row (Moosic look). Optimistic writes; tapping the
// current rating clears it. Sized for the Now Playing hero but reusable in rows.

import { useEffect, useState } from 'react'
import { Star } from 'lucide-react'
import { cn } from '@/lib/cn'
import { getRatings, setRating, clearRating } from '@/lib/music/metaApi'

export function StarRating({ trackRef, title, artist, className, size = 'default' }: {
  trackRef: string
  title?: string
  artist?: string | null
  className?: string
  size?: 'default' | 'sm'
}) {
  const [stars, setStars] = useState(0)
  const [hover, setHover] = useState(0)

  useEffect(() => {
    let alive = true
    setStars(0)
    getRatings([trackRef]).then((r) => { if (alive) setStars(r[trackRef] ?? 0) })
    return () => { alive = false }
  }, [trackRef])

  const apply = (n: number) => {
    const next = n === stars ? 0 : n
    setStars(next)  // optimistic
    void (next === 0 ? clearRating(trackRef) : setRating(trackRef, next, title, artist))
  }

  const active = hover || stars
  return (
    <div className={cn('flex items-center', size === 'sm' ? 'gap-0.5' : 'gap-1.5', className)}
      onPointerLeave={() => setHover(0)} role="radiogroup" aria-label="Song rating">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" role="radio" aria-checked={stars === n} aria-label={`${n} star${n > 1 ? 's' : ''}`}
          onPointerEnter={() => setHover(n)} onClick={() => apply(n)}
          className="p-0.5 transition-transform active:scale-90">
          <Star className={cn(
            size === 'sm' ? 'size-4' : 'size-5',
            'transition-colors',
            n <= active ? 'fill-current text-foreground/90' : 'text-foreground/30',
          )} />
        </button>
      ))}
    </div>
  )
}

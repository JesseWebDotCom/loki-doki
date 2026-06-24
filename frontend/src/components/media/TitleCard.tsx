import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Star, Tv } from 'lucide-react'
import { cn } from '@/lib/cn'
import { mediaImg } from '@/lib/shows/api'

// A poster card for a show or movie. Generic over both apps via the `to` link target.
export interface PosterItem {
  to: string
  title: string
  subtitle?: string | null
  poster: string | null
  rating?: number | null
  badge?: string | null
}

export function TitleCard({ item, fluid, className }: { item: PosterItem; fluid?: boolean; className?: string }) {
  const [ok, setOk] = useState(true)
  return (
    <Link
      to={item.to}
      className={cn(
        'group block',
        fluid ? 'w-full' : 'w-[140px] shrink-0 sm:w-[160px]',
        className,
      )}
    >
      <div className="relative aspect-[2/3] overflow-hidden rounded-lg bg-muted shadow-sm ring-1 ring-border/40 transition-transform group-hover:scale-[1.03] group-active:scale-[0.99]">
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
          <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white">
            {item.badge}
          </span>
        )}
        {item.rating != null && item.rating > 0 && (
          <span className="absolute bottom-1.5 right-1.5 flex items-center gap-0.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
            <Star className="size-2.5 fill-amber-300" />
            {item.rating.toFixed(1)}
          </span>
        )}
      </div>
      <p className="mt-1.5 line-clamp-1 text-sm font-medium leading-tight">{item.title}</p>
      {item.subtitle && <p className="line-clamp-1 text-xs text-muted-foreground">{item.subtitle}</p>}
    </Link>
  )
}

// A horizontally-scrolling shelf of poster cards with a heading.
export function MediaShelfRow({ title, items }: { title: string; items: PosterItem[] }) {
  if (!items.length) return null
  return (
    <section className="space-y-2.5">
      <h2 className="px-0.5 text-base font-semibold">{title}</h2>
      <div className="flex gap-3 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((item, i) => (
          <TitleCard key={`${item.to}-${i}`} item={item} />
        ))}
      </div>
    </section>
  )
}

// A small section heading used across detail-page sections.
export function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-3 text-lg font-semibold">{children}</h2>
}

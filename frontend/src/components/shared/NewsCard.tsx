// Shared news-card primitives used by NewsPage and the HomePage "Top Stories" section.
// Two card shapes (mirroring a typical news site): NewsFeature (image-on-top hero) and
// NewsRow (thumbnail-on-left list row). Both degrade gracefully when an item has no image
// (a tinted placeholder) and show a source badge (favicon + name) plus a relative timestamp.

import { useState } from 'react'
import { Clock, Newspaper } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface NewsItem {
  title: string
  url?: string
  source?: string
  detail?: string
  imageUrl?: string
  summary?: string
  publishedAt?: number
}

export function hostFromUrl(url?: string): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

export function sourceLabel(item: NewsItem): string {
  return item.source || hostFromUrl(item.url) || 'News'
}

function faviconUrl(url?: string): string | null {
  const host = hostFromUrl(url)
  return host ? `https://www.google.com/s2/favicons?domain=${host}&sz=64` : null
}

export function relativeTime(ts?: number): string | null {
  if (!ts || Number.isNaN(ts)) return null
  const mins = Math.round((Date.now() - ts) / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  if (days < 7) return `${days}d ago`
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// Stable per-source tint for image-less placeholders (static classes for Tailwind).
const TINTS = [
  'from-rose-500/25 to-rose-500/5 text-rose-300',
  'from-amber-500/25 to-amber-500/5 text-amber-300',
  'from-emerald-500/25 to-emerald-500/5 text-emerald-300',
  'from-sky-500/25 to-sky-500/5 text-sky-300',
  'from-violet-500/25 to-violet-500/5 text-violet-300',
  'from-fuchsia-500/25 to-fuchsia-500/5 text-fuchsia-300',
]
function tintFor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return TINTS[h % TINTS.length]!
}

function Favicon({ item, className }: { item: NewsItem; className?: string }) {
  const [failed, setFailed] = useState(false)
  const fav = faviconUrl(item.url)
  if (!fav || failed) return null
  return <img src={fav} alt="" loading="lazy" onError={() => setFailed(true)} className={cn('rounded-[3px]', className)} />
}

/** Small source chip: favicon + uppercased source name. */
export function SourceBadge({ item }: { item: NewsItem }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 rounded-md bg-foreground/8 px-1.5 py-0.5">
      <Favicon item={item} className="size-3 shrink-0" />
      <span className="truncate text-[10px] font-bold uppercase tracking-wide text-foreground/55">{sourceLabel(item)}</span>
    </span>
  )
}

/** Thumbnail/photo area; falls back to a tinted placeholder when there's no image. */
function NewsThumb({ item, className }: { item: NewsItem; className?: string }) {
  const [failed, setFailed] = useState(false)
  if (item.imageUrl && !failed) {
    return (
      <img
        src={item.imageUrl}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
        className={cn('bg-foreground/5 object-cover', className)}
      />
    )
  }
  return (
    <div className={cn('grid place-items-center bg-gradient-to-br', tintFor(sourceLabel(item)), className)}>
      <Newspaper className="size-6 opacity-40" />
    </div>
  )
}

function TimeStamp({ ts }: { ts?: number }) {
  const t = relativeTime(ts)
  if (!t) return null
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground/55">
      <Clock className="size-2.5" />
      {t}
    </span>
  )
}

function Wrap({ item, className, children }: { item: NewsItem; className?: string; children: React.ReactNode }) {
  if (item.url) {
    return (
      <a href={item.url} target="_blank" rel="noopener noreferrer" className={cn('block h-full', className)}>
        {children}
      </a>
    )
  }
  return <div className={cn('h-full', className)}>{children}</div>
}

/** Image-on-top hero card. `big` enlarges the image + headline (use for a lead story). */
export function NewsFeature({ item, big, className }: { item: NewsItem; big?: boolean; className?: string }) {
  return (
    <Wrap item={item} className={className}>
      <div className="group flex h-full flex-col overflow-hidden rounded-2xl border border-border/60 bg-card transition-all hover:border-brand/40 hover:shadow-lg hover:shadow-black/20">
        <NewsThumb item={item} className={cn('w-full', big ? 'h-48 sm:h-60' : 'h-36')} />
        <div className="flex flex-1 flex-col gap-2 p-4">
          <p
            className={cn(
              'font-semibold leading-snug transition-colors group-hover:text-brand',
              big ? 'line-clamp-3 text-lg sm:text-xl' : 'line-clamp-2 text-sm',
            )}
          >
            {item.title}
          </p>
          {item.summary && (
            <p className={cn('leading-snug text-muted-foreground', big ? 'line-clamp-3 text-sm' : 'line-clamp-2 text-[12px]')}>
              {item.summary}
            </p>
          )}
          <div className="mt-auto flex items-center justify-between gap-2 pt-1">
            <SourceBadge item={item} />
            <TimeStamp ts={item.publishedAt} />
          </div>
        </div>
      </div>
    </Wrap>
  )
}

/** Thumbnail-on-left list row (compact). Optional `tag` shows a small accent label. */
export function NewsRow({ item, tag, tagColor }: { item: NewsItem; tag?: string; tagColor?: string }) {
  return (
    <Wrap item={item}>
      <div className="group flex gap-3 rounded-xl p-2 transition-colors hover:bg-foreground/5">
        <NewsThumb item={item} className="size-[60px] shrink-0 rounded-lg" />
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="line-clamp-2 text-[13px] font-semibold leading-snug transition-colors group-hover:text-brand">
            {item.title}
          </p>
          <div className="mt-auto flex items-center gap-2 pt-1.5">
            {tag && (
              <span
                className="shrink-0 text-[10px] font-bold uppercase tracking-wide"
                style={tagColor ? { color: tagColor } : undefined}
              >
                {tag}
              </span>
            )}
            <SourceBadge item={item} />
            <TimeStamp ts={item.publishedAt} />
          </div>
        </div>
      </div>
    </Wrap>
  )
}

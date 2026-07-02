import { useState } from 'react'
import { ArrowUpDown, ChevronDown, Radio, Search } from 'lucide-react'
import { cn } from '@/lib/cn'

/** Shared building blocks for the Apple-Podcasts-style show detail pages —
 *  used by both the subscribed-show view (RssShowDetail) and the pre-subscribe
 *  preview page (PodcastPreviewPage). */

export const EPISODE_PAGE_SIZE = 50

/** Hero: cover on the left; badges, title, author, meta line, clamped description,
 *  and the action row on the right. */
export function ShowHero({ cover, badges, title, author, meta, description, warning, actions }: {
  cover: React.ReactNode
  badges?: string[]
  title: string
  author?: string | null
  meta?: React.ReactNode
  description?: string | null
  warning?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-6 sm:flex-row">
      <div className="shrink-0">{cover}</div>

      <div className="min-w-0 flex-1 sm:pt-1">
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">Podcast</span>
          {badges?.slice(0, 3).map(b => (
            <span key={b} className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">{b}</span>
          ))}
        </div>

        <h1 className="text-3xl font-black leading-tight tracking-tight">{title}</h1>
        {author && <p className="mt-1 text-sm font-medium text-brand">{author}</p>}

        {meta && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">{meta}</div>
        )}

        {description && <ClampedDescription text={description} />}

        {warning}

        {actions && <div className="mt-4 flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  )
}

/** Show description clamped to 3 lines with a More/Less toggle. */
export function ClampedDescription({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const long = text.length > 220
  return (
    <div className="mt-3 max-w-2xl">
      <p className={cn('text-sm leading-relaxed text-muted-foreground', !open && 'line-clamp-3')}>{text}</p>
      {long && (
        <button onClick={() => setOpen(v => !v)} className="mt-1 text-xs font-semibold text-brand hover:underline">
          {open ? 'Less' : 'More'}
        </button>
      )}
    </div>
  )
}

/** "Episodes" section header with count, sort toggle, and search box. */
export function EpisodesToolbar({ count, sortNewest, onToggleSort, query, onQueryChange, hint }: {
  count: number
  sortNewest: boolean
  onToggleSort: () => void
  query: string
  onQueryChange: (q: string) => void
  hint?: string
}) {
  return (
    <>
      <div className="mt-10 flex flex-wrap items-center gap-2 border-b border-border/40 pb-3">
        <h2 className="text-lg font-bold tracking-tight">Episodes</h2>
        {count > 0 && <span className="text-xs tabular-nums text-muted-foreground">{count}</span>}
        <div className="ml-auto flex items-center gap-1.5">
          <button onClick={onToggleSort}
            className="flex items-center gap-1 rounded-md border border-border px-2 py-1.5 text-[11px] font-medium text-muted-foreground hover:bg-muted">
            <ArrowUpDown className="size-3" /> {sortNewest ? 'Newest' : 'Oldest'}
          </button>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/50" />
            <input value={query} onChange={e => onQueryChange(e.target.value)} placeholder="Search episodes…"
              className="w-44 rounded-md border border-border bg-background py-1.5 pl-8 pr-2 text-xs outline-none focus:ring-1 focus:ring-brand sm:w-56" />
          </div>
        </div>
      </div>
      {hint && <p className="mt-2 text-xs text-muted-foreground/70">{hint}</p>}
    </>
  )
}

/** Pulsing placeholder rows while the episode list loads. */
export function EpisodeListSkeleton() {
  return (
    <div className="space-y-2 py-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-16 animate-pulse rounded-xl bg-muted/50" />
      ))}
    </div>
  )
}

/** Centered empty state for the episode list. */
export function EpisodeEmptyState({ primary, secondary }: { primary: string; secondary?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center text-muted-foreground">
      <Radio className="size-10 opacity-25" />
      <p className="text-sm">{primary}</p>
      {secondary && <p className="text-xs">{secondary}</p>}
    </div>
  )
}

/** "Show more" pager button under the episode list. */
export function ShowMoreButton({ remaining, onClick }: { remaining: number; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="mt-4 w-full rounded-xl border border-border py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
      Show more · {remaining} remaining
    </button>
  )
}

/** Structural shell of one expandable episode row: optional leading affordance,
 *  the body, and a right rail (extras + expand chevron). Click toggles expansion. */
export function EpisodeRowFrame({ onToggle, expanded, highlight, leading, rightExtras, children }: {
  onToggle: () => void
  expanded: boolean
  highlight?: string | false
  leading?: React.ReactNode
  rightExtras?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div onClick={onToggle}
      className={cn('group cursor-pointer px-2 py-4 transition-colors hover:bg-accent/20', highlight)}>
      <div className="flex items-start gap-4">
        {leading}

        <div className="min-w-0 flex-1">{children}</div>

        <div className="flex shrink-0 items-center gap-1 pt-1.5" onClick={e => e.stopPropagation()}>
          {rightExtras}
          <button onClick={onToggle} title={expanded ? 'Collapse' : 'Expand'}
            className="flex size-8 items-center justify-center rounded-full text-muted-foreground/40 transition-colors hover:bg-muted hover:text-foreground">
            <ChevronDown className={cn('size-4 transition-transform', expanded && 'rotate-180')} />
          </button>
        </div>
      </div>
    </div>
  )
}

export function EpisodeRowTitle({ title, expanded, current }: { title: string; expanded: boolean; current?: boolean }) {
  return (
    <h3 className={cn('text-sm font-semibold leading-snug', current && 'text-brand', !expanded && 'truncate')}>
      {title}
    </h3>
  )
}

export function EpisodeRowMeta({ children }: { children: React.ReactNode }) {
  return <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">{children}</div>
}

export function EpisodeRowDescription({ text, expanded }: { text: string; expanded: boolean }) {
  return (
    <p className={cn('mt-1 text-xs leading-relaxed text-muted-foreground/80', !expanded && 'line-clamp-2')}>
      {text}
    </p>
  )
}

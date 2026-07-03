// Shared book tile, used by Library, Discover, and Audiobooks so the app has one
// consistent "product tile" instead of three slightly different ones. Mirrors
// Podcast's ShowGrid/ContinueCard tile shape exactly: no card chrome around the
// cover, the (generated or real) cover art itself is the visual, with a
// hover-reveal play/read overlay button and a progress bar on its bottom edge.

import { Link } from 'react-router-dom'
import type { LucideIcon } from 'lucide-react'
import { Bookmark, Headphones } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/cn'
import { BookCover } from './BookCover'

export interface BookCardProps {
  to: string
  bookId: string
  title: string
  author?: string | null
  coverSrc?: string | null
  progressPercent?: number
  completed?: boolean
  hasAudio?: boolean
  pending?: boolean
  failed?: boolean
  // In the library but no local copy yet (status 'saved') — shows a subtle marker
  // so it reads differently from a downloaded/offline book.
  savedOnly?: boolean
  quickAction?: { icon: LucideIcon; label: string; onClick: () => void }
  className?: string
}

export function BookCard({
  to, bookId, title, author, coverSrc, progressPercent = 0, completed, hasAudio, pending, failed, savedOnly, quickAction, className,
}: BookCardProps) {
  const pct = Math.round(progressPercent * 100)
  const inert = pending || failed

  const cover = (
    <div className="relative aspect-[2/3] w-full overflow-hidden rounded-card shadow-sm transition-shadow group-hover:shadow-lg">
      <BookCover bookId={bookId} title={title} author={author} coverSrc={inert ? null : coverSrc} fill size={220} className="transition-transform group-hover:scale-[1.02]" />
      {pending && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40"><Spinner className="text-white" /></div>
      )}
      {hasAudio && !inert && (
        <span className="absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-full bg-black/60 text-white">
          <Headphones className="size-3.5" />
        </span>
      )}
      {savedOnly && !inert && (
        <span className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-medium text-white" title="Saved — not downloaded for offline">
          <Bookmark className="size-3" />Saved
        </span>
      )}
      {quickAction && !inert && (
        // design-ok(backdrop-blur-outside-chrome): play control floats over cover artwork
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); quickAction.onClick() }}
          title={quickAction.label}
          className="absolute bottom-2 right-2 flex size-11 items-center justify-center rounded-full bg-black/55 text-white opacity-0 shadow-lg backdrop-blur transition hover:scale-105 group-hover:opacity-100"
        >
          <quickAction.icon className="size-5 fill-current" />
        </button>
      )}
      {pct > 0 && !completed && !inert && (
        <div className="absolute inset-x-0 bottom-0 h-1 bg-black/40">
          <div className="h-full bg-[var(--books-accent)]" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  )

  const label = (
    <div className={cn('mt-2', inert && 'opacity-70')}>
      <p className="truncate text-sm font-semibold">{title}</p>
      {pending ? <p className="truncate text-xs text-muted-foreground">Downloading…</p>
        : failed ? <p className="truncate text-xs text-destructive">Failed</p>
        : author && <p className="truncate text-xs text-muted-foreground">{author}</p>}
    </div>
  )

  if (inert) {
    return <div className={cn('block', className)}>{cover}{label}</div>
  }
  return (
    <Link to={to} className={cn('group block', className)}>
      {cover}{label}
    </Link>
  )
}

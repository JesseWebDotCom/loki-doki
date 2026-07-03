import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { SeasonGroup } from '@/lib/shows/api'

// Season-grouped episode list. Watched state is optional so Phase 1 renders read-only and
// Phase 3 can pass `watched` + `onToggle` to enable per-episode checkmarks without changing
// the layout.
export function EpisodeList({
  seasons,
  watched,
  onToggle,
}: {
  seasons: SeasonGroup[]
  watched?: Set<number>
  onToggle?: (episodeId: number) => void
}) {
  // Default to the first season expanded.
  const [open, setOpen] = useState<number>(seasons[0]?.season ?? 1)
  if (!seasons.length) return <p className="text-sm text-muted-foreground">No episode data available.</p>

  return (
    <div className="space-y-2">
      {seasons.map((group) => {
        const isOpen = open === group.season
        const watchedCount = watched ? group.episodes.filter((e) => watched.has(e.id)).length : 0
        return (
          <div key={group.season} className="overflow-hidden rounded-card border border-border/50">
            <button
              type="button"
              onClick={() => setOpen(isOpen ? -1 : group.season)}
              className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-foreground/5"
            >
              <span className="font-medium">
                {group.season === 0 ? 'Specials' : `Season ${group.season}`}
                <span className="ml-2 text-xs text-muted-foreground">
                  {group.episodes.length} ep{group.episodes.length !== 1 ? 's' : ''}
                  {watched && watchedCount > 0 ? ` · ${watchedCount} watched` : ''}
                </span>
              </span>
              <ChevronDown className={cn('size-4 text-muted-foreground transition-transform', isOpen && 'rotate-180')} />
            </button>
            {isOpen && (
              <ul className="divide-y divide-border/40">
                {group.episodes.map((ep) => {
                  const isWatched = watched?.has(ep.id) ?? false
                  return (
                    <li key={ep.id} className="flex gap-3 px-4 py-3">
                      {onToggle && (
                        <button
                          type="button"
                          onClick={() => onToggle(ep.id)}
                          aria-label={isWatched ? 'Mark unwatched' : 'Mark watched'}
                          className={cn(
                            'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors',
                            isWatched
                              ? 'border-success bg-success text-success-foreground'
                              : 'border-border text-transparent hover:border-success',
                          )}
                        >
                          <Check className="size-3" />
                        </button>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <p className="text-sm font-medium">
                            <span className="text-muted-foreground">
                              {ep.number != null ? `${ep.number}. ` : ''}
                            </span>
                            {ep.name}
                          </p>
                          {ep.airdate && <span className="shrink-0 text-xs text-muted-foreground">{ep.airdate}</span>}
                        </div>
                        {ep.summary && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{ep.summary}</p>}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}

import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { Bookmark, BookmarkCheck, Loader2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import {
  addToWatchlist,
  checkWatchlist,
  removeFromWatchlist,
  setWatchlistStatus,
  type MediaType,
  type WatchStatus,
} from '@/lib/library/api'

const STATUS_LABELS: Record<WatchStatus, string> = {
  want: 'Want to watch',
  watching: 'Watching',
  completed: 'Completed',
  dropped: 'Dropped',
}
const STATUS_ORDER: WatchStatus[] = ['want', 'watching', 'completed']

// Add/remove a title from the watchlist, with an inline status selector once it's in. Used on
// both the Shows and Movies detail pages.
export function WatchlistButton({
  mediaType,
  refId,
  title,
  posterUrl,
  subtitle,
}: {
  mediaType: MediaType
  refId: string
  title: string
  posterUrl?: string | null
  subtitle?: string | null
}) {
  const qc = useQueryClient()
  const key = ['watchlist-check', mediaType, refId]

  const { data, isLoading } = useQuery({
    queryKey: key,
    queryFn: () => checkWatchlist(mediaType, refId),
    staleTime: 60 * 1000,
  })

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: key })
    void qc.invalidateQueries({ queryKey: ['watchlist'] })
    void qc.invalidateQueries({ queryKey: ['continue-watching'] })
  }

  const add = useMutation({
    mutationFn: (status: WatchStatus) => addToWatchlist({ mediaType, refId, title, posterUrl, subtitle, status }),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: () => removeFromWatchlist(mediaType, refId),
    onSuccess: invalidate,
  })
  const changeStatus = useMutation({
    mutationFn: (status: WatchStatus) => addToWatchlist({ mediaType, refId, title, posterUrl, subtitle, status }),
    onSuccess: invalidate,
  })

  if (isLoading) {
    return (
      <button type="button" disabled className="inline-flex items-center gap-2 rounded-lg bg-foreground/10 px-4 py-2 text-sm font-medium">
        <Loader2 className="size-4 animate-spin" />
      </button>
    )
  }

  const inList = data?.inList ?? false
  const status = data?.status ?? null
  const busy = add.isPending || remove.isPending || changeStatus.isPending

  if (!inList) {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => add.mutate('want')}
        className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-colors hover:opacity-90 disabled:opacity-60"
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Bookmark className="size-4" />}
        Add to Watchlist
      </button>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-400">
        <BookmarkCheck className="size-4" /> In Watchlist
      </span>
      <div className="flex overflow-hidden rounded-lg border border-border">
        {STATUS_ORDER.map((s) => (
          <button
            key={s}
            type="button"
            disabled={busy}
            onClick={() => changeStatus.mutate(s)}
            className={cn(
              'px-2.5 py-1.5 text-xs font-medium transition-colors',
              status === s ? 'bg-brand text-brand-foreground' : 'hover:bg-foreground/8',
            )}
          >
            {STATUS_LABELS[s]}
          </button>
        ))}
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() => remove.mutate()}
        className="text-xs text-muted-foreground hover:text-rose-400"
      >
        Remove
      </button>
    </div>
  )
}

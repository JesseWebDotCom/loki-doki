import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { Bookmark, BookmarkCheck } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { Button } from '@/components/ui/button'
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
      <Button type="button" variant="secondary" disabled className="gap-2 bg-foreground/10" aria-label="Loading watchlist state">
        <Spinner className="text-current" />
      </Button>
    )
  }

  const inList = data?.inList ?? false
  const status = data?.status ?? null
  const busy = add.isPending || remove.isPending || changeStatus.isPending

  if (!inList) {
    return (
      <Button
        type="button"
        disabled={busy}
        onClick={() => add.mutate('want')}
        className="gap-2"
      >
        {busy ? <Spinner className="text-current" /> : <Bookmark className="size-4" />}
        Add to Watchlist
      </Button>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-success">
        <BookmarkCheck className="size-4" /> In Watchlist
      </span>
      <div className="flex overflow-hidden rounded-full border border-border">
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
        className="text-xs text-muted-foreground hover:text-destructive"
      >
        Remove
      </button>
    </div>
  )
}

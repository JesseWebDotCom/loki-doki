import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useInfiniteScrollSentinel } from '@/hooks/useInfiniteScrollSentinel'

/**
 * Bottom-of-list loader for the hub's paged grids. Auto-fetches the next page as the user
 * scrolls near the end (so content keeps flowing without a click), with a manual "Load
 * more" button as a fallback. Drop it right after a paged collection; pass react-query's
 * useInfiniteQuery fields.
 */
export function InfiniteLoadMore({ hasNextPage, isFetchingNextPage, fetchNextPage }: {
  hasNextPage: boolean
  isFetchingNextPage: boolean
  fetchNextPage: () => void
}) {
  const sentinelRef = useInfiniteScrollSentinel(hasNextPage, isFetchingNextPage, fetchNextPage)
  if (!hasNextPage && !isFetchingNextPage) return null
  return (
    <div className="mt-8 flex flex-col items-center gap-2">
      <div ref={sentinelRef} aria-hidden className="h-px w-full" />
      {isFetchingNextPage
        ? <Spinner size="sm" />
        : hasNextPage
          ? <Button variant="outline" onClick={fetchNextPage}>Load more</Button>
          : null}
    </div>
  )
}

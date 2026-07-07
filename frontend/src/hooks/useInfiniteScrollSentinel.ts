import { useEffect, useRef } from 'react'

/**
 * Auto-load-more sentinel. Observe the returned ref (place it at the end of a paged list);
 * when it scrolls into view (with a generous margin so the next page loads before the user
 * actually reaches the bottom) and there's more to fetch, it calls onLoadMore. Modeled on
 * the admin log viewer's IntersectionObserver. Pass react-query's hasNextPage/
 * isFetchingNextPage so it never double-fires while a fetch is in flight.
 */
export function useInfiniteScrollSentinel(hasMore: boolean, loading: boolean, onLoadMore: () => void) {
  const ref = useRef<HTMLDivElement | null>(null)
  // Keep the latest callback without re-subscribing the observer every render.
  const cb = useRef(onLoadMore)
  cb.current = onLoadMore

  useEffect(() => {
    const el = ref.current
    if (!el || !hasMore) return
    const io = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting && !loading) cb.current() },
      { rootMargin: '800px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, loading])

  return ref
}

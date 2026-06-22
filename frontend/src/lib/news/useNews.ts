import { useEffect } from 'react'
import { useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import type { NewsItem } from '@/components/shared/NewsCard'

export type NewsType = 'world' | 'local'

export async function fetchNews(type: NewsType): Promise<NewsItem[]> {
  const r = await fetch(`/api/news?type=${type}&limit=20`, { credentials: 'include' })
  if (!r.ok) return []
  const d = (await r.json()) as { items: NewsItem[]; error?: string }
  return d.items ?? []
}

// News is enriched server-side (stale-while-revalidate, 15-min TTL), so a 5-minute
// client staleTime keeps it instant on revisit without going stale within a session.
export function newsQueryOptions(type: NewsType): UseQueryOptions<NewsItem[]> {
  return {
    queryKey: ['news', type],
    queryFn: () => fetchNews(type),
    staleTime: 5 * 60_000,
  }
}

// Warm the News cache in the background so the page renders instantly when opened.
// Runs once on mount during browser idle time; failures are swallowed.
export function useNewsPrefetch(): void {
  const qc = useQueryClient()
  useEffect(() => {
    const warm = () => {
      for (const type of ['world', 'local'] as NewsType[]) {
        qc.prefetchQuery(newsQueryOptions(type)).catch(() => {})
      }
    }
    const ric = (window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
    }).requestIdleCallback
    if (ric) {
      const id = ric(warm, { timeout: 3000 })
      return () => (window as unknown as { cancelIdleCallback?: (id: number) => void })
        .cancelIdleCallback?.(id)
    }
    const t = setTimeout(warm, 1500)
    return () => clearTimeout(t)
  }, [qc])
}

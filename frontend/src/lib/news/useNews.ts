import { useEffect } from 'react'
import { useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import type { NewsItem } from '@/components/shared/NewsCard'

export type CategoryKind = 'builtin' | 'shared' | 'personal'

export interface NewsCategory {
  id: string
  name: string
  slug: string | null
  kind: CategoryKind
  locked: boolean
  editable: boolean   // personal categories: feeds are user-managed
  hidden: boolean      // per-user tab visibility
}

export async function fetchCategories(): Promise<NewsCategory[]> {
  const r = await fetch('/api/news/categories', { credentials: 'include' })
  if (!r.ok) return []
  return ((await r.json()) as { categories?: NewsCategory[] }).categories ?? []
}

export function newsCategoriesQueryOptions(): UseQueryOptions<NewsCategory[]> {
  return { queryKey: ['news-categories'], queryFn: fetchCategories, staleTime: 5 * 60_000 }
}

export async function fetchCategoryItems(categoryId: string, place?: string | null): Promise<NewsItem[]> {
  const placeParam = place ? `&place=${encodeURIComponent(place)}` : ''
  const r = await fetch(`/api/news/categories/${categoryId}/items?limit=20${placeParam}`, { credentials: 'include' })
  if (!r.ok) return []
  return ((await r.json()) as { items?: NewsItem[] }).items ?? []
}

// News is enriched server-side (stale-while-revalidate, 15-min TTL), so a 5-minute
// client staleTime keeps it instant on revisit without going stale within a session.
// `place` = the device's current town while traveling (useCurrentPlace) - the server
// only acts on it for the built-in Local category, so it's safe to pass for every tab.
export function newsQueryOptions(categoryId: string, place?: string | null): UseQueryOptions<NewsItem[]> {
  return {
    queryKey: ['news', categoryId, place ?? null],
    queryFn: () => fetchCategoryItems(categoryId, place),
    staleTime: 5 * 60_000,
    enabled: !!categoryId,
  }
}

// ── Mutations (category management) ──────────────────────────────────────────────

export async function hideCategory(id: string): Promise<void> {
  await fetch(`/api/news/categories/${id}/hide`, { method: 'POST', credentials: 'include' })
}
export async function unhideCategory(id: string): Promise<void> {
  await fetch(`/api/news/categories/${id}/unhide`, { method: 'POST', credentials: 'include' })
}
// Personal categories reuse the per-user feed folders API.
export async function createPersonalCategory(name: string): Promise<string> {
  const r = await fetch('/api/feeds/folders', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  })
  if (!r.ok) throw new Error('Failed to create category')
  return ((await r.json()) as { id: string }).id
}
export async function deletePersonalCategory(id: string): Promise<void> {
  const r = await fetch(`/api/feeds/folders/${id}`, { method: 'DELETE', credentials: 'include' })
  if (!r.ok) throw new Error('Failed to delete category')
}

// Warm the News cache in the background so the page renders instantly when opened.
export function useNewsPrefetch(): void {
  const qc = useQueryClient()
  useEffect(() => {
    const warm = () => { qc.prefetchQuery(newsCategoriesQueryOptions()).catch(() => {}) }
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

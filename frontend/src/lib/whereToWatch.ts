// Typed wrappers + shared query options for the /api/where-to-watch endpoint.
// Extracted from WhereToWatchPage so the page and the prefetch warmer share the same
// query keys (the warmed "Popular Right Now" cache must match what the page reads).

import type { UseQueryOptions } from '@tanstack/react-query'

export interface Provider {
  name: string
  offerType: string
  label: string
  url: string
}

export interface TitleCard {
  title: string
  year: number | null
  objectType: string
  posterUrl: string
  justwatchUrl: string
  providers: Provider[]
}

interface BrowseResponse {
  mode: 'popular' | 'new'
  found: boolean
  items: TitleCard[]
  error?: string
}

interface LookupResponse {
  mode: 'lookup'
  found: boolean
  title?: string
  year?: number | null
  posterUrl?: string
  justwatchUrl?: string
  providers?: Provider[]
  error?: string
}

type ApiResponse = BrowseResponse | LookupResponse

export async function fetchPopular(country = 'US'): Promise<TitleCard[]> {
  const r = await fetch(
    `/api/where-to-watch?mode=popular&country=${encodeURIComponent(country)}`,
    { credentials: 'include' },
  )
  if (!r.ok) return []
  const d = (await r.json()) as BrowseResponse
  return d.items ?? []
}

export async function fetchSearch(q: string, country = 'US'): Promise<TitleCard[]> {
  const r = await fetch(
    `/api/where-to-watch?q=${encodeURIComponent(q)}&country=${encodeURIComponent(country)}`,
    { credentials: 'include' },
  )
  if (!r.ok) return []
  const d = (await r.json()) as ApiResponse
  if (d.mode === 'lookup') {
    if (!d.found || !d.title) return []
    const lookup = d as LookupResponse
    return [
      {
        title: lookup.title!,
        year: lookup.year ?? null,
        objectType: '',
        posterUrl: lookup.posterUrl ?? '',
        justwatchUrl: lookup.justwatchUrl ?? '',
        providers: lookup.providers ?? [],
      },
    ]
  }
  return (d as BrowseResponse).items ?? []
}

// "Popular Right Now" is the landing view and the slow first paint — warm it. JustWatch
// editorial popularity changes slowly, so a long staleTime keeps it instant on revisit.
export function whereToWatchPopularQueryOptions(country = 'US'): UseQueryOptions<TitleCard[]> {
  return {
    queryKey: ['where-to-watch', 'popular', country],
    queryFn: () => fetchPopular(country),
    staleTime: 30 * 60_000,
  }
}

export function whereToWatchSearchQueryOptions(q: string, country = 'US'): UseQueryOptions<TitleCard[]> {
  return {
    queryKey: ['where-to-watch', 'search', country, q],
    queryFn: () => fetchSearch(q, country),
    staleTime: 5 * 60_000,
    enabled: !!q,
  }
}

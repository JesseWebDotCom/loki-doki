// Prefetch registry: per-app functions that warm the React Query cache (and preload a few
// thumbnails) for an app's above-the-fold content. Keyed by the app `id` from
// lib/appCategories. The idle warmer (useAppWarmer) runs these for pinned/recent apps, and
// the nav hover-intent handler runs one when the pointer enters an app's link.
//
// IMPORTANT: each prefetcher MUST warm the SAME query keys the page reads — it does this by
// reusing the app's shared `…QueryOptions()` factory. If a page query isn't backed by a
// shared factory yet, add one before registering it here, or the warm is wasted.
//
// Re-running a prefetcher is cheap: prefetchQuery respects staleTime (no refetch when fresh)
// and dedupes in-flight requests; preloadImages dedupes by URL.

import type { QueryClient, QueryKey } from '@tanstack/react-query'
import { newsCategoriesQueryOptions, newsQueryOptions, type NewsCategory } from '@/lib/news/useNews'
import { showsHomeQueryOptions, mediaImg, type ShowShelf } from '@/lib/shows/api'
import {
  ytPopularQueryOptions,
  ytTrendingQueryOptions,
  ytSubsQueryOptions,
  ytImageProxy,
  type ItVideo,
} from '@/lib/youtube/api'
import { whereToWatchPopularQueryOptions, type TitleCard } from '@/lib/whereToWatch'
import { prewarmWeather } from '@/lib/weatherCache'
import type { NewsItem } from '@/components/shared/NewsCard'
import type { UserLocation } from '@/hooks/useUserLocation'
import { preloadImages } from './preloadImages'

export interface WarmCtx {
  /** External network features are available (Standard mode + device online). */
  online: boolean
  /** The user's saved location, for location-dependent apps (weather). */
  location: UserLocation | null
}

export type Prefetcher = (qc: QueryClient, ctx: WarmCtx) => Promise<unknown>

export const APP_PREFETCHERS: Record<string, Prefetcher> = {
  // News — categories, then the first (default) category's items, then its lead images.
  news: async (qc) => {
    const catOpts = newsCategoriesQueryOptions()
    await qc.prefetchQuery(catOpts)
    const cats = qc.getQueryData<NewsCategory[]>(catOpts.queryKey as QueryKey) ?? []
    const first = cats[0]
    if (!first) return
    const itemOpts = newsQueryOptions(first.id)
    await qc.prefetchQuery(itemOpts)
    const items = qc.getQueryData<NewsItem[]>(itemOpts.queryKey as QueryKey) ?? []
    preloadImages(items.map((i) => i.imageUrl))
  },

  // Shows — home shelves + the first few posters per shelf (proxied through the media cache).
  shows: async (qc) => {
    const opts = showsHomeQueryOptions()
    await qc.prefetchQuery(opts)
    const shelves = qc.getQueryData<ShowShelf[]>(opts.queryKey as QueryKey) ?? []
    preloadImages(shelves.flatMap((s) => s.items.slice(0, 6).map((i) => mediaImg(i.poster))))
  },

  // YouTube — Popular + Trending + sidebar subscriptions. Only when online (the page's
  // discovery shelves are gated on online mode and won't query otherwise).
  youtube: async (qc, ctx) => {
    if (!ctx.online) return
    const popularOpts = ytPopularQueryOptions()
    await Promise.all([
      qc.prefetchQuery(popularOpts),
      qc.prefetchQuery(ytTrendingQueryOptions()),
      qc.prefetchQuery(ytSubsQueryOptions()),
    ])
    const popular = qc.getQueryData<ItVideo[]>(popularOpts.queryKey as QueryKey) ?? []
    preloadImages(popular.map((v) => (v.thumbnailUrl ? ytImageProxy(v.thumbnailUrl) : null)))
  },

  // Where to Watch — the "Popular Right Now" landing grid + its posters.
  'where-to-watch': async (qc) => {
    const opts = whereToWatchPopularQueryOptions()
    await qc.prefetchQuery(opts)
    const items = qc.getQueryData<TitleCard[]>(opts.queryKey as QueryKey) ?? []
    preloadImages(items.map((i) => i.posterUrl))
  },

  // Weather — fills the cross-route module cache the page reads on mount (instant paint).
  weather: async (_qc, ctx) => {
    if (ctx.location) await prewarmWeather(ctx.location)
  },
}

export function hasPrefetcher(appId: string): boolean {
  return appId in APP_PREFETCHERS
}

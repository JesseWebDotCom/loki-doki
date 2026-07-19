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
import { moviesHomeQueryOptions, showtimesNearMeQueryOptions, type MovieShelf, type NearMe } from '@/lib/movies/api'
import { onTvTodayQueryOptions, type OnTvToday } from '@/lib/shows/api'
import { musicStationsQueryOptions, musicHistoryQueryOptions, musicRailsQueryOptions, type StationBuckets } from '@/lib/music/catalogApi'
import { musicMixesQueryOptions, type MixForYou } from '@/lib/music/intelApi'
import { songArtQueryOptions } from '@/components/music/SongArt'
import { podcastFeedQueryOptions, type PodcastFeed } from '@/lib/podcast/useFeed'
import { podcastChartsQueryOptions, coverUrl, type DirectoryCharts } from '@/lib/podcast/api'
import { videosSourcesQueryOptions, videosHomeQueryKey, getHubHome, type HubVideoItem, type SourceInfo, type VideoViewFlags } from '@/lib/videos/api'
import { proxyImg } from '@/lib/img'
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

  // Shows — home shelves + On Tonight + the first few posters per shelf.
  shows: async (qc) => {
    const opts = showsHomeQueryOptions()
    const tvOpts = onTvTodayQueryOptions()
    await Promise.all([qc.prefetchQuery(opts), qc.prefetchQuery(tvOpts)])
    const shelves = qc.getQueryData<ShowShelf[]>(opts.queryKey as QueryKey) ?? []
    const onTv = qc.getQueryData<OnTvToday>(tvOpts.queryKey as QueryKey)
    // Width must match TitleCard's render request (480 bucket) or the preload warms the wrong URL.
    preloadImages([
      ...shelves.flatMap((s) => s.items.slice(0, 6).map((i) => mediaImg(i.poster, 480))),
      ...(onTv?.entries ?? []).slice(0, 6).map((e) => (e.show.poster ? mediaImg(e.show.poster, 480) : null)),
    ])
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

  // Movies: home shelves + the first few posters per shelf (bucketed 480px variants,
  // matching TitleCard's render width).
  movies: async (qc) => {
    const opts = moviesHomeQueryOptions()
    const nearOpts = showtimesNearMeQueryOptions()
    await Promise.all([qc.prefetchQuery(opts), qc.prefetchQuery(nearOpts)])
    const shelves = qc.getQueryData<MovieShelf[]>(opts.queryKey as QueryKey) ?? []
    const near = qc.getQueryData<NearMe>(nearOpts.queryKey as QueryKey)
    preloadImages([
      ...shelves.flatMap((s) => s.items.slice(0, 6).map((i) => (i.poster ? mediaImg(i.poster, 480) : null))),
      ...(near?.data?.movies ?? []).slice(0, 6).map((m) => (m.poster_url ? mediaImg(m.poster_url, 480) : null)),
    ])
  },

  // Music: the four hub queries, then resolve + preload cover art for the first shelf
  // of stations and mixes (the same per-tile song-art queries useSongArt reads, then the
  // 480-bucket bytes SongArt renders).
  music: async (qc) => {
    const stationsOpts = musicStationsQueryOptions()
    const mixesOpts = musicMixesQueryOptions()
    await Promise.all([
      qc.prefetchQuery(stationsOpts),
      qc.prefetchQuery(musicHistoryQueryOptions(12)),
      qc.prefetchQuery(musicRailsQueryOptions()),
      qc.prefetchQuery(mixesOpts),
    ])
    const buckets = qc.getQueryData<StationBuckets>(stationsOpts.queryKey as QueryKey)
    const mixes = qc.getQueryData<{ mixes: MixForYou[] }>(mixesOpts.queryKey as QueryKey)
    const covers = [
      ...[...(buckets?.builtin ?? []), ...(buckets?.shared ?? []), ...(buckets?.mine ?? [])]
        .map((s) => s.coverTrack),
      ...(mixes?.mixes ?? []).map((m) => m.tracks[0] ?? null),
    ].filter((c): c is { videoId: string; title: string; artist: string } => !!c?.artist && !!c.title)
      .slice(0, 12)
    const urls = await Promise.all(covers.map(async (c) => {
      const artOpts = songArtQueryOptions(c.artist, c.title)
      await qc.prefetchQuery(artOpts)
      const url = qc.getQueryData<string | null>(artOpts.queryKey as QueryKey)
      return url ? proxyImg(url, 480) : null
    }))
    preloadImages(urls)
  },

  // Podcasts: feed + top charts, then the "Your shows" rail covers (288 device px,
  // exactly what ShowCover size=144 requests) and the first chart artworks (480,
  // matching DirectoryCard).
  podcasts: async (qc) => {
    const feedOpts = podcastFeedQueryOptions()
    const chartOpts = podcastChartsQueryOptions(null)
    await Promise.all([qc.prefetchQuery(feedOpts), qc.prefetchQuery(chartOpts)])
    const feed = qc.getQueryData<PodcastFeed>(feedOpts.queryKey as QueryKey)
    const charts = qc.getQueryData<DirectoryCharts>(chartOpts.queryKey as QueryKey)
    preloadImages([
      ...(feed?.shows ?? []).slice(0, 10).map((s) => coverUrl(s.id, 288)),
      ...(charts?.results ?? []).slice(0, 6).map((r) => (r.artworkUrl ? proxyImg(r.artworkUrl, 480) : null)),
    ])
  },

  // Videos hub: sources, then the mixed home feed for "all enabled" (the default
  // filter state) and its first thumbnails (640, matching HubVideoCard).
  videos: async (qc, ctx) => {
    if (!ctx.online) return
    const srcOpts = videosSourcesQueryOptions()
    await qc.prefetchQuery(srcOpts)
    const data = qc.getQueryData<{ sources: SourceInfo[]; allowlistOnly?: boolean; viewFlags?: VideoViewFlags }>(srcOpts.queryKey as QueryKey)
    const active = (data?.sources ?? []).filter((s) => s.enabled).map((s) => s.source)
    if (!active.length) return
    const homeKey = videosHomeQueryKey(active)
    await qc.prefetchInfiniteQuery({
      queryKey: homeKey,
      queryFn: () => getHubHome(undefined, null),
      initialPageParam: null as string | null,
    })
    const pages = qc.getQueryData<{ pages: { items: HubVideoItem[] }[] }>(homeKey as QueryKey)
    preloadImages((pages?.pages?.[0]?.items ?? []).slice(0, 8).map((i) => (i.thumbnailUrl ? proxyImg(i.thumbnailUrl, 640) : null)))
  },

  // Weather — fills the cross-route module cache the page reads on mount (instant paint).
  weather: async (_qc, ctx) => {
    if (ctx.location) await prewarmWeather(ctx.location)
  },
}

export function hasPrefetcher(appId: string): boolean {
  return appId in APP_PREFETCHERS
}

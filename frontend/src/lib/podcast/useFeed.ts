import { useQuery } from '@tanstack/react-query'
import { getFeed, type Show, type Episode } from '@/lib/podcast/api'

export interface FeedEpisode { episode: Episode; show: Show }

export interface PodcastFeed {
  shows: Show[]
  episodesByShow: Record<string, Episode[]>
  all: FeedEpisode[]
}

async function fetchFeed(): Promise<PodcastFeed> {
  const { shows, episodesByShow } = await getFeed()
  const all: FeedEpisode[] = []
  for (const show of shows) {
    for (const episode of episodesByShow[show.id] ?? []) all.push({ episode, show })
  }
  return { shows, episodesByShow, all }
}

/** Shared factory so the idle warmer / hover prefetch (lib/prefetch/registry) warm the
 *  exact query the hub reads. The 60s staleTime makes hub revisits paint instantly from
 *  cache (the feed is DB-backed and slow-moving; a background refetch still follows). */
export function podcastFeedQueryOptions() {
  return { queryKey: ['podcast-feed'] as const, queryFn: fetchFeed, staleTime: 60 * 1000 }
}

export function usePodcastFeed() {
  return useQuery(podcastFeedQueryOptions())
}

// RSS episodes carry a real publish date; generated ones fall back to generation time.
const ts = (e: Episode) => new Date(e.publishedAt ?? e.generatedAt ?? e.createdAt ?? 0).getTime()

/** In-progress, not-completed episodes — most recent first. */
export function continueListening(all: FeedEpisode[]): FeedEpisode[] {
  return all
    .filter(x => x.episode.status === 'ready' && x.episode.watchState && x.episode.watchState.positionSec > 5 && !x.episode.watchState.completed)
    .sort((a, b) => ts(b.episode) - ts(a.episode))
}

/** Ready episodes, newest first. */
export function newEpisodes(all: FeedEpisode[]): FeedEpisode[] {
  return all.filter(x => x.episode.status === 'ready').sort((a, b) => ts(b.episode) - ts(a.episode))
}

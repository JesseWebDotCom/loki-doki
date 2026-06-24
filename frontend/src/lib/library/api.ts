// Typed wrappers around /api/library/* — the shared watchlist + show episode progress used
// by both the Shows and Movies apps.

const opts: RequestInit = { credentials: 'include' }
const J = { 'Content-Type': 'application/json' }

export type MediaType = 'show' | 'movie'
export type WatchStatus = 'want' | 'watching' | 'completed' | 'dropped'

export interface WatchlistItem {
  id: string
  mediaType: MediaType
  refId: string
  title: string
  posterUrl: string | null
  subtitle: string | null
  status: WatchStatus
  addedAt: number
  updatedAt: number
}

export interface ContinueItem {
  tvmazeId: number
  title: string
  posterUrl: string | null
  nextEpisode: { id: number; season: number; number: number | null; name: string } | null
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, opts)
  if (!res.ok) throw new Error(`Request failed: ${res.status}`)
  return (await res.json()) as T
}

export async function getWatchlist(mediaType?: MediaType): Promise<WatchlistItem[]> {
  const qs = mediaType ? `?mediaType=${mediaType}` : ''
  const data = await getJson<{ items: WatchlistItem[] }>(`/api/library/watchlist${qs}`)
  return data.items
}

export async function checkWatchlist(mediaType: MediaType, refId: string): Promise<{ inList: boolean; status: WatchStatus | null }> {
  return getJson(`/api/library/watchlist/check?mediaType=${mediaType}&refId=${encodeURIComponent(refId)}`)
}

export async function addToWatchlist(input: {
  mediaType: MediaType
  refId: string
  title: string
  posterUrl?: string | null
  subtitle?: string | null
  status?: WatchStatus
}): Promise<{ id: string; status: WatchStatus }> {
  const res = await fetch('/api/library/watchlist', { ...opts, method: 'POST', headers: J, body: JSON.stringify(input) })
  if (!res.ok) throw new Error('Failed to add to watchlist')
  return (await res.json()) as { id: string; status: WatchStatus }
}

export async function removeFromWatchlist(mediaType: MediaType, refId: string): Promise<void> {
  await fetch(`/api/library/watchlist?mediaType=${mediaType}&refId=${encodeURIComponent(refId)}`, { ...opts, method: 'DELETE' })
}

export async function setWatchlistStatus(id: string, status: WatchStatus): Promise<void> {
  await fetch(`/api/library/watchlist/${id}`, { ...opts, method: 'PATCH', headers: J, body: JSON.stringify({ status }) })
}

export async function getShowWatched(tvmazeId: number): Promise<number[]> {
  const data = await getJson<{ watched: number[] }>(`/api/library/shows/${tvmazeId}/watched`)
  return data.watched
}

export async function toggleEpisodeWatched(
  tvmazeId: number,
  episodeId: number,
  meta: { season: number; number: number | null },
): Promise<boolean> {
  const res = await fetch(`/api/library/shows/${tvmazeId}/episodes/${episodeId}/watched`, {
    ...opts,
    method: 'POST',
    headers: J,
    body: JSON.stringify(meta),
  })
  if (!res.ok) return false
  const data = (await res.json()) as { watched: boolean }
  return data.watched
}

export async function getContinueWatching(): Promise<ContinueItem[]> {
  const data = await getJson<{ items: ContinueItem[] }>('/api/library/continue')
  return data.items
}

// Typed wrappers around /api/plex/*. Everything degrades to "not configured / not present"
// so the UI can call freely and just hide Plex affordances when absent.

const opts: RequestInit = { credentials: 'include' }

export interface PlexMatch {
  present: boolean
  ratingKey: string | null
  title: string | null
  year: number | null
  type: 'movie' | 'show' | null
  deepLink: string | null
  guids: string[]
}

export interface PlexStatus {
  configured: boolean
  ok: boolean
  serverName: string | null
}

export async function getPlexStatus(): Promise<PlexStatus> {
  const res = await fetch('/api/plex/status', opts)
  if (!res.ok) return { configured: false, ok: false, serverName: null }
  return (await res.json()) as PlexStatus
}

export async function findInPlex(params: {
  type: 'movie' | 'show'
  title: string
  year?: number | null
  imdb?: string | null
  tvdb?: number | null
}): Promise<PlexMatch> {
  const qs = new URLSearchParams({ type: params.type, title: params.title })
  if (params.year) qs.set('year', String(params.year))
  if (params.imdb) qs.set('imdb', params.imdb)
  if (params.tvdb) qs.set('tvdb', String(params.tvdb))
  const res = await fetch(`/api/plex/find?${qs}`, opts)
  if (!res.ok) {
    return { present: false, ratingKey: null, title: null, year: null, type: null, deepLink: null, guids: [] }
  }
  return (await res.json()) as PlexMatch
}

export async function addToPlexWatchlist(plexGuid: string): Promise<boolean> {
  const res = await fetch('/api/plex/watchlist', {
    ...opts,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plexGuid }),
  })
  if (!res.ok) return false
  const data = (await res.json()) as { ok: boolean }
  return data.ok
}

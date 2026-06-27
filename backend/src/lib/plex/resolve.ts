// Maps a Plex library item to an in-app detail route + a proxied poster, so any Plex feed
// (recentlyAdded / onDeck / hubs) can be rendered with the existing TitleCard and clicked
// straight into the Shows/Movies detail pages. Shows are keyed by TVMaze id (resolved from
// the item's IMDb/TVDB GUID, else title+year); movies by title+year (the app's movie key).
// Resolutions are cached hard — a Plex item's identity doesn't change.

import { cachedLookup, THIRTY_DAYS_MS } from '@/lib/lookupCache'
import { lookupShowId, resolveShow } from '@/lib/shows/tvmaze'
import type { PlexNormItem } from './index'

export interface PlexPoster {
  to: string
  title: string
  subtitle: string | null
  poster: string | null
  mediaType: 'movie' | 'show'
}

function extractExternal(guids: string[]): { imdb: string | null; tvdb: number | null } {
  let imdb: string | null = null
  let tvdb: number | null = null
  for (const g of guids) {
    const mi = g.match(/imdb:\/\/(tt\d+)/)
    if (mi) imdb = mi[1]
    const mt = g.match(/tvdb:\/\/(\d+)/)
    if (mt) tvdb = Number(mt[1])
  }
  return { imdb, tvdb }
}

/** Proxy a relative Plex thumb path through the token-stripping image route. */
export function plexThumbProxy(thumb: string | null): string | null {
  if (!thumb) return null
  return `/api/plex/img?path=${encodeURIComponent(thumb)}`
}

/** Resolve a TVMaze show id from Plex GUIDs (IMDb/TVDB) with a title+year fallback. Cached. */
export async function resolveShowId(guids: string[], title: string, year: number | null): Promise<number | null> {
  const { imdb, tvdb } = extractExternal(guids)
  const key = `${imdb ?? ''}|${tvdb ?? ''}|${title.toLowerCase()}|${year ?? ''}`
  return cachedLookup('plex-show-resolve', key, THIRTY_DAYS_MS, async () => {
    if (imdb || tvdb) {
      const byExt = await lookupShowId({ imdb, thetvdb: tvdb })
      if (byExt) return byExt
    }
    const s = await resolveShow(title, year)
    return s?.id ?? null
  })
}

/** Build the in-app detail route for a normalized Plex item, or null if unresolvable. */
export async function plexItemToRoute(item: PlexNormItem): Promise<string | null> {
  if (!item.title) return null
  if (item.type === 'movie') {
    const y = item.year ? `?year=${item.year}` : ''
    return `/movies/${encodeURIComponent(item.title)}${y}`
  }
  const id = await resolveShowId(item.guids, item.title, item.year)
  return id ? `/shows/${id}` : null
}

/** Resolve a batch of Plex items to clickable poster cards, dropping any that don't resolve. */
export async function plexItemsToPosters(items: PlexNormItem[]): Promise<PlexPoster[]> {
  const resolved = await Promise.all(
    items.map(async (item): Promise<PlexPoster | null> => {
      const to = await plexItemToRoute(item)
      if (!to) return null
      const subtitle = item.episodeLabel ?? (item.year ? String(item.year) : null)
      return { to, title: item.title, subtitle, poster: plexThumbProxy(item.thumb), mediaType: item.type }
    }),
  )
  return resolved.filter((p): p is PlexPoster => !!p)
}

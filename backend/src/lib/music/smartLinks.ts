// Cross-platform "Listen on …" links for a song or album.
// Uses the keyless iTunes Search API to find the Apple Music URL, then expands
// it across Spotify, YouTube Music, Tidal, Deezer, etc. via Odesli (song.link).
// Cached 30 days — same pattern as lib/titles/soundtrack.ts.

import { cachedLookup, THIRTY_DAYS_MS } from '@/lib/lookupCache'
import { odesliLinks } from '@/lib/titles/soundtrack'
import type { PlatformLink } from '@/lib/titles/types'

export type { PlatformLink }

interface ItunesTrack {
  trackViewUrl?: string
  collectionViewUrl?: string
}

async function itunesUrl(term: string, entity: 'song' | 'album'): Promise<string | null> {
  try {
    const res = await fetch(
      `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=${entity}&limit=5`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000) },
    )
    if (!res.ok) return null
    const data = (await res.json()) as { results?: ItunesTrack[] }
    const first = data.results?.[0]
    if (!first) return null
    const url = entity === 'song' ? first.trackViewUrl : first.collectionViewUrl
    return url ? url.replace(/\?uo=\d+$/, '') : null
  } catch {
    return null
  }
}

export async function getSongSmartLinks(artist: string, track: string): Promise<PlatformLink[]> {
  if (!artist.trim() || !track.trim()) return []
  const key = `song:${artist.toLowerCase()}:${track.toLowerCase()}`
  return cachedLookup('music-smartlinks', key, THIRTY_DAYS_MS, async () => {
    const appleUrl = await itunesUrl(`${track} ${artist}`, 'song')
    if (!appleUrl) return []
    const links: PlatformLink[] = [{ platform: 'Apple Music', url: appleUrl }]
    for (const l of await odesliLinks(appleUrl)) {
      if (!links.some(x => x.platform === l.platform)) links.push(l)
    }
    return links
  })
}

export async function getAlbumSmartLinks(artist: string, album: string): Promise<PlatformLink[]> {
  if (!artist.trim() || !album.trim()) return []
  const key = `album:${artist.toLowerCase()}:${album.toLowerCase()}`
  return cachedLookup('music-smartlinks', key, THIRTY_DAYS_MS, async () => {
    const appleUrl = await itunesUrl(`${album} ${artist}`, 'album')
    if (!appleUrl) return []
    const links: PlatformLink[] = [{ platform: 'Apple Music', url: appleUrl }]
    for (const l of await odesliLinks(appleUrl)) {
      if (!links.some(x => x.platform === l.platform)) links.push(l)
    }
    return links
  })
}

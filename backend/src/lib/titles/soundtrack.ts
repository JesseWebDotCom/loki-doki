// Soundtrack album links. We find the album on Apple's keyless iTunes Search API (reliable,
// with cover art), then expand it across every streaming service via Odesli (song.link) —
// a keyless API that, given one streaming URL, returns the same album on Spotify, YouTube
// Music, Amazon Music, Tidal, Deezer, etc. Spotify falls back to a deep search link when
// Odesli can't resolve it directly. All cached 30 days.

import { cachedLookup, THIRTY_DAYS_MS } from '@/lib/lookupCache'
import type { MediaKind, PlatformLink, SoundtrackAlbum } from './types'

export type { SoundtrackAlbum }

interface ItunesAlbum {
  collectionName?: string
  artistName?: string
  collectionViewUrl?: string
  artworkUrl100?: string
}

const SOUNDTRACK_RE = /(soundtrack|original score|motion picture|music from|\bost\b|original series)/i

// Odesli platform key → display label, in the order we want to show them.
const ODESLI_PLATFORMS: Array<[string, string]> = [
  ['spotify', 'Spotify'],
  ['youtubeMusic', 'YouTube Music'],
  ['amazonMusic', 'Amazon Music'],
  ['tidal', 'Tidal'],
  ['deezer', 'Deezer'],
  ['pandora', 'Pandora'],
  ['soundcloud', 'SoundCloud'],
  ['anghami', 'Anghami'],
  ['audiomack', 'Audiomack'],
  ['youtube', 'YouTube'],
]

function norm(s: string): string {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).join(' ')
}

// Ask Odesli for every platform the album is on, given its Apple Music URL. Keyless,
// best-effort (rate-limited → returns [] on failure, which just yields fewer links).
async function odesliLinks(appleUrl: string): Promise<PlatformLink[]> {
  try {
    const res = await fetch(
      `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(appleUrl)}&userCountry=US`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000) },
    )
    if (!res.ok) return []
    const data = (await res.json()) as { linksByPlatform?: Record<string, { url?: string }> }
    const byPlatform = data.linksByPlatform ?? {}
    const out: PlatformLink[] = []
    for (const [key, label] of ODESLI_PLATFORMS) {
      const url = byPlatform[key]?.url
      if (url) out.push({ platform: label, url })
    }
    return out
  } catch {
    return []
  }
}

export async function getSoundtrackAlbums(title: string, year: string | null, kind: MediaKind): Promise<SoundtrackAlbum[]> {
  const key = `v2:${kind}:${title.toLowerCase()}:${year ?? ''}`
  return cachedLookup('soundtrack-album', key, THIRTY_DAYS_MS, async () => {
    try {
      const term = `${title} ${kind === 'show' ? 'soundtrack' : 'original soundtrack'}`
      const res = await fetch(
        `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=album&limit=12`,
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000) },
      )
      if (!res.ok) return []
      const data = (await res.json()) as { results?: ItunesAlbum[] }
      const titleNorm = norm(title)

      // Pick the matching soundtrack/score albums first (cheap), then enrich them in parallel.
      const picks: Array<{ name: string; artist: string; appleUrl: string; artworkUrl: string | null }> = []
      const seen = new Set<string>()
      for (const a of data.results ?? []) {
        const name = (a.collectionName ?? '').trim()
        const url = (a.collectionViewUrl ?? '').trim().replace(/\?uo=\d+$/, '')
        if (!name || !url || seen.has(url)) continue
        if (!SOUNDTRACK_RE.test(name) || !norm(name).includes(titleNorm)) continue
        seen.add(url)
        picks.push({
          name,
          artist: (a.artistName ?? '').trim(),
          appleUrl: url,
          artworkUrl: a.artworkUrl100 ? a.artworkUrl100.replace('100x100bb', '400x400bb') : null,
        })
        if (picks.length >= 4) break
      }

      return Promise.all(
        picks.map(async (p): Promise<SoundtrackAlbum> => {
          const links: PlatformLink[] = [{ platform: 'Apple Music', url: p.appleUrl }]
          for (const l of await odesliLinks(p.appleUrl)) {
            if (!links.some((x) => x.platform === l.platform)) links.push(l)
          }
          // Guarantee a Spotify link even when Odesli can't resolve it directly.
          if (!links.some((l) => l.platform === 'Spotify')) {
            links.push({ platform: 'Spotify', url: `https://open.spotify.com/search/${encodeURIComponent(`${p.name} ${p.artist}`.trim())}` })
          }
          return { name: p.name, artist: p.artist, artworkUrl: p.artworkUrl, links }
        }),
      )
    } catch {
      return []
    }
  })
}

// Query autosuggest for the Music search box (the artist/song dropdown that appears as you type),
// mirroring youtube/suggest.ts. MusicBrainz — our catalog-search source — is throttled to ~1 req/s,
// far too slow for per-keystroke suggestions, so we suggest off Deezer instead: keyless, fast, and
// clean metadata (see lib/music/deezer.ts for why we trust it). Playback/search still resolve
// through MusicBrainz + the YouTube resolver; this only feeds the dropdown.

import { logger } from '@/lib/logger'

const BASE = 'https://api.deezer.com'

export interface MusicSuggestion {
  /** Display text AND the string dropped into the search box when picked. */
  label: string
  /** Type/context hint shown muted on the right ("Artist", or the song's artist). */
  sublabel?: string
}

async function dz<T = any>(path: string, timeout: number): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { 'User-Agent': 'LokiDoki/1.0' },
      signal: AbortSignal.timeout(timeout),
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

/**
 * Suggestions for a partial music query. Artists lead (the primary "search for an artist" case),
 * then songs as "Title" tagged with their artist. Deduped by label, capped at `limit`.
 */
export async function getMusicSuggestions(q: string, limit = 8, timeout = 4000): Promise<MusicSuggestion[]> {
  try {
    const [artists, tracks] = await Promise.all([
      dz<{ data?: Array<{ name?: string }> }>(`/search/artist?q=${encodeURIComponent(q)}&limit=6`, timeout),
      dz<{ data?: Array<{ title?: string; artist?: { name?: string } }> }>(`/search/track?q=${encodeURIComponent(q)}&limit=6`, timeout),
    ])

    const out: MusicSuggestion[] = []
    const seen = new Set<string>()
    const push = (label: string | undefined, sublabel?: string) => {
      const l = (label ?? '').trim()
      if (!l) return
      const k = l.toLowerCase()
      if (seen.has(k)) return
      seen.add(k)
      out.push(sublabel ? { label: l, sublabel } : { label: l })
    }

    for (const a of artists?.data ?? []) push(a.name, 'Artist')
    for (const t of tracks?.data ?? []) push(t.title, t.artist?.name)

    return out.slice(0, limit)
  } catch (err) {
    logger.warn(`[music/suggest] lookup failed for "${q}": ${err}`)
    return []
  }
}

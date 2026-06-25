// Music information proxy — Wikipedia artist summaries and MusicBrainz soundtrack lookups.
// MusicBrainz requires a User-Agent and rate-limits to 1 req/sec; we keep it simple
// and only call it when a track search is explicitly requested.

import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { cachedLookup, THIRTY_DAYS_MS } from '@/lib/lookupCache'
import type { AppEnv } from '@/types'

export const musicInfo = new Hono<AppEnv>()
musicInfo.use('*', requireAuth)

const MB_UA = 'LokiDoki/3.0 (https://github.com/lokidoki; contact@lokidoki.app)'
const MB_BASE = 'https://musicbrainz.org/ws/2'
const WP_REST = 'https://en.wikipedia.org/api/rest_v1/page/summary'

async function wikipediaSummary(title: string) {
  const res = await fetch(`${WP_REST}/${encodeURIComponent(title)}`, {
    headers: { 'User-Agent': MB_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(6000),
  })
  if (!res.ok) return null
  const d = await res.json() as {
    type?: string
    title?: string
    description?: string
    extract?: string
    thumbnail?: { source?: string }
    content_urls?: { desktop?: { page?: string } }
  }
  if (d.type === 'disambiguation') return null
  return {
    title: d.title ?? title,
    description: d.description ?? '',
    extract: d.extract ?? '',
    image: d.thumbnail?.source ?? null,
    url: d.content_urls?.desktop?.page ?? null,
  }
}

// Confirm a Wikipedia page is actually about THIS song — not a same-named topic (the classic trap:
// "Columns" the song → the article on architectural columns). We check Wikipedia's own short
// description and the opening sentence for music wording, or that the artist is named in the blurb.
function looksLikeSong(info: { description?: string; extract?: string }, artist: string): boolean {
  const desc = (info.description ?? '').toLowerCase()
  const extract = (info.extract ?? '').toLowerCase()
  const a = artist.trim().toLowerCase()
  if (/\b(song|single|musical composition|instrumental|studio album|extended play)\b/.test(desc)) return true
  if (/\bis an?\b[^.]*\b(song|single|track|composition|instrumental|recording)\b/.test(extract)) return true
  // The artist is explicitly named in the summary — strong signal it's the right recording.
  if (a.length > 2 && /[a-z]/.test(a) && extract.includes(a)) return true
  return false
}

// GET /api/music/info/artist?q=ARTIST — Wikipedia bio + image
musicInfo.get('/artist', async (c) => {
  const q = c.req.query('q')?.trim()
  if (!q) return c.json({ error: 'q required' }, 400)
  try {
    const info = await wikipediaSummary(q)
    if (!info) return c.json({ found: false })
    return c.json({ found: true, ...info })
  } catch {
    return c.json({ found: false })
  }
})

// GET /api/music/info/track?artist=X&track=Y — MusicBrainz soundtrack appearances
// Returns movies/shows the recording appeared on so the frontend can deep-link.
musicInfo.get('/track', async (c) => {
  const artist = c.req.query('artist')?.trim()
  const track = c.req.query('track')?.trim()
  if (!track) return c.json({ appearances: [] })

  const qParts: string[] = []
  if (track) qParts.push(`recording:"${track}"`)
  if (artist) qParts.push(`artist:"${artist}"`)

  try {
    const url = `${MB_BASE}/recording/?query=${encodeURIComponent(qParts.join(' AND '))}&fmt=json&limit=3&inc=releases+release-groups`
    const res = await fetch(url, {
      headers: { 'User-Agent': MB_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return c.json({ appearances: [] })

    const data = await res.json() as {
      recordings?: Array<{
        releases?: Array<{
          title: string
          date?: string
          'release-group'?: {
            'primary-type'?: string
            'secondary-types'?: string[]
          }
        }>
      }>
    }

    const appearances: Array<{ title: string; year: string | null; type: 'movie' | 'show' | 'soundtrack' }> = []
    const seen = new Set<string>()

    for (const rec of data.recordings ?? []) {
      for (const rel of rec.releases ?? []) {
        const rg = rel['release-group']
        const primary = rg?.['primary-type'] ?? ''
        const secondary = rg?.['secondary-types'] ?? []
        const isSoundtrack = secondary.includes('Soundtrack') || primary === 'Soundtrack'
        if (!isSoundtrack) continue

        const title = rel.title.replace(/\s*\(Original.*?\)/i, '').trim()
        if (seen.has(title)) continue
        seen.add(title)

        const year = rel.date ? rel.date.slice(0, 4) : null
        // Heuristic: TV soundtracks often have "Season" / episode numbers in the title.
        const isShow = /season|vol\.|volume|episode|series/i.test(title)
        appearances.push({ title, year, type: isShow ? 'show' : 'movie' })
        if (appearances.length >= 12) break
      }
      if (appearances.length >= 12) break
    }

    return c.json({ appearances })
  } catch {
    return c.json({ appearances: [] })
  }
})

// GET /api/music/info/song?artist=X&title=Y — Wikipedia summary for a song (for the Now-Playing
// info panel). Tries the song page, then "artist song", then falls back to the artist.
musicInfo.get('/song', async (c) => {
  const artist = c.req.query('artist')?.trim() ?? ''
  const title = c.req.query('title')?.trim()
  if (!title) return c.json({ found: false })
  try {
    // Disambiguated page forms are inherently song articles, so accept them on sight. Wikipedia
    // uses "<Title> (<Artist> song)" and "<Title> (song)" exactly for this.
    const songForms = [artist ? `${title} (${artist} song)` : '', `${title} (song)`].filter(Boolean)
    for (const cand of songForms) {
      const info = await wikipediaSummary(cand)
      if (info?.extract) return c.json({ found: true, ...info })
    }
    // Bare title is ambiguous ("Columns" → architectural columns), so only accept it when the page
    // is clearly about a song / the artist is named in the blurb.
    const info = await wikipediaSummary(title)
    if (info?.extract && looksLikeSong(info, artist)) return c.json({ found: true, ...info })
    return c.json({ found: false })
  } catch {
    return c.json({ found: false })
  }
})

// ── Lyrics (LRCLIB) ────────────────────────────────────────────────────────────────
// Free, keyless, open lyrics database with time-synced LRC. Cached hard (lyrics don't change).
interface LyricLine { sec: number; text: string }
interface LyricsResult { synced: LyricLine[] | null; plain: string | null; source: string }

// Parse an LRC string ("[mm:ss.xx] words") into timestamped lines, dropping blank/timing-only ones.
function parseLrc(lrc: string): LyricLine[] {
  const out: LyricLine[] = []
  for (const raw of lrc.split('\n')) {
    const matches = [...raw.matchAll(/\[(\d+):(\d+)(?:\.(\d+))?\]/g)]
    if (!matches.length) continue
    const text = raw.replace(/\[(\d+):(\d+)(?:\.(\d+))?\]/g, '').trim()
    for (const m of matches) {
      const min = parseInt(m[1]!, 10), s = parseInt(m[2]!, 10), frac = m[3] ? parseInt(m[3].padEnd(3, '0').slice(0, 3), 10) / 1000 : 0
      out.push({ sec: min * 60 + s + frac, text })
    }
  }
  return out.sort((a, b) => a.sec - b.sec)
}

async function fetchLrclib(artist: string, title: string, duration?: number): Promise<LyricsResult> {
  const headers = { 'User-Agent': MB_UA, Accept: 'application/json' }
  // Exact match endpoint first (best, includes duration disambiguation).
  try {
    const p = new URLSearchParams({ artist_name: artist, track_name: title })
    if (duration) p.set('duration', String(duration))
    const res = await fetch(`https://lrclib.net/api/get?${p}`, { headers, signal: AbortSignal.timeout(7000) })
    if (res.ok) {
      const d = await res.json() as { syncedLyrics?: string | null; plainLyrics?: string | null }
      if (d.syncedLyrics) return { synced: parseLrc(d.syncedLyrics), plain: d.plainLyrics ?? null, source: 'lrclib' }
      if (d.plainLyrics) return { synced: null, plain: d.plainLyrics, source: 'lrclib' }
    }
  } catch { /* fall through to search */ }
  // Fuzzy search fallback — first hit that has lyrics.
  try {
    const res = await fetch(`https://lrclib.net/api/search?${new URLSearchParams({ artist_name: artist, track_name: title })}`,
      { headers, signal: AbortSignal.timeout(7000) })
    if (res.ok) {
      const arr = await res.json() as Array<{ syncedLyrics?: string | null; plainLyrics?: string | null }>
      const hit = arr.find(x => x.syncedLyrics) ?? arr.find(x => x.plainLyrics)
      if (hit?.syncedLyrics) return { synced: parseLrc(hit.syncedLyrics), plain: hit.plainLyrics ?? null, source: 'lrclib' }
      if (hit?.plainLyrics) return { synced: null, plain: hit.plainLyrics, source: 'lrclib' }
    }
  } catch { /* give up */ }
  return { synced: null, plain: null, source: 'none' }
}

// GET /api/music/info/lyrics?artist=X&title=Y&duration=Z — synced (or plain) lyrics from LRCLIB.
musicInfo.get('/lyrics', async (c) => {
  const artist = c.req.query('artist')?.trim() ?? ''
  const title = c.req.query('title')?.trim()
  if (!title) return c.json({ synced: null, plain: null, source: 'none' })
  const durationRaw = c.req.query('duration')
  const duration = durationRaw ? parseInt(durationRaw, 10) : undefined
  const result = await cachedLookup<LyricsResult>(
    'lrclib', `${artist}|${title}|${duration ?? ''}`, THIRTY_DAYS_MS,
    () => fetchLrclib(artist, title, duration),
  )
  return c.json(result)
})

// GET /api/music/info/soundtrack?title=SHOW_TITLE — Songs from a show/movie's soundtrack
musicInfo.get('/soundtrack', async (c) => {
  const title = c.req.query('title')?.trim()
  if (!title) return c.json({ songs: [] })

  try {
    const url = `${MB_BASE}/release/?query=release:"${encodeURIComponent(title)}"+secondary-type:Soundtrack&fmt=json&limit=5&inc=recordings`
    const res = await fetch(url, {
      headers: { 'User-Agent': MB_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return c.json({ songs: [] })

    const data = await res.json() as {
      releases?: Array<{
        title: string
        media?: Array<{
          tracks?: Array<{
            title: string
            length?: number
            recording?: { artist?: string }
          }>
        }>
      }>
    }

    const songs: Array<{ title: string; durationMs: number | null }> = []
    for (const release of data.releases ?? []) {
      if (!release.title.toLowerCase().includes(title.toLowerCase())) continue
      for (const medium of release.media ?? []) {
        for (const t of medium.tracks ?? []) {
          songs.push({ title: t.title, durationMs: t.length ?? null })
          if (songs.length >= 30) break
        }
        if (songs.length >= 30) break
      }
      if (songs.length) break
    }

    return c.json({ songs, sourceTitle: data.releases?.[0]?.title ?? title })
  } catch {
    return c.json({ songs: [] })
  }
})

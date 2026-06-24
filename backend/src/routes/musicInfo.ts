// Music information proxy — Wikipedia artist summaries and MusicBrainz soundtrack lookups.
// MusicBrainz requires a User-Agent and rate-limits to 1 req/sec; we keep it simple
// and only call it when a track search is explicitly requested.

import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
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
    extract?: string
    thumbnail?: { source?: string }
    content_urls?: { desktop?: { page?: string } }
  }
  if (d.type === 'disambiguation') return null
  return {
    title: d.title ?? title,
    extract: d.extract ?? '',
    image: d.thumbnail?.source ?? null,
    url: d.content_urls?.desktop?.page ?? null,
  }
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

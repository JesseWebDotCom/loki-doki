// Music catalog API — browse and search the MusicBrainz identity graph, and resolve a song
// to a playable YouTube id. Thin HTTP wrapper over lib/music/catalog.ts + lib/music/resolve.ts;
// all the caching and rate-limiting lives in those libs.

import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import {
  searchArtists, searchAlbums, searchSongs,
  getArtist, getArtistAlbums, getAlbum,
} from '@/lib/music/catalog'
import { resolveTrack } from '@/lib/music/resolve'
import { searchStations } from '@/routes/musicStations'
import type { AppEnv } from '@/types'

export const musicCatalog = new Hono<AppEnv>()
musicCatalog.use('*', requireAuth)

// GET /api/music/catalog/search?q=…&type=all|artists|albums|songs|stations
musicCatalog.get('/search', async (c) => {
  const q = c.req.query('q')?.trim()
  const type = c.req.query('type') ?? 'all'
  const user = c.get('user')
  if (!q) return c.json({ artists: [], albums: [], songs: [], stations: [] })

  const [artists, albums, songs, stations] = await Promise.all([
    type === 'all' || type === 'artists' ? searchArtists(q, type === 'artists' ? 24 : 6) : Promise.resolve([]),
    type === 'all' || type === 'albums' ? searchAlbums(q, type === 'albums' ? 24 : 8) : Promise.resolve([]),
    type === 'all' || type === 'songs' ? searchSongs(q, type === 'songs' ? 30 : 10) : Promise.resolve([]),
    type === 'all' || type === 'stations' ? searchStations(q, user.id, type === 'stations' ? 24 : 8) : Promise.resolve([]),
  ])
  return c.json({ artists, albums, songs, stations })
})

// GET /api/music/catalog/artist/:mbid — bio/links + discography
musicCatalog.get('/artist/:mbid', async (c) => {
  const mbid = c.req.param('mbid')
  const [artist, albums] = await Promise.all([getArtist(mbid), getArtistAlbums(mbid)])
  if (!artist) return c.json({ error: 'not found' }, 404)
  return c.json({ artist, albums })
})

// GET /api/music/catalog/album/:mbid — album + tracklist
musicCatalog.get('/album/:mbid', async (c) => {
  const { album, songs } = await getAlbum(c.req.param('mbid'))
  if (!album) return c.json({ error: 'not found' }, 404)
  return c.json({ album, songs })
})

// GET /api/music/catalog/resolve?mbid=&title=&artist=&duration= — identity → playable videoId
musicCatalog.get('/resolve', async (c) => {
  const title = c.req.query('title')?.trim()
  const artist = c.req.query('artist')?.trim() ?? ''
  if (!title) return c.json({ error: 'title required' }, 400)
  const durationRaw = c.req.query('duration')
  const resolved = await resolveTrack({
    mbid: c.req.query('mbid')?.trim() || null,
    title,
    artist,
    durationSec: durationRaw ? parseInt(durationRaw, 10) : null,
  })
  if (!resolved) return c.json({ resolved: null })
  return c.json({ resolved })
})

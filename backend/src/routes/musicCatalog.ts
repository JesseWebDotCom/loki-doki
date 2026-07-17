// Music catalog API — browse and search the MusicBrainz identity graph, and resolve a song
// to a playable YouTube id. Thin HTTP wrapper over lib/music/catalog.ts + lib/music/resolve.ts;
// all the caching and rate-limiting lives in those libs.

import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import {
  searchArtists, searchAlbums, searchSongs,
  getArtist, getArtistAlbums, getAlbum, itunesAlbumCover, itunesSongArt, pickArtistMbid, albumMbidFor,
} from '@/lib/music/catalog'
import { resolvePlayable, findOwned } from '@/lib/music/resolveSource'
import { deezerChartTracks, deezerArtistPicture } from '@/lib/music/deezer'
import { getMusicSuggestions } from '@/lib/music/suggest'
import { searchStations } from '@/routes/musicStations'
import {
  familyEntrySetsFor, artistAllowed, stationAllowed, audioGateFor, logFamilyAudioEvent,
} from '@/lib/family/audioPolicy'
import type { AppEnv } from '@/types'

export const musicCatalog = new Hono<AppEnv>()
musicCatalog.use('*', requireAuth)

// GET /api/music/catalog/search?q=…&type=all|artists|albums|songs|stations
musicCatalog.get('/search', async (c) => {
  const q = c.req.query('q')?.trim() ?? ''
  const artist = c.req.query('artist')?.trim() ?? ''   // optional band filter (songs only)
  const type = c.req.query('type') ?? 'all'
  const user = c.get('user')
  if (!q && !artist) return c.json({ artists: [], albums: [], songs: [], stations: [] })

  const [artists, albums, songs, stations] = await Promise.all([
    (type === 'all' || type === 'artists') && q ? searchArtists(q, type === 'artists' ? 24 : 6) : Promise.resolve([]),
    (type === 'all' || type === 'albums') && q ? searchAlbums(q, type === 'albums' ? 24 : 8) : Promise.resolve([]),
    type === 'all' || type === 'songs' ? searchSongs(q, type === 'songs' ? 30 : 10, artist) : Promise.resolve([]),
    (type === 'all' || type === 'stations') && q ? searchStations(q, user.id, type === 'stations' ? 24 : 8) : Promise.resolve([]),
  ])

  // Family audio: allowlist-only profiles only see approved artists/stations; blocked
  // items disappear for everyone they apply to.
  const sets = await familyEntrySetsFor(user.id)
  if (sets.hasAny) {
    return c.json({
      artists: artists.filter(a => artistAllowed(sets, a.name)),
      albums: albums.filter(a => artistAllowed(sets, a.artistName)),
      songs: songs.filter(s => artistAllowed(sets, s.artistName)),
      stations: stations.filter(s => stationAllowed(sets, s.id)),
    })
  }
  return c.json({ artists, albums, songs, stations })
})

// GET /api/music/catalog/suggest?q=… — query autosuggest for the search box (Deezer-backed, fast,
// per-keystroke, no caching). Mirrors /api/youtube/suggest.
musicCatalog.get('/suggest', async (c) => {
  const q = c.req.query('q')?.trim()
  if (!q) return c.json({ suggestions: [] })
  // Allowlist-only profiles get no open-ended autosuggest (it surfaces the whole
  // catalog); blocked artists never appear as a suggestion's artist line.
  const sets = await familyEntrySetsFor(c.get('user').id)
  if (sets.allowlistOnly) return c.json({ suggestions: [] })
  const suggestions = await getMusicSuggestions(q)
  if (!sets.hasAny) return c.json({ suggestions })
  return c.json({ suggestions: suggestions.filter(s => artistAllowed(sets, s.sublabel ?? s.label)) })
})

// GET /api/music/catalog/artist/:mbid — bio/links + discography
musicCatalog.get('/artist/:mbid', async (c) => {
  const mbid = c.req.param('mbid')
  const [artist, albums] = await Promise.all([getArtist(mbid), getArtistAlbums(mbid)])
  if (!artist) return c.json({ error: 'not found' }, 404)
  const sets = await familyEntrySetsFor(c.get('user').id)
  if (sets.hasAny && !artistAllowed(sets, artist.name)) {
    logFamilyAudioEvent(c.get('user').id, 'blocked_play', { label: artist.name, medium: 'music', reason: 'artist' })
    return c.json({ error: 'This artist is not available on this profile' }, 403)
  }
  return c.json({ artist, albums })
})

// GET /api/music/catalog/album/:mbid — album + tracklist
musicCatalog.get('/album/:mbid', async (c) => {
  const { album, songs } = await getAlbum(c.req.param('mbid'))
  if (!album) return c.json({ error: 'not found' }, 404)
  const sets = await familyEntrySetsFor(c.get('user').id)
  if (sets.hasAny && !artistAllowed(sets, album.artistName)) {
    return c.json({ error: 'This album is not available on this profile' }, 403)
  }
  return c.json({ album, songs })
})

// GET /api/music/catalog/cover?artist=&album= — PRIMARY album art (iTunes; CAA is the
// slow fallback client-side). Singles rarely exist as iTunes ALBUMS ("Chop Suey!" is a
// song, not an album), so the song lookup fills in - it returns the parent album's
// artwork, the same thing streaming services show for singles without dedicated art.
musicCatalog.get('/cover', async (c) => {
  const artist = c.req.query('artist')?.trim() ?? ''
  const album = c.req.query('album')?.trim() ?? ''
  if (!album) return c.json({ coverUrl: null })
  const coverUrl = (await itunesAlbumCover(artist, album)) ?? (await itunesSongArt(artist, album))
  return c.json({ coverUrl }, 200, { 'Cache-Control': 'private, max-age=604800' })
})

// GET /api/music/catalog/genre?g=Metal — a GENRE landing (top songs + top artists from the
// live Deezer genre chart), for Browse's genre tiles. This is real genre browsing, not a
// text search for the genre word in titles. Artist photos ride along from Deezer's CDN
// (fast, near-complete) so the chip row fills instantly.
musicCatalog.get('/genre', async (c) => {
  const g = c.req.query('g')?.trim() ?? ''
  if (!g) return c.json({ error: 'g required' }, 400)
  const sets = await familyEntrySetsFor(c.get('user').id)
  let tracks = (await deezerChartTracks(g, 40)).slice(0, 30)
  if (sets.hasAny) tracks = tracks.filter(t => artistAllowed(sets, t.artist))
  const seen = new Set<string>()
  const names: string[] = []
  for (const t of tracks) {
    const k = t.artist.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    names.push(t.artist)
    if (names.length >= 10) break
  }
  const artists = await Promise.all(names.map(async (name) => ({
    name,
    picture: await deezerArtistPicture(name).catch(() => null),
  })))
  // Charts move slowly - an hour of browser cache keeps tile clicks instant.
  return c.json({ tracks, artists }, 200, { 'Cache-Control': 'private, max-age=3600' })
})

// GET /api/music/catalog/artist-id?name=Skid%20Row — bare name → THE MusicBrainz artist,
// so chart/genre chips can open the real artist page instead of a text search.
musicCatalog.get('/artist-id', async (c) => {
  const name = c.req.query('name')?.trim() ?? ''
  if (!name) return c.json({ error: 'name required' }, 400)
  const mbid = await pickArtistMbid(name)
  return c.json({ mbid }, 200, { 'Cache-Control': 'private, max-age=86400' })
})

// GET /api/music/catalog/album-id?title=&artist= — album name → THE release-group MBID, so a
// Deezer search result (which has no MBID) can open the real album page. Resolved lazily on click.
musicCatalog.get('/album-id', async (c) => {
  const title = c.req.query('title')?.trim() ?? ''
  const artist = c.req.query('artist')?.trim() ?? ''
  if (!title) return c.json({ error: 'title required' }, 400)
  const mbid = await albumMbidFor(title, artist)
  return c.json({ mbid }, 200, { 'Cache-Control': 'private, max-age=86400' })
})

// GET /api/music/catalog/resolve?mbid=&title=&artist=&duration= — identity → playable ref.
// Library-first: owning the song means playing YOUR copy (local file or Plex track)
// instead of a YouTube stream. `videoId` keeps its name but carries the unified ref -
// the frontend queue and streaming paths already speak refs.
musicCatalog.get('/resolve', async (c) => {
  const title = c.req.query('title')?.trim()
  const artist = c.req.query('artist')?.trim() ?? ''
  if (!title) return c.json({ error: 'title required' }, 400)

  // Family audio hard gates: this is the identity -> playable seam every direct song
  // play crosses, so allowlist/blocklist and the time budget are enforced here.
  const user = c.get('user')
  const gate = await audioGateFor(user.id)
  if (!gate.allowed) {
    logFamilyAudioEvent(user.id, gate.reason === 'quiet_hours' ? 'quiet_hours_block' : 'budget_exhausted', { label: `${artist} - ${title}`, medium: 'music' })
    return c.json({ error: gate.reason === 'quiet_hours' ? 'Audio is paused during quiet hours' : 'Audio time is done for today', code: 'family_time' }, 403)
  }
  const sets = await familyEntrySetsFor(user.id)
  if (sets.hasAny && !artistAllowed(sets, artist)) {
    logFamilyAudioEvent(user.id, 'blocked_play', { label: `${artist} - ${title}`, medium: 'music', reason: 'artist' })
    return c.json({ error: 'This artist is not available on this profile', code: 'family_blocked' }, 403)
  }

  const durationRaw = c.req.query('duration')
  const playable = await resolvePlayable({
    mbid: c.req.query('mbid')?.trim() || null,
    title,
    artist,
    durationSec: durationRaw ? parseInt(durationRaw, 10) : null,
  })
  if (!playable) return c.json({ resolved: null })
  return c.json({
    resolved: {
      videoId: playable.ref,
      title: playable.title,
      artist: playable.artist,
      durationSec: playable.durationSec,
      score: 1,
      source: playable.source,
      codec: playable.codec,
      bitrate: playable.bitrate,
    },
  })
})

// POST /api/music/catalog/match — batch owned-copy lookup for browse rows: which of
// these songs does the user's library already have? Powers the "owned" badges.
musicCatalog.post('/match', async (c) => {
  const body = await c.req.json().catch(() => null) as { tracks?: Array<{ title?: string; artist?: string; mbid?: string | null; durationSec?: number | null }> } | null
  const tracks = (body?.tracks ?? []).slice(0, 60)
  const matches: Array<{ index: number; ref: string; source: string; codec: string | null }> = []
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i]!
    if (!t.title) continue
    const owned = await findOwned({ title: t.title, artist: t.artist ?? '', mbid: t.mbid ?? null, durationSec: t.durationSec ?? null })
    if (owned) matches.push({ index: i, ref: owned.ref, source: owned.source, codec: owned.codec })
  }
  return c.json({ matches })
})

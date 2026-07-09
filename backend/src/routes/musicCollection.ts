// Unified music Collection API - the household's OWNED library, merged across sources:
// local folders + uploads (music_local_tracks) and the synced Plex music mirror
// (music_plex_tracks). One collection, source as a badge/filter - never a navigation
// split. Routes are auth- but not owner-gated (a home media library, like Plex's).
// Artists/albums are computed with GROUP BY + in-memory merge across the two tables -
// deliberately no derived artist/album tables to keep the scanners sync-bug-free.
// When the same album exists in both sources, rows merge by normalized (albumArtist, album);
// duplicate tracks inside a merged album prefer the LOCAL copy (no network hop, no Plex
// transcode risk).

import { promises as fs } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { Hono } from 'hono'
import { asc, eq, like, or, sql } from 'drizzle-orm'
import { parseFile } from 'music-metadata'
import { db } from '@/db'
import { musicLocalTracks, musicPlexTracks } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { serveFileRange } from '@/lib/http/rangeFile'
import { ensureUploadsFolder, indexUploadedFile } from '@/lib/music/localLibrary'
import { localRef, plexRef } from '@/lib/music/trackRef'
import { resolveContentTypePath } from '@/lib/storage/contentRoots'
import { logger } from '@/lib/logger'
import type { AppEnv } from '@/types'

export const musicCollection = new Hono<AppEnv>()
musicCollection.use('*', requireAuth)

const UPLOAD_MAX_BYTES = 250 * 1024 * 1024
const UPLOAD_EXTENSIONS = new Set(['.mp3', '.flac', '.m4a', '.m4b', '.aac', '.ogg', '.oga', '.opus', '.wav', '.aiff', '.aif'])

const MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.m4b': 'audio/mp4',
  '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
  '.wav': 'audio/wav', '.aiff': 'audio/aiff', '.aif': 'audio/aiff',
}

type Source = 'local' | 'plex'
const parseSourceFilter = (c: { req: { query(k: string): string | undefined } }): Source | null => {
  const s = c.req.query('source')
  return s === 'local' || s === 'plex' ? s : null
}

// The album grouping key: albumArtist when tagged, else artist - without this, "Various
// Artists" compilations shatter into one album per contributing artist. (Plex has no
// album-artist column in the mirror; grandparentTitle already IS the album's artist.)
const ALBUM_ARTIST = sql<string>`COALESCE(NULLIF(${musicLocalTracks.albumArtist}, ''), ${musicLocalTracks.artist}, 'Unknown Artist')`
const ARTIST = sql<string>`COALESCE(NULLIF(${musicLocalTracks.artist}, ''), ${musicLocalTracks.albumArtist}, 'Unknown Artist')`
const PLEX_ARTIST = sql<string>`COALESCE(NULLIF(${musicPlexTracks.artist}, ''), 'Unknown Artist')`

// Case/punctuation-insensitive merge key for cross-source artist/album identity.
const mergeKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

// Every Plex track is playable: browser-native codecs stream raw; the rest (ALAC/WMA/…)
// go through the stream route's on-the-fly ffmpeg transcode (routes/plex.ts). Unlike
// local files, there is no unplayable state to grey out.
const plexPlayable = (_codec: string | null) => true

const plexArt = (row: { thumb: string | null; parentThumb: string | null; grandparentThumb: string | null }): string | null => {
  const path = row.parentThumb ?? row.thumb ?? row.grandparentThumb
  return path ? `/api/plex/img?path=${encodeURIComponent(path)}` : null
}

export interface TrackDto {
  ref: string
  source: Source
  title: string
  artist: string | null
  album: string | null
  albumArtist: string | null
  trackNo: number | null
  discNo: number | null
  year: number | null
  genre: string | null
  durationSec: number | null
  codec: string | null
  bitrate: number | null      // kbps
  sampleRate: number | null
  bitDepth: number | null
  browserPlayable: boolean
  artUrl: string | null
}

function trackDto(row: typeof musicLocalTracks.$inferSelect): TrackDto {
  return {
    ref: localRef(row.id),
    source: 'local',
    title: row.title,
    artist: row.artist ?? row.albumArtist,
    album: row.album,
    albumArtist: row.albumArtist ?? row.artist,
    trackNo: row.trackNo,
    discNo: row.discNo,
    year: row.year,
    genre: row.genre,
    durationSec: row.durationSec,
    codec: row.codec,
    bitrate: row.bitrate ? Math.round(row.bitrate / 1000) : null,  // stored b/s → kbps
    sampleRate: row.sampleRate,
    bitDepth: row.bitDepth,
    browserPlayable: row.browserPlayable,
    artUrl: row.hasEmbeddedArt || row.folderArtPath ? `/api/music/collection/local/art/${row.id}` : null,
  }
}

function plexTrackDto(row: typeof musicPlexTracks.$inferSelect): TrackDto {
  return {
    ref: plexRef(row.machineId, row.ratingKey),
    source: 'plex',
    title: row.title,
    artist: row.artist,
    album: row.album,
    albumArtist: row.artist,
    trackNo: row.trackNo,
    discNo: row.discNo,
    year: row.year,
    genre: null,
    durationSec: row.durationSec,
    codec: row.codec ? row.codec.toUpperCase() : null,
    bitrate: row.bitrate,       // Plex already reports kbps
    sampleRate: null,
    bitDepth: null,
    browserPlayable: plexPlayable(row.codec),
    artUrl: plexArt(row),
  }
}

// ── Summary (gates the Collection tab) ────────────────────────────────────────────
musicCollection.get('/summary', async (c) => {
  const [localRow] = await db.select({
    tracks: sql<number>`COUNT(*)`,
    artists: sql<number>`COUNT(DISTINCT ${ARTIST})`,
    albums: sql<number>`COUNT(DISTINCT ${ALBUM_ARTIST} || '|' || COALESCE(${musicLocalTracks.album}, ''))`,
  }).from(musicLocalTracks)
  const [plexRow] = await db.select({
    tracks: sql<number>`COUNT(*)`,
    artists: sql<number>`COUNT(DISTINCT ${PLEX_ARTIST})`,
    albums: sql<number>`COUNT(DISTINCT ${PLEX_ARTIST} || '|' || COALESCE(${musicPlexTracks.album}, ''))`,
  }).from(musicPlexTracks)
  const local = { tracks: localRow?.tracks ?? 0, artists: localRow?.artists ?? 0, albums: localRow?.albums ?? 0 }
  const plex = { tracks: plexRow?.tracks ?? 0, artists: plexRow?.artists ?? 0, albums: plexRow?.albums ?? 0 }
  return c.json({ local, plex, total: local.tracks + plex.tracks })
})

// ── Artists (GROUP BY per source, merged by normalized name) ───────────────────────
musicCollection.get('/artists', async (c) => {
  const q = (c.req.query('q') ?? '').trim().toLowerCase()
  const letter = (c.req.query('letter') ?? '').trim().toUpperCase()
  const sourceFilter = parseSourceFilter(c)

  interface ArtistAgg { name: string; trackCount: number; albumCount: number; sources: Set<Source>; artUrl: string | null }
  const merged = new Map<string, ArtistAgg>()
  const fold = (name: string, trackCount: number, albumCount: number, source: Source, artUrl: string | null) => {
    const key = mergeKey(name)
    const cur = merged.get(key)
    if (cur) {
      cur.trackCount += trackCount
      cur.albumCount += albumCount   // approximate across sources; exact enough for a count chip
      cur.sources.add(source)
      cur.artUrl ??= artUrl
    } else {
      merged.set(key, { name, trackCount, albumCount, sources: new Set([source]), artUrl })
    }
  }

  if (sourceFilter !== 'plex') {
    const rows = await db.select({
      name: ARTIST,
      trackCount: sql<number>`COUNT(*)`,
      albumCount: sql<number>`COUNT(DISTINCT COALESCE(${musicLocalTracks.album}, ''))`,
      artTrackId: sql<string | null>`MAX(CASE WHEN ${musicLocalTracks.hasEmbeddedArt} = 1 OR ${musicLocalTracks.folderArtPath} IS NOT NULL THEN ${musicLocalTracks.id} END)`,
    }).from(musicLocalTracks).groupBy(ARTIST)
    for (const r of rows) fold(r.name, r.trackCount, r.albumCount, 'local', r.artTrackId ? `/api/music/collection/local/art/${r.artTrackId}` : null)
  }
  if (sourceFilter !== 'local') {
    const rows = await db.select({
      name: PLEX_ARTIST,
      trackCount: sql<number>`COUNT(*)`,
      albumCount: sql<number>`COUNT(DISTINCT COALESCE(${musicPlexTracks.album}, ''))`,
      thumb: sql<string | null>`MAX(COALESCE(${musicPlexTracks.grandparentThumb}, ${musicPlexTracks.parentThumb}))`,
    }).from(musicPlexTracks).groupBy(PLEX_ARTIST)
    for (const r of rows) fold(r.name, r.trackCount, r.albumCount, 'plex', r.thumb ? `/api/plex/img?path=${encodeURIComponent(r.thumb)}` : null)
  }

  const artists = [...merged.values()]
    .filter((a) => {
      if (q && !a.name.toLowerCase().includes(q)) return false
      if (letter === '#') return !/^[A-Za-z]/.test(a.name)
      if (letter) return a.name.toUpperCase().startsWith(letter)
      return true
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => ({
      name: a.name, trackCount: a.trackCount, albumCount: a.albumCount,
      source: (a.sources.size === 1 ? [...a.sources][0] : 'local') as Source,
      sources: [...a.sources],
      artUrl: a.artUrl,
    }))
  return c.json({ artists })
})

// ── Albums (GROUP BY per source, merged by normalized artist|album) ────────────────
musicCollection.get('/albums', async (c) => {
  const artist = (c.req.query('artist') ?? '').trim()
  const q = (c.req.query('q') ?? '').trim().toLowerCase()
  const sourceFilter = parseSourceFilter(c)

  interface AlbumAgg {
    album: string; albumArtist: string; year: number | null
    trackCount: number; durationSec: number; sources: Set<Source>; artUrl: string | null
  }
  const merged = new Map<string, AlbumAgg>()
  const fold = (a: Omit<AlbumAgg, 'sources'>, source: Source) => {
    const key = `${mergeKey(a.albumArtist)}|${mergeKey(a.album)}`
    const cur = merged.get(key)
    if (cur) {
      // Same album in both sources: keep the larger tracklist's count (they're the same
      // record, not additive) and fill gaps.
      cur.trackCount = Math.max(cur.trackCount, a.trackCount)
      cur.durationSec = Math.max(cur.durationSec, a.durationSec)
      cur.year ??= a.year
      cur.artUrl ??= a.artUrl
      cur.sources.add(source)
    } else {
      merged.set(key, { ...a, sources: new Set([source]) })
    }
  }

  if (sourceFilter !== 'plex') {
    const rows = await db.select({
      album: sql<string>`COALESCE(NULLIF(${musicLocalTracks.album}, ''), 'Unknown Album')`,
      albumArtist: ALBUM_ARTIST,
      year: sql<number | null>`MAX(${musicLocalTracks.year})`,
      trackCount: sql<number>`COUNT(*)`,
      durationSec: sql<number>`SUM(COALESCE(${musicLocalTracks.durationSec}, 0))`,
      artTrackId: sql<string | null>`MAX(CASE WHEN ${musicLocalTracks.hasEmbeddedArt} = 1 OR ${musicLocalTracks.folderArtPath} IS NOT NULL THEN ${musicLocalTracks.id} END)`,
    }).from(musicLocalTracks)
      .groupBy(ALBUM_ARTIST, sql`COALESCE(NULLIF(${musicLocalTracks.album}, ''), 'Unknown Album')`)
    for (const r of rows) {
      fold({
        album: r.album, albumArtist: r.albumArtist, year: r.year, trackCount: r.trackCount,
        durationSec: Math.round(r.durationSec),
        artUrl: r.artTrackId ? `/api/music/collection/local/art/${r.artTrackId}` : null,
      }, 'local')
    }
  }
  if (sourceFilter !== 'local') {
    const rows = await db.select({
      album: sql<string>`COALESCE(NULLIF(${musicPlexTracks.album}, ''), 'Unknown Album')`,
      albumArtist: PLEX_ARTIST,
      year: sql<number | null>`MAX(${musicPlexTracks.year})`,
      trackCount: sql<number>`COUNT(*)`,
      durationSec: sql<number>`SUM(COALESCE(${musicPlexTracks.durationSec}, 0))`,
      thumb: sql<string | null>`MAX(COALESCE(${musicPlexTracks.parentThumb}, ${musicPlexTracks.thumb}))`,
    }).from(musicPlexTracks)
      .groupBy(PLEX_ARTIST, sql`COALESCE(NULLIF(${musicPlexTracks.album}, ''), 'Unknown Album')`)
    for (const r of rows) {
      fold({
        album: r.album, albumArtist: r.albumArtist, year: r.year, trackCount: r.trackCount,
        durationSec: Math.round(r.durationSec),
        artUrl: r.thumb ? `/api/plex/img?path=${encodeURIComponent(r.thumb)}` : null,
      }, 'plex')
    }
  }

  const albums = [...merged.values()]
    .filter((a) => {
      if (artist && mergeKey(a.albumArtist) !== mergeKey(artist)) return false
      if (q && !a.album.toLowerCase().includes(q)) return false
      return true
    })
    .sort((a, b) => a.albumArtist.localeCompare(b.albumArtist) || a.album.localeCompare(b.album))
    .map((a) => ({
      album: a.album, albumArtist: a.albumArtist, year: a.year, trackCount: a.trackCount,
      durationSec: a.durationSec,
      source: (a.sources.size === 1 ? [...a.sources][0] : 'local') as Source,
      sources: [...a.sources],
      artUrl: a.artUrl,
    }))
  return c.json({ albums })
})

// ── One album's tracks (merged/deduped: local copy wins over plex) ──────────────────
musicCollection.get('/album', async (c) => {
  const artist = (c.req.query('artist') ?? '').trim()
  const album = (c.req.query('album') ?? '').trim()
  if (!album) return c.json({ error: 'album required' }, 400)

  const localRows = await db.select().from(musicLocalTracks)
    .where(album === 'Unknown Album'
      ? sql`COALESCE(NULLIF(${musicLocalTracks.album}, ''), 'Unknown Album') = 'Unknown Album' AND ${ALBUM_ARTIST} = ${artist}`
      : sql`${musicLocalTracks.album} = ${album} AND ${ALBUM_ARTIST} = ${artist}`)
  const plexRows = await db.select().from(musicPlexTracks)
    .where(album === 'Unknown Album'
      ? sql`COALESCE(NULLIF(${musicPlexTracks.album}, ''), 'Unknown Album') = 'Unknown Album' AND ${PLEX_ARTIST} = ${artist}`
      : sql`${musicPlexTracks.album} = ${album} AND ${PLEX_ARTIST} = ${artist}`)

  const tracks: TrackDto[] = localRows.map(trackDto)
  const seen = new Set(localRows.map((r) => `${r.discNo ?? 1}|${r.normTitle}`))
  for (const r of plexRows) {
    if (seen.has(`${r.discNo ?? 1}|${r.normTitle}`)) continue  // local copy of the same song wins
    tracks.push(plexTrackDto(r))
  }
  tracks.sort((a, b) => (a.discNo ?? 1) - (b.discNo ?? 1) || (a.trackNo ?? 0) - (b.trackNo ?? 0) || a.title.localeCompare(b.title))
  return c.json({ tracks })
})

// ── Songs (flat list / search, merged) ───────────────────────────────────────────────
musicCollection.get('/songs', async (c) => {
  const q = (c.req.query('q') ?? '').trim()
  const artist = (c.req.query('artist') ?? '').trim()
  const sourceFilter = parseSourceFilter(c)
  const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 200)))
  const offset = Math.max(0, Number(c.req.query('offset') ?? 0))
  const pat = `%${q}%`

  let songs: TrackDto[] = []
  if (sourceFilter !== 'plex') {
    const conds = []
    if (q) conds.push(or(like(musicLocalTracks.title, pat), like(musicLocalTracks.artist, pat), like(musicLocalTracks.album, pat))!)
    if (artist) conds.push(sql`${ARTIST} = ${artist}`)
    const rows = await db.select().from(musicLocalTracks)
      .where(conds.length ? sql.join(conds, sql` AND `) : undefined)
    songs.push(...rows.map(trackDto))
  }
  if (sourceFilter !== 'local') {
    const conds = []
    if (q) conds.push(or(like(musicPlexTracks.title, pat), like(musicPlexTracks.artist, pat), like(musicPlexTracks.album, pat))!)
    if (artist) conds.push(sql`${PLEX_ARTIST} = ${artist}`)
    const rows = await db.select().from(musicPlexTracks)
      .where(conds.length ? sql.join(conds, sql` AND `) : undefined)
    songs.push(...rows.map(plexTrackDto))
  }
  songs.sort((a, b) =>
    (a.artist ?? '').localeCompare(b.artist ?? '') || (a.album ?? '').localeCompare(b.album ?? '')
    || (a.discNo ?? 1) - (b.discNo ?? 1) || (a.trackNo ?? 0) - (b.trackNo ?? 0))
  songs = songs.slice(offset, offset + limit)
  return c.json({ songs })
})

// ── Grouped search (Browse "In your library" section) ─────────────────────────────
musicCollection.get('/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim()
  if (q.length < 2) return c.json({ artists: [], albums: [], songs: [] })
  const pat = `%${q}%`

  const [localSongs, plexSongs] = await Promise.all([
    db.select().from(musicLocalTracks)
      .where(or(like(musicLocalTracks.title, pat), like(musicLocalTracks.artist, pat)))
      .orderBy(asc(musicLocalTracks.title)).limit(12),
    db.select().from(musicPlexTracks)
      .where(or(like(musicPlexTracks.title, pat), like(musicPlexTracks.artist, pat)))
      .orderBy(asc(musicPlexTracks.title)).limit(12),
  ])
  const songSeen = new Set<string>()
  const songs: TrackDto[] = []
  for (const t of [...localSongs.map(trackDto), ...plexSongs.map(plexTrackDto)]) {
    const key = `${mergeKey(t.artist ?? '')}~${mergeKey(t.title)}`
    if (songSeen.has(key)) continue
    songSeen.add(key)
    songs.push(t)
    if (songs.length >= 12) break
  }

  const [localArtists, plexArtists] = await Promise.all([
    db.select({ name: ARTIST, trackCount: sql<number>`COUNT(*)` }).from(musicLocalTracks)
      .where(or(like(musicLocalTracks.artist, pat), like(musicLocalTracks.albumArtist, pat)))
      .groupBy(ARTIST).limit(6),
    db.select({ name: PLEX_ARTIST, trackCount: sql<number>`COUNT(*)` }).from(musicPlexTracks)
      .where(like(musicPlexTracks.artist, pat))
      .groupBy(PLEX_ARTIST).limit(6),
  ])
  const artistMap = new Map<string, { name: string; trackCount: number; source: Source }>()
  for (const r of localArtists) artistMap.set(mergeKey(r.name), { name: r.name, trackCount: r.trackCount, source: 'local' })
  for (const r of plexArtists) {
    const cur = artistMap.get(mergeKey(r.name))
    if (cur) cur.trackCount += r.trackCount
    else artistMap.set(mergeKey(r.name), { name: r.name, trackCount: r.trackCount, source: 'plex' })
  }

  const [localAlbums, plexAlbums] = await Promise.all([
    db.select({
      album: sql<string>`COALESCE(NULLIF(${musicLocalTracks.album}, ''), 'Unknown Album')`,
      albumArtist: ALBUM_ARTIST,
      trackCount: sql<number>`COUNT(*)`,
    }).from(musicLocalTracks).where(like(musicLocalTracks.album, pat))
      .groupBy(ALBUM_ARTIST, sql`COALESCE(NULLIF(${musicLocalTracks.album}, ''), 'Unknown Album')`).limit(6),
    db.select({
      album: sql<string>`COALESCE(NULLIF(${musicPlexTracks.album}, ''), 'Unknown Album')`,
      albumArtist: PLEX_ARTIST,
      trackCount: sql<number>`COUNT(*)`,
    }).from(musicPlexTracks).where(like(musicPlexTracks.album, pat))
      .groupBy(PLEX_ARTIST, sql`COALESCE(NULLIF(${musicPlexTracks.album}, ''), 'Unknown Album')`).limit(6),
  ])
  const albumMap = new Map<string, { album: string; albumArtist: string; trackCount: number; source: Source }>()
  for (const r of localAlbums) albumMap.set(`${mergeKey(r.albumArtist)}|${mergeKey(r.album)}`, { ...r, source: 'local' })
  for (const r of plexAlbums) {
    const key = `${mergeKey(r.albumArtist)}|${mergeKey(r.album)}`
    if (!albumMap.has(key)) albumMap.set(key, { ...r, source: 'plex' })
  }

  return c.json({
    artists: [...artistMap.values()].slice(0, 6),
    albums: [...albumMap.values()].slice(0, 6),
    songs,
  })
})

// ── Stream a local file (Range-aware; path comes from the DB row only) ────────────
musicCollection.get('/local/stream/:id', async (c) => {
  const [row] = await db.select({ path: musicLocalTracks.path }).from(musicLocalTracks)
    .where(eq(musicLocalTracks.id, c.req.param('id'))).limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)
  const mime = MIME_BY_EXT[extname(row.path).toLowerCase()] ?? 'application/octet-stream'
  return serveFileRange(c, row.path, mime)
})

// ── Album art: folder image, else embedded art extracted on demand + cached ───────
musicCollection.get('/local/art/:id', async (c) => {
  const id = c.req.param('id')
  const [row] = await db.select({
    path: musicLocalTracks.path, folderArtPath: musicLocalTracks.folderArtPath,
    hasEmbeddedArt: musicLocalTracks.hasEmbeddedArt,
  }).from(musicLocalTracks).where(eq(musicLocalTracks.id, id)).limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)

  const ART_CACHE = 'public, max-age=604800'  // album art is effectively immutable per track id
  if (row.folderArtPath) {
    const ext = extname(row.folderArtPath).toLowerCase()
    return serveFileRange(c, row.folderArtPath, ext === '.png' ? 'image/png' : 'image/jpeg', ART_CACHE)
  }
  if (!row.hasEmbeddedArt) return c.json({ error: 'No art' }, 404)

  // Extract-on-demand with a disk cache - never bulk-extracted at scan time.
  const cachePath = await resolveContentTypePath('music', 'local-art', `${id}.img`)
  try {
    await fs.access(cachePath)
    return serveFileRange(c, cachePath, 'image/jpeg', ART_CACHE)
  } catch { /* not cached yet */ }
  try {
    const meta = await parseFile(row.path)
    const pic = meta.common.picture?.[0]
    if (!pic) return c.json({ error: 'No art' }, 404)
    await fs.mkdir(join(cachePath, '..'), { recursive: true })
    await fs.writeFile(cachePath, pic.data)
    return new Response(new Uint8Array(pic.data), { headers: { 'Content-Type': pic.format || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' } })
  } catch (err) {
    logger.debug(`[music-collection] art extract failed for ${id}: ${String(err)}`)
    return c.json({ error: 'No art' }, 404)
  }
})

// ── Browser upload → managed uploads folder, indexed synchronously ────────────────
musicCollection.post('/upload', async (c) => {
  const form = await c.req.formData()
  const file = form.get('audio')
  if (!(file instanceof File)) return c.json({ error: 'audio required' }, 400)
  const ext = extname(file.name || '').toLowerCase()
  if (!UPLOAD_EXTENSIONS.has(ext)) return c.json({ error: `Unsupported file type ${ext || '(none)'}` }, 415)
  if (file.size === 0) return c.json({ error: 'Empty file' }, 400)
  if (file.size > UPLOAD_MAX_BYTES) return c.json({ error: 'File too large (250 MB max)' }, 413)

  const folder = await ensureUploadsFolder()
  // Sanitized, collision-safe filename inside the managed dir.
  const stem = basename(file.name, ext).replace(/[^\w\s.-]+/g, '').trim().slice(0, 120) || 'upload'
  let dest = join(folder.path, `${stem}${ext}`)
  for (let n = 1; ; n++) {
    try { await fs.access(dest) } catch { break }  // free name found
    dest = join(folder.path, `${stem}-${n}${ext}`)
  }
  await fs.writeFile(dest, new Uint8Array(await file.arrayBuffer()))

  try {
    const trackId = await indexUploadedFile(dest)
    const [row] = await db.select().from(musicLocalTracks).where(eq(musicLocalTracks.id, trackId)).limit(1)
    return c.json({ track: row ? trackDto(row) : null })
  } catch (err) {
    await fs.rm(dest, { force: true })  // don't leave unindexable bytes behind
    logger.warn(`[music-collection] upload index failed: ${String(err)}`)
    return c.json({ error: 'Could not read that audio file' }, 422)
  }
})

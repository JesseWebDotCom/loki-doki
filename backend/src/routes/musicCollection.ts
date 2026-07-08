// Unified music Collection API — the user's OWNED library (local folders + uploads now;
// Plex tracks merge in via the same routes in a later phase). The whole household shares
// one collection (a home media library, like Plex's), so routes are auth- but not
// owner-gated. Artists/albums are computed with GROUP BY over the indexed columns —
// deliberately no derived artist/album tables to keep the scanner sync-bug-free.

import { promises as fs } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { Hono } from 'hono'
import { asc, eq, like, or, sql } from 'drizzle-orm'
import { parseFile } from 'music-metadata'
import { db } from '@/db'
import { musicLocalTracks } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { serveFileRange } from '@/lib/http/rangeFile'
import { ensureUploadsFolder, indexUploadedFile } from '@/lib/music/localLibrary'
import { localRef } from '@/lib/music/trackRef'
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

// The album grouping key: albumArtist when tagged, else artist — without this, "Various
// Artists" compilations shatter into one album per contributing artist.
const ALBUM_ARTIST = sql<string>`COALESCE(NULLIF(${musicLocalTracks.albumArtist}, ''), ${musicLocalTracks.artist}, 'Unknown Artist')`
const ARTIST = sql<string>`COALESCE(NULLIF(${musicLocalTracks.artist}, ''), ${musicLocalTracks.albumArtist}, 'Unknown Artist')`

function trackDto(row: typeof musicLocalTracks.$inferSelect) {
  return {
    ref: localRef(row.id),
    source: 'local' as const,
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
    bitrate: row.bitrate ? Math.round(row.bitrate / 1000) : null,  // kbps for display
    sampleRate: row.sampleRate,
    bitDepth: row.bitDepth,
    browserPlayable: row.browserPlayable,
    artUrl: row.hasEmbeddedArt || row.folderArtPath ? `/api/music/collection/local/art/${row.id}` : null,
  }
}

// ── Summary (gates the Collection tab) ────────────────────────────────────────────
musicCollection.get('/summary', async (c) => {
  const [row] = await db.select({
    tracks: sql<number>`COUNT(*)`,
    artists: sql<number>`COUNT(DISTINCT ${ARTIST})`,
    albums: sql<number>`COUNT(DISTINCT ${ALBUM_ARTIST} || '|' || COALESCE(${musicLocalTracks.album}, ''))`,
  }).from(musicLocalTracks)
  const local = { tracks: row?.tracks ?? 0, artists: row?.artists ?? 0, albums: row?.albums ?? 0 }
  return c.json({ local, plex: { tracks: 0, artists: 0, albums: 0 }, total: local.tracks })
})

// ── Artists (GROUP BY) ────────────────────────────────────────────────────────────
musicCollection.get('/artists', async (c) => {
  const q = (c.req.query('q') ?? '').trim().toLowerCase()
  const letter = (c.req.query('letter') ?? '').trim().toUpperCase()
  const rows = await db.select({
    name: ARTIST,
    trackCount: sql<number>`COUNT(*)`,
    albumCount: sql<number>`COUNT(DISTINCT COALESCE(${musicLocalTracks.album}, ''))`,
    artTrackId: sql<string | null>`MAX(CASE WHEN ${musicLocalTracks.hasEmbeddedArt} = 1 OR ${musicLocalTracks.folderArtPath} IS NOT NULL THEN ${musicLocalTracks.id} END)`,
  }).from(musicLocalTracks)
    .groupBy(ARTIST)
    .orderBy(ARTIST)
  const filtered = rows.filter((r) => {
    if (q && !r.name.toLowerCase().includes(q)) return false
    if (letter === '#') return !/^[A-Za-z]/.test(r.name)
    if (letter) return r.name.toUpperCase().startsWith(letter)
    return true
  })
  return c.json({
    artists: filtered.map((r) => ({
      name: r.name, trackCount: r.trackCount, albumCount: r.albumCount, source: 'local' as const,
      artUrl: r.artTrackId ? `/api/music/collection/local/art/${r.artTrackId}` : null,
    })),
  })
})

// ── Albums (GROUP BY) ─────────────────────────────────────────────────────────────
musicCollection.get('/albums', async (c) => {
  const artist = (c.req.query('artist') ?? '').trim()
  const q = (c.req.query('q') ?? '').trim().toLowerCase()
  const rows = await db.select({
    album: sql<string>`COALESCE(NULLIF(${musicLocalTracks.album}, ''), 'Unknown Album')`,
    albumArtist: ALBUM_ARTIST,
    year: sql<number | null>`MAX(${musicLocalTracks.year})`,
    trackCount: sql<number>`COUNT(*)`,
    durationSec: sql<number>`SUM(COALESCE(${musicLocalTracks.durationSec}, 0))`,
    artTrackId: sql<string | null>`MAX(CASE WHEN ${musicLocalTracks.hasEmbeddedArt} = 1 OR ${musicLocalTracks.folderArtPath} IS NOT NULL THEN ${musicLocalTracks.id} END)`,
  }).from(musicLocalTracks)
    .groupBy(ALBUM_ARTIST, sql`COALESCE(NULLIF(${musicLocalTracks.album}, ''), 'Unknown Album')`)
    .orderBy(ALBUM_ARTIST)
  const filtered = rows.filter((r) => {
    // An artist page should show albums they lead AND albums they appear on — but grouping is
    // by album artist, so match either. Cheap at library scale.
    if (artist && r.albumArtist !== artist) return false
    if (q && !r.album.toLowerCase().includes(q)) return false
    return true
  })
  return c.json({
    albums: filtered.map((r) => ({
      album: r.album, albumArtist: r.albumArtist, year: r.year, trackCount: r.trackCount,
      durationSec: Math.round(r.durationSec), source: 'local' as const,
      artUrl: r.artTrackId ? `/api/music/collection/local/art/${r.artTrackId}` : null,
    })),
  })
})

// ── One album's tracks ────────────────────────────────────────────────────────────
musicCollection.get('/album', async (c) => {
  const artist = (c.req.query('artist') ?? '').trim()
  const album = (c.req.query('album') ?? '').trim()
  if (!album) return c.json({ error: 'album required' }, 400)
  const rows = await db.select().from(musicLocalTracks)
    .where(album === 'Unknown Album'
      ? sql`COALESCE(NULLIF(${musicLocalTracks.album}, ''), 'Unknown Album') = 'Unknown Album' AND ${ALBUM_ARTIST} = ${artist}`
      : sql`${musicLocalTracks.album} = ${album} AND ${ALBUM_ARTIST} = ${artist}`)
    .orderBy(asc(musicLocalTracks.discNo), asc(musicLocalTracks.trackNo), asc(musicLocalTracks.title))
  return c.json({ tracks: rows.map(trackDto) })
})

// ── Songs (flat list / search) ────────────────────────────────────────────────────
musicCollection.get('/songs', async (c) => {
  const q = (c.req.query('q') ?? '').trim()
  const artist = (c.req.query('artist') ?? '').trim()
  const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 200)))
  const offset = Math.max(0, Number(c.req.query('offset') ?? 0))
  const conds = []
  if (q) {
    const pat = `%${q}%`
    conds.push(or(
      like(musicLocalTracks.title, pat),
      like(musicLocalTracks.artist, pat),
      like(musicLocalTracks.album, pat),
    )!)
  }
  if (artist) conds.push(sql`${ARTIST} = ${artist}`)
  const rows = await db.select().from(musicLocalTracks)
    .where(conds.length ? sql.join(conds, sql` AND `) : undefined)
    .orderBy(asc(musicLocalTracks.artist), asc(musicLocalTracks.album), asc(musicLocalTracks.discNo), asc(musicLocalTracks.trackNo))
    .limit(limit).offset(offset)
  return c.json({ songs: rows.map(trackDto) })
})

// ── Grouped search (Browse "In your library" section) ─────────────────────────────
musicCollection.get('/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim()
  if (q.length < 2) return c.json({ artists: [], albums: [], songs: [] })
  const pat = `%${q}%`
  const songRows = await db.select().from(musicLocalTracks)
    .where(or(like(musicLocalTracks.title, pat), like(musicLocalTracks.artist, pat)))
    .orderBy(asc(musicLocalTracks.title)).limit(12)
  const artistRows = await db.select({ name: ARTIST, trackCount: sql<number>`COUNT(*)` })
    .from(musicLocalTracks)
    .where(or(like(musicLocalTracks.artist, pat), like(musicLocalTracks.albumArtist, pat)))
    .groupBy(ARTIST).orderBy(ARTIST).limit(6)
  const albumRows = await db.select({
    album: sql<string>`COALESCE(NULLIF(${musicLocalTracks.album}, ''), 'Unknown Album')`,
    albumArtist: ALBUM_ARTIST,
    trackCount: sql<number>`COUNT(*)`,
  }).from(musicLocalTracks)
    .where(like(musicLocalTracks.album, pat))
    .groupBy(ALBUM_ARTIST, sql`COALESCE(NULLIF(${musicLocalTracks.album}, ''), 'Unknown Album')`)
    .limit(6)
  return c.json({
    artists: artistRows.map((r) => ({ name: r.name, trackCount: r.trackCount, source: 'local' as const })),
    albums: albumRows.map((r) => ({ album: r.album, albumArtist: r.albumArtist, trackCount: r.trackCount, source: 'local' as const })),
    songs: songRows.map(trackDto),
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

  if (row.folderArtPath) {
    const ext = extname(row.folderArtPath).toLowerCase()
    return serveFileRange(c, row.folderArtPath, ext === '.png' ? 'image/png' : 'image/jpeg')
  }
  if (!row.hasEmbeddedArt) return c.json({ error: 'No art' }, 404)

  // Extract-on-demand with a disk cache — never bulk-extracted at scan time.
  const cachePath = await resolveContentTypePath('music', 'local-art', `${id}.img`)
  try {
    await fs.access(cachePath)
    return serveFileRange(c, cachePath, 'image/jpeg')
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

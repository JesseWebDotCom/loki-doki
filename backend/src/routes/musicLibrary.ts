// Music library API — favorites (songs / artists / albums / stations / playlists) and listening history
// ("Continue listening" + recently played). All per-user.

import { Hono } from 'hono'
import { eq, and, desc, inArray } from 'drizzle-orm'
import { unlink } from 'node:fs/promises'
import { db } from '@/db'
import { musicFavorites, musicHistory, ytDownloads, musicOfflineStationTracks } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { enqueueVideoSave, enqueuePrefetch } from '@/lib/youtube/automation'
import { enqueueListen } from '@/lib/music/scrobble'
import { releaseAssetsIfOrphaned, AUDIO_FORMATS, type AudioFormat } from '@/lib/youtube/assets'
import { resolveUserPath } from '@/lib/storage/paths'
import { looksLikeVideo } from '@/lib/music/junk'
import type { AppEnv } from '@/types'

export const musicLibrary = new Hono<AppEnv>()
musicLibrary.use('*', requireAuth)

type FavKind = 'song' | 'station' | 'playlist' | 'artist' | 'album'
const FAV_KINDS: readonly FavKind[] = ['song', 'station', 'playlist', 'artist', 'album']

// ── Favorites ─────────────────────────────────────────────────────────────────────
musicLibrary.get('/favorites', async (c) => {
  const user = c.get('user')
  const kind = c.req.query('kind') as FavKind | undefined
  const rows = await db.select().from(musicFavorites)
    .where(kind ? and(eq(musicFavorites.userId, user.id), eq(musicFavorites.kind, kind)) : eq(musicFavorites.userId, user.id))
    .orderBy(desc(musicFavorites.addedAt))
  return c.json({ favorites: rows })
})

musicLibrary.put('/favorites', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ kind?: FavKind; refId?: string; title?: string; artist?: string; mbid?: string }>().catch(() => ({} as { kind?: FavKind; refId?: string; title?: string; artist?: string; mbid?: string }))
  if (!body.kind || !FAV_KINDS.includes(body.kind) || !body.refId) return c.json({ error: 'kind and refId required' }, 400)
  await db.insert(musicFavorites).values({
    id: crypto.randomUUID(), userId: user.id, kind: body.kind, refId: body.refId,
    title: body.title || null, artist: body.artist || null, mbid: body.mbid || null, addedAt: new Date(),
  }).onConflictDoNothing()
  return c.json({ ok: true })
})

musicLibrary.delete('/favorites/:kind/:refId', async (c) => {
  const user = c.get('user')
  await db.delete(musicFavorites).where(and(
    eq(musicFavorites.userId, user.id),
    eq(musicFavorites.kind, c.req.param('kind') as FavKind),
    eq(musicFavorites.refId, c.req.param('refId')),
  ))
  return c.json({ ok: true })
})

// ── History ─────────────────────────────────────────────────────────────────────
musicLibrary.post('/history', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ videoId?: string; title?: string; artist?: string; mbid?: string; stationId?: string; positionSec?: number; durationSec?: number }>().catch(() => ({} as Record<string, never>))
  if (!body.videoId || !body.title) return c.json({ error: 'videoId and title required' }, 400)
  const id = crypto.randomUUID()
  await db.insert(musicHistory).values({
    id, userId: user.id, videoId: body.videoId, title: body.title,
    artist: body.artist || null, mbid: body.mbid || null, stationId: body.stationId || null,
    positionSec: body.positionSec ?? 0,
    durationSec: typeof body.durationSec === 'number' && body.durationSec > 0 ? body.durationSec : null,
    playedAt: new Date(),
  })
  // Scrobbling out: a local queue insert only (no-op unless the user enabled it); the
  // background flusher does the network. Never blocks or fails the history write.
  void enqueueListen(user.id, {
    artist: body.artist ?? '',
    title: body.title,
    durationSec: typeof body.durationSec === 'number' && body.durationSec > 0 ? body.durationSec : null,
    listenedAt: Math.floor(Date.now() / 1000),
  })
  return c.json({ ok: true, id })
})

// Progress beacon: how far the listener actually got (fired on track change / skip /
// unload via sendBeacon). Powers real listening-minutes in stats and Replay.
musicLibrary.post('/history/progress', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ id?: string; positionSec?: number; durationSec?: number }>().catch(() => ({} as Record<string, never>))
  if (!body.id || typeof body.positionSec !== 'number') return c.json({ error: 'id and positionSec required' }, 400)
  await db.update(musicHistory)
    .set({
      positionSec: Math.max(0, body.positionSec),
      ...(typeof body.durationSec === 'number' && body.durationSec > 0 ? { durationSec: body.durationSec } : {}),
    })
    .where(and(eq(musicHistory.id, body.id), eq(musicHistory.userId, user.id)))
  return c.json({ ok: true })
})

// ── Offline (audio saved for offline play) ──────────────────────────────────────────
// Reuses the YouTube offline-save pipeline (download_jobs → ytDownloads) with kind 'audio'.
// A "song" offline = the resolved YouTube videoId saved as audio.
musicLibrary.post('/offline', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ videoId?: string; title?: string; audioFormat?: string }>().catch(() => ({} as { videoId?: string; title?: string; audioFormat?: string }))
  if (!body.videoId || !body.title) return c.json({ error: 'videoId and title required' }, 400)
  // Quality choice from the client (Original M4A / MP3 320 / MP3 192 / Opus 128) - each
  // quality is a distinct shared asset, validated by assetFormat.
  const audioFormat = (AUDIO_FORMATS as readonly string[]).includes(body.audioFormat ?? '') ? body.audioFormat as AudioFormat : 'm4a'
  const r = await enqueueVideoSave({
    userId: user.id, videoId: body.videoId, title: body.title, kind: 'audio',
    maxHeight: null, firstName: user.firstName, audioFormat, origin: 'music',
  })
  return c.json(r)
})

// List the user's offline audio (newest first). `stationVideoIds` are the videoIds that belong to
// a saved offline station, so the UI can separate à-la-carte song downloads from station songs.
musicLibrary.get('/offline', async (c) => {
  const user = c.get('user')
  const rows = await db.select({
    videoId: ytDownloads.videoId, title: ytDownloads.title, status: ytDownloads.status, sizeBytes: ytDownloads.sizeBytes,
  }).from(ytDownloads)
    .where(and(eq(ytDownloads.userId, user.id), eq(ytDownloads.kind, 'audio'), eq(ytDownloads.prefetch, false)))
    .orderBy(desc(ytDownloads.createdAt))
  const stationTracks = await db.select({ videoId: musicOfflineStationTracks.videoId })
    .from(musicOfflineStationTracks).where(eq(musicOfflineStationTracks.userId, user.id))
  const stationVideoIds = [...new Set(stationTracks.map(t => t.videoId))]
  return c.json({ offline: rows, fileBase: '/api/youtube/file', stationVideoIds })
})

// Remove an offline audio save (row + file).
musicLibrary.delete('/offline/:videoId', async (c) => {
  const user = c.get('user')
  const videoId = c.req.param('videoId')
  const [row] = await db.select().from(ytDownloads)
    .where(and(eq(ytDownloads.userId, user.id), eq(ytDownloads.videoId, videoId), eq(ytDownloads.kind, 'audio')))
  // The audio is a SHARED blob — only unlink a legacy unmigrated per-user file. Otherwise drop
  // the reference and let GC reclaim the blob once no one references its asset.
  if (row && !row.assetId && row.relPath) { try { await unlink(await resolveUserPath(row.relPath)) } catch { /* already gone */ } }
  await db.delete(ytDownloads).where(and(eq(ytDownloads.userId, user.id), eq(ytDownloads.videoId, videoId), eq(ytDownloads.kind, 'audio')))
  await releaseAssetsIfOrphaned([row?.assetId])
  return c.json({ ok: true })
})

// ── Prefetch cache (transient download-ahead for gapless playback) ───────────────────
// POST /library/prefetch — download-ahead a track. Fire-and-forget; bounded + self-evicting.
musicLibrary.post('/prefetch', async (c) => {
  const user = c.get('user')
  const b = await c.req.json<{ videoId?: string; title?: string; kind?: 'audio' | 'video'; maxHeight?: number }>().catch(() => ({} as { videoId?: string; title?: string; kind?: 'audio' | 'video'; maxHeight?: number }))
  if (!b.videoId) return c.json({ error: 'videoId required' }, 400)
  const kind = b.kind === 'video' ? 'video' : 'audio'
  void enqueuePrefetch({ userId: user.id, videoId: b.videoId, title: b.title || '', kind, maxHeight: kind === 'video' ? (b.maxHeight ?? 480) : null }).catch(() => {})
  return c.json({ ok: true })
})

// GET /library/prefetch?ids=a,b,c&kind=audio — which ids are locally ready (prefetch OR a real
// save — either way the file is on disk), so the player can choose local bytes over streaming.
musicLibrary.get('/prefetch', async (c) => {
  const user = c.get('user')
  const ids = (c.req.query('ids') ?? '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 50)
  const kind = c.req.query('kind') === 'video' ? 'video' : 'audio'
  if (!ids.length) return c.json({ ready: [] })
  const rows = await db.select({ videoId: ytDownloads.videoId }).from(ytDownloads)
    .where(and(eq(ytDownloads.userId, user.id), eq(ytDownloads.kind, kind), eq(ytDownloads.status, 'ready'), inArray(ytDownloads.videoId, ids)))
  return c.json({ ready: [...new Set(rows.map(r => r.videoId))] })
})

// Recent plays, deduped to the latest occurrence of each song.
musicLibrary.get('/history', async (c) => {
  const user = c.get('user')
  const limit = Math.min(parseInt(c.req.query('limit') ?? '40', 10), 100)
  const rows = await db.select().from(musicHistory)
    .where(eq(musicHistory.userId, user.id))
    .orderBy(desc(musicHistory.playedAt))
    .limit(400)
  const seen = new Set<string>()
  const recent: typeof rows = []
  for (const r of rows) {
    if (seen.has(r.videoId)) continue
    seen.add(r.videoId)
    // Keep ordinary YouTube videos out of "Continue listening" — trailers/reviews/etc. leak in when
    // a companion "play music" request is mis-parsed into a station seeded from free text.
    if (looksLikeVideo(r.title, r.artist ?? '')) continue
    recent.push(r)
    if (recent.length >= limit) break
  }
  return c.json({ history: recent })
})

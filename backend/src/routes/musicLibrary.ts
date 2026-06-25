// Music library API — favorites (songs / stations / playlists) and listening history
// ("Continue listening" + recently played). All per-user.

import { Hono } from 'hono'
import { eq, and, desc } from 'drizzle-orm'
import { unlink } from 'node:fs/promises'
import { db } from '@/db'
import { musicFavorites, musicHistory, ytDownloads } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { enqueueVideoSave } from '@/lib/youtube/automation'
import { resolveUserPath } from '@/lib/storage/paths'
import type { AppEnv } from '@/types'

export const musicLibrary = new Hono<AppEnv>()
musicLibrary.use('*', requireAuth)

type FavKind = 'song' | 'station' | 'playlist'

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
  if (!body.kind || !body.refId) return c.json({ error: 'kind and refId required' }, 400)
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
  const body = await c.req.json<{ videoId?: string; title?: string; artist?: string; mbid?: string; stationId?: string; positionSec?: number }>().catch(() => ({} as { videoId?: string; title?: string; artist?: string; mbid?: string; stationId?: string; positionSec?: number }))
  if (!body.videoId || !body.title) return c.json({ error: 'videoId and title required' }, 400)
  await db.insert(musicHistory).values({
    id: crypto.randomUUID(), userId: user.id, videoId: body.videoId, title: body.title,
    artist: body.artist || null, mbid: body.mbid || null, stationId: body.stationId || null,
    positionSec: body.positionSec ?? 0, playedAt: new Date(),
  })
  return c.json({ ok: true })
})

// ── Offline (audio saved for offline play) ──────────────────────────────────────────
// Reuses the YouTube offline-save pipeline (download_jobs → ytDownloads) with kind 'audio'.
// A "song" offline = the resolved YouTube videoId saved as audio.
musicLibrary.post('/offline', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ videoId?: string; title?: string }>().catch(() => ({} as { videoId?: string; title?: string }))
  if (!body.videoId || !body.title) return c.json({ error: 'videoId and title required' }, 400)
  const r = await enqueueVideoSave({
    userId: user.id, videoId: body.videoId, title: body.title, kind: 'audio',
    maxHeight: null, firstName: user.firstName, audioFormat: 'm4a',
  })
  return c.json(r)
})

// List the user's offline audio (newest first).
musicLibrary.get('/offline', async (c) => {
  const user = c.get('user')
  const rows = await db.select({
    videoId: ytDownloads.videoId, title: ytDownloads.title, status: ytDownloads.status, sizeBytes: ytDownloads.sizeBytes,
  }).from(ytDownloads)
    .where(and(eq(ytDownloads.userId, user.id), eq(ytDownloads.kind, 'audio')))
    .orderBy(desc(ytDownloads.createdAt))
  return c.json({ offline: rows, fileBase: '/api/youtube/file' })
})

// Remove an offline audio save (row + file).
musicLibrary.delete('/offline/:videoId', async (c) => {
  const user = c.get('user')
  const videoId = c.req.param('videoId')
  const [row] = await db.select().from(ytDownloads)
    .where(and(eq(ytDownloads.userId, user.id), eq(ytDownloads.videoId, videoId), eq(ytDownloads.kind, 'audio')))
  if (row?.relPath) { try { await unlink(await resolveUserPath(row.relPath)) } catch { /* already gone */ } }
  await db.delete(ytDownloads).where(and(eq(ytDownloads.userId, user.id), eq(ytDownloads.videoId, videoId), eq(ytDownloads.kind, 'audio')))
  return c.json({ ok: true })
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
    recent.push(r)
    if (recent.length >= limit) break
  }
  return c.json({ history: recent })
})

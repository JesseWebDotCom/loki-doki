// Music playlists API — explicit, user-curated track lists (distinct from generative stations).
// Owner-only edits; family sharing (private ↔ shared); clone-a-shared-playlist.

import { Hono } from 'hono'
import { eq, and, or, desc, asc, max } from 'drizzle-orm'
import { db } from '@/db'
import { musicPlaylists, musicPlaylistTracks, users } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import type { AppEnv } from '@/types'

export const musicPlaylists_route = new Hono<AppEnv>()
musicPlaylists_route.use('*', requireAuth)
export { musicPlaylists_route as musicPlaylists }

type PlaylistRow = typeof musicPlaylists.$inferSelect

function serialize(row: PlaylistRow, currentUserId: string, ownerName?: string | null, trackCount?: number) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    owned: row.userId === currentUserId,
    ownerName: row.userId === currentUserId ? null : (ownerName ?? null),
    trackCount: trackCount ?? 0,
    coverUrl: row.coverPath ? `/api/music/playlists/${row.id}/cover` : null,
  }
}

// ── List own + shared playlists ───────────────────────────────────────────────────
musicPlaylists_route.get('/', async (c) => {
  const user = c.get('user')
  const rows = await db
    .select({ p: musicPlaylists, ownerName: users.firstName })
    .from(musicPlaylists)
    .leftJoin(users, eq(musicPlaylists.userId, users.id))
    .where(or(eq(musicPlaylists.userId, user.id), eq(musicPlaylists.visibility, 'shared')))
    .orderBy(desc(musicPlaylists.updatedAt))

  // Track counts per playlist (one grouped query).
  const counts = new Map<string, number>()
  const countRows = await db
    .select({ playlistId: musicPlaylistTracks.playlistId })
    .from(musicPlaylistTracks)
  for (const r of countRows) counts.set(r.playlistId, (counts.get(r.playlistId) ?? 0) + 1)

  const all = rows.map(r => serialize(r.p, user.id, r.ownerName, counts.get(r.p.id) ?? 0))
  return c.json({ mine: all.filter(p => p.owned), shared: all.filter(p => !p.owned) })
})

// ── Create ──────────────────────────────────────────────────────────────────────
musicPlaylists_route.post('/', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ name?: string; description?: string; visibility?: PlaylistRow['visibility'] }>().catch(() => ({} as { name?: string; description?: string; visibility?: PlaylistRow['visibility'] }))
  const name = body.name?.trim()
  if (!name) return c.json({ error: 'name required' }, 400)
  const id = crypto.randomUUID()
  const now = new Date()
  await db.insert(musicPlaylists).values({
    id, userId: user.id, name, description: body.description?.trim() || null,
    visibility: body.visibility === 'shared' ? 'shared' : 'private', createdAt: now, updatedAt: now,
  })
  const [row] = await db.select().from(musicPlaylists).where(eq(musicPlaylists.id, id))
  return c.json({ playlist: serialize(row!, user.id, null, 0) })
})

// ── Get one + tracks ──────────────────────────────────────────────────────────────
musicPlaylists_route.get('/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [row] = await db
    .select({ p: musicPlaylists, ownerName: users.firstName })
    .from(musicPlaylists)
    .leftJoin(users, eq(musicPlaylists.userId, users.id))
    .where(eq(musicPlaylists.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.p.userId !== user.id && row.p.visibility !== 'shared') return c.json({ error: 'not available' }, 403)
  const tracks = await db.select().from(musicPlaylistTracks)
    .where(eq(musicPlaylistTracks.playlistId, id))
    .orderBy(asc(musicPlaylistTracks.position))
  return c.json({ playlist: serialize(row.p, user.id, row.ownerName, tracks.length), tracks })
})

// ── Update (owner) ────────────────────────────────────────────────────────────────
musicPlaylists_route.patch('/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [row] = await db.select().from(musicPlaylists).where(eq(musicPlaylists.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.userId !== user.id) return c.json({ error: 'not your playlist' }, 403)
  const body = await c.req.json<{ name?: string; description?: string; visibility?: PlaylistRow['visibility'] }>().catch(() => ({} as { name?: string; description?: string; visibility?: PlaylistRow['visibility'] }))
  await db.update(musicPlaylists).set({
    name: body.name?.trim() || row.name,
    description: body.description !== undefined ? (body.description?.trim() || null) : row.description,
    visibility: body.visibility ?? row.visibility,
    updatedAt: new Date(),
  }).where(eq(musicPlaylists.id, id))
  const [updated] = await db.select().from(musicPlaylists).where(eq(musicPlaylists.id, id))
  return c.json({ playlist: serialize(updated!, user.id) })
})

// ── Delete (owner) ────────────────────────────────────────────────────────────────
musicPlaylists_route.delete('/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [row] = await db.select().from(musicPlaylists).where(eq(musicPlaylists.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.userId !== user.id) return c.json({ error: 'not your playlist' }, 403)
  await db.delete(musicPlaylists).where(eq(musicPlaylists.id, id))
  return c.json({ ok: true })
})

// ── Add a track (owner) ──────────────────────────────────────────────────────────
musicPlaylists_route.post('/:id/tracks', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [row] = await db.select().from(musicPlaylists).where(eq(musicPlaylists.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.userId !== user.id) return c.json({ error: 'not your playlist' }, 403)
  const body = await c.req.json<{ videoId?: string; title?: string; artist?: string; mbid?: string; durationSec?: number }>().catch(() => ({} as { videoId?: string; title?: string; artist?: string; mbid?: string; durationSec?: number }))
  if (!body.videoId || !body.title) return c.json({ error: 'videoId and title required' }, 400)
  const [{ maxPos } = { maxPos: null }] = await db
    .select({ maxPos: max(musicPlaylistTracks.position) })
    .from(musicPlaylistTracks).where(eq(musicPlaylistTracks.playlistId, id))
  await db.insert(musicPlaylistTracks).values({
    id: crypto.randomUUID(), playlistId: id, videoId: body.videoId, title: body.title,
    artist: body.artist?.trim() || null, mbid: body.mbid || null, durationSec: body.durationSec ?? null,
    position: (maxPos ?? -1) + 1, addedAt: new Date(),
  })
  await db.update(musicPlaylists).set({ updatedAt: new Date() }).where(eq(musicPlaylists.id, id))
  return c.json({ ok: true })
})

// ── Remove a track (owner) ────────────────────────────────────────────────────────
musicPlaylists_route.delete('/:id/tracks/:trackId', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [row] = await db.select().from(musicPlaylists).where(eq(musicPlaylists.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.userId !== user.id) return c.json({ error: 'not your playlist' }, 403)
  await db.delete(musicPlaylistTracks)
    .where(and(eq(musicPlaylistTracks.id, c.req.param('trackId')), eq(musicPlaylistTracks.playlistId, id)))
  return c.json({ ok: true })
})

// ── Reorder tracks (owner) ────────────────────────────────────────────────────────
musicPlaylists_route.put('/:id/tracks/order', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [row] = await db.select().from(musicPlaylists).where(eq(musicPlaylists.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.userId !== user.id) return c.json({ error: 'not your playlist' }, 403)
  const body = await c.req.json<{ trackIds?: string[] }>().catch(() => ({} as { trackIds?: string[] }))
  const order = body.trackIds ?? []
  for (let i = 0; i < order.length; i++) {
    await db.update(musicPlaylistTracks).set({ position: i })
      .where(and(eq(musicPlaylistTracks.id, order[i]!), eq(musicPlaylistTracks.playlistId, id)))
  }
  await db.update(musicPlaylists).set({ updatedAt: new Date() }).where(eq(musicPlaylists.id, id))
  return c.json({ ok: true })
})

// ── Share toggle (owner) ──────────────────────────────────────────────────────────
musicPlaylists_route.post('/:id/share', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json<{ shared?: boolean }>().catch(() => ({} as { shared?: boolean }))
  const [row] = await db.select().from(musicPlaylists).where(eq(musicPlaylists.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.userId !== user.id) return c.json({ error: 'not your playlist' }, 403)
  const visibility = body.shared === false ? 'private' : 'shared'
  await db.update(musicPlaylists).set({ visibility, updatedAt: new Date() }).where(eq(musicPlaylists.id, id))
  return c.json({ visibility })
})

// ── Clone a shared playlist into your own ─────────────────────────────────────────
musicPlaylists_route.post('/:id/clone', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [row] = await db.select().from(musicPlaylists).where(eq(musicPlaylists.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.userId !== user.id && row.visibility !== 'shared') return c.json({ error: 'not available' }, 403)
  const srcTracks = await db.select().from(musicPlaylistTracks)
    .where(eq(musicPlaylistTracks.playlistId, id)).orderBy(asc(musicPlaylistTracks.position))
  const newId = crypto.randomUUID()
  const now = new Date()
  await db.insert(musicPlaylists).values({
    id: newId, userId: user.id, name: `${row.name} (copy)`, description: row.description,
    visibility: 'private', createdAt: now, updatedAt: now,
  })
  for (const t of srcTracks) {
    await db.insert(musicPlaylistTracks).values({
      id: crypto.randomUUID(), playlistId: newId, videoId: t.videoId, title: t.title,
      artist: t.artist, mbid: t.mbid, durationSec: t.durationSec, position: t.position, addedAt: now,
    })
  }
  const [created] = await db.select().from(musicPlaylists).where(eq(musicPlaylists.id, newId))
  return c.json({ playlist: serialize(created!, user.id, null, srcTracks.length) })
})

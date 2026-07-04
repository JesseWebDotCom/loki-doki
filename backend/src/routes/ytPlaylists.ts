// YouTube playlists API — explicit, user-curated video lists (distinct from the fixed
// Watch Later/Liked buckets in yt_collections, and from viewing someone else's real YouTube playlist).
// Owner-only edits; family sharing (private ↔ shared); clone-a-shared-playlist.

import { Hono } from 'hono'
import { eq, and, or, desc, asc, max } from 'drizzle-orm'
import { db } from '@/db'
import { ytPlaylists, ytPlaylistVideos, users } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { startPlaylistDownloadBatch, getPlaylistDownloadBatchStatus } from '@/lib/youtube/playlistDownload'
import type { AppEnv } from '@/types'

export const ytPlaylists_route = new Hono<AppEnv>()
ytPlaylists_route.use('*', requireAuth)
export { ytPlaylists_route as ytPlaylists }

type PlaylistRow = typeof ytPlaylists.$inferSelect

function serialize(row: PlaylistRow, currentUserId: string, ownerName?: string | null, videoCount?: number, coverVideoIds?: string[]) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    owned: row.userId === currentUserId,
    ownerName: row.userId === currentUserId ? null : (ownerName ?? null),
    videoCount: videoCount ?? 0,
    // Leading videoIds (by position) so the client can render a real thumbnail cover /
    // collage instead of a placeholder icon — matches YouTube's playlist-card look.
    coverVideoIds: coverVideoIds ?? [],
  }
}

// ── List own + shared playlists ───────────────────────────────────────────────────
ytPlaylists_route.get('/', async (c) => {
  const user = c.get('user')
  const rows = await db
    .select({ p: ytPlaylists, ownerName: users.firstName })
    .from(ytPlaylists)
    .leftJoin(users, eq(ytPlaylists.userId, users.id))
    .where(or(eq(ytPlaylists.userId, user.id), eq(ytPlaylists.visibility, 'shared')))
    .orderBy(desc(ytPlaylists.updatedAt))

  // Video counts + cover thumbnails per playlist (one ordered scan). Rows come back in
  // position order, so the first ≤4 videoIds we see per playlist are its leading videos.
  const counts = new Map<string, number>()
  const covers = new Map<string, string[]>()
  const vidRows = await db
    .select({ playlistId: ytPlaylistVideos.playlistId, videoId: ytPlaylistVideos.videoId })
    .from(ytPlaylistVideos)
    .orderBy(asc(ytPlaylistVideos.position))
  for (const r of vidRows) {
    counts.set(r.playlistId, (counts.get(r.playlistId) ?? 0) + 1)
    const cov = covers.get(r.playlistId) ?? covers.set(r.playlistId, []).get(r.playlistId)!
    if (cov.length < 4) cov.push(r.videoId)
  }

  const all = rows.map(r => serialize(r.p, user.id, r.ownerName, counts.get(r.p.id) ?? 0, covers.get(r.p.id) ?? []))
  return c.json({ mine: all.filter(p => p.owned), shared: all.filter(p => !p.owned) })
})

// ── Create ──────────────────────────────────────────────────────────────────────
ytPlaylists_route.post('/', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ name?: string; description?: string; visibility?: PlaylistRow['visibility'] }>().catch(() => ({} as { name?: string; description?: string; visibility?: PlaylistRow['visibility'] }))
  const name = body.name?.trim()
  if (!name) return c.json({ error: 'name required' }, 400)
  const id = crypto.randomUUID()
  const now = new Date()
  await db.insert(ytPlaylists).values({
    id, userId: user.id, name, description: body.description?.trim() || null,
    visibility: body.visibility === 'shared' ? 'shared' : 'private', createdAt: now, updatedAt: now,
  })
  const [row] = await db.select().from(ytPlaylists).where(eq(ytPlaylists.id, id))
  return c.json({ playlist: serialize(row!, user.id, null, 0) })
})

// ── Get one + videos ──────────────────────────────────────────────────────────────
ytPlaylists_route.get('/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [row] = await db
    .select({ p: ytPlaylists, ownerName: users.firstName })
    .from(ytPlaylists)
    .leftJoin(users, eq(ytPlaylists.userId, users.id))
    .where(eq(ytPlaylists.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.p.userId !== user.id && row.p.visibility !== 'shared') return c.json({ error: 'not available' }, 403)
  const videos = await db.select().from(ytPlaylistVideos)
    .where(eq(ytPlaylistVideos.playlistId, id))
    .orderBy(asc(ytPlaylistVideos.position))
  return c.json({ playlist: serialize(row.p, user.id, row.ownerName, videos.length), videos })
})

// ── Update (owner) ────────────────────────────────────────────────────────────────
ytPlaylists_route.patch('/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [row] = await db.select().from(ytPlaylists).where(eq(ytPlaylists.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.userId !== user.id) return c.json({ error: 'not your playlist' }, 403)
  const body = await c.req.json<{ name?: string; description?: string; visibility?: PlaylistRow['visibility'] }>().catch(() => ({} as { name?: string; description?: string; visibility?: PlaylistRow['visibility'] }))
  await db.update(ytPlaylists).set({
    name: body.name?.trim() || row.name,
    description: body.description !== undefined ? (body.description?.trim() || null) : row.description,
    visibility: body.visibility ?? row.visibility,
    updatedAt: new Date(),
  }).where(eq(ytPlaylists.id, id))
  const [updated] = await db.select().from(ytPlaylists).where(eq(ytPlaylists.id, id))
  return c.json({ playlist: serialize(updated!, user.id) })
})

// ── Delete (owner) ────────────────────────────────────────────────────────────────
ytPlaylists_route.delete('/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [row] = await db.select().from(ytPlaylists).where(eq(ytPlaylists.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.userId !== user.id) return c.json({ error: 'not your playlist' }, 403)
  await db.delete(ytPlaylists).where(eq(ytPlaylists.id, id))
  return c.json({ ok: true })
})

// ── Add a video (owner) ──────────────────────────────────────────────────────────
ytPlaylists_route.post('/:id/videos', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [row] = await db.select().from(ytPlaylists).where(eq(ytPlaylists.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.userId !== user.id) return c.json({ error: 'not your playlist' }, 403)
  const body = await c.req.json<{ videoId?: string; title?: string; author?: string; channelId?: string; durationSec?: number }>().catch(() => ({} as { videoId?: string; title?: string; author?: string; channelId?: string; durationSec?: number }))
  if (!body.videoId || !body.title) return c.json({ error: 'videoId and title required' }, 400)
  const [{ maxPos } = { maxPos: null }] = await db
    .select({ maxPos: max(ytPlaylistVideos.position) })
    .from(ytPlaylistVideos).where(eq(ytPlaylistVideos.playlistId, id))
  await db.insert(ytPlaylistVideos).values({
    id: crypto.randomUUID(), playlistId: id, videoId: body.videoId, title: body.title,
    author: body.author?.trim() || null, channelId: body.channelId || null, durationSec: body.durationSec ?? null,
    position: (maxPos ?? -1) + 1, addedAt: new Date(),
  })
  await db.update(ytPlaylists).set({ updatedAt: new Date() }).where(eq(ytPlaylists.id, id))
  return c.json({ ok: true })
})

// ── Remove a video (owner) ────────────────────────────────────────────────────────
ytPlaylists_route.delete('/:id/videos/:rowId', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [row] = await db.select().from(ytPlaylists).where(eq(ytPlaylists.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.userId !== user.id) return c.json({ error: 'not your playlist' }, 403)
  await db.delete(ytPlaylistVideos)
    .where(and(eq(ytPlaylistVideos.id, c.req.param('rowId')), eq(ytPlaylistVideos.playlistId, id)))
  return c.json({ ok: true })
})

// ── Reorder videos (owner) ────────────────────────────────────────────────────────
ytPlaylists_route.put('/:id/videos/order', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [row] = await db.select().from(ytPlaylists).where(eq(ytPlaylists.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.userId !== user.id) return c.json({ error: 'not your playlist' }, 403)
  const body = await c.req.json<{ videoIds?: string[] }>().catch(() => ({} as { videoIds?: string[] }))
  const order = body.videoIds ?? []
  for (let i = 0; i < order.length; i++) {
    await db.update(ytPlaylistVideos).set({ position: i })
      .where(and(eq(ytPlaylistVideos.id, order[i]!), eq(ytPlaylistVideos.playlistId, id)))
  }
  await db.update(ytPlaylists).set({ updatedAt: new Date() }).where(eq(ytPlaylists.id, id))
  return c.json({ ok: true })
})

// ── Share toggle (owner) ──────────────────────────────────────────────────────────
ytPlaylists_route.post('/:id/share', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json<{ shared?: boolean }>().catch(() => ({} as { shared?: boolean }))
  const [row] = await db.select().from(ytPlaylists).where(eq(ytPlaylists.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.userId !== user.id) return c.json({ error: 'not your playlist' }, 403)
  const visibility = body.shared === false ? 'private' : 'shared'
  await db.update(ytPlaylists).set({ visibility, updatedAt: new Date() }).where(eq(ytPlaylists.id, id))
  return c.json({ visibility })
})

// ── Download all (owner, or a household member downloading their own copy of a shared list) ──
ytPlaylists_route.post('/:id/download', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json<{ kind?: 'audio' | 'video'; maxHeight?: number | null }>().catch(() => ({} as { kind?: 'audio' | 'video'; maxHeight?: number | null }))
  const kind = body.kind === 'audio' ? 'audio' : 'video'
  try {
    const { batchId, videoCount } = await startPlaylistDownloadBatch({ userId: user.id, playlistId: id, kind, maxHeight: body.maxHeight ?? null })
    return c.json({ batchId, videoCount })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Could not start download' }, 400)
  }
})

ytPlaylists_route.get('/:id/download/:batchId', async (c) => {
  const user = c.get('user')
  const status = await getPlaylistDownloadBatchStatus(c.req.param('batchId'), user.id)
  if (!status) return c.json({ error: 'not found' }, 404)
  return c.json(status)
})

// ── Clone a shared playlist into your own ─────────────────────────────────────────
ytPlaylists_route.post('/:id/clone', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [row] = await db.select().from(ytPlaylists).where(eq(ytPlaylists.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.userId !== user.id && row.visibility !== 'shared') return c.json({ error: 'not available' }, 403)
  const srcVideos = await db.select().from(ytPlaylistVideos)
    .where(eq(ytPlaylistVideos.playlistId, id)).orderBy(asc(ytPlaylistVideos.position))
  const newId = crypto.randomUUID()
  const now = new Date()
  await db.insert(ytPlaylists).values({
    id: newId, userId: user.id, name: `${row.name} (copy)`, description: row.description,
    visibility: 'private', createdAt: now, updatedAt: now,
  })
  for (const v of srcVideos) {
    await db.insert(ytPlaylistVideos).values({
      id: crypto.randomUUID(), playlistId: newId, videoId: v.videoId, title: v.title,
      author: v.author, channelId: v.channelId, durationSec: v.durationSec, position: v.position, addedAt: now,
    })
  }
  const [created] = await db.select().from(ytPlaylists).where(eq(ytPlaylists.id, newId))
  return c.json({ playlist: serialize(created!, user.id, null, srcVideos.length) })
})

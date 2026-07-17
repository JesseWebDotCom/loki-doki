// Music playlists API — explicit, user-curated track lists (distinct from generative stations).
// Owner-only edits; family sharing (private ↔ shared); clone-a-shared-playlist.

import { Hono } from 'hono'
import { eq, and, or, desc, asc, max } from 'drizzle-orm'
import { db } from '@/db'
import { musicPlaylists, musicPlaylistTracks, users } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { parseSmartRules, evaluateSmartPlaylist } from '@/lib/music/smartRules'
import { createCuratedPlaylist, regenerateFromRecipe, CurateError } from '@/lib/music/curate'
import {
  audioGateFor, familyEntrySetsFor, playlistAllowed, filterTracksBySets, logFamilyAudioEvent,
} from '@/lib/family/audioPolicy'
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
    kind: row.kind ?? 'manual',
    rules: row.kind === 'smart' ? parseSmartRules(row.rulesJson) : null,
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

  let all = rows.map(r => serialize(r.p, user.id, r.ownerName, counts.get(r.p.id) ?? 0))
  // Family audio: allowlist-only profiles only see approved playlists; blocklisted
  // playlists disappear for anyone they apply to.
  const sets = await familyEntrySetsFor(user.id)
  if (sets.hasAny) all = all.filter(p => playlistAllowed(sets, p.id))
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

// ── Magic Vibe: describe it, get a playlist ──────────────────────────────────────
// Delegates to the shared curation engine (lib/music/curate.ts) so a UI-built magic
// playlist and a companion-voice-built one are identical: the LLM proposes real songs
// for the vibe (chips fold into the brief, the arc shapes ordering), the resolver makes
// them playable, prefer-library swaps in owned copies, and the result lands as a NORMAL
// editable playlist (kind 'magic', recipe kept in rules_json so Regenerate can re-roll it).
musicPlaylists_route.post('/magic', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ vibe?: string; chips?: string[]; arc?: string; count?: number; name?: string }>().catch(() => ({} as Record<string, never>))
  const vibe = body.vibe?.trim()
  if (!vibe) return c.json({ error: 'vibe required' }, 400)

  try {
    const { id, trackCount } = await createCuratedPlaylist(user.id, {
      vibe, chips: body.chips, arc: body.arc, count: body.count, name: body.name, description: `Magic mix: ${vibe}`,
    })
    const [row] = await db.select().from(musicPlaylists).where(eq(musicPlaylists.id, id))
    return c.json({ playlist: serialize(row!, user.id, null, trackCount) })
  } catch (err) {
    if (err instanceof CurateError) return c.json({ error: 'Could not find enough songs for that vibe - try rewording it.' }, 422)
    throw err
  }
})

// Re-roll a magic playlist from its stored recipe (owner only).
musicPlaylists_route.post('/:id/regenerate', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [row] = await db.select().from(musicPlaylists).where(eq(musicPlaylists.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.userId !== user.id) return c.json({ error: 'not your playlist' }, 403)
  if (row.kind !== 'magic' || !row.rulesJson) return c.json({ error: 'not a magic playlist' }, 400)
  try {
    const trackCount = await regenerateFromRecipe(user.id, id)
    return c.json({ ok: true, trackCount })
  } catch (err) {
    if (err instanceof CurateError) return c.json({ error: 'Could not find enough songs - try editing the vibe.' }, 422)
    throw err
  }
})

// ── Smart playlist: create with rules / update rules (owner) ─────────────────────
musicPlaylists_route.post('/smart', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ name?: string; rules?: unknown }>().catch(() => ({} as Record<string, never>))
  const name = body.name?.trim()
  const rules = parseSmartRules(JSON.stringify(body.rules ?? null))
  if (!name || !rules || !rules.rules.length) return c.json({ error: 'name and at least one rule required' }, 400)
  const id = crypto.randomUUID()
  const now = new Date()
  await db.insert(musicPlaylists).values({
    id, userId: user.id, name, description: null, visibility: 'private',
    kind: 'smart', rulesJson: JSON.stringify(rules), createdAt: now, updatedAt: now,
  })
  const [row] = await db.select().from(musicPlaylists).where(eq(musicPlaylists.id, id))
  const count = (await evaluateSmartPlaylist(user.id, rules)).length
  return c.json({ playlist: serialize(row!, user.id, null, count) })
})

musicPlaylists_route.put('/:id/rules', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [row] = await db.select().from(musicPlaylists).where(eq(musicPlaylists.id, id))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.userId !== user.id) return c.json({ error: 'not your playlist' }, 403)
  if (row.kind !== 'smart') return c.json({ error: 'not a smart playlist' }, 400)
  const body = await c.req.json<{ rules?: unknown }>().catch(() => ({} as Record<string, never>))
  const rules = parseSmartRules(JSON.stringify(body.rules ?? null))
  if (!rules || !rules.rules.length) return c.json({ error: 'at least one rule required' }, 400)
  await db.update(musicPlaylists).set({ rulesJson: JSON.stringify(rules), updatedAt: new Date() }).where(eq(musicPlaylists.id, id))
  return c.json({ ok: true, count: (await evaluateSmartPlaylist(user.id, rules)).length })
})

// Live preview: how many universe tracks match a rule set right now.
musicPlaylists_route.post('/smart/preview', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ rules?: unknown }>().catch(() => ({} as Record<string, never>))
  const rules = parseSmartRules(JSON.stringify(body.rules ?? null))
  if (!rules) return c.json({ count: 0 })
  return c.json({ count: (await evaluateSmartPlaylist(user.id, rules)).length })
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

  // Family audio: this GET is what the player queues from, so gate the playlist and
  // the time budget here, and drop blocklisted artists from what comes back.
  const familyGate = await audioGateFor(user.id)
  if (!familyGate.allowed) {
    return c.json({ error: familyGate.reason === 'quiet_hours' ? 'Audio is paused during quiet hours' : 'Audio time is done for today', code: 'family_time' }, 403)
  }
  const sets = await familyEntrySetsFor(user.id)
  const approved = playlistAllowed(sets, id)
  if (sets.hasAny && !approved) {
    logFamilyAudioEvent(user.id, 'blocked_play', { label: row.p.name, medium: 'music', reason: 'playlist' })
    return c.json({ error: 'This playlist is not available on this profile', code: 'family_blocked' }, 403)
  }

  // Smart playlists ARE their rules: re-evaluated over the owner's universe on every
  // read (a fresh play, rating, or favorite changes the answer) - no persisted rows.
  if (row.p.kind === 'smart') {
    const rules = parseSmartRules(row.p.rulesJson)
    const hits = rules ? await evaluateSmartPlaylist(row.p.userId, rules) : []
    const tracks = filterTracksBySets(sets, hits.map((t, i) => ({
      id: `smart-${i}`, playlistId: id, videoId: t.videoId, title: t.title,
      artist: t.artist || null, mbid: null, durationSec: null, position: i, addedAt: new Date(),
    })), approved)
    return c.json({ playlist: serialize(row.p, user.id, row.ownerName, tracks.length), tracks })
  }

  const trackRows = await db.select().from(musicPlaylistTracks)
    .where(eq(musicPlaylistTracks.playlistId, id))
    .orderBy(asc(musicPlaylistTracks.position))
  const tracks = filterTracksBySets(sets, trackRows, approved)
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

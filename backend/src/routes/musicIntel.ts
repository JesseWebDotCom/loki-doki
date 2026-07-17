// Music intelligence API - Plexamp-grade listening features on top of the similarity
// engine: Track Radio, Mixes For You, Family Blend, Play Something, per-track tempo/key
// (AutoMix), and the offline auto-cache toggle. Mounted at /api/music/intel.

import { Hono } from 'hono'
import { and, eq, inArray } from 'drizzle-orm'
import { db, sqlite } from '@/db'
import { musicBlends, musicFavorites, musicTrackFeatures } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { buildTrackRadio } from '@/lib/music/trackRadio'
import { getMixesForUser } from '@/lib/music/mixes'
import { listBlends, createBlend, deleteBlend, refreshBlend, getBlendInfo, parseMembers } from '@/lib/music/blends'
import { getAutocacheSettings, setAutocacheSettings, getAutocacheStatus, runAutocacheForUser } from '@/lib/music/autocache'
import { filterTracksForUser } from '@/lib/music/advisory'
import { getImpressions } from '@/lib/interests/impressions'
import { looksLikeVideo } from '@/lib/music/junk'
import type { AppEnv } from '@/types'

export const musicIntel = new Hono<AppEnv>()
musicIntel.use('*', requireAuth)

// ── Track Radio ───────────────────────────────────────────────────────────────────────
// GET /track-radio?ref=<trackRef>&title=&artist= - an ordered queue of similar tracks.
musicIntel.get('/track-radio', async (c) => {
  const ref = c.req.query('ref')?.trim()
  if (!ref) return c.json({ error: 'ref required' }, 400)
  const result = await buildTrackRadio({
    ref,
    title: c.req.query('title')?.trim() || undefined,
    artist: c.req.query('artist')?.trim() || undefined,
  })
  result.tracks = await filterTracksForUser(c.get('user').id, result.tracks)
  return c.json(result)
})

// ── Tempo/key facts for AutoMix (batched) ─────────────────────────────────────────────
musicIntel.get('/tempo', async (c) => {
  const refs = (c.req.query('refs') ?? '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 50)
  if (!refs.length) return c.json({})
  const rows = await db.select({ ref: musicTrackFeatures.ref, bpm: musicTrackFeatures.bpm, keyLabel: musicTrackFeatures.keyLabel })
    .from(musicTrackFeatures)
    .where(and(eq(musicTrackFeatures.status, 'ready'), inArray(musicTrackFeatures.ref, refs)))
  const out: Record<string, { bpm: number | null; keyLabel: string | null }> = {}
  for (const r of rows) out[r.ref] = { bpm: r.bpm, keyLabel: r.keyLabel }
  return c.json(out)
})

// ── Mixes For You ─────────────────────────────────────────────────────────────────────
// Dismissals ride the interest engine's impression store (domain 'music', ref `mix:<key>`),
// so DismissableCard's "Not interested" works exactly like every other suggestion rail.
musicIntel.get('/mixes', async (c) => {
  const user = c.get('user')
  const mixes = await getMixesForUser(user.id)
  let dismissed = new Set<string>()
  try {
    const impressions = await getImpressions(user.id, 'music')
    dismissed = new Set([...impressions.entries()].filter(([, v]) => v.dismissedAt).map(([k]) => k))
  } catch { /* impressions unavailable - serve everything */ }
  return c.json({
    mixes: mixes
      .filter(m => !dismissed.has(`mix:${m.key}`))
      .map(m => ({ ...m, ref: `mix:${m.key}` })),
  })
})

// ── Family Blend ──────────────────────────────────────────────────────────────────────
// Blends are household objects: anyone can see them (the playlist is shared anyway);
// members can refresh; only the owner deletes.
musicIntel.get('/blends', async (c) => {
  const user = c.get('user')
  const blends = await listBlends()
  return c.json({
    blends: blends.map(b => ({
      ...b,
      owned: b.ownerId === user.id,
      member: b.members.some(m => m.id === user.id),
    })),
  })
})

musicIntel.post('/blends', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ memberIds?: string[]; name?: string }>().catch(() => ({} as { memberIds?: string[]; name?: string }))
  const memberIds = (body.memberIds ?? []).filter(id => typeof id === 'string')
  if (!memberIds.filter(id => id !== user.id).length) {
    return c.json({ error: 'pick at least one other household member' }, 400)
  }
  try {
    const blend = await createBlend(user.id, memberIds, body.name)
    return c.json({ blend })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'could not create blend' }, 400)
  }
})

musicIntel.post('/blends/:id/refresh', async (c) => {
  const user = c.get('user')
  const [row] = await db.select().from(musicBlends).where(eq(musicBlends.id, c.req.param('id')))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.ownerId !== user.id && !parseMembers(row).includes(user.id)) return c.json({ error: 'not your blend' }, 403)
  const trackCount = await refreshBlend(row)
  return c.json({ ok: true, trackCount, blend: await getBlendInfo(row.id) })
})

musicIntel.delete('/blends/:id', async (c) => {
  const user = c.get('user')
  const [row] = await db.select().from(musicBlends).where(eq(musicBlends.id, c.req.param('id')))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.ownerId !== user.id) return c.json({ error: 'not your blend' }, 403)
  await deleteBlend(row.id)
  return c.json({ ok: true })
})

// ── Play Something ────────────────────────────────────────────────────────────────────
// One tap picks something appropriate: a Mix For You, a shuffle of recent favorites, or a
// time-of-day built-in station. The client starts whatever comes back immediately.
const DAY = 86_400   // played_at is unix SECONDS

function timeOfDayStation(): { stationId: string; reason: string } {
  const h = new Date().getHours()
  if (h >= 5 && h < 9) return { stationId: 'builtin:morning-coffee', reason: 'A gentle start to the morning' }
  if (h >= 9 && h < 12) return { stationId: 'builtin:happy-vibes', reason: 'Bright sounds for the morning' }
  if (h >= 12 && h < 17) return { stationId: 'builtin:good-times', reason: 'Easy afternoon vibes' }
  if (h >= 17 && h < 21) return { stationId: 'builtin:chill', reason: 'Winding down the evening' }
  return { stationId: 'builtin:mellow-mood', reason: 'Something calm for late hours' }
}

musicIntel.get('/play-something', async (c) => {
  const user = c.get('user')
  type Choice =
    | { kind: 'tracks'; name: string; reason: string; tracks: Array<{ videoId: string; title: string; artist: string }> }
    | { kind: 'station'; stationId: string; reason: string }
  const choices: Choice[] = []

  // Recent favorites + heavy rotation, shuffled.
  try {
    const since = Math.floor(Date.now() / 1000) - 90 * DAY
    const hist = sqlite.prepare(`
      SELECT video_id, MAX(title) AS title, MAX(artist) AS artist, COUNT(*) AS plays
      FROM music_history WHERE user_id = ? AND played_at >= ?
      GROUP BY video_id ORDER BY plays DESC LIMIT 60
    `).all(user.id, since) as Array<{ video_id: string; title: string; artist: string | null; plays: number }>
    const favs = await db.select().from(musicFavorites)
      .where(and(eq(musicFavorites.userId, user.id), eq(musicFavorites.kind, 'song')))
    const pool = new Map<string, { videoId: string; title: string; artist: string }>()
    for (const f of favs) if (f.refId && f.title) pool.set(f.refId, { videoId: f.refId, title: f.title, artist: f.artist ?? '' })
    for (const h of hist) {
      if (!h.video_id || !h.title || pool.has(h.video_id)) continue
      if (looksLikeVideo(h.title, h.artist ?? '')) continue
      pool.set(h.video_id, { videoId: h.video_id, title: h.title, artist: h.artist ?? '' })
    }
    let tracks = [...pool.values()]
    if (tracks.length >= 8) {
      for (let i = tracks.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[tracks[i], tracks[j]] = [tracks[j]!, tracks[i]!]
      }
      tracks = await filterTracksForUser(user.id, tracks.slice(0, 25))
      if (tracks.length >= 8) choices.push({ kind: 'tracks', name: 'Your favorites', reason: 'Songs you keep coming back to', tracks })
    }
  } catch { /* favorites pool unavailable */ }

  // A Mix For You (already advisory-filtered).
  try {
    const mixes = await getMixesForUser(user.id)
    if (mixes.length) {
      const m = mixes[Math.floor(Math.random() * mixes.length)]!
      choices.push({ kind: 'tracks', name: m.name, reason: 'One of your mixes', tracks: m.tracks })
    }
  } catch { /* mixes unavailable */ }

  // Time-of-day built-in station - always available, and the fallback.
  choices.push({ kind: 'station', ...timeOfDayStation() })

  return c.json({ choice: choices[Math.floor(Math.random() * choices.length)]! })
})

// ── Offline auto-cache ────────────────────────────────────────────────────────────────
musicIntel.get('/autocache', async (c) => {
  return c.json(await getAutocacheStatus(c.get('user').id))
})

musicIntel.put('/autocache', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ enabled?: boolean; count?: number }>().catch(() => ({} as { enabled?: boolean; count?: number }))
  const current = await getAutocacheSettings(user.id)
  const next = {
    enabled: body.enabled ?? current.enabled,
    count: body.count ?? current.count,
  }
  await setAutocacheSettings(user.id, next)
  // Turning it on (or raising N) should start downloads right away, not at the next daily pass.
  if (next.enabled) void runAutocacheForUser(user.id).catch(() => {})
  return c.json(await getAutocacheStatus(user.id))
})

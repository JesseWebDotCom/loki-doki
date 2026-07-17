// Listening Together: household player presence, phone-as-remote commands, and the
// Family Jam shared queue.
//
//   POST /api/together/presence            heartbeat from every app session (player state)
//   POST /api/together/presence/clear      pagehide beacon
//   GET  /api/together/devices             live sessions (custom names merged in)
//   PUT  /api/together/devices/:id/name    rename a device (persisted)
//   POST /api/together/command             route a remote command to one session
//   GET/POST... /api/together/jam*         Family Jam shared queue (see lib below)
//
// Presence is in-memory (lib/together/presence.ts); only device names persist
// (player_devices). The jam queue is DB-backed (music_jams / music_jam_items):
// reorder + attribution want durable ordering and a restart should not eat the
// party queue. Commands ride the existing browser-session SSE channel and are
// executed by the target through the player contexts' public APIs only.

import { Hono } from 'hono'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { requireAuth } from '@/middleware/auth'
import type { AppEnv } from '@/types'
import { db } from '@/db'
import { musicJamItems, musicJams, playerDevices } from '@/db/schema'
import {
  clearPresence, listPresence, getPresence, reportPresence,
  type PlayerSnapshot, type PlayerSource,
} from '@/lib/together/presence'
import { isTogetherCommandKind, sendTogetherCommand, type TogetherCommand } from '@/lib/together/commands'

const together = new Hono<AppEnv>()

const now = () => new Date()
const uuid = () => crypto.randomUUID()

function displayName(u: { nickname: string | null; firstName: string }): string {
  return (u.nickname?.trim() || u.firstName || 'Someone').slice(0, 40)
}

const SOURCES: PlayerSource[] = ['radio', 'liveRadio', 'podcast']

function parseSnapshot(raw: unknown): PlayerSnapshot | null {
  const s = raw as Partial<PlayerSnapshot> | null
  if (!s || typeof s !== 'object') return null
  if (!SOURCES.includes(s.source as PlayerSource)) return null
  return {
    source: s.source as PlayerSource,
    title: typeof s.title === 'string' ? s.title.slice(0, 300) : '',
    artist: typeof s.artist === 'string' ? s.artist.slice(0, 200) : null,
    cover: typeof s.cover === 'string' ? s.cover.slice(0, 2000) : '',
    positionSec: Number.isFinite(s.positionSec) ? Math.max(0, Number(s.positionSec)) : 0,
    durationSec: Number.isFinite(s.durationSec) ? Math.max(0, Number(s.durationSec)) : 0,
    playing: !!s.playing,
    volume: Number.isFinite(s.volume) ? Math.max(0, Math.min(1, Number(s.volume))) : 1,
  }
}

const validDeviceId = (id: unknown): id is string =>
  typeof id === 'string' && id.length >= 8 && id.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(id)

async function deviceNames(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map()
  const rows = await db.select().from(playerDevices).where(inArray(playerDevices.id, ids))
  return new Map(rows.map((r) => [r.id, r.name]))
}

// ── Presence ─────────────────────────────────────────────────────────────────────
together.post('/presence', requireAuth, async (c) => {
  const user = c.get('user')
  const b = (await c.req.json().catch(() => ({}))) as { deviceId?: unknown; label?: unknown; state?: unknown }
  if (!validDeviceId(b.deviceId)) return c.json({ error: 'deviceId required' }, 400)
  reportPresence({
    deviceId: b.deviceId,
    userId: user.id,
    userName: displayName(user),
    label: typeof b.label === 'string' ? b.label.slice(0, 60) : 'Browser',
    state: parseSnapshot(b.state),
  })
  return c.json({ ok: true })
})

together.post('/presence/clear', requireAuth, async (c) => {
  const user = c.get('user')
  const b = (await c.req.json().catch(() => ({}))) as { deviceId?: unknown }
  if (validDeviceId(b.deviceId)) clearPresence(b.deviceId, user.id)
  return c.json({ ok: true })
})

// ── Device list + rename ─────────────────────────────────────────────────────────
together.get('/devices', requireAuth, async (c) => {
  const live = listPresence()
  const names = await deviceNames(live.map((e) => e.deviceId))
  return c.json({
    devices: live.map((e) => ({
      deviceId: e.deviceId,
      userId: e.userId,
      userName: e.userName,
      label: e.label,
      name: names.get(e.deviceId) ?? e.label,
      named: names.has(e.deviceId),
      state: e.state,
      lastSeenMs: e.lastSeenMs,
    })),
  })
})

together.put('/devices/:id/name', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  if (!validDeviceId(id)) return c.json({ error: 'bad device id' }, 400)
  const b = (await c.req.json().catch(() => ({}))) as { name?: unknown }
  const name = typeof b.name === 'string' ? b.name.trim().slice(0, 40) : ''
  if (!name) return c.json({ error: 'name required' }, 400)
  // Renaming is limited to the device's own current session (or an admin) so one
  // household member cannot relabel someone else's phone out from under them.
  const entry = getPresence(id)
  if (user.role !== 'admin' && (!entry || entry.userId !== user.id)) {
    return c.json({ error: 'you can only rename this device from the device itself' }, 403)
  }
  const ts = now()
  await db.insert(playerDevices)
    .values({ id, name, userId: user.id, createdAt: ts, updatedAt: ts })
    .onConflictDoUpdate({ target: playerDevices.id, set: { name, userId: user.id, updatedAt: ts } })
  return c.json({ ok: true, name })
})

// ── Remote command ───────────────────────────────────────────────────────────────
together.post('/command', requireAuth, async (c) => {
  const user = c.get('user')
  const b = (await c.req.json().catch(() => ({}))) as { deviceId?: unknown; command?: Partial<TogetherCommand> }
  if (!validDeviceId(b.deviceId)) return c.json({ error: 'deviceId required' }, 400)
  const cmd = b.command
  if (!cmd || !isTogetherCommandKind(cmd.kind)) return c.json({ error: 'unknown command' }, 400)
  if (!getPresence(b.deviceId)) return c.json({ error: 'device is not active' }, 404)
  const delivered = await sendTogetherCommand(b.deviceId, { ...cmd, kind: cmd.kind, fromName: displayName(user) })
  return c.json({ ok: delivered, delivered })
})

// ── Family Jam ───────────────────────────────────────────────────────────────────

interface JamTrackBody { videoId?: unknown; title?: unknown; author?: unknown; thumbnail?: unknown }

function parseJamTrack(raw: JamTrackBody): { videoId: string; title: string; author: string | null; thumbnail: string } | null {
  if (typeof raw?.videoId !== 'string' || !raw.videoId.trim()) return null
  if (typeof raw.title !== 'string' || !raw.title.trim()) return null
  return {
    videoId: raw.videoId.trim().slice(0, 200),
    title: raw.title.trim().slice(0, 300),
    author: typeof raw.author === 'string' && raw.author.trim() ? raw.author.trim().slice(0, 200) : null,
    thumbnail: typeof raw.thumbnail === 'string' ? raw.thumbnail.slice(0, 2000) : '',
  }
}

async function activeJam() {
  const [jam] = await db.select().from(musicJams).where(eq(musicJams.active, true))
  return jam ?? null
}

async function jamPayload(jam: typeof musicJams.$inferSelect) {
  const items = await db.select().from(musicJamItems)
    .where(eq(musicJamItems.jamId, jam.id)).orderBy(asc(musicJamItems.position))
  return {
    jam: {
      id: jam.id,
      name: jam.name,
      hostUserId: jam.hostUserId,
      hostName: jam.hostName,
      hostDeviceId: jam.hostDeviceId,
      createdAt: jam.createdAt.getTime(),
      items: items.map((i) => ({
        id: i.id, videoId: i.videoId, title: i.title, author: i.author,
        thumbnail: i.thumbnail, addedByName: i.addedByName,
      })),
    },
  }
}

together.get('/jam', requireAuth, async (c) => {
  const jam = await activeJam()
  if (!jam) return c.json({ jam: null })
  return c.json(await jamPayload(jam))
})

const MAX_JAM_ITEMS = 200

together.post('/jam/start', requireAuth, async (c) => {
  const user = c.get('user')
  const b = (await c.req.json().catch(() => ({}))) as { deviceId?: unknown; name?: unknown; queue?: JamTrackBody[] }
  if (!validDeviceId(b.deviceId)) return c.json({ error: 'deviceId required' }, 400)
  const existing = await activeJam()
  if (existing) return c.json({ error: 'a jam is already going - join it instead', jamId: existing.id }, 409)
  const ts = now()
  const id = uuid()
  const hostName = displayName(user)
  await db.insert(musicJams).values({
    id, hostUserId: user.id, hostName, hostDeviceId: b.deviceId,
    name: typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 60) : `${hostName}'s Jam`,
    active: true, createdAt: ts,
  })
  // Seed with the host's current Up Next so members see (and can reorder) it.
  const seed = Array.isArray(b.queue) ? b.queue.map(parseJamTrack).filter((t) => t !== null).slice(0, MAX_JAM_ITEMS) : []
  if (seed.length) {
    await db.insert(musicJamItems).values(seed.map((t, i) => ({
      id: uuid(), jamId: id, ...t, position: i, addedById: user.id, addedByName: hostName, createdAt: ts,
    })))
  }
  const jam = await activeJam()
  return c.json(await jamPayload(jam!))
})

together.post('/jam/end', requireAuth, async (c) => {
  const user = c.get('user')
  const jam = await activeJam()
  if (!jam) return c.json({ ok: true })
  if (jam.hostUserId !== user.id && user.role !== 'admin') return c.json({ error: 'only the host can end the jam' }, 403)
  await db.update(musicJams).set({ active: false, endedAt: now() }).where(eq(musicJams.id, jam.id))
  return c.json({ ok: true })
})

together.post('/jam/items', requireAuth, async (c) => {
  const user = c.get('user')
  const jam = await activeJam()
  if (!jam) return c.json({ error: 'no active jam' }, 404)
  const b = (await c.req.json().catch(() => ({}))) as JamTrackBody
  const track = parseJamTrack(b)
  if (!track) return c.json({ error: 'videoId and title required' }, 400)
  const items = await db.select({ position: musicJamItems.position }).from(musicJamItems).where(eq(musicJamItems.jamId, jam.id))
  if (items.length >= MAX_JAM_ITEMS) return c.json({ error: 'the jam queue is full' }, 400)
  const nextPos = items.reduce((m, i) => Math.max(m, i.position), -1) + 1
  await db.insert(musicJamItems).values({
    id: uuid(), jamId: jam.id, ...track, position: nextPos,
    addedById: user.id, addedByName: displayName(user), createdAt: now(),
  })
  return c.json(await jamPayload(jam))
})

together.put('/jam/reorder', requireAuth, async (c) => {
  const jam = await activeJam()
  if (!jam) return c.json({ error: 'no active jam' }, 404)
  const b = (await c.req.json().catch(() => ({}))) as { itemIds?: unknown }
  if (!Array.isArray(b.itemIds) || !b.itemIds.every((x) => typeof x === 'string')) {
    return c.json({ error: 'itemIds must be an array' }, 400)
  }
  const items = await db.select().from(musicJamItems).where(eq(musicJamItems.jamId, jam.id))
  const known = new Set(items.map((i) => i.id))
  const ordered = (b.itemIds as string[]).filter((id) => known.has(id))
  // Anything the client's list missed (a concurrent add) keeps its relative order at the end.
  const missing = items.filter((i) => !ordered.includes(i.id)).sort((a, z) => a.position - z.position).map((i) => i.id)
  const finalOrder = [...ordered, ...missing]
  for (let i = 0; i < finalOrder.length; i++) {
    await db.update(musicJamItems).set({ position: i })
      .where(and(eq(musicJamItems.id, finalOrder[i]!), eq(musicJamItems.jamId, jam.id)))
  }
  return c.json(await jamPayload(jam))
})

together.delete('/jam/items/:id', requireAuth, async (c) => {
  const jam = await activeJam()
  if (!jam) return c.json({ error: 'no active jam' }, 404)
  await db.delete(musicJamItems).where(and(eq(musicJamItems.id, c.req.param('id')), eq(musicJamItems.jamId, jam.id)))
  return c.json(await jamPayload(jam))
})

// The host reporting it started playing a jam item - the item leaves the shared queue.
together.post('/jam/consume', requireAuth, async (c) => {
  const user = c.get('user')
  const jam = await activeJam()
  if (!jam) return c.json({ error: 'no active jam' }, 404)
  if (jam.hostUserId !== user.id) return c.json({ error: 'only the host consumes the queue' }, 403)
  const b = (await c.req.json().catch(() => ({}))) as { itemId?: unknown }
  if (typeof b.itemId !== 'string') return c.json({ error: 'itemId required' }, 400)
  await db.delete(musicJamItems).where(and(eq(musicJamItems.id, b.itemId), eq(musicJamItems.jamId, jam.id)))
  return c.json(await jamPayload(jam))
})

export { together }

// gpodder.net-compatible sync API (the subset AntennaPod actually uses). Point
// AntennaPod's "gpodder.net" sync at http://<host>:<port> with the username +
// app password from Podcast settings and subscriptions/positions sync both ways.
//
// Like KOSync, this does NOT use the app session cookie: clients send HTTP Basic auth
// on every call (see lib/podcast/gpodderStore.ts for credential verification).
//
// Implemented:
//   POST   /api/2/auth/:username/login.json
//   GET    /api/2/devices/:username.json
//   POST   /api/2/devices/:username/:deviceId.json          (register / update)
//   GET    /subscriptions/:username/:deviceId.json          (simple list)
//   PUT    /subscriptions/:username/:deviceId.json          (simple list replace)
//   GET    /api/2/subscriptions/:username/:deviceId.json    (diff since)
//   POST   /api/2/subscriptions/:username/:deviceId.json    (add/remove diff)
//   GET    /api/2/episodes/:username.json                   (actions since)
//   POST   /api/2/episodes/:username.json                   (upload actions)
//
// Deliberately out of scope for v1: device sync-groups, podcast/episode metadata
// endpoints, toplists, suggestions, and the client-side settings API. AntennaPod
// degrades cleanly without them.

import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { and, eq, gt, inArray } from 'drizzle-orm'
import { db } from '@/db'
import {
  gpodderEpisodeActions, gpodderSubscriptionLog, podcastEpisodes, podcastShows,
  podcastSubscriptions, podcastWatchState,
} from '@/db/schema'
import { normalizeFeedUrl, subscribeToFeed, unsubscribe } from '@/lib/podcast/feeds'
import {
  logSubscriptionChange, nowEpochSec, touchDevice, verifyGpodderCredentials, listDevices,
} from '@/lib/podcast/gpodderStore'
import { logger } from '@/lib/logger'
import type { AppEnv } from '@/types'

export const gpodder = new Hono<AppEnv>()

const MAX_ACTIONS = 500

/** Basic-auth check. The username in the path must match the credentials, so one
 *  account's token can never drive another's sync. Returns the user id or null. */
async function authFor(c: {
  req: { header(n: string): string | undefined; param(n: string): string }
}): Promise<string | null> {
  const header = c.req.header('authorization') ?? ''
  const m = /^Basic\s+(.+)$/i.exec(header.trim())
  if (!m) return null
  let decoded: string
  try { decoded = Buffer.from(m[1]!, 'base64').toString('utf8') } catch { return null }
  const sep = decoded.indexOf(':')
  if (sep < 0) return null
  const username = decoded.slice(0, sep)
  const password = decoded.slice(sep + 1)

  const pathUser = c.req.param('username')?.replace(/\.json$/, '')
  if (pathUser && pathUser.toLowerCase() !== username.toLowerCase()) return null
  return verifyGpodderCredentials(username, password)
}

const unauthorized = (c: { text: (t: string, s: 401) => Response }) => c.text('Unauthorized', 401)
const stripJson = (v: string) => v.replace(/\.json$/, '')

/** The user's current subscription feed URLs. */
async function currentFeeds(userId: string): Promise<string[]> {
  const rows = await db.select({ feedUrl: podcastShows.feedUrl })
    .from(podcastSubscriptions)
    .innerJoin(podcastShows, eq(podcastSubscriptions.showId, podcastShows.id))
    .where(eq(podcastSubscriptions.userId, userId))
  return rows.map(r => r.feedUrl).filter((u): u is string => Boolean(u))
}

// ── Auth + devices ──────────────────────────────────────────────────────────────────

gpodder.post('/api/2/auth/:username/login.json', async (c) => {
  const userId = await authFor(c)
  if (!userId) return unauthorized(c)
  return c.json({ ok: true })
})

gpodder.get('/api/2/devices/:username', async (c) => {
  const userId = await authFor(c)
  if (!userId) return unauthorized(c)
  const devices = await listDevices(userId)
  return c.json(devices.map(d => ({
    id: d.deviceId,
    caption: d.caption ?? d.deviceId,
    type: d.type ?? 'other',
    subscriptions: 0,   // clients only use this cosmetically
  })))
})

gpodder.post('/api/2/devices/:username/:deviceId', async (c) => {
  const userId = await authFor(c)
  if (!userId) return unauthorized(c)
  const body = await c.req.json<{ caption?: string; type?: string }>().catch(() => ({}))
  await touchDevice(userId, stripJson(c.req.param('deviceId')), {
    ...(body.caption ? { caption: body.caption } : {}),
    ...(body.type ? { type: body.type } : {}),
  })
  return c.json({ ok: true })
})

// ── Subscriptions: simple list get/put ──────────────────────────────────────────────

gpodder.get('/subscriptions/:username/:deviceId', async (c) => {
  const userId = await authFor(c)
  if (!userId) return unauthorized(c)
  await touchDevice(userId, stripJson(c.req.param('deviceId')))
  return c.json(await currentFeeds(userId))
})

/** Replace the whole list: subscribe to what's new, unsubscribe from what's gone.
 *  Feed fetches can be slow, so failures are collected and reported rather than
 *  failing the whole sync (AntennaPod retries the rest next round). */
gpodder.put('/subscriptions/:username/:deviceId', async (c) => {
  const userId = await authFor(c)
  if (!userId) return unauthorized(c)
  const deviceId = stripJson(c.req.param('deviceId'))
  await touchDevice(userId, deviceId)

  const urls = await c.req.json<string[]>().catch(() => null)
  if (!Array.isArray(urls)) return c.json({ error: 'Expected a JSON array of feed URLs' }, 400)

  const wanted = new Set(urls.filter(u => typeof u === 'string' && /^https?:/i.test(u)).map(normalizeFeedUrl))
  const have = new Set((await currentFeeds(userId)).map(normalizeFeedUrl))

  for (const url of wanted) {
    if (have.has(url)) continue
    try { await subscribeToFeed(userId, url) } catch (err) {
      logger.warn(`[gpodder] subscribe failed for ${url}: ${String(err)}`)
    }
  }
  await removeFeeds(userId, [...have].filter(u => !wanted.has(u)), deviceId)
  return c.json({ timestamp: nowEpochSec() })
})

/** Unsubscribe by feed URL (the gpodder wire speaks URLs; our rows speak show ids). */
async function removeFeeds(userId: string, feedUrls: string[], deviceId: string): Promise<void> {
  if (!feedUrls.length) return
  const rows = await db.select({ id: podcastShows.id, feedUrl: podcastShows.feedUrl })
    .from(podcastSubscriptions)
    .innerJoin(podcastShows, eq(podcastSubscriptions.showId, podcastShows.id))
    .where(eq(podcastSubscriptions.userId, userId))
  const targets = new Set(feedUrls)
  for (const row of rows) {
    if (!row.feedUrl || !targets.has(normalizeFeedUrl(row.feedUrl))) continue
    try {
      await unsubscribe(userId, row.id)
      // unsubscribe() already logs a tombstone; stamp the device that drove it.
      await db.update(gpodderSubscriptionLog).set({ deviceId })
        .where(and(
          eq(gpodderSubscriptionLog.userId, userId),
          eq(gpodderSubscriptionLog.feedUrl, row.feedUrl),
          eq(gpodderSubscriptionLog.action, 'unsubscribe'),
        ))
    } catch (err) {
      logger.warn(`[gpodder] unsubscribe failed for ${row.feedUrl}: ${String(err)}`)
    }
  }
}

// ── Subscriptions: diff API ─────────────────────────────────────────────────────────

// GET ?since=<ts> — what changed since ts. since=0 (or absent) returns the full list
// as adds, which is exactly what a fresh device wants.
gpodder.get('/api/2/subscriptions/:username/:deviceId', async (c) => {
  const userId = await authFor(c)
  if (!userId) return unauthorized(c)
  await touchDevice(userId, stripJson(c.req.param('deviceId')))

  const since = Math.max(0, Number(c.req.query('since')) || 0)
  const timestamp = nowEpochSec()
  if (since === 0) return c.json({ add: await currentFeeds(userId), remove: [], timestamp })

  const changes = await db.select().from(gpodderSubscriptionLog)
    .where(and(eq(gpodderSubscriptionLog.userId, userId), gt(gpodderSubscriptionLog.timestamp, since)))
    .orderBy(gpodderSubscriptionLog.timestamp)

  // Last write per feed wins: a subscribe-then-unsubscribe inside one window is a
  // remove, not both.
  const latest = new Map<string, 'subscribe' | 'unsubscribe'>()
  for (const ch of changes) latest.set(normalizeFeedUrl(ch.feedUrl), ch.action)
  const add: string[] = []
  const remove: string[] = []
  for (const [url, action] of latest) (action === 'subscribe' ? add : remove).push(url)
  return c.json({ add, remove, timestamp })
})

// POST { add: [...], remove: [...] } — apply a device-side diff.
gpodder.post('/api/2/subscriptions/:username/:deviceId', async (c) => {
  const userId = await authFor(c)
  if (!userId) return unauthorized(c)
  const deviceId = stripJson(c.req.param('deviceId'))
  await touchDevice(userId, deviceId)

  const body = await c.req.json<{ add?: string[]; remove?: string[] }>().catch(() => ({} as Record<string, never>))
  const add = (body.add ?? []).filter(u => typeof u === 'string' && /^https?:/i.test(u))
  const remove = (body.remove ?? []).filter(u => typeof u === 'string' && /^https?:/i.test(u))

  const have = new Set((await currentFeeds(userId)).map(normalizeFeedUrl))
  for (const url of add) {
    if (have.has(normalizeFeedUrl(url))) continue
    try { await subscribeToFeed(userId, url) } catch (err) {
      logger.warn(`[gpodder] subscribe failed for ${url}: ${String(err)}`)
    }
  }
  await removeFeeds(userId, remove.map(normalizeFeedUrl), deviceId)

  // update_urls is the protocol's rewrite channel (feed URL changed server-side). We
  // never rewrite, so it is always empty.
  return c.json({ timestamp: nowEpochSec(), update_urls: [] })
})

// ── Episode actions ─────────────────────────────────────────────────────────────────

interface WireAction {
  podcast?: string
  episode?: string
  device?: string
  action?: string
  timestamp?: string
  started?: number
  position?: number
  total?: number
}

/** gpodder timestamps are ISO-8601 without a zone (UTC by convention). */
function parseActionAt(raw: string | undefined): number {
  if (!raw) return nowEpochSec()
  const ts = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : `${raw}Z`)
  return Number.isNaN(ts) ? nowEpochSec() : Math.floor(ts / 1000)
}

const isoOf = (epochSec: number) => new Date(epochSec * 1000).toISOString().replace(/\.\d{3}Z$/, '')

gpodder.get('/api/2/episodes/:username', async (c) => {
  const userId = await authFor(c)
  if (!userId) return unauthorized(c)
  const since = Math.max(0, Number(c.req.query('since')) || 0)

  const rows = await db.select().from(gpodderEpisodeActions)
    .where(and(eq(gpodderEpisodeActions.userId, userId), gt(gpodderEpisodeActions.actionAt, since)))
    .orderBy(gpodderEpisodeActions.actionAt)
    .limit(MAX_ACTIONS)

  return c.json({
    actions: rows.map(r => ({
      podcast: r.podcastUrl,
      episode: r.episodeUrl,
      device: r.deviceId ?? undefined,
      action: r.action,
      timestamp: isoOf(r.actionAt),
      ...(r.startedSec != null ? { started: r.startedSec } : {}),
      ...(r.positionSec != null ? { position: r.positionSec } : {}),
      ...(r.totalSec != null ? { total: r.totalSec } : {}),
    })),
    timestamp: nowEpochSec(),
  })
})

gpodder.post('/api/2/episodes/:username', async (c) => {
  const userId = await authFor(c)
  if (!userId) return unauthorized(c)
  const body = await c.req.json<WireAction[]>().catch(() => null)
  if (!Array.isArray(body)) return c.json({ error: 'Expected a JSON array of actions' }, 400)

  const actions = body.slice(0, MAX_ACTIONS).filter(a => a.podcast && a.episode && a.action)
  if (!actions.length) return c.json({ timestamp: nowEpochSec(), update_urls: [] })

  const now = new Date()
  await db.insert(gpodderEpisodeActions).values(actions.map(a => ({
    id: randomUUID(), userId,
    deviceId: a.device ?? null,
    podcastUrl: a.podcast!, episodeUrl: a.episode!,
    action: a.action!.toLowerCase(),
    positionSec: typeof a.position === 'number' ? Math.max(0, Math.round(a.position)) : null,
    startedSec: typeof a.started === 'number' ? Math.max(0, Math.round(a.started)) : null,
    totalSec: typeof a.total === 'number' ? Math.max(0, Math.round(a.total)) : null,
    actionAt: parseActionAt(a.timestamp),
    createdAt: now,
  })))

  // Fold 'play' positions into the app's own watch state so a position set in
  // AntennaPod resumes in MaiPai Home. Matched by enclosure URL (the only episode
  // identity the protocol carries).
  await applyPlayActions(userId, actions.filter(a => a.action!.toLowerCase() === 'play' && typeof a.position === 'number'))

  return c.json({ timestamp: nowEpochSec(), update_urls: [] })
})

/** Map enclosure URLs back to our episode rows and upsert watch state. */
async function applyPlayActions(userId: string, plays: WireAction[]): Promise<void> {
  if (!plays.length) return
  const urls = [...new Set(plays.map(p => p.episode!))]
  const rows: Array<{ id: string; enclosureUrl: string | null; durationSec: number | null }> = []
  for (let i = 0; i < urls.length; i += 200) {
    rows.push(...await db.select({
      id: podcastEpisodes.id, enclosureUrl: podcastEpisodes.enclosureUrl, durationSec: podcastEpisodes.durationSec,
    }).from(podcastEpisodes).where(inArray(podcastEpisodes.enclosureUrl, urls.slice(i, i + 200))))
  }
  const byUrl = new Map(rows.filter(r => r.enclosureUrl).map(r => [r.enclosureUrl!, r]))

  // Newest action per episode wins (a client may upload a whole session at once).
  const newest = new Map<string, WireAction>()
  for (const p of plays) {
    const prev = newest.get(p.episode!)
    if (!prev || parseActionAt(p.timestamp) >= parseActionAt(prev.timestamp)) newest.set(p.episode!, p)
  }

  for (const [url, action] of newest) {
    const ep = byUrl.get(url)
    if (!ep) continue   // an episode we don't have a row for; the action log still kept it
    const position = Math.max(0, Math.round(action.position!))
    const total = action.total ?? ep.durationSec ?? null
    // gpodder has no "completed" flag: treat the last 30s as finished, like the player does.
    const completed = Boolean(total && total > 0 && position >= total - 30)
    const at = new Date(parseActionAt(action.timestamp) * 1000)
    await db.insert(podcastWatchState).values({
      id: randomUUID(), userId, episodeId: ep.id, positionSec: position, completed, updatedAt: at,
    }).onConflictDoUpdate({
      target: [podcastWatchState.userId, podcastWatchState.episodeId],
      set: { positionSec: position, completed, updatedAt: at },
    })
  }
}

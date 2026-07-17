// Podcast player table stakes: server-persisted Up Next queue, per-show playback
// settings, bookmarks, smart episode filters, Podcasting 2.0 chapters, OPML
// import/export, and the trim-silence "time saved" counter. Mounted beside the other
// podcast routers under /api/podcasts (distinct sub-paths, no collisions).

import { Hono } from 'hono'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  podcastBookmarks, podcastEpisodeFilters, podcastEpisodes, podcastQueue, podcastShows,
  podcastShowSettings, podcastSubscriptions, userPreferences,
} from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { getEpisodeChapters } from '@/lib/podcast/chapters'
import { evaluatePodcastFilter, parsePodcastFilterRules, type PodcastFilterRules } from '@/lib/podcast/smartFilters'
import { filterEpisodesForUser } from '@/lib/podcast/policy'
import { normalizeFeedUrl, subscribeToFeed } from '@/lib/podcast/feeds'
import type { AppEnv } from '@/types'

export const podcastPlayerRoute = new Hono<AppEnv>()
podcastPlayerRoute.use('*', requireAuth)

// ── Access control (same semantics as routes/podcasts.ts) ─────────────────────────
type Actor = { id: string; role: string }
type ShowAccess = { ownerUserId: string; visibility: string | null; source?: string | null }
const canSeeShow = (s: ShowAccess, u: Actor) =>
  s.ownerUserId === u.id || s.visibility === 'shared' || s.source === 'rss' || u.role === 'admin'

async function showAccessForEpisode(episodeId: string): Promise<ShowAccess | null> {
  const [row] = await db.select({ ownerUserId: podcastShows.ownerUserId, visibility: podcastShows.visibility, source: podcastShows.source })
    .from(podcastEpisodes)
    .innerJoin(podcastShows, eq(podcastEpisodes.showId, podcastShows.id))
    .where(eq(podcastEpisodes.id, episodeId))
  return row ?? null
}

// ── Chapters ───────────────────────────────────────────────────────────────────────

podcastPlayerRoute.get('/episodes/:id/chapters', async (c) => {
  const user = c.get('user')
  const episodeId = c.req.param('id')
  const access = await showAccessForEpisode(episodeId)
  if (!access || !canSeeShow(access, user)) return c.json({ error: 'Not found' }, 404)
  return c.json({ chapters: await getEpisodeChapters(episodeId) })
})

// ── Per-show playback settings ─────────────────────────────────────────────────────

podcastPlayerRoute.get('/shows/:id/settings', async (c) => {
  const user = c.get('user')
  const showId = c.req.param('id')
  const [row] = await db.select().from(podcastShowSettings)
    .where(and(eq(podcastShowSettings.userId, user.id), eq(podcastShowSettings.showId, showId)))
  return c.json({
    settings: row ? {
      speed: row.speed,
      skipIntroSec: row.skipIntroSec,
      skipOutroSec: row.skipOutroSec,
      trimSilence: row.trimSilence == null ? null : row.trimSilence === 1,
      voiceBoost: row.voiceBoost == null ? null : row.voiceBoost === 1,
      skipAds: row.skipAds == null ? null : row.skipAds === 1,
    } : null,
  })
})

podcastPlayerRoute.put('/shows/:id/settings', async (c) => {
  const user = c.get('user')
  const showId = c.req.param('id')
  const [show] = await db.select({ ownerUserId: podcastShows.ownerUserId, visibility: podcastShows.visibility, source: podcastShows.source })
    .from(podcastShows).where(eq(podcastShows.id, showId))
  if (!show || !canSeeShow(show, user)) return c.json({ error: 'Not found' }, 404)

  const body = await c.req.json<{
    speed?: number | null
    skipIntroSec?: number
    skipOutroSec?: number
    trimSilence?: boolean | null
    voiceBoost?: boolean | null
    skipAds?: boolean | null
  }>().catch(() => ({} as Record<string, never>))

  const clampSec = (v: unknown) => Math.max(0, Math.min(600, Math.round(Number(v) || 0)))
  const speed = body.speed == null ? null : Math.max(0.5, Math.min(3, Number(body.speed) || 1))
  const tri = (v: boolean | null | undefined) => v == null ? null : (v ? 1 : 0)

  const now = new Date()
  await db.insert(podcastShowSettings).values({
    id: crypto.randomUUID(),
    userId: user.id,
    showId,
    speed,
    skipIntroSec: clampSec(body.skipIntroSec),
    skipOutroSec: clampSec(body.skipOutroSec),
    trimSilence: tri(body.trimSilence),
    voiceBoost: tri(body.voiceBoost),
    skipAds: body.skipAds ? 1 : 0,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [podcastShowSettings.userId, podcastShowSettings.showId],
    set: {
      speed,
      skipIntroSec: clampSec(body.skipIntroSec),
      skipOutroSec: clampSec(body.skipOutroSec),
      trimSilence: tri(body.trimSilence),
      voiceBoost: tri(body.voiceBoost),
      skipAds: tri(body.skipAds),
      updatedAt: now,
    },
  })
  return c.json({ ok: true })
})

// ── Up Next queue ──────────────────────────────────────────────────────────────────

async function serializeQueue(userId: string) {
  const rows = await db.select({
    episodeId: podcastQueue.episodeId,
    position: podcastQueue.position,
    title: podcastEpisodes.title,
    description: podcastEpisodes.description,
    durationSec: podcastEpisodes.durationSec,
    enclosureUrl: podcastEpisodes.enclosureUrl,
    explicit: podcastEpisodes.explicit,
    status: podcastEpisodes.status,
    showId: podcastEpisodes.showId,
    showName: podcastShows.name,
  })
    .from(podcastQueue)
    .innerJoin(podcastEpisodes, eq(podcastQueue.episodeId, podcastEpisodes.id))
    .innerJoin(podcastShows, eq(podcastEpisodes.showId, podcastShows.id))
    .where(eq(podcastQueue.userId, userId))
    .orderBy(asc(podcastQueue.position), asc(podcastQueue.addedAt))
  // Kid-safe media: a blocked episode must not surface (or auto-play) via the queue.
  const allowed = await filterEpisodesForUser(userId, rows.map(r => ({
    id: r.episodeId, title: r.title, description: r.description, explicit: r.explicit,
  })))
  const allowedIds = new Set(allowed.map(a => a.id))
  return rows
    .filter(r => allowedIds.has(r.episodeId) && r.status === 'ready')
    .map(r => ({
      episodeId: r.episodeId,
      showId: r.showId,
      showName: r.showName,
      title: r.title,
      durationSec: r.durationSec,
    }))
}

/** Rewrite positions 0..n-1 in the given episode order (queue stays small; simplest wins). */
async function writeQueueOrder(userId: string, episodeIds: string[]): Promise<void> {
  for (let i = 0; i < episodeIds.length; i++) {
    await db.update(podcastQueue)
      .set({ position: i })
      .where(and(eq(podcastQueue.userId, userId), eq(podcastQueue.episodeId, episodeIds[i]!)))
  }
}

podcastPlayerRoute.get('/queue', async (c) => {
  return c.json({ items: await serializeQueue(c.get('user').id) })
})

// Add one episode: mode 'next' puts it first, 'last' (default) appends.
podcastPlayerRoute.post('/queue', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ episodeId?: string; mode?: 'next' | 'last' }>().catch(() => ({} as { episodeId?: undefined }))
  const episodeId = body.episodeId?.trim()
  if (!episodeId) return c.json({ error: 'episodeId required' }, 400)
  const access = await showAccessForEpisode(episodeId)
  if (!access || !canSeeShow(access, user)) return c.json({ error: 'Not found' }, 404)

  const now = new Date()
  if (body.mode === 'next') {
    const [minRow] = await db.select({ min: sql<number>`min(${podcastQueue.position})` })
      .from(podcastQueue).where(eq(podcastQueue.userId, user.id))
    const pos = (minRow?.min ?? 1) - 1
    await db.insert(podcastQueue).values({ id: crypto.randomUUID(), userId: user.id, episodeId, position: pos, addedAt: now })
      .onConflictDoUpdate({ target: [podcastQueue.userId, podcastQueue.episodeId], set: { position: pos, addedAt: now } })
  } else {
    const [maxRow] = await db.select({ max: sql<number>`max(${podcastQueue.position})` })
      .from(podcastQueue).where(eq(podcastQueue.userId, user.id))
    const pos = (maxRow?.max ?? -1) + 1
    await db.insert(podcastQueue).values({ id: crypto.randomUUID(), userId: user.id, episodeId, position: pos, addedAt: now })
      .onConflictDoNothing()
  }
  return c.json({ items: await serializeQueue(user.id) })
})

// Replace the whole queue (play-all-into-queue) or reorder it (dnd) with an ordered id list.
podcastPlayerRoute.put('/queue', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ episodeIds?: string[]; replace?: boolean }>().catch(() => ({} as { episodeIds?: undefined }))
  const ids = [...new Set((body.episodeIds ?? []).filter(v => typeof v === 'string'))].slice(0, 500)

  if (body.replace) {
    await db.delete(podcastQueue).where(eq(podcastQueue.userId, user.id))
    if (ids.length) {
      // Only queue episodes the user may actually see.
      const rows = await db.select({ id: podcastEpisodes.id, ownerUserId: podcastShows.ownerUserId, visibility: podcastShows.visibility, source: podcastShows.source })
        .from(podcastEpisodes)
        .innerJoin(podcastShows, eq(podcastEpisodes.showId, podcastShows.id))
        .where(inArray(podcastEpisodes.id, ids))
      const visible = new Set(rows.filter(r => canSeeShow(r, user)).map(r => r.id))
      const now = new Date()
      const ordered = ids.filter(id => visible.has(id))
      for (let i = 0; i < ordered.length; i += 100) {
        await db.insert(podcastQueue).values(ordered.slice(i, i + 100).map((episodeId, j) => ({
          id: crypto.randomUUID(), userId: user.id, episodeId, position: i + j, addedAt: now,
        }))).onConflictDoNothing()
      }
    }
  } else {
    await writeQueueOrder(user.id, ids)
  }
  return c.json({ items: await serializeQueue(user.id) })
})

podcastPlayerRoute.delete('/queue/:episodeId', async (c) => {
  const user = c.get('user')
  await db.delete(podcastQueue)
    .where(and(eq(podcastQueue.userId, user.id), eq(podcastQueue.episodeId, c.req.param('episodeId'))))
  return c.json({ items: await serializeQueue(user.id) })
})

podcastPlayerRoute.delete('/queue', async (c) => {
  const user = c.get('user')
  await db.delete(podcastQueue).where(eq(podcastQueue.userId, user.id))
  return c.json({ items: [] })
})

// ── Bookmarks ──────────────────────────────────────────────────────────────────────

podcastPlayerRoute.get('/bookmarks', async (c) => {
  const user = c.get('user')
  const showId = c.req.query('showId')?.trim()
  const episodeId = c.req.query('episodeId')?.trim()

  const rows = await db.select({
    id: podcastBookmarks.id,
    episodeId: podcastBookmarks.episodeId,
    positionSec: podcastBookmarks.positionSec,
    note: podcastBookmarks.note,
    createdAt: podcastBookmarks.createdAt,
    title: podcastEpisodes.title,
    durationSec: podcastEpisodes.durationSec,
    showId: podcastEpisodes.showId,
    showName: podcastShows.name,
  })
    .from(podcastBookmarks)
    .innerJoin(podcastEpisodes, eq(podcastBookmarks.episodeId, podcastEpisodes.id))
    .innerJoin(podcastShows, eq(podcastEpisodes.showId, podcastShows.id))
    .where(and(
      eq(podcastBookmarks.userId, user.id),
      ...(showId ? [eq(podcastEpisodes.showId, showId)] : []),
      ...(episodeId ? [eq(podcastBookmarks.episodeId, episodeId)] : []),
    ))
    .orderBy(desc(podcastBookmarks.createdAt))

  return c.json({
    bookmarks: rows.map(r => ({
      id: r.id,
      episodeId: r.episodeId,
      positionSec: r.positionSec,
      note: r.note,
      createdAt: r.createdAt,
      episodeTitle: r.title,
      durationSec: r.durationSec,
      showId: r.showId,
      showName: r.showName,
    })),
  })
})

podcastPlayerRoute.post('/bookmarks', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ episodeId?: string; positionSec?: number; note?: string }>().catch(() => ({} as { episodeId?: undefined }))
  const episodeId = body.episodeId?.trim()
  if (!episodeId) return c.json({ error: 'episodeId required' }, 400)
  const access = await showAccessForEpisode(episodeId)
  if (!access || !canSeeShow(access, user)) return c.json({ error: 'Not found' }, 404)

  const bookmark = {
    id: crypto.randomUUID(),
    userId: user.id,
    episodeId,
    positionSec: Math.max(0, Number(body.positionSec) || 0),
    note: body.note?.trim().slice(0, 2000) || null,
    createdAt: new Date(),
  }
  await db.insert(podcastBookmarks).values(bookmark)
  return c.json({ bookmark })
})

podcastPlayerRoute.put('/bookmarks/:id', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ note?: string | null }>().catch(() => ({} as { note?: undefined }))
  await db.update(podcastBookmarks)
    .set({ note: body.note?.trim().slice(0, 2000) || null })
    .where(and(eq(podcastBookmarks.id, c.req.param('id')), eq(podcastBookmarks.userId, user.id)))
  return c.json({ ok: true })
})

podcastPlayerRoute.delete('/bookmarks/:id', async (c) => {
  const user = c.get('user')
  await db.delete(podcastBookmarks)
    .where(and(eq(podcastBookmarks.id, c.req.param('id')), eq(podcastBookmarks.userId, user.id)))
  return c.json({ ok: true })
})

// ── Smart episode filters ──────────────────────────────────────────────────────────

function sanitizeRules(input: unknown): PodcastFilterRules {
  const parsed = parsePodcastFilterRules(JSON.stringify(input ?? {}))
  return parsed ?? { match: 'all', rules: [] }
}

const serializeEpisode = (e: Awaited<ReturnType<typeof evaluatePodcastFilter>>[number]) => ({
  id: e.id,
  showId: e.showId,
  showName: e.showName,
  title: e.title,
  description: e.description,
  durationSec: e.durationSec,
  publishedAt: e.publishedAt,
  generatedAt: e.generatedAt,
  watchState: e.watchState,
  download: e.download,
})

podcastPlayerRoute.get('/filters', async (c) => {
  const user = c.get('user')
  const rows = await db.select().from(podcastEpisodeFilters)
    .where(eq(podcastEpisodeFilters.userId, user.id))
    .orderBy(asc(podcastEpisodeFilters.createdAt))
  return c.json({
    filters: rows.map(r => ({ id: r.id, name: r.name, rules: parsePodcastFilterRules(r.rulesJson) ?? { match: 'all', rules: [] } })),
  })
})

podcastPlayerRoute.post('/filters', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ name?: string; rules?: unknown }>().catch(() => ({} as { name?: undefined }))
  const name = body.name?.trim().slice(0, 80)
  if (!name) return c.json({ error: 'name required' }, 400)
  const now = new Date()
  const row = {
    id: crypto.randomUUID(),
    userId: user.id,
    name,
    rulesJson: JSON.stringify(sanitizeRules(body.rules)),
    createdAt: now,
    updatedAt: now,
  }
  await db.insert(podcastEpisodeFilters).values(row)
  return c.json({ filter: { id: row.id, name, rules: sanitizeRules(body.rules) } })
})

podcastPlayerRoute.put('/filters/:id', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ name?: string; rules?: unknown }>().catch(() => ({} as { name?: undefined }))
  const [row] = await db.select().from(podcastEpisodeFilters)
    .where(and(eq(podcastEpisodeFilters.id, c.req.param('id')), eq(podcastEpisodeFilters.userId, user.id)))
  if (!row) return c.json({ error: 'Not found' }, 404)
  await db.update(podcastEpisodeFilters).set({
    ...(body.name?.trim() ? { name: body.name.trim().slice(0, 80) } : {}),
    ...(body.rules !== undefined ? { rulesJson: JSON.stringify(sanitizeRules(body.rules)) } : {}),
    updatedAt: new Date(),
  }).where(eq(podcastEpisodeFilters.id, row.id))
  return c.json({ ok: true })
})

podcastPlayerRoute.delete('/filters/:id', async (c) => {
  const user = c.get('user')
  await db.delete(podcastEpisodeFilters)
    .where(and(eq(podcastEpisodeFilters.id, c.req.param('id')), eq(podcastEpisodeFilters.userId, user.id)))
  return c.json({ ok: true })
})

podcastPlayerRoute.get('/filters/:id/episodes', async (c) => {
  const user = c.get('user')
  const [row] = await db.select().from(podcastEpisodeFilters)
    .where(and(eq(podcastEpisodeFilters.id, c.req.param('id')), eq(podcastEpisodeFilters.userId, user.id)))
  if (!row) return c.json({ error: 'Not found' }, 404)
  const rules = parsePodcastFilterRules(row.rulesJson) ?? { match: 'all' as const, rules: [] }
  const episodes = await evaluatePodcastFilter(user.id, rules)
  return c.json({ episodes: episodes.map(serializeEpisode) })
})

// Live preview while building a filter (nothing persisted).
podcastPlayerRoute.post('/filters/preview', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ rules?: unknown }>().catch(() => ({} as { rules?: undefined }))
  const episodes = await evaluatePodcastFilter(user.id, sanitizeRules(body.rules))
  return c.json({ episodes: episodes.map(serializeEpisode) })
})

// ── Trim-silence "time saved" counter ──────────────────────────────────────────────
// Server-side increment (read-add-write on the user_preferences row) so two devices
// flushing at once merge instead of clobbering each other with stale totals.

const TIME_SAVED_KEY = 'podcasts.timeSavedSec'

async function readTimeSaved(userId: string): Promise<number> {
  const [row] = await db.select({ value: userPreferences.value }).from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, TIME_SAVED_KEY)))
  if (!row) return 0
  try { return Math.max(0, Number(JSON.parse(row.value)) || 0) } catch { return 0 }
}

podcastPlayerRoute.get('/player/stats', async (c) => {
  return c.json({ timeSavedSec: await readTimeSaved(c.get('user').id) })
})

podcastPlayerRoute.post('/player/time-saved', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ seconds?: number }>().catch(() => ({} as { seconds?: undefined }))
  const add = Math.max(0, Math.min(3600, Number(body.seconds) || 0))
  const total = await readTimeSaved(user.id) + add
  await db.insert(userPreferences).values({
    id: crypto.randomUUID(), userId: user.id, key: TIME_SAVED_KEY, value: JSON.stringify(Math.round(total)), updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: [userPreferences.userId, userPreferences.key],
    set: { value: JSON.stringify(Math.round(total)), updatedAt: new Date() },
  })
  return c.json({ timeSavedSec: Math.round(total) })
})

// ── OPML import / export ───────────────────────────────────────────────────────────

const xmlEscape = (s: string) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;')

podcastPlayerRoute.get('/opml.export', async (c) => {
  const user = c.get('user')
  const rows = await db.select({
    name: podcastShows.name,
    feedUrl: podcastShows.feedUrl,
    link: podcastShows.link,
  }).from(podcastSubscriptions)
    .innerJoin(podcastShows, eq(podcastSubscriptions.showId, podcastShows.id))
    .where(eq(podcastSubscriptions.userId, user.id))
    .orderBy(asc(podcastShows.name))

  const outlines = rows
    .filter(r => r.feedUrl)
    .map(r => `    <outline type="rss" text="${xmlEscape(r.name)}" title="${xmlEscape(r.name)}" xmlUrl="${xmlEscape(r.feedUrl!)}"${r.link ? ` htmlUrl="${xmlEscape(r.link)}"` : ''}/>`)
    .join('\n')

  const opml = `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head>\n    <title>Loki Doki podcast subscriptions</title>\n    <dateCreated>${new Date().toUTCString()}</dateCreated>\n  </head>\n  <body>\n${outlines}\n  </body>\n</opml>\n`

  return new Response(opml, {
    headers: {
      'Content-Type': 'text/x-opml; charset=utf-8',
      'Content-Disposition': 'attachment; filename="podcasts.opml"',
      'Cache-Control': 'no-store',
    },
  })
})

podcastPlayerRoute.post('/opml/import', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ opml?: string }>().catch(() => ({} as { opml?: undefined }))
  const xml = body.opml ?? ''
  if (!xml.trim()) return c.json({ error: 'opml required' }, 400)
  if (xml.length > 2 * 1024 * 1024) return c.json({ error: 'File too large' }, 413)

  // Every <outline> carrying an xmlUrl is a feed; text/title is best-effort labeling.
  const entries: Array<{ title: string; url: string }> = []
  const seen = new Set<string>()
  for (const m of xml.match(/<outline\b[^>]*>/gi) ?? []) {
    const url = m.match(/\bxmlUrl=["']([^"']+)["']/i)?.[1]
    if (!url || !/^https?:/i.test(url)) continue
    const key = normalizeFeedUrl(url)
    if (seen.has(key)) continue
    seen.add(key)
    const title = m.match(/\b(?:title|text)=["']([^"']*)["']/i)?.[1] ?? url
    entries.push({ title, url })
    if (entries.length >= 100) break
  }
  if (!entries.length) return c.json({ error: 'No podcast feeds found in that file.' }, 400)

  // Already-subscribed feeds get reported as skipped, not re-fetched.
  const subs = await db.select({ feedUrl: podcastShows.feedUrl })
    .from(podcastSubscriptions)
    .innerJoin(podcastShows, eq(podcastSubscriptions.showId, podcastShows.id))
    .where(eq(podcastSubscriptions.userId, user.id))
  const have = new Set(subs.map(s => s.feedUrl ? normalizeFeedUrl(s.feedUrl) : ''))

  const added: string[] = []
  const skipped: string[] = []
  const failed: Array<{ title: string; url: string; error: string }> = []
  for (const entry of entries) {
    if (have.has(normalizeFeedUrl(entry.url))) { skipped.push(entry.title); continue }
    try {
      await subscribeToFeed(user.id, entry.url, { title: entry.title })
      added.push(entry.title)
    } catch (err) {
      failed.push({ title: entry.title, url: entry.url, error: String(err instanceof Error ? err.message : err).slice(0, 200) })
    }
  }
  return c.json({ added, skipped, failed })
})

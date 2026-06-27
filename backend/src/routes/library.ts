// Personal tracking for the Shows + Movies apps: a shared watchlist and per-episode watched
// marks. Drives the "Your Watchlist" and "Continue Watching" shelves and the episode
// checkmarks. All rows are scoped to the authenticated user.

import { Hono } from 'hono'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { mediaWatchlist, showWatchedEpisodes } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { getShowEpisodes, type ShowEpisode } from '@/lib/shows/tvmaze'
import { mirrorWatchlistAdd, mirrorWatchlistRemove } from '@/lib/plex/sync'
import { mirrorEpisodeWatched } from '@/lib/plex/watched'
import type { AppEnv } from '@/types'

const libraryRoute = new Hono<AppEnv>()
libraryRoute.use('*', requireAuth)

type MediaType = 'show' | 'movie'
const STATUSES = ['want', 'watching', 'completed', 'dropped'] as const
type Status = (typeof STATUSES)[number]

function isMediaType(v: unknown): v is MediaType {
  return v === 'show' || v === 'movie'
}

// ── watchlist ──────────────────────────────────────────────────────────────────

libraryRoute.get('/watchlist', async (c) => {
  const user = c.get('user')
  const mediaType = c.req.query('mediaType')
  const rows = await db
    .select()
    .from(mediaWatchlist)
    .where(
      isMediaType(mediaType)
        ? and(eq(mediaWatchlist.userId, user.id), eq(mediaWatchlist.mediaType, mediaType), isNull(mediaWatchlist.deletedAt))
        : and(eq(mediaWatchlist.userId, user.id), isNull(mediaWatchlist.deletedAt)),
    )
    .orderBy(desc(mediaWatchlist.updatedAt))
  return c.json({ items: rows })
})

libraryRoute.get('/watchlist/check', async (c) => {
  const user = c.get('user')
  const mediaType = c.req.query('mediaType')
  const refId = c.req.query('refId')
  if (!isMediaType(mediaType) || !refId) return c.json({ inList: false, status: null })
  const [row] = await db
    .select()
    .from(mediaWatchlist)
    .where(and(eq(mediaWatchlist.userId, user.id), eq(mediaWatchlist.mediaType, mediaType), eq(mediaWatchlist.refId, refId), isNull(mediaWatchlist.deletedAt)))
    .limit(1)
  return c.json({ inList: !!row, status: row?.status ?? null })
})

libraryRoute.post('/watchlist', async (c) => {
  const user = c.get('user')
  const body = (await c.req.json().catch(() => ({}))) as {
    mediaType?: string
    refId?: string
    title?: string
    posterUrl?: string | null
    subtitle?: string | null
    status?: string
  }
  if (!isMediaType(body.mediaType) || !body.refId || !body.title) {
    return c.json({ error: 'mediaType, refId and title are required' }, 400)
  }
  const status: Status = STATUSES.includes(body.status as Status) ? (body.status as Status) : 'want'
  const now = new Date()

  const [existing] = await db
    .select()
    .from(mediaWatchlist)
    .where(and(eq(mediaWatchlist.userId, user.id), eq(mediaWatchlist.mediaType, body.mediaType), eq(mediaWatchlist.refId, body.refId)))
    .limit(1)

  if (existing) {
    // Revive a tombstoned row in place (the unique index forbids a second row for the title).
    await db
      .update(mediaWatchlist)
      .set({ status, title: body.title, posterUrl: body.posterUrl ?? existing.posterUrl, subtitle: body.subtitle ?? existing.subtitle, deletedAt: null, updatedAt: now })
      .where(eq(mediaWatchlist.id, existing.id))
    void mirrorWatchlistAdd(existing.id)
    return c.json({ id: existing.id, status })
  }

  const id = crypto.randomUUID()
  await db.insert(mediaWatchlist).values({
    id,
    userId: user.id,
    mediaType: body.mediaType,
    refId: body.refId,
    title: body.title,
    posterUrl: body.posterUrl ?? null,
    subtitle: body.subtitle ?? null,
    status,
    addedAt: now,
    updatedAt: now,
  })
  void mirrorWatchlistAdd(id)
  return c.json({ id, status })
})

libraryRoute.patch('/watchlist/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const body = (await c.req.json().catch(() => ({}))) as { status?: string }
  if (!STATUSES.includes(body.status as Status)) return c.json({ error: 'Invalid status' }, 400)
  await db
    .update(mediaWatchlist)
    .set({ status: body.status as Status, updatedAt: new Date() })
    .where(and(eq(mediaWatchlist.id, id), eq(mediaWatchlist.userId, user.id)))
  return c.json({ ok: true })
})

libraryRoute.delete('/watchlist/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const [row] = await db
    .select()
    .from(mediaWatchlist)
    .where(and(eq(mediaWatchlist.id, id), eq(mediaWatchlist.userId, user.id)))
    .limit(1)
  if (!row) return c.json({ ok: true })
  // Tombstone, don't hard-delete: the reconcile loop reads deletedAt to avoid re-importing.
  await db.update(mediaWatchlist).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(mediaWatchlist.id, row.id))
  void mirrorWatchlistRemove(row)
  return c.json({ ok: true })
})

// Convenience: remove by (mediaType, refId) so the detail page can toggle without knowing the row id.
libraryRoute.delete('/watchlist', async (c) => {
  const user = c.get('user')
  const mediaType = c.req.query('mediaType')
  const refId = c.req.query('refId')
  if (!isMediaType(mediaType) || !refId) return c.json({ error: 'mediaType and refId are required' }, 400)
  const [row] = await db
    .select()
    .from(mediaWatchlist)
    .where(and(eq(mediaWatchlist.userId, user.id), eq(mediaWatchlist.mediaType, mediaType), eq(mediaWatchlist.refId, refId)))
    .limit(1)
  if (!row) return c.json({ ok: true })
  await db.update(mediaWatchlist).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(mediaWatchlist.id, row.id))
  void mirrorWatchlistRemove(row)
  return c.json({ ok: true })
})

// ── episode progress (shows) ─────────────────────────────────────────────────────

libraryRoute.get('/shows/:tvmazeId/watched', async (c) => {
  const user = c.get('user')
  const tvmazeId = Number(c.req.param('tvmazeId'))
  if (!Number.isInteger(tvmazeId)) return c.json({ watched: [] })
  const rows = await db
    .select({ episodeId: showWatchedEpisodes.episodeId })
    .from(showWatchedEpisodes)
    .where(and(eq(showWatchedEpisodes.userId, user.id), eq(showWatchedEpisodes.tvmazeId, tvmazeId)))
  return c.json({ watched: rows.map((r) => r.episodeId) })
})

libraryRoute.post('/shows/:tvmazeId/episodes/:episodeId/watched', async (c) => {
  const user = c.get('user')
  const tvmazeId = Number(c.req.param('tvmazeId'))
  const episodeId = Number(c.req.param('episodeId'))
  if (!Number.isInteger(tvmazeId) || !Number.isInteger(episodeId)) return c.json({ error: 'Invalid id' }, 400)
  const body = (await c.req.json().catch(() => ({}))) as { season?: number; number?: number | null }

  const [existing] = await db
    .select()
    .from(showWatchedEpisodes)
    .where(and(eq(showWatchedEpisodes.userId, user.id), eq(showWatchedEpisodes.episodeId, episodeId)))
    .limit(1)

  const season = Number(body.season ?? existing?.season ?? 0)
  const number = body.number ?? existing?.number ?? null
  if (existing) {
    await db.delete(showWatchedEpisodes).where(eq(showWatchedEpisodes.id, existing.id))
    void mirrorEpisodeWatched(user.id, tvmazeId, season, number, false)
    return c.json({ watched: false })
  }
  await db.insert(showWatchedEpisodes).values({
    id: crypto.randomUUID(),
    userId: user.id,
    tvmazeId,
    episodeId,
    season,
    number,
    watchedAt: new Date(),
  })
  void mirrorEpisodeWatched(user.id, tvmazeId, season, number, true)
  return c.json({ watched: true })
})

// ── continue watching ─────────────────────────────────────────────────────────────

export interface ContinueItem {
  tvmazeId: number
  title: string
  posterUrl: string | null
  nextEpisode: { id: number; season: number; number: number | null; name: string } | null
}

function nextUnwatched(episodes: ShowEpisode[], watched: Set<number>): ShowEpisode | null {
  const today = new Date().toISOString().slice(0, 10)
  const aired = episodes
    .filter((e) => e.season > 0 && (!e.airdate || e.airdate <= today))
    .sort((a, b) => a.season - b.season || (a.number ?? 0) - (b.number ?? 0))
  return aired.find((e) => !watched.has(e.id)) ?? null
}

libraryRoute.get('/continue', async (c) => {
  const user = c.get('user')
  // Shows the user is actively watching: status='watching' OR has at least one watched episode.
  const watchlistShows = await db
    .select()
    .from(mediaWatchlist)
    .where(and(eq(mediaWatchlist.userId, user.id), eq(mediaWatchlist.mediaType, 'show'), isNull(mediaWatchlist.deletedAt)))

  const watchedRows = await db
    .select()
    .from(showWatchedEpisodes)
    .where(eq(showWatchedEpisodes.userId, user.id))

  const watchedByShow = new Map<number, Set<number>>()
  for (const r of watchedRows) {
    const set = watchedByShow.get(r.tvmazeId) ?? new Set<number>()
    set.add(r.episodeId)
    watchedByShow.set(r.tvmazeId, set)
  }

  const activeIds = new Set<number>()
  const meta = new Map<number, { title: string; posterUrl: string | null }>()
  for (const w of watchlistShows) {
    const id = Number(w.refId)
    if (!Number.isInteger(id)) continue
    meta.set(id, { title: w.title, posterUrl: w.posterUrl })
    if (w.status === 'watching') activeIds.add(id)
  }
  for (const id of watchedByShow.keys()) activeIds.add(id)

  const items: ContinueItem[] = []
  await Promise.all(
    [...activeIds].map(async (id) => {
      const episodes = await getShowEpisodes(id)
      if (!episodes.length) return
      const next = nextUnwatched(episodes, watchedByShow.get(id) ?? new Set())
      // Only surface shows that have been started (some watched) or explicitly 'watching'.
      const started = (watchedByShow.get(id)?.size ?? 0) > 0
      if (!started && !meta.has(id)) return
      items.push({
        tvmazeId: id,
        title: meta.get(id)?.title ?? '',
        posterUrl: meta.get(id)?.posterUrl ?? null,
        nextEpisode: next ? { id: next.id, season: next.season, number: next.number, name: next.name } : null,
      })
    }),
  )

  // Started shows with a next episode first; caught-up shows last.
  items.sort((a, b) => Number(!!b.nextEpisode) - Number(!!a.nextEpisode))
  return c.json({ items })
})

export { libraryRoute }

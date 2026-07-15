// Background poller for media_requests: advances each non-terminal request row
// (requested → downloading with progress → ready in Plex), emits the one-time
// "ready to watch" notification, and periodically syncs requests filed directly in
// Overseerr's own UI by linked users (origin 'external') so those notify too.
// Mirrors startYoutubeFeedPoller: setInterval + overlap guard, no-op when unconfigured.

import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { mediaRequests, toolUserConfig } from '@/db/schema'
import {
  getIntegrationsConfig, overseerrRequests, overseerrStatusByTmdbId,
  radarrMovieById, radarrQueue, sonarrSeriesById, sonarrQueue, type ArrQueueItem,
} from '@/lib/media/integrations'
import { getUserPlexConnection } from '@/lib/plex/account'
import { findInPlex } from '@/lib/plex/index'
import { emitNotification } from '@/lib/notify/index'

const TICK_MS = 2 * 60 * 1000
const EXTERNAL_SYNC_EVERY = 5 // ~10 minutes

type RequestRow = typeof mediaRequests.$inferSelect

let _timer: ReturnType<typeof setInterval> | null = null
let _running = false
let _tick = 0

export function startMediaRequestsPoller(): void {
  if (_timer) return
  _timer = setInterval(async () => {
    if (_running) return
    _running = true
    try {
      const cfg = await getIntegrationsConfig()
      const anyConfigured = !!(
        (cfg.overseerr_url && cfg.overseerr_key) ||
        (cfg.radarr_url && cfg.radarr_key) ||
        (cfg.sonarr_url && cfg.sonarr_key)
      )
      if (!anyConfigured) return
      _tick++
      if (_tick % EXTERNAL_SYNC_EVERY === 1 && cfg.overseerr_url && cfg.overseerr_key) {
        await syncExternalOverseerrRequests()
      }
      await advanceRequests()
    } catch (err) {
      console.warn('[mediaRequests] poller error:', err)
    } finally {
      _running = false
    }
  }, TICK_MS)
}

// ── Advance in-flight requests ────────────────────────────────────────────────────────

async function advanceRequests(): Promise<void> {
  const rows = await db.select().from(mediaRequests)
    .where(inArray(mediaRequests.status, ['requested', 'downloading']))
  if (!rows.length) return

  // One queue snapshot per tick, shared across rows.
  const [rQueue, sQueue] = await Promise.all([radarrQueue(), sonarrQueue()])

  for (const row of rows) {
    try {
      await advanceOne(row, rQueue, sQueue)
    } catch (err) {
      console.warn(`[mediaRequests] advance failed for "${row.title}":`, err)
    }
  }
}

async function advanceOne(row: RequestRow, rQueue: ArrQueueItem[], sQueue: ArrQueueItem[]): Promise<void> {
  const now = new Date()

  // 1) Ready check: the title exists in Plex (guid match preferred; user token, global fallback).
  const conn = await getUserPlexConnection(row.userId)
  if (conn) {
    const match = await findInPlex(conn, {
      type: row.mediaType, title: row.title, year: row.year,
      imdb: row.imdbId, tvdb: row.tvdbId,
    })
    if (match.present && match.ratingKey) {
      await markReady(row, match.ratingKey, match.deepLink)
      return
    }
  }

  // 2) Downloading check: a queue item for this title (by arr library id, else title match).
  const queue = row.pipeline === 'radarr' ? rQueue : row.pipeline === 'sonarr' ? sQueue : [...rQueue, ...sQueue]
  const libraryId = Number(row.externalId) || null
  const qItem = queue.find((q) =>
    row.pipeline !== 'overseerr' && libraryId != null
      ? q.libraryId === libraryId
      : q.title.toLowerCase() === row.title.toLowerCase(),
  )
  if (qItem) {
    await db.update(mediaRequests).set({
      status: 'downloading', progress: qItem.progress, error: null, lastCheckedAt: now, updatedAt: now,
    }).where(eq(mediaRequests.id, row.id))
    return
  }

  // 3) Downloaded-but-not-yet-in-Plex (or no Plex): arr hasFile / Overseerr available also
  //    count as ready, so users without Plex visibility still get their notification.
  let downloaded = false
  if (row.pipeline === 'radarr' && libraryId) {
    downloaded = (await radarrMovieById(libraryId))?.hasFile === true
  } else if (row.pipeline === 'sonarr' && libraryId) {
    downloaded = (await sonarrSeriesById(libraryId))?.hasFile === true
  } else if (row.pipeline === 'overseerr' && row.tmdbId) {
    downloaded = (await overseerrStatusByTmdbId(row.tmdbId, row.mediaType)) === 'available'
  }
  if (downloaded) {
    await markReady(row, null, null)
    return
  }

  await db.update(mediaRequests).set({ lastCheckedAt: now, updatedAt: now }).where(eq(mediaRequests.id, row.id))
}

async function markReady(row: RequestRow, ratingKey: string | null, deepLink: string | null): Promise<void> {
  const now = new Date()
  await db.update(mediaRequests).set({
    status: 'ready', progress: 100,
    plexRatingKey: ratingKey ?? row.plexRatingKey, plexDeepLink: deepLink ?? row.plexDeepLink,
    error: null, lastCheckedAt: now, updatedAt: now,
  }).where(eq(mediaRequests.id, row.id))

  if (row.notifiedAt) return
  const url = deepLink
    ?? (row.mediaType === 'show' ? `/shows/${row.refId}` : `/movies/${encodeURIComponent(row.refId)}`)
  const id = await emitNotification({
    type: 'download_complete',
    userId: row.userId,
    payload: { label: row.title },
    title: `${row.title} is ready to watch`,
    body: row.year ? `${row.title} (${row.year}) has finished downloading.` : `${row.title} has finished downloading.`,
    url,
    dedupeKey: `media-ready:${row.id}`,
  })
  if (id !== null) {
    await db.update(mediaRequests).set({ notifiedAt: now }).where(eq(mediaRequests.id, row.id))
  }
}

// ── Sync requests filed directly in Overseerr by linked users ────────────────────────

/** Cached map: Overseerr plexId (as string) → app userId, built from the overseerr_user_id
 *  cache plus the plex account resolution used when users request in-app. To avoid hammering
 *  plex.tv, external sync only matches users whose Plex account id is already stored locally
 *  (admin mapping or prior link). */
async function plexIdToUserMap(): Promise<Map<string, string>> {
  const rows = await db.select().from(toolUserConfig)
    .where(and(eq(toolUserConfig.toolId, 'plex'), eq(toolUserConfig.key, 'plex_account_id')))
  const map = new Map<string, string>()
  for (const r of rows) {
    try {
      const id = String(JSON.parse(r.value) ?? '').trim()
      if (id) map.set(id, r.userId)
    } catch { /* ignore */ }
  }
  return map
}

async function syncExternalOverseerrRequests(): Promise<void> {
  const requests = await overseerrRequests(100)
  if (!requests.length) return
  const byPlexId = await plexIdToUserMap()

  // Also cover linked-token users (their account id is not in tool_user_config under
  // plex_account_id): resolve lazily, once per user with a cached overseerr_user_id.
  const overseerrIdRows = await db.select().from(toolUserConfig)
    .where(and(eq(toolUserConfig.toolId, 'media_integrations'), eq(toolUserConfig.key, 'overseerr_user_id')))
  const userByOverseerrId = new Map<number, string>()
  for (const r of overseerrIdRows) {
    try {
      const id = Number(JSON.parse(r.value))
      if (Number.isInteger(id) && id > 0) userByOverseerrId.set(id, r.userId)
    } catch { /* ignore */ }
  }

  for (const req of requests) {
    const userId =
      (req.overseerrUserId != null ? userByOverseerrId.get(req.overseerrUserId) : undefined)
      ?? (req.plexId != null ? byPlexId.get(String(req.plexId)) : undefined)
    if (!userId || !req.tmdbId) continue

    // refId convention: shows use the TVMaze id which we don't have here, so external rows
    // key on a tmdb-scoped refId — the unique index still dedupes repeat syncs.
    const refId = `tmdb:${req.tmdbId}`
    const [existing] = await db.select({ id: mediaRequests.id }).from(mediaRequests).where(and(
      eq(mediaRequests.userId, userId), eq(mediaRequests.mediaType, req.mediaType),
      eq(mediaRequests.refId, refId),
    )).limit(1)
    if (existing) continue
    // Skip rows already tracked from an in-app request (same external request id).
    const [tracked] = await db.select({ id: mediaRequests.id }).from(mediaRequests).where(and(
      eq(mediaRequests.userId, userId), eq(mediaRequests.pipeline, 'overseerr'),
      eq(mediaRequests.externalId, String(req.requestId)),
    )).limit(1)
    if (tracked) continue

    const detail = await overseerrTitleDetail(req.tmdbId, req.mediaType)
    const now = new Date()
    await db.insert(mediaRequests).values({
      id: crypto.randomUUID(), userId, mediaType: req.mediaType, refId,
      title: detail?.title ?? `TMDB ${req.tmdbId}`, year: detail?.year ?? null,
      posterUrl: detail?.posterUrl ?? null,
      tmdbId: req.tmdbId, tvdbId: req.tvdbId, imdbId: detail?.imdbId ?? null,
      pipeline: 'overseerr', externalId: String(req.requestId), origin: 'external',
      status: req.status === 'available' ? 'ready' : 'requested',
      // Already-available external requests predate tracking — don't notify retroactively.
      notifiedAt: req.status === 'available' ? now : null,
      progress: req.status === 'available' ? 100 : null,
      createdAt: now, updatedAt: now,
    }).onConflictDoNothing()
  }
}

// Title/year/poster for an external request (Overseerr movie/tv detail endpoint).
async function overseerrTitleDetail(
  tmdbId: number,
  mediaType: 'movie' | 'show',
): Promise<{ title: string; year: number | null; posterUrl: string | null; imdbId: string | null } | null> {
  const cfg = await getIntegrationsConfig()
  if (!cfg.overseerr_url || !cfg.overseerr_key) return null
  try {
    const res = await fetch(`${cfg.overseerr_url.trim().replace(/\/+$/, '')}/api/v1/${mediaType === 'show' ? 'tv' : 'movie'}/${tmdbId}`, {
      headers: { 'X-Api-Key': cfg.overseerr_key, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const data = (await res.json()) as {
      title?: string; name?: string; releaseDate?: string; firstAirDate?: string
      posterPath?: string; externalIds?: { imdbId?: string }
    }
    const title = data.title ?? data.name
    if (!title) return null
    return {
      title,
      year: Number((data.releaseDate ?? data.firstAirDate ?? '').slice(0, 4)) || null,
      posterUrl: data.posterPath ? `https://image.tmdb.org/t/p/w342${data.posterPath}` : null,
      imdbId: data.externalIds?.imdbId ?? null,
    }
  } catch {
    return null
  }
}

// Two-way mirror between the app's media watchlist and the Plex account Watchlist (cloud).
//
// Plex exposes ONE account Watchlist (the configured token's account), but the app is
// multi-user — so mirroring is scoped to a single "linked" user (config `linked_user_id`,
// else the earliest admin). Pushes happen inline on add/remove for snappiness; a periodic
// reconcile is the source of correctness and also pulls Plex-side changes back in.
//
// Deletes are tombstones (deletedAt), never hard removals, so a title the user removed in the
// app isn't re-imported from Plex on the next pass — and vice-versa.

import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { mediaWatchlist } from '@/db/schema'
import { logger } from '@/lib/logger'
import {
  searchDiscover,
  getAccountWatchlist,
  addToPlexWatchlist,
  removeFromPlexWatchlist,
  type PlexConnection,
  type DiscoverHit,
} from './index'
import { resolveShowId } from './resolve'
import { getUserPlexConnection, isUserPlexLinked, listLinkedPlexUserIds } from './account'
import { pullPlexProgress } from './watched'
import { getShowDetails, resolveShow } from '@/lib/shows/tvmaze'

type WatchlistRow = typeof mediaWatchlist.$inferSelect

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** Year embedded in a watchlist subtitle ("Comedy · 2023" / "ABC · 2020"), if any. */
function yearFromSubtitle(subtitle: string | null): number | null {
  const m = subtitle?.match(/\b(19|20)\d{2}\b/)
  return m ? Number(m[0]) : null
}

/** Canonical identity for matching an app row against a Plex item across the two ID spaces. */
function appRowKey(row: Pick<WatchlistRow, 'mediaType' | 'refId' | 'title'>): string {
  return row.mediaType === 'show' ? `show:${row.refId}` : `movie:${norm(row.title)}`
}

async function discoverHitKey(hit: DiscoverHit): Promise<string | null> {
  if (hit.type === 'movie') return `movie:${norm(hit.title)}`
  const id = await resolveShowId(hit.guids, hit.title, hit.year)
  return id ? `show:${id}` : null
}

// ── inline mirror (fire-and-forget from the route) ───────────────────────────────

/** Push a freshly-added/revived app row to that user's own Plex account Watchlist. Best-effort. */
export async function mirrorWatchlistAdd(rowId: string): Promise<void> {
  const [row] = await db.select().from(mediaWatchlist).where(eq(mediaWatchlist.id, rowId)).limit(1)
  if (!row || row.deletedAt) return
  // Only mirror for users who linked their OWN Plex account — never write to the fallback admin token.
  if (!(await isUserPlexLinked(row.userId))) return
  const conn = await getUserPlexConnection(row.userId)
  if (!conn) return
  try {
    let ratingKey = row.plexRatingKey
    if (!ratingKey) {
      const hit = await searchDiscover(conn, { type: row.mediaType, title: row.title, year: yearFromSubtitle(row.subtitle) })
      ratingKey = hit?.ratingKey ?? null
    }
    if (!ratingKey) return
    const ok = await addToPlexWatchlist(conn, ratingKey)
    if (ok) {
      await db
        .update(mediaWatchlist)
        .set({ plexRatingKey: ratingKey, plexSyncedAt: new Date() })
        .where(eq(mediaWatchlist.id, rowId))
    }
  } catch (err) {
    logger.warn(`[plex] mirror add failed for "${row.title}": ${err}`)
  }
}

/** Remove a just-tombstoned app row from that user's own Plex account Watchlist. Best-effort. */
export async function mirrorWatchlistRemove(row: WatchlistRow): Promise<void> {
  if (!(await isUserPlexLinked(row.userId))) return
  const conn = await getUserPlexConnection(row.userId)
  if (!conn) return
  try {
    let ratingKey = row.plexRatingKey
    if (!ratingKey) {
      const hit = await searchDiscover(conn, { type: row.mediaType, title: row.title, year: yearFromSubtitle(row.subtitle) })
      ratingKey = hit?.ratingKey ?? null
    }
    if (ratingKey) await removeFromPlexWatchlist(conn, ratingKey)
  } catch (err) {
    logger.warn(`[plex] mirror remove failed for "${row.title}": ${err}`)
  }
}

// ── periodic reconcile (source of correctness + Plex→app import) ──────────────────

/** Build the app-watchlist row fields for a Plex Watchlist item we're importing. */
async function discoverToRow(hit: DiscoverHit): Promise<{ mediaType: 'show' | 'movie'; refId: string; title: string; posterUrl: string | null; subtitle: string | null } | null> {
  if (hit.type === 'movie') {
    return { mediaType: 'movie', refId: hit.title, title: hit.title, posterUrl: null, subtitle: hit.year ? String(hit.year) : null }
  }
  const id = await resolveShowId(hit.guids, hit.title, hit.year)
  if (!id) return null
  const details = await getShowDetails(id)
  if (details) {
    return {
      mediaType: 'show',
      refId: String(id),
      title: details.name,
      posterUrl: details.poster,
      subtitle: [details.network, details.year].filter(Boolean).join(' · ') || null,
    }
  }
  const summary = await resolveShow(hit.title, hit.year)
  return {
    mediaType: 'show',
    refId: String(id),
    title: summary?.name ?? hit.title,
    posterUrl: summary?.poster ?? null,
    subtitle: summary ? [summary.network, summary.year].filter(Boolean).join(' · ') || null : null,
  }
}

let _running = false

/** One full reconcile pass across every user who linked their own Plex account. */
export async function reconcileWatchlist(): Promise<void> {
  if (_running) return
  const userIds = await listLinkedPlexUserIds()
  if (!userIds.length) return
  _running = true
  try {
    for (const userId of userIds) {
      const conn = await getUserPlexConnection(userId)
      if (conn) await reconcileWatchlistForUser(userId, conn)
    }
  } finally {
    _running = false
  }
}

/** Reconcile one user's app watchlist against their own Plex account Watchlist (two-way). */
async function reconcileWatchlistForUser(linked: string, conn: PlexConnection): Promise<void> {
  try {
    const plexItems = await getAccountWatchlist(conn)
    const rows = await db.select().from(mediaWatchlist).where(eq(mediaWatchlist.userId, linked))

    const activeByKey = new Map<string, WatchlistRow>()
    const tombstoneKeys = new Set<string>()
    for (const r of rows) {
      const key = appRowKey(r)
      if (r.deletedAt) tombstoneKeys.add(key)
      else activeByKey.set(key, r)
    }

    const plexByKey = new Map<string, DiscoverHit>()
    for (const hit of plexItems) {
      const key = await discoverHitKey(hit)
      if (key) plexByKey.set(key, hit)
    }

    // App → Plex: active rows missing from the Plex Watchlist get pushed.
    for (const [key, row] of activeByKey) {
      if (!plexByKey.has(key)) await mirrorWatchlistAdd(row.id)
    }
    // Tombstones still present on Plex → push the removal, then forget the tombstone.
    for (const r of rows) {
      if (!r.deletedAt) continue
      if (plexByKey.has(appRowKey(r))) await mirrorWatchlistRemove(r)
    }

    // Plex → App: items on Plex that aren't active and weren't deliberately removed → import.
    const now = new Date()
    for (const [key, hit] of plexByKey) {
      if (activeByKey.has(key) || tombstoneKeys.has(key)) continue
      const fields = await discoverToRow(hit)
      if (!fields) continue
      const [existing] = await db
        .select()
        .from(mediaWatchlist)
        .where(and(eq(mediaWatchlist.userId, linked), eq(mediaWatchlist.mediaType, fields.mediaType), eq(mediaWatchlist.refId, fields.refId)))
        .limit(1)
      if (existing) continue
      await db.insert(mediaWatchlist).values({
        id: crypto.randomUUID(),
        userId: linked,
        mediaType: fields.mediaType,
        refId: fields.refId,
        title: fields.title,
        posterUrl: fields.posterUrl,
        subtitle: fields.subtitle,
        status: 'want',
        plexRatingKey: hit.ratingKey,
        plexSyncedAt: now,
        addedAt: now,
        updatedAt: now,
      })
    }
  } catch (err) {
    logger.warn(`[plex] watchlist reconcile error (user ${linked}): ${err}`)
  }
}

let _timer: ReturnType<typeof setInterval> | null = null
const RECONCILE_INTERVAL_MS = 15 * 60 * 1000

async function syncPass(): Promise<void> {
  await reconcileWatchlist()
  await pullPlexProgress()
  // Remove-watched sweep over exported video libraries (YouTube/TikTok/Vimeo/Reddit) —
  // fully-played episodes leave the Plex tree and their offline saves are deleted.
  const { runWatchedSweep } = await import('@/lib/plex/export/watchedSweep')
  await runWatchedSweep().catch((err) => logger.warn(`[plex] watched sweep failed: ${err}`))
}

/** Start the 15-minute Plex sync loop: watchlist mirror + watched-progress pull. No-op until configured. */
export function startPlexWatchlistSync(): void {
  if (_timer) return
  // Kick once shortly after boot, then on the interval.
  setTimeout(() => void syncPass(), 30_000)
  _timer = setInterval(() => void syncPass(), RECONCILE_INTERVAL_MS)
}

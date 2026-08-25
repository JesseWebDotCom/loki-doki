// Scrobbling out: submit music listens to ListenBrainz on the user's behalf.
//
// Contract: playback/history paths only ever call enqueueListen(), which is a single
// local INSERT into scrobble_queue (plus a briefly-cached settings read). All network
// I/O happens in the background flusher, batched per user and retried with backoff,
// so an unreachable listenbrainz.org can never slow a play or a history write.
//
// Last.fm is deliberately not implemented: it requires a per-install API key pair and
// an interactive web-auth handshake to mint a session key, which doesn't fit a
// self-hosted "paste one token" settings row. ListenBrainz's user token does.

import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { db, sqlite } from '@/db'
import { scrobbleQueue, userPreferences } from '@/db/schema'
import { logger } from '@/lib/logger'

const LB_API = 'https://api.listenbrainz.org'
const TOKEN_PREF = 'music.scrobble.listenbrainz_token'
const ENABLED_PREF = 'music.scrobble.enabled'
const BACKFILL_PREF = 'music.scrobble.backfilled_through'

const MAX_ATTEMPTS = 10
const BATCH_PER_SUBMIT = 50          // listens per submit-listens call
const FLUSH_INTERVAL_MS = 30_000
const PICK_LIMIT = 400               // queue rows considered per flush pass

export interface ListenPayload {
  artist: string
  title: string
  durationSec?: number | null
  listenedAt: number                 // epoch seconds
}

// ── Settings ────────────────────────────────────────────────────────────────────────

export interface ScrobbleSettings { enabled: boolean; token: string | null }

async function readPref(userId: string, key: string): Promise<string | null> {
  const [row] = await db.select({ value: userPreferences.value }).from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, key))).limit(1)
  if (!row?.value) return null
  try { return JSON.parse(row.value) as string } catch { return null }
}

async function writePref(userId: string, key: string, value: unknown): Promise<void> {
  const now = new Date()
  await db.insert(userPreferences).values({
    id: randomUUID(), userId, key, value: JSON.stringify(value), updatedAt: now,
  }).onConflictDoUpdate({
    target: [userPreferences.userId, userPreferences.key],
    set: { value: JSON.stringify(value), updatedAt: now },
  })
}

export async function getScrobbleSettings(userId: string): Promise<ScrobbleSettings> {
  const [token, enabled] = await Promise.all([readPref(userId, TOKEN_PREF), readPref(userId, ENABLED_PREF)])
  return { enabled: enabled === 'true', token: token || null }
}

export async function setScrobbleSettings(userId: string, patch: { token?: string | null; enabled?: boolean }): Promise<void> {
  if (patch.token !== undefined) await writePref(userId, TOKEN_PREF, patch.token ?? '')
  if (patch.enabled !== undefined) await writePref(userId, ENABLED_PREF, patch.enabled ? 'true' : 'false')
  settingsCache.delete(userId)
}

// The enqueue path runs on every history write, so cache "is scrobbling on for this
// user" for a minute instead of hitting user_preferences twice per play.
const settingsCache = new Map<string, { at: number; s: ScrobbleSettings }>()
async function cachedSettings(userId: string): Promise<ScrobbleSettings> {
  const hit = settingsCache.get(userId)
  if (hit && Date.now() - hit.at < 60_000) return hit.s
  const s = await getScrobbleSettings(userId)
  settingsCache.set(userId, { at: Date.now(), s })
  return s
}

/** GET /1/validate-token: is this ListenBrainz token real? Returns the LB username on
 *  success, throws with a user-facing message otherwise. */
export async function validateListenBrainzToken(token: string): Promise<string> {
  const res = await fetch(`${LB_API}/1/validate-token`, {
    headers: { Authorization: `Token ${token}` },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`ListenBrainz responded ${res.status}`)
  const body = await res.json() as { valid?: boolean; user_name?: string }
  if (!body.valid) throw new Error('ListenBrainz rejected that token')
  return body.user_name ?? 'unknown'
}

// ── Enqueue (the only call playback paths make) ─────────────────────────────────────

/** Queue one listen for background submission. No-op unless the user enabled
 *  scrobbling and saved a token. Never throws (callers fire-and-forget). */
export async function enqueueListen(userId: string, listen: ListenPayload): Promise<void> {
  try {
    if (!listen.artist?.trim() || !listen.title?.trim()) return
    const s = await cachedSettings(userId)
    if (!s.enabled || !s.token) return
    await db.insert(scrobbleQueue).values({
      id: randomUUID(), userId, service: 'listenbrainz',
      payloadJson: JSON.stringify({
        artist: listen.artist.trim(),
        title: listen.title.trim(),
        durationSec: listen.durationSec ?? null,
        listenedAt: Math.floor(listen.listenedAt),
      }),
      status: 'pending', attempts: 0, nextAttemptAt: null, createdAt: new Date(),
    })
  } catch (err) {
    logger.debug(`[scrobble] enqueue failed for ${userId}: ${String(err)}`)
  }
}

// ── Backfill ────────────────────────────────────────────────────────────────────────

/** Queue the user's existing music history for submission. Only rows played before
 *  "now" and after the last backfill high-water mark, so pressing the button twice
 *  never double-submits. Rows are staggered so the flusher trickles them out. */
export async function backfillHistory(userId: string): Promise<number> {
  const s = await getScrobbleSettings(userId)
  if (!s.enabled || !s.token) throw new Error('Turn scrobbling on and save a token first')

  const since = Number(await readPref(userId, BACKFILL_PREF)) || 0
  const nowSec = Math.floor(Date.now() / 1000)
  const rows = sqlite.prepare(`
    SELECT title, artist, duration_sec AS durationSec, played_at AS playedAt
    FROM music_history
    WHERE user_id = ? AND played_at > ? AND played_at <= ?
      AND artist IS NOT NULL AND artist != ''
    ORDER BY played_at ASC
    LIMIT 20000
  `).all(userId, since, nowSec) as Array<{ title: string; artist: string; durationSec: number | null; playedAt: number }>

  if (!rows.length) return 0
  const now = new Date()
  // Stagger: one BATCH_PER_SUBMIT chunk becomes eligible every flush tick, keeping the
  // submission rate around 50 listens / 30s regardless of history size.
  for (let i = 0; i < rows.length; i += 200) {
    await db.insert(scrobbleQueue).values(rows.slice(i, i + 200).map((r, j) => ({
      id: randomUUID(), userId, service: 'listenbrainz' as const,
      payloadJson: JSON.stringify({ artist: r.artist, title: r.title, durationSec: r.durationSec, listenedAt: r.playedAt }),
      status: 'pending' as const, attempts: 0,
      nextAttemptAt: new Date(Date.now() + Math.floor((i + j) / BATCH_PER_SUBMIT) * FLUSH_INTERVAL_MS),
      createdAt: now,
    })))
  }
  await writePref(userId, BACKFILL_PREF, String(rows[rows.length - 1]!.playedAt))
  return rows.length
}

/** Queue depth for the settings UI. */
export async function queueStatus(userId: string): Promise<{ pending: number; failed: number; lastError: string | null }> {
  const [pending] = await db.select({ n: sql<number>`count(*)` }).from(scrobbleQueue)
    .where(and(eq(scrobbleQueue.userId, userId), eq(scrobbleQueue.status, 'pending')))
  const [failed] = await db.select({ n: sql<number>`count(*)` }).from(scrobbleQueue)
    .where(and(eq(scrobbleQueue.userId, userId), eq(scrobbleQueue.status, 'failed')))
  const [lastErr] = await db.select({ lastError: scrobbleQueue.lastError }).from(scrobbleQueue)
    .where(and(eq(scrobbleQueue.userId, userId), eq(scrobbleQueue.status, 'failed')))
    .limit(1)
  return { pending: pending?.n ?? 0, failed: failed?.n ?? 0, lastError: lastErr?.lastError ?? null }
}

/** Re-queue this user's failed rows (settings "Retry failed" affordance). */
export async function retryFailed(userId: string): Promise<void> {
  await db.update(scrobbleQueue)
    .set({ status: 'pending', attempts: 0, nextAttemptAt: null, lastError: null })
    .where(and(eq(scrobbleQueue.userId, userId), eq(scrobbleQueue.status, 'failed')))
}

// ── Flusher ─────────────────────────────────────────────────────────────────────────

async function submitBatch(token: string, listens: Array<{ artist: string; title: string; durationSec: number | null; listenedAt: number }>): Promise<void> {
  const res = await fetch(`${LB_API}/1/submit-listens`, {
    method: 'POST',
    headers: { Authorization: `Token ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      listen_type: 'import',
      payload: listens.map(l => ({
        listened_at: l.listenedAt,
        track_metadata: {
          artist_name: l.artist,
          track_name: l.title,
          additional_info: {
            media_player: 'MaiPai Home',
            submission_client: 'MaiPai Home',
            ...(l.durationSec ? { duration_ms: Math.round(l.durationSec * 1000) } : {}),
          },
        },
      })),
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`submit-listens ${res.status}: ${text.slice(0, 200)}`)
  }
}

async function flushOnce(): Promise<void> {
  const due = await db.select().from(scrobbleQueue)
    .where(and(
      eq(scrobbleQueue.status, 'pending'),
      or(isNull(scrobbleQueue.nextAttemptAt), lte(scrobbleQueue.nextAttemptAt, new Date())),
    ))
    .orderBy(asc(scrobbleQueue.createdAt))
    .limit(PICK_LIMIT)
  if (!due.length) return

  const byUser = new Map<string, typeof due>()
  for (const row of due) {
    const list = byUser.get(row.userId) ?? []
    list.push(row)
    byUser.set(row.userId, list)
  }

  for (const [userId, rows] of byUser) {
    const s = await getScrobbleSettings(userId)
    if (!s.enabled || !s.token) {
      // Scrobbling turned off after rows queued: drop them rather than retry forever.
      await db.delete(scrobbleQueue).where(inArray(scrobbleQueue.id, rows.map(r => r.id)))
      continue
    }
    // One submit per user per pass keeps us politely under ListenBrainz rate limits.
    const batch = rows.slice(0, BATCH_PER_SUBMIT)
    const listens = batch.map(r => {
      try { return JSON.parse(r.payloadJson) as { artist: string; title: string; durationSec: number | null; listenedAt: number } }
      catch { return null }
    }).filter((l): l is NonNullable<typeof l> => l !== null)
    try {
      if (listens.length) await submitBatch(s.token, listens)
      await db.delete(scrobbleQueue).where(inArray(scrobbleQueue.id, batch.map(r => r.id)))
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err).slice(0, 300)
      for (const r of batch) {
        const attempts = r.attempts + 1
        if (attempts >= MAX_ATTEMPTS) {
          await db.update(scrobbleQueue)
            .set({ status: 'failed', attempts, lastError: msg })
            .where(eq(scrobbleQueue.id, r.id))
        } else {
          // Exponential backoff, capped at 6h: transient outages retry soon, a bad
          // token doesn't hammer the API.
          const delayMs = Math.min(60_000 * 2 ** attempts, 6 * 60 * 60 * 1000)
          await db.update(scrobbleQueue)
            .set({ attempts, nextAttemptAt: new Date(Date.now() + delayMs), lastError: msg })
            .where(eq(scrobbleQueue.id, r.id))
        }
      }
      logger.warn(`[scrobble] submit failed for user ${userId}: ${msg}`)
    }
  }
}

let _timer: ReturnType<typeof setInterval> | null = null
let _flushing = false

export function startScrobbleFlusher(): void {
  if (_timer) return
  _timer = setInterval(async () => {
    if (_flushing) return
    _flushing = true
    try { await flushOnce() }
    catch (err) { logger.warn(`[scrobble] flush error: ${String(err)}`) }
    finally { _flushing = false }
  }, FLUSH_INTERVAL_MS)
}

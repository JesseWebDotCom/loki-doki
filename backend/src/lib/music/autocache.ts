// Offline mix auto-cache - a per-user toggle that keeps their top N most-played and
// favorited tracks downloaded, reusing the existing offline plumbing (enqueueVideoSave ->
// download_jobs -> ytDownloads, kind 'audio'). Preferences live in user_preferences under
// 'music.autocache'; the daily music intel job (intelJobs.ts) re-runs the pass so the
// cached set follows the listener's taste. Only YouTube refs are downloadable - owned
// local/plex tracks are already on the household's disks and are skipped.

import { and, eq, inArray } from 'drizzle-orm'
import { db, sqlite } from '@/db'
import { musicFavorites, userPreferences, users, ytDownloads } from '@/db/schema'
import { enqueueVideoSave } from '@/lib/youtube/automation'
import { looksLikeVideo } from '@/lib/music/junk'
import { logger } from '@/lib/logger'

export interface AutocacheSettings { enabled: boolean; count: number }
export interface AutocacheTrackStatus { videoId: string; title: string; artist: string | null; status: 'ready' | 'pending' | 'downloading' | 'failed' | 'missing' }
export interface AutocacheStatus extends AutocacheSettings {
  total: number
  ready: number
  inProgress: number
  tracks: AutocacheTrackStatus[]
}

const PREF_KEY = 'music.autocache'
const DEFAULT_COUNT = 50
const DAY = 86_400   // played_at is unix SECONDS

export async function getAutocacheSettings(userId: string): Promise<AutocacheSettings> {
  const [row] = await db.select({ value: userPreferences.value }).from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, PREF_KEY))).limit(1)
  if (!row) return { enabled: false, count: DEFAULT_COUNT }
  try {
    const v = JSON.parse(row.value) as Partial<AutocacheSettings>
    const count = Number.isFinite(v.count) && (v.count as number) > 0 ? Math.min(Math.floor(v.count as number), 200) : DEFAULT_COUNT
    return { enabled: v.enabled === true, count }
  } catch { return { enabled: false, count: DEFAULT_COUNT } }
}

export async function setAutocacheSettings(userId: string, settings: AutocacheSettings): Promise<void> {
  const now = new Date()
  const value = JSON.stringify({ enabled: settings.enabled === true, count: Math.min(Math.max(1, Math.floor(settings.count || DEFAULT_COUNT)), 200) })
  await db.insert(userPreferences)
    .values({ id: crypto.randomUUID(), userId, key: PREF_KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: [userPreferences.userId, userPreferences.key], set: { value, updatedAt: now } })
}

interface TopTrack { videoId: string; title: string; artist: string | null }

/** Top N by plays (180 days) + favorite bonus, YouTube refs only (downloadable). */
async function topTracks(userId: string, n: number): Promise<TopTrack[]> {
  const since = Math.floor(Date.now() / 1000) - 180 * DAY
  const rows = sqlite.prepare(`
    SELECT video_id, MAX(title) AS title, MAX(artist) AS artist, COUNT(*) AS plays
    FROM music_history
    WHERE user_id = ? AND played_at >= ?
    GROUP BY video_id
    ORDER BY plays DESC
    LIMIT 400
  `).all(userId, since) as Array<{ video_id: string; title: string; artist: string | null; plays: number }>

  const favs = await db.select().from(musicFavorites)
    .where(and(eq(musicFavorites.userId, userId), eq(musicFavorites.kind, 'song')))
  const favSet = new Set(favs.map(f => f.refId))

  const weighted = new Map<string, { t: TopTrack; w: number }>()
  for (const r of rows) {
    if (!r.video_id || r.video_id.includes(':') || !r.title) continue   // YouTube refs only
    if (looksLikeVideo(r.title, r.artist ?? '')) continue
    weighted.set(r.video_id, {
      t: { videoId: r.video_id, title: r.title, artist: r.artist },
      w: r.plays + (favSet.has(r.video_id) ? 5 : 0),
    })
  }
  // Favorites the listener hasn't played recently still count as "top" - they asked for them.
  for (const f of favs) {
    if (!f.refId || f.refId.includes(':') || !f.title || weighted.has(f.refId)) continue
    weighted.set(f.refId, { t: { videoId: f.refId, title: f.title, artist: f.artist }, w: 5 })
  }
  return [...weighted.values()].sort((a, b) => b.w - a.w).slice(0, n).map(x => x.t)
}

/** Live status of the auto-cache set (top-N list joined with each track's download row). */
export async function getAutocacheStatus(userId: string): Promise<AutocacheStatus> {
  const settings = await getAutocacheSettings(userId)
  const top = await topTracks(userId, settings.count)
  const ids = top.map(t => t.videoId)
  const dlRows = ids.length
    ? await db.select({ videoId: ytDownloads.videoId, status: ytDownloads.status }).from(ytDownloads)
        .where(and(eq(ytDownloads.userId, userId), eq(ytDownloads.kind, 'audio'), inArray(ytDownloads.videoId, ids)))
    : []
  const statusById = new Map(dlRows.map(r => [r.videoId, r.status]))
  const tracks: AutocacheTrackStatus[] = top.map(t => {
    const s = statusById.get(t.videoId)
    const status: AutocacheTrackStatus['status'] =
      s === 'ready' ? 'ready' : s === 'failed' ? 'failed' : s === 'downloading' ? 'downloading' : s ? 'pending' : 'missing'
    return { ...t, status }
  })
  return {
    ...settings,
    total: tracks.length,
    ready: tracks.filter(t => t.status === 'ready').length,
    inProgress: tracks.filter(t => t.status === 'pending' || t.status === 'downloading').length,
    tracks,
  }
}

/** Enqueue downloads for every top-N track that isn't saved yet. Returns how many queued. */
export async function runAutocacheForUser(userId: string): Promise<number> {
  const settings = await getAutocacheSettings(userId)
  if (!settings.enabled) return 0
  const status = await getAutocacheStatus(userId)
  const missing = status.tracks.filter(t => t.status === 'missing')
  if (!missing.length) return 0
  const [u] = await db.select({ firstName: users.firstName }).from(users).where(eq(users.id, userId)).limit(1)
  let queued = 0
  for (const t of missing) {
    try {
      await enqueueVideoSave({
        userId, videoId: t.videoId, title: t.title, kind: 'audio',
        maxHeight: null, firstName: u?.firstName ?? 'user', origin: 'music',
      })
      queued++
    } catch (err) {
      logger.debug(`[autocache] enqueue failed for ${t.videoId}: ${String(err)}`)
    }
  }
  if (queued) logger.info(`[autocache] queued ${queued} tracks for ${userId}`)
  return queued
}

/** Daily-job entry: run the pass for every user who has the toggle on. */
export async function runAutocacheForAllUsers(): Promise<void> {
  const rows = await db.select({ userId: userPreferences.userId, value: userPreferences.value })
    .from(userPreferences).where(eq(userPreferences.key, PREF_KEY))
  for (const row of rows) {
    try {
      const v = JSON.parse(row.value) as Partial<AutocacheSettings>
      if (v.enabled === true) await runAutocacheForUser(row.userId)
    } catch { /* malformed pref - skip */ }
  }
}

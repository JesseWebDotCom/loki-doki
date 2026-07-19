// Station head cache: pre-built "first tracks" per station, so pressing play serves a
// ready head instantly instead of paying LLM query-gen + live YouTube Music searches +
// a fit pass on the tune-in critical path. Three moments feed it:
//   1. Opening the app/Music page (the tune-in tell) warms heads for EVERY visible station
//      (rolling, low concurrency) — the old bounded top-8 warm left most clicks cold.
//   2. Serving a cached head schedules a background rotation rebuild, so the NEXT tune-in
//      of the same station opens differently.
//   3. A cold tune-in (cache miss) builds the old way, then banks the pool for next time.
// Warm/rotation builds run off the critical path, so they use the MAIN model as the fit
// judge (better subgenre/era knowledge than the fast 3B judge the live path uses) and
// pre-resolve the likely openers' stream URLs into the 4h stream cache - by the time the
// player's <audio> element asks, both the track list and the bytes URL are hot.
//
// Warm/rotation builds also exclude the HOUSEHOLD's recent listening history up front.
// The /queue route filters served heads against the listener's last-48h plays; a pool
// built blind to that history converges on exactly the anthems just played and gets
// filtered down to nothing — which used to silently fall through to a 20-30s cold build.
// If filtering still empties a pool, the pool is served anyway (an instant repeat beats
// dead air) and a rebuild is scheduled.
//
// Entries are keyed by the station's seed identity (not user), so the pool is shared
// across the household; per-user variety comes from the route's history/exclude filter
// applied at serve time. Pools persist to data/cache/station-heads.json so a backend
// restart (routine in dev, where any edit restarts Bun) doesn't rewind every station
// to cold.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { desc, gt } from 'drizzle-orm'

import { buildStationQueue, type StationSeed, type StationQueueResult } from '@/lib/music/stationEngine'
import { dataDir } from '@/lib/download'
import { db } from '@/db'
import { musicHistory } from '@/db/schema'
import { logger } from '@/lib/logger'

const TTL_MS = 24 * 60 * 60_000   // pools stay serveable all day; rotation-on-serve keeps active ones fresh
const ROTATE_MS = 10 * 60_000     // a pool older than this rebuilds after serving
const HEAD_POOL = 10              // tracks banked per station (serves stay well-fed after filtering)
const OPENER_WARM = 3             // pool tracks whose stream URL + DJ intro get pre-warmed
const MAX_ENTRIES = 300           // ~120 built-ins + personal/shared stations, with headroom
const WARM_CONCURRENCY = 2
const PERSIST_PATH = join(dataDir, 'cache', 'station-heads.json')

interface HeadEntry {
  tracks: StationQueueResult['tracks']
  source: StationQueueResult['source']
  at: number
  building: boolean
}

const cache = new Map<string, HeadEntry>()

const keyFor = (seed: StationSeed): string =>
  [seed.name ?? '', seed.aiPrompt, seed.seedType ?? '', seed.seedValue ?? ''].join('\u0000')

// ── Disk persistence ───────────────────────────────────────────────────────────
// Small JSON snapshot (track metadata only, ~1KB/station) loaded lazily on first use and
// rewritten (debounced) after cache mutations. Stream URLs / DJ audio live in their own
// caches; a pool loaded from disk re-warms those via prewarmOpeners on its first serve.
let loaded: Promise<void> | null = null
function ensureLoaded(): Promise<void> {
  loaded ??= (async () => {
    try {
      const raw = JSON.parse(await readFile(PERSIST_PATH, 'utf8')) as {
        entries?: Array<[string, { tracks: HeadEntry['tracks']; source: HeadEntry['source']; at: number }]>
      }
      for (const [key, e] of raw.entries ?? []) {
        if (!e?.tracks?.length || Date.now() - e.at >= TTL_MS) continue
        cache.set(key, { tracks: e.tracks, source: e.source, at: e.at, building: false })
      }
    } catch { /* first boot or unreadable snapshot - start cold */ }
  })()
  return loaded
}

let persistTimer: ReturnType<typeof setTimeout> | null = null
function persistSoon(): void {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    void (async () => {
      try {
        const entries = [...cache.entries()]
          .filter(([, e]) => e.tracks.length && Date.now() - e.at < TTL_MS)
          .map(([k, e]) => [k, { tracks: e.tracks, source: e.source, at: e.at }])
        await mkdir(dirname(PERSIST_PATH), { recursive: true })
        await writeFile(PERSIST_PATH, JSON.stringify({ entries }))
      } catch (err) { logger.debug(`[stationHead] persist failed: ${err}`) }
    })()
  }, 3000)
}

// Pre-resolve stream URLs for the likely openers (plain YouTube refs only - library
// local:/plex: refs stream straight off disk and have no resolver latency to hide),
// and pre-generate DJ intro variants for them (djIntroCache.ts) so the voice is as
// instant as the audio. Idempotent: stream resolves hit the 4h stream cache and the
// intro warm skips fresh entries, so calling this on every serve just self-heals
// whatever expired (or was consumed) since the pool was built.
function prewarmOpeners(seed: StationSeed, tracks: StationQueueResult['tracks']): void {
  void (async () => {
    try {
      const { resolveStreamUrl } = await import('@/lib/youtube/stream')
      for (const t of tracks.slice(0, OPENER_WARM)) {
        if (t.videoId.includes(':')) continue
        await resolveStreamUrl(t.videoId, 'audio').catch(() => null)
      }
    } catch { /* stream lib unavailable - the lazy per-request resolve still works */ }
    try {
      if (seed.name) {
        // Intros are LLM+TTS work (unlike the cheap stream resolves above), so warm one
        // fewer than OPENER_WARM - the third opener only matters when history filtering
        // shifts the head twice, and its stream being hot already covers most of the cost.
        const { warmIntros } = await import('@/lib/music/djIntroCache')
        await warmIntros(seed.name, tracks.slice(0, 2))
      }
    } catch { /* intro warm is a fast path only - live generation still works */ }
  })()
}

function evictIfFull(): void {
  if (cache.size < MAX_ENTRIES) return
  let oldestKey: string | null = null
  let oldestAt = Infinity
  for (const [k, e] of cache) if (e.at < oldestAt) { oldestAt = e.at; oldestKey = k }
  if (oldestKey) cache.delete(oldestKey)
}

/** The household's recently played videoIds (any listener, last 48h). Excluded at BUILD
 *  time so pools survive the route's serve-time history filter instead of being built
 *  from exactly the tracks it will strike out. */
async function householdRecentIds(): Promise<string[]> {
  try {
    const since = new Date(Date.now() - 48 * 3600_000)
    const rows = await db.select({ videoId: musicHistory.videoId }).from(musicHistory)
      .where(gt(musicHistory.playedAt, since))
      .orderBy(desc(musicHistory.playedAt)).limit(100)
    return [...new Set(rows.map(r => r.videoId))]
  } catch { return [] }   // history is an optimization, never a build blocker
}

/** Rebuild one station's pool in the background (main-model judge, household excludes). */
async function refresh(key: string, seed: StationSeed): Promise<void> {
  const existing = cache.get(key)
  if (existing?.building) return
  // Mark building even for a first-time key, so concurrent warm sweeps / rotations
  // don't run duplicate LLM builds for the same station.
  const placeholder = !existing
  if (existing) existing.building = true
  else cache.set(key, { tracks: [], source: 'empty', at: Date.now(), building: true })
  const clearBuilding = () => {
    const live = cache.get(key)
    if (!live) return
    // Only delete what is still OUR placeholder - a cold tune-in may have banked a real
    // pool under this key while the failed build ran, and that pool must survive.
    if (placeholder && !live.tracks.length) cache.delete(key)
    else live.building = false
  }
  try {
    const result = await buildStationQueue(
      { ...seed, count: HEAD_POOL, excludeVideoIds: await householdRecentIds() },
      { fast: true, judge: 'main' },
    )
    if (result.tracks.length) {
      evictIfFull()
      cache.set(key, { tracks: result.tracks, source: result.source, at: Date.now(), building: false })
      prewarmOpeners(seed, result.tracks)
      persistSoon()
    } else {
      clearBuilding()
    }
  } catch (err) {
    clearBuilding()
    logger.debug(`[stationHead] refresh failed for "${seed.name ?? seed.aiPrompt}": ${err}`)
  }
}

/** Serve a station head: instant from the cached pool when possible (filtered against the
 *  seed's excludeVideoIds), else a cold fast build that seeds the cache for next time. */
export async function serveStationHead(seed: StationSeed, want: number): Promise<StationQueueResult> {
  await ensureLoaded()
  const key = keyFor(seed)
  const exclude = new Set(seed.excludeVideoIds ?? [])
  const entry = cache.get(key)

  if (entry && entry.tracks.length && Date.now() - entry.at < TTL_MS) {
    const usable = entry.tracks.filter(t => !exclude.has(t.videoId))
    if (usable.length) {
      if (Date.now() - entry.at > ROTATE_MS) void refresh(key, seed)
      prewarmOpeners(seed, usable)   // self-heal expired stream URLs / consumed intros
      logger.debug(`[stationHead] hit "${seed.name ?? seed.aiPrompt}" (pool ${entry.tracks.length}, usable ${usable.length})`)
      return { tracks: usable.slice(0, want), source: entry.source }
    }
    // Every pooled track is in the listener's recent history. An instant repeat beats the
    // 20-30s cold build this used to fall through to - serve the pool as-is and rotate it
    // in the background so the NEXT tune-in differs.
    void refresh(key, seed)
    prewarmOpeners(seed, entry.tracks)
    logger.debug(`[stationHead] hit (all ${entry.tracks.length} in history) "${seed.name ?? seed.aiPrompt}"`)
    return { tracks: entry.tracks.slice(0, want), source: entry.source }
  }

  // Cold path: the listener is waiting, so build with the latency defaults (small judge),
  // bank the surplus pool, and let the rotation rebuild upgrade it in the background.
  logger.debug(`[stationHead] cold build "${seed.name ?? seed.aiPrompt}"`)
  const result = await buildStationQueue({ ...seed, count: HEAD_POOL }, { fast: true })
  if (result.tracks.length) {
    evictIfFull()
    cache.set(key, { tracks: result.tracks, source: result.source, at: Date.now(), building: false })
    prewarmOpeners(seed, result.tracks)
    persistSoon()
  }
  const usable = result.tracks.filter(t => !exclude.has(t.videoId))
  return { tracks: (usable.length ? usable : result.tracks).slice(0, want), source: result.source }
}

/** Warm heads for a set of stations (app/Music-page open). Covers EVERY station passed —
 *  an unwarmed station is a 20-30s tune-in, so none may be skipped — but rolls through
 *  them at low concurrency, skips fresh/in-flight entries, and never throws; callers
 *  fire and forget. */
export async function warmStationHeads(seeds: StationSeed[]): Promise<void> {
  await ensureLoaded()
  const due = seeds
    .filter(s => s.aiPrompt || s.seedValue)
    .filter(s => {
      const e = cache.get(keyFor(s))
      return !e || (!e.building && (Date.now() - e.at > TTL_MS / 2 || !e.tracks.length))
    })
  if (!due.length) return
  logger.debug(`[stationHead] warming ${due.length} station(s)`)
  const queue = [...due]
  await Promise.all(Array.from({ length: Math.min(WARM_CONCURRENCY, queue.length) }, async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      await refresh(keyFor(s), s).catch(() => {})
    }
  }))
}

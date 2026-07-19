// Station head cache: pre-built "first tracks" per station, so pressing play serves a
// ready head instantly instead of paying LLM query-gen + live YouTube Music searches +
// a fit pass on the tune-in critical path. Three moments feed it:
//   1. Opening the Music page (the tune-in tell) warms heads for the stations on screen.
//   2. Serving a cached head schedules a background rotation rebuild, so the NEXT tune-in
//      of the same station opens differently.
//   3. A cold tune-in (cache miss) builds the old way, then banks the pool for next time.
// Warm/rotation builds run off the critical path, so they use the MAIN model as the fit
// judge (better subgenre/era knowledge than the fast 3B judge the live path uses) and
// pre-resolve the likely openers' stream URLs into the 4h stream cache - by the time the
// player's <audio> element asks, both the track list and the bytes URL are hot.
//
// Entries are keyed by the station's seed identity (not user), so the pool is shared
// across the household; per-user variety comes from the route's history/exclude filter
// applied at serve time.

import { buildStationQueue, type StationSeed, type StationQueueResult } from '@/lib/music/stationEngine'
import { logger } from '@/lib/logger'

const TTL_MS = 4 * 60 * 60_000    // matches the stream URL cache TTL
const ROTATE_MS = 10 * 60_000     // a pool older than this rebuilds after serving
const HEAD_POOL = 10              // tracks banked per station (serves stay well-fed after filtering)
const MAX_ENTRIES = 200
const WARM_MAX = 8                // stations warmed per Music-page open
const WARM_CONCURRENCY = 2

interface HeadEntry {
  tracks: StationQueueResult['tracks']
  source: StationQueueResult['source']
  at: number
  building: boolean
}

const cache = new Map<string, HeadEntry>()

const keyFor = (seed: StationSeed): string =>
  [seed.name ?? '', seed.aiPrompt, seed.seedType ?? '', seed.seedValue ?? ''].join('\u0000')

// Pre-resolve stream URLs for the likely openers (plain YouTube refs only - library
// local:/plex: refs stream straight off disk and have no resolver latency to hide),
// and pre-generate DJ intro variants for them (djIntroCache.ts) so the voice is as
// instant as the audio.
function prewarmOpeners(seed: StationSeed, tracks: StationQueueResult['tracks']): void {
  void (async () => {
    try {
      const { resolveStreamUrl } = await import('@/lib/youtube/stream')
      for (const t of tracks.slice(0, 2)) {
        if (t.videoId.includes(':')) continue
        await resolveStreamUrl(t.videoId, 'audio').catch(() => null)
      }
    } catch { /* stream lib unavailable - the lazy per-request resolve still works */ }
    try {
      if (seed.name) {
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

/** Rebuild one station's pool in the background (main-model judge, no user excludes). */
async function refresh(key: string, seed: StationSeed): Promise<void> {
  const existing = cache.get(key)
  if (existing?.building) return
  if (existing) existing.building = true
  try {
    const result = await buildStationQueue(
      { ...seed, count: HEAD_POOL, excludeVideoIds: [] },
      { fast: true, judge: 'main' },
    )
    if (result.tracks.length) {
      evictIfFull()
      cache.set(key, { tracks: result.tracks, source: result.source, at: Date.now(), building: false })
      prewarmOpeners(seed, result.tracks)
    } else if (existing) {
      existing.building = false
    }
  } catch (err) {
    if (existing) existing.building = false
    logger.debug(`[stationHead] refresh failed for "${seed.name ?? seed.aiPrompt}": ${err}`)
  }
}

/** Serve a station head: instant from the cached pool when possible (filtered against the
 *  seed's excludeVideoIds), else a cold fast build that seeds the cache for next time. */
export async function serveStationHead(seed: StationSeed, want: number): Promise<StationQueueResult> {
  const key = keyFor(seed)
  const exclude = new Set(seed.excludeVideoIds ?? [])
  const entry = cache.get(key)

  if (entry && Date.now() - entry.at < TTL_MS) {
    const usable = entry.tracks.filter(t => !exclude.has(t.videoId))
    if (usable.length) {
      if (Date.now() - entry.at > ROTATE_MS) void refresh(key, seed)
      return { tracks: usable.slice(0, want), source: entry.source }
    }
  }

  // Cold path: the listener is waiting, so build with the latency defaults (small judge),
  // bank the surplus pool, and let the rotation rebuild upgrade it in the background.
  const result = await buildStationQueue({ ...seed, count: HEAD_POOL }, { fast: true })
  if (result.tracks.length) {
    evictIfFull()
    cache.set(key, { tracks: result.tracks, source: result.source, at: Date.now(), building: false })
    prewarmOpeners(seed, result.tracks)
  }
  const usable = result.tracks.filter(t => !exclude.has(t.videoId))
  return { tracks: (usable.length ? usable : result.tracks).slice(0, want), source: result.source }
}

/** Warm heads for a set of stations (Music page open). Bounded, skips fresh entries,
 *  never throws - callers fire and forget. */
export async function warmStationHeads(seeds: StationSeed[]): Promise<void> {
  const due = seeds
    .filter(s => s.aiPrompt || s.seedValue)
    .filter(s => {
      const e = cache.get(keyFor(s))
      return !e || (Date.now() - e.at > TTL_MS / 2 && !e.building)
    })
    .slice(0, WARM_MAX)
  if (!due.length) return
  const queue = [...due]
  await Promise.all(Array.from({ length: Math.min(WARM_CONCURRENCY, queue.length) }, async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      await refresh(keyFor(s), s).catch(() => {})
    }
  }))
}

// Warm in-memory briefing cache, keyed by location displayName.
//
// The companion route reads this with a synchronous Map lookup — NEVER an await/fetch —
// so the briefing adds ~0ms to time-to-first-token (the [COMPANION-TIMING] budget).
// Mirrors memory/blockCache.ts. The block changes only every ~cadence, so the
// system-prompt prefix stays byte-identical across turns within a window → Ollama
// KV-cache reuse, exactly the rationale documented in blockCache.ts.

import type { BriefingPayload } from './types'

export interface BriefingCacheEntry {
  payload: BriefingPayload
  block: string // rendered prompt block (may be empty string)
  expiresAt: number
}

const cache = new Map<string, BriefingCacheEntry>()

// Bound the cache so a long-running server can't accumulate unbounded location
// keys (each one feeds the refresh loop forever). Map preserves insertion order,
// so we evict the oldest entry once we exceed the cap (LRU: reads re-insert).
const MAX_ENTRIES = 32

// 2.5h default. The refresher overwrites entries on its own cadence; this TTL only
// governs how long a stale entry is still served on a miss-driven lazy refresh.
export const BRIEFING_TTL_MS = 2.5 * 60 * 60 * 1000

/** Touch `key` so it becomes the most-recently-used entry (re-insert at the tail). */
function touch(key: string, entry: BriefingCacheEntry): void {
  cache.delete(key)
  cache.set(key, entry)
}

/** Fresh cached entry for `key`, or null on miss/expiry. */
export function getCachedBriefing(key: string): BriefingCacheEntry | null {
  const entry = cache.get(key)
  if (!entry) return null
  if (entry.expiresAt > Date.now()) {
    touch(key, entry) // mark as recently used
    return entry
  }
  // Expired, drop it so it can't linger as dead weight against the cap.
  cache.delete(key)
  return null
}

/** Stale-tolerant read — returns the entry even if expired (null only if never set). */
export function peekCachedBriefing(key: string): BriefingCacheEntry | null {
  return cache.get(key) ?? null
}

export function setCachedBriefing(key: string, payload: BriefingPayload, block: string): void {
  cache.delete(key) // re-insert at the tail so a refresh counts as most-recently-used
  cache.set(key, { payload, block, expiresAt: Date.now() + BRIEFING_TTL_MS })
  // Evict oldest entries until we're back within the cap.
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

export function invalidateBriefing(key: string): void {
  cache.delete(key)
}

/** All currently-cached location keys (for admin inspection / refresh-all). */
export function cachedBriefingKeys(): string[] {
  return [...cache.keys()]
}

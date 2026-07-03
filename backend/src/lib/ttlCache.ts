// Minimal generic in-memory TTL cache for cheap, small-keyspace memoization (e.g.
// Book Store genre shelves) — mirrors the simple Map+expiry pattern already used
// in lib/ogImage.ts and lib/youtube/discovery.ts, generalized since a second
// consumer (LibriVox category browsing) needs the same thing.

interface Entry<T> { value: T; expiresAt: number }

export function createTtlCache<T>(ttlMs: number) {
  const cache = new Map<string, Entry<T>>()

  return {
    get(key: string): T | undefined {
      const entry = cache.get(key)
      if (!entry) return undefined
      if (entry.expiresAt <= Date.now()) { cache.delete(key); return undefined }
      return entry.value
    },
    set(key: string, value: T): void {
      cache.set(key, { value, expiresAt: Date.now() + ttlMs })
    },
    /** Serve the cache on a hit; otherwise compute, cache, and return. Concurrent
     *  callers for the same cold key each compute once (no de-dup lock) — fine for
     *  a handful of fixed category keys, not worth the complexity for this scale. */
    async getOrCompute(key: string, compute: () => Promise<T>): Promise<T> {
      const cached = this.get(key)
      if (cached !== undefined) return cached
      const value = await compute()
      this.set(key, value)
      return value
    },
  }
}

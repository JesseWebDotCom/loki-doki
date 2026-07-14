// Generic read-through TTL cache for slow / rate-limited external lookups. Any tool that
// scrapes a source it shouldn't hammer (property assessor, people search, …) wraps its
// fetch in cachedLookup() and gets transparent caching with negative-result memoisation.
//
// Backed by the shared `lookup_cache` table (one row per namespace+key). The stored value
// is the JSON-encoded result, so a `null` result round-trips as the literal "null" — a row
// existing (and unexpired) means "we already looked this up", even if the answer was empty.
// That stops us re-scraping a known miss on every call.

import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { lookupCache } from '@/db/schema'

/** Common TTLs. Lookups change rarely, so we cache hard. */
export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

function rowKey(namespace: string, key: string): string {
  const hash = createHash('sha256').update(key.toLowerCase()).digest('hex').slice(0, 32)
  return `${namespace}:${hash}`
}

/**
 * Return a cached value if present and unexpired; otherwise run `fetcher`, cache its
 * result (including null/empty), and return it. `fetcher` failures are NOT cached — a
 * thrown error propagates so the caller can decide, and nothing is written, so the next
 * call retries. Pass a stable, fully-qualifying `key` (every input that changes the
 * result must be in it).
 */
export async function cachedLookup<T>(
  namespace: string,
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const k = rowKey(namespace, key)
  const now = Date.now()

  const [row] = await db
    .select({ data: lookupCache.data, expiresAt: lookupCache.expiresAt })
    .from(lookupCache)
    .where(eq(lookupCache.key, k))
    .limit(1)

  if (row && row.expiresAt > now) {
    try {
      return JSON.parse(row.data) as T
    } catch {
      /* corrupt row — fall through and re-fetch */
    }
  }

  const value = await fetcher()

  // Upsert (primary-key conflict → overwrite the stale/expired row).
  await db
    .insert(lookupCache)
    .values({
      key: k,
      namespace,
      data: JSON.stringify(value ?? null),
      expiresAt: now + ttlMs,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: lookupCache.key,
      set: { data: JSON.stringify(value ?? null), expiresAt: now + ttlMs, createdAt: now },
    })

  return value
}

/**
 * Write-through companion to cachedLookup, for callers that compute values on their own
 * schedule (background pool/profile builds) rather than lazily inside a read: cachedLookup
 * would return an unexpired row instead of accepting the fresh value. Same keying, so
 * cachedLookup/cachedLookupStale read what this writes.
 */
export async function cachedLookupPut(namespace: string, key: string, ttlMs: number, value: unknown): Promise<void> {
  const now = Date.now()
  await db
    .insert(lookupCache)
    .values({
      key: rowKey(namespace, key),
      namespace,
      data: JSON.stringify(value ?? null),
      expiresAt: now + ttlMs,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: lookupCache.key,
      set: { data: JSON.stringify(value ?? null), expiresAt: now + ttlMs, createdAt: now },
    })
}

/**
 * Stale-while-revalidate probe: return the cached value if a row exists — even if expired —
 * plus whether it's still fresh. Never runs a fetcher and never writes. Request paths that
 * must not block on a slow/unreliable lookup (e.g. TikTok, whose yt-dlp extraction can take
 * ~10s per creator) use this to serve the last-known-good result instantly and trigger a
 * background refresh when `fresh` is false. `value` is undefined only when no row exists at
 * all (or it's corrupt). Same keying as cachedLookup, so they share rows.
 */
export async function cachedLookupStale<T>(
  namespace: string,
  key: string,
): Promise<{ value: T | undefined; fresh: boolean }> {
  const [row] = await db
    .select({ data: lookupCache.data, expiresAt: lookupCache.expiresAt })
    .from(lookupCache)
    .where(eq(lookupCache.key, rowKey(namespace, key)))
    .limit(1)

  if (!row) return { value: undefined, fresh: false }
  try {
    return { value: JSON.parse(row.data) as T, fresh: row.expiresAt > Date.now() }
  } catch {
    return { value: undefined, fresh: false }
  }
}

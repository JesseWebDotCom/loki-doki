// Small in-memory LRU over extractArticle keyed by url, so the reader endpoint (HTML and
// plain-text formats), the TV client, and the URL-summary path share one extraction instead
// of re-fetching and re-parsing the same page. Failures are never cached (the promise
// rejects and nothing is stored), and concurrent callers for the same url share one
// in-flight extraction.

import { extractArticle, type ExtractedArticle } from '@/lib/content/extract'

const MAX_ENTRIES = 50
const TTL_MS = 60 * 60 * 1000 // 1h - matches the URL-summary cache in lib/news/summarize.ts

const cache = new Map<string, { article: ExtractedArticle; expiresAt: number }>()
const inFlight = new Map<string, Promise<ExtractedArticle>>()

/** extractArticle with an LRU cache (50 entries, 1h TTL) and in-flight dedupe. */
export function cachedExtractArticle(url: string, timeoutMs?: number): Promise<ExtractedArticle> {
  const hit = cache.get(url)
  if (hit && Date.now() < hit.expiresAt) {
    // Refresh recency: Map iteration order is insertion order, so delete+set moves it last.
    cache.delete(url)
    cache.set(url, hit)
    return Promise.resolve(hit.article)
  }
  const existing = inFlight.get(url)
  if (existing) return existing
  const p = extractArticle(url, timeoutMs)
    .then((article) => {
      cache.delete(url)
      cache.set(url, { article, expiresAt: Date.now() + TTL_MS })
      while (cache.size > MAX_ENTRIES) {
        const oldest = cache.keys().next().value
        if (oldest === undefined) break
        cache.delete(oldest)
      }
      return article
    })
    .finally(() => inFlight.delete(url))
  inFlight.set(url, p)
  return p
}

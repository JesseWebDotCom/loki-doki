// YouTube's own query-autosuggest endpoint (what youtube.com's search box calls as you
// type). Unauthenticated, no key — proxied server-side per the app's convention of never
// letting the browser hit third parties directly (see returndislike.ts, sponsorblock.ts).
// Confirmed live: returns a plain JSON array (not JSONP-wrapped) — ["q", ["suggestion", ...], [], {...}].

import { logger } from '@/lib/logger'

const API = 'https://suggestqueries.google.com/complete/search'

// Per-keystroke endpoint, so cache hard: everyone retypes the same prefixes ("mine",
// "minec", "minecr"…), and backspacing replays them exactly. Small LRU Map + inflight
// dedupe keeps a typing burst at one upstream round-trip per distinct prefix.
const CACHE_MAX = 300
const CACHE_TTL_MS = 10 * 60 * 1000
const cache = new Map<string, { at: number; suggestions: string[] }>()
const inflight = new Map<string, Promise<string[]>>()

// 1500ms, not more: a suggestion that arrives after the user's next keystroke is useless.
export async function getYoutubeSuggestions(q: string, timeout = 1500): Promise<string[]> {
  const key = q.trim().toLowerCase()
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    cache.delete(key)   // re-insert to refresh LRU position (Map iterates in insert order)
    cache.set(key, hit)
    return hit.suggestions
  }
  const pending = inflight.get(key)
  if (pending) return pending
  const p = (async () => {
    try {
      const res = await fetch(`${API}?client=firefox&ds=yt&q=${encodeURIComponent(q)}`, {
        headers: { 'User-Agent': 'MaiPaiHome/1.0' },
        signal: AbortSignal.timeout(timeout),
      })
      if (!res.ok) return []
      const data = await res.json() as unknown
      const list = Array.isArray(data) ? data[1] : null
      const suggestions = Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : []
      cache.set(key, { at: Date.now(), suggestions })
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
      return suggestions
    } catch (err) {
      // Failures (incl. timeouts) are not cached — the next keystroke simply retries.
      logger.warn(`[youtube/suggest] lookup failed for "${q}": ${err}`)
      return []
    }
  })()
  inflight.set(key, p)
  void p.finally(() => { if (inflight.get(key) === p) inflight.delete(key) })
  return p
}

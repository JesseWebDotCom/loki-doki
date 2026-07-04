// YouTube's own query-autosuggest endpoint (what youtube.com's search box calls as you
// type). Unauthenticated, no key — proxied server-side per the app's convention of never
// letting the browser hit third parties directly (see returndislike.ts, sponsorblock.ts).
// Confirmed live: returns a plain JSON array (not JSONP-wrapped) — ["q", ["suggestion", ...], [], {...}].

import { logger } from '@/lib/logger'

const API = 'https://suggestqueries.google.com/complete/search'

export async function getYoutubeSuggestions(q: string, timeout = 4000): Promise<string[]> {
  try {
    const res = await fetch(`${API}?client=firefox&ds=yt&q=${encodeURIComponent(q)}`, {
      headers: { 'User-Agent': 'LokiDoki/1.0' },
      signal: AbortSignal.timeout(timeout),
    })
    if (!res.ok) return []
    const data = await res.json() as unknown
    const list = Array.isArray(data) ? data[1] : null
    return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : []
  } catch (err) {
    logger.warn(`[youtube/suggest] lookup failed for "${q}": ${err}`)
    return []
  }
}

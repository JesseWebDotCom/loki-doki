// og:image enrichment for news items whose feed gives no image (e.g. Google News RSS).
// Each article page is fetched and its og:image meta extracted. Results are cached per-URL
// so repeat refreshes are free until the TTL expires (and the news route caches the whole
// response for 15 min on top of that, so this scrape runs at most once per cache window).

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
const CACHE_TTL_MS = 6 * 60 * 60 * 1000 // 6h

const cache = new Map<string, { url: string | null; expires: number }>()

function extractOgImage(html: string): string | null {
  const patterns = [
    /<meta[^>]+(?:property|name)=["']og:image(?::url)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image(?::url)?["']/i,
    /<meta[^>]+(?:property|name)=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
  ]
  for (const re of patterns) {
    const m = html.match(re)
    if (m && m[1]) return m[1]
  }
  return null
}

async function fetchOgImage(pageUrl: string, timeoutMs: number): Promise<string | null> {
  const hit = cache.get(pageUrl)
  if (hit && Date.now() < hit.expires) return hit.url

  let url: string | null = null
  try {
    const res = await fetch(pageUrl, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.ok) url = extractOgImage(await res.text())
  } catch {
    /* leave url null */
  }
  cache.set(pageUrl, { url, expires: Date.now() + CACHE_TTL_MS })
  return url
}

/**
 * Fill in `imageUrl` (in place) for items that have a `url` but no image, by scraping each
 * page's og:image. Bounded by `max` items and `concurrency` parallel fetches. Best effort:
 * items that fail simply keep no image. Returns the same array for chaining.
 */
export async function enrichOgImages<T extends { url?: string; imageUrl?: string }>(
  items: T[],
  opts: { max?: number; concurrency?: number; timeoutMs?: number } = {},
): Promise<T[]> {
  const { max = 12, concurrency = 8, timeoutMs = 4000 } = opts
  const targets = items.slice(0, max).filter((it) => it.url && !it.imageUrl)
  let next = 0
  const worker = async () => {
    while (next < targets.length) {
      const it = targets[next++]!
      const img = await fetchOgImage(it.url!, timeoutMs)
      if (img) it.imageUrl = img
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker))
  return items
}

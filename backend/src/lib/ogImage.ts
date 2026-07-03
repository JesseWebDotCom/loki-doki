// og:image enrichment for news items whose feed gives no image (e.g. Google News RSS).
// Each article page is fetched and its og:image meta extracted. Results are cached per-URL
// so repeat refreshes are free until the TTL expires (and the news route caches the whole
// response for 15 min on top of that, so this scrape runs at most once per cache window).
//
// Some sites (MSN's article template, in practice) render their og:image client-side, so it's
// simply absent from the plain-fetch HTML — a bounded few stragglers get a second-tier
// headless-browser render (JS executes) via the Reader's renderPage(), see fetchOgImageViaBrowser.

import { renderPage } from '@/lib/bookmarks/render'
import { decodeEntities } from '@/lib/htmlText'

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
    // Regex-extracted from raw HTML text, not a real parser — the attribute value can still
    // carry HTML entities (e.g. "&amp;" between query params), which would corrupt the URL
    // if used as-is outside of HTML parsing (a React `src` set via the DOM API, an /api/img proxy).
    if (m && m[1]) return decodeEntities(m[1])
  }
  return null
}

// Fallback for pages with no og:image/twitter:image meta at all: scan <img> tags and pick the
// largest by declared width*height. Icons/logos/tracking pixels are usually small or undeclared
// and sorted after any content image with real dimensions; ties/undeclared sizes keep document
// order (a page's lead image is almost always the first substantial <img>, not a random one).
function extractLargestImage(html: string, baseUrl: string): string | null {
  let best: { url: string; area: number } | null = null
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    const src = tag.match(/\b(?:src|data-src)=["']([^"']+)["']/i)?.[1]
    if (!src || src.startsWith('data:')) continue
    let resolved: string
    try { resolved = new URL(decodeEntities(src), baseUrl).href } catch { continue }
    if (/\.svg(?:\?|$)/i.test(resolved)) continue
    const w = Number(tag.match(/\bwidth=["']?(\d+)/i)?.[1] ?? 0)
    const h = Number(tag.match(/\bheight=["']?(\d+)/i)?.[1] ?? 0)
    if ((w && w < 200) || (h && h < 200)) continue // icon/thumbnail-sized, skip
    const area = w && h ? w * h : 0 // undeclared size ranks below any measured content image
    if (!best || area > best.area) best = { url: resolved, area }
  }
  return best?.url ?? null
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
    if (res.ok) {
      const html = await res.text()
      url = extractOgImage(html) ?? extractLargestImage(html, pageUrl)
    }
  } catch {
    /* leave url null */
  }
  cache.set(pageUrl, { url, expires: Date.now() + CACHE_TTL_MS })
  return url
}

// Reuses the Reader's headless-browser renderer (already a backend dependency, already
// serialized to one browser at a time) instead of spinning up a second browser pool. Only
// called for the handful of items still imageless after the fast fetch path, and its result
// is written into the SAME cache as fetchOgImage so a repeat run within the TTL never re-renders.
async function fetchOgImageViaBrowser(pageUrl: string, timeoutMs: number): Promise<string | null> {
  let url: string | null = null
  try {
    const result = await renderPage(pageUrl, { captureMedia: false, timeoutMs })
    if (result) url = extractOgImage(result.html) ?? extractLargestImage(result.html, pageUrl)
  } catch {
    /* leave url null */
  }
  if (url) cache.set(pageUrl, { url, expires: Date.now() + CACHE_TTL_MS })
  return url
}

// news.google.com/rss/articles/... links are Google's own redirect interstitial, not the
// real article — it only resolves via client-side JS, so a server fetch lands on Google's
// page and its og:image is Google's generic reused "News" thumbnail, never the article's own.
// Skip these rather than enrich them with a fake-looking generic image.
function isGoogleNewsRedirect(url: string): boolean {
  try {
    return new URL(url).hostname === 'news.google.com'
  } catch {
    return false
  }
}

/**
 * Fill in `imageUrl` (in place) for items that have a `url` but no image, by scraping each
 * page's og:image. Bounded by `max` items and `concurrency` parallel fetches, with a further
 * `browserMax` stragglers escalated to a real browser render. Best effort: items that fail
 * simply keep no image. Returns the same array for chaining.
 */
export async function enrichOgImages<T extends { url?: string; imageUrl?: string }>(
  items: T[],
  opts: { max?: number; concurrency?: number; timeoutMs?: number; browserMax?: number; browserTimeoutMs?: number } = {},
): Promise<T[]> {
  const { max = 12, concurrency = 8, timeoutMs = 4000, browserMax = 1, browserTimeoutMs = 15000 } = opts
  const targets = items.slice(0, max).filter((it) => it.url && !it.imageUrl && !isGoogleNewsRedirect(it.url))
  let next = 0
  const worker = async () => {
    while (next < targets.length) {
      const it = targets[next++]!
      const img = await fetchOgImage(it.url!, timeoutMs)
      if (img) it.imageUrl = img
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker))

  // Second tier — sequential (a shared browser is already serialized across the whole app,
  // so "concurrent" calls here would just queue behind each other anyway).
  const stillMissing = targets.filter((it) => !it.imageUrl).slice(0, browserMax)
  for (const it of stillMissing) {
    const img = await fetchOgImageViaBrowser(it.url!, browserTimeoutMs)
    if (img) it.imageUrl = img
  }

  return items
}

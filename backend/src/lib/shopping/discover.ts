// Cross-retailer product discovery via the local SearXNG metasearch sidecar. The first-
// class retailers (except Amazon) block their own product SEARCH from a home IP, but their
// individual product PAGES are reachable (Walmart by fetch, Target by render) — and a
// metasearch for "<specific product> <store>" reliably surfaces those exact product-page
// URLs. So to compare a product across stores we discover candidate URLs here, then the
// caller resolves each through its retailer adapter to get the real price.
//
// We call SearXNG directly (not lib/searxng's guarded wrapper) because that wrapper early-
// returns unless its supervision state is 'ready', which isn't reliable here; the raw HTTP
// call with limiter=false works whenever the sidecar is up and fails soft otherwise.

import { SEARXNG_PORT } from '@/lib/searxng'
import type { RetailerId } from '@/lib/shopping/types'

/** Retailer → product-page URL matcher (only real PDP URLs, not category/brand pages). */
const PRODUCT_URL_PATTERNS: Partial<Record<RetailerId, RegExp>> = {
  walmart: /^https?:\/\/(?:www\.)?walmart\.com\/ip\//i,
  target: /^https?:\/\/(?:www\.)?target\.com\/p\/.*\/-\/A-\d+/i,
  bestbuy: /^https?:\/\/(?:www\.)?bestbuy\.com\/site\/.*\.p/i,
  homedepot: /^https?:\/\/(?:www\.)?homedepot\.com\/p\/.*\/\d{6,}/i,
  lowes: /^https?:\/\/(?:www\.)?lowes\.com\/pd\/.*\/\d+/i,
}

const SEARCH_TERM: Partial<Record<RetailerId, string>> = {
  walmart: 'walmart', target: 'target', bestbuy: 'best buy',
  homedepot: 'home depot', lowes: "lowe's",
}

async function searxngUrls(query: string, timeoutMs = 7000): Promise<string[]> {
  try {
    const url = `http://127.0.0.1:${SEARXNG_PORT}/search?q=${encodeURIComponent(query)}&format=json&safesearch=0&limiter=false`
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return []
    const data = await res.json() as { results?: { url?: string }[] }
    return (data.results ?? []).map(r => r.url).filter((u): u is string => !!u)
  } catch {
    return []
  }
}

/**
 * Find candidate product-page URLs for `query` at a specific retailer. Returns up to
 * `limit` distinct PDP URLs (deduped by product path), best-effort — [] if the sidecar is
 * down or nothing matched. The caller resolves these to real prices via the adapter.
 */
export async function discoverProductUrls(query: string, retailer: RetailerId, limit = 3): Promise<string[]> {
  const pattern = PRODUCT_URL_PATTERNS[retailer]
  const term = SEARCH_TERM[retailer]
  if (!pattern || !term) return []
  const urls = await searxngUrls(`${query} ${term}`)
  const seen = new Set<string>()
  const out: string[] = []
  for (const u of urls) {
    if (!pattern.test(u)) continue
    // Dedupe by the product path (strip query/fragment) so variants don't repeat.
    const key = u.split(/[?#]/)[0]!.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(u)
    if (out.length >= limit) break
  }
  return out
}

/** Which non-Amazon retailers we can discover + price for cross-store comparison. */
export const COMPARABLE_RETAILERS: RetailerId[] = ['walmart', 'target']

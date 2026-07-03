// Adapter registry + paste-a-URL routing. First-class adapters claim their hosts; any
// other http(s) product URL falls through to the generic strategy-ladder adapter.

import { amazonAdapter } from '@/lib/shopping/adapters/amazon'
import { walmartAdapter } from '@/lib/shopping/adapters/walmart'
import { targetAdapter } from '@/lib/shopping/adapters/target'
import { homedepotAdapter, lowesAdapter, appleAdapter, costcoAdapter, bjsAdapter, temuAdapter, wootAdapter } from '@/lib/shopping/adapters/bigbox'
import { genericAdapter } from '@/lib/shopping/adapters/generic'
import { followRedirect } from '@/lib/shopping/fetch'
import type { RetailerAdapter, RetailerId } from '@/lib/shopping/types'

const FIRST_CLASS: RetailerAdapter[] = [
  amazonAdapter,
  walmartAdapter,
  targetAdapter,
  homedepotAdapter,
  lowesAdapter,
  appleAdapter,
  costcoAdapter,
  bjsAdapter,
  temuAdapter,
  wootAdapter,
]

export const ADAPTERS: Partial<Record<RetailerId, RetailerAdapter>> = Object.fromEntries(
  [...FIRST_CLASS, genericAdapter].map(a => [a.id, a]),
)

export const RETAILER_LABELS: Record<string, string> = Object.fromEntries(
  [...FIRST_CLASS, genericAdapter].map(a => [a.id, a.label]),
)

export function adapterFor(id: string): RetailerAdapter | null {
  return (ADAPTERS as Record<string, RetailerAdapter>)[id] ?? null
}

/** Route a pasted URL to the adapter that owns its host (or generic). Null = not http(s). */
export function adapterForUrl(url: string): { adapter: RetailerAdapter; externalId: string; url: string } | null {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
  for (const adapter of FIRST_CLASS) {
    if (adapter.hosts.includes(host)) {
      const parsed = adapter.parseUrl(url)
      if (parsed) return { adapter, ...parsed }
      return null // right store, but not a product page — don't fall through to generic
    }
  }
  const parsed = genericAdapter.parseUrl(url)
  return parsed ? { adapter: genericAdapter, ...parsed } : null
}

/** Walmart's own affiliate-click bot-check intercepts redirect chains before they reach the
 *  real product page, landing on `walmart.com/blocked?url=<base64-encoded-real-path>` instead
 *  of a clean 30x — the real destination is still recoverable, just base64-wrapped in a query
 *  param rather than a Location header. Any other host/shape is returned unchanged. */
function unwrapWalmartBlocked(url: string): string {
  try {
    const u = new URL(url)
    if (!u.hostname.endsWith('walmart.com') || u.pathname !== '/blocked') return url
    const encoded = u.searchParams.get('url')
    if (!encoded) return url
    const path = Buffer.from(encoded, 'base64').toString('utf8')
    return path.startsWith('/') ? `https://www.walmart.com${path}` : url
  } catch {
    return url
  }
}

/** Same as `adapterForUrl`, but when the host isn't a recognized retailer (so we'd otherwise
 *  fall through to the generic scraper) it first follows the URL as a redirect — deal
 *  aggregators (Slickdeals, RSS feeds, shortened links) commonly link through an affiliate
 *  tracker rather than the retailer directly, e.g. `slickdeals.net/click?...` → 2-4 affiliate
 *  hops → `target.com/p/...`. If that lands on a host we DO recognize, we use the real
 *  product page instead of scraping the tracker link itself. Falls back to the plain
 *  (untouched) `adapterForUrl(url)` result — including its generic-adapter fallback — when
 *  the redirect doesn't resolve to anything better, so "track any URL" behavior is unchanged. */
export async function resolveTrackableUrl(url: string): Promise<{ adapter: RetailerAdapter; externalId: string; url: string } | null> {
  const direct = adapterForUrl(url)
  if (direct && direct.adapter.id !== 'generic') return direct

  const resolved = await followRedirect(url)
  if (resolved !== url) {
    const viaRedirect = adapterForUrl(unwrapWalmartBlocked(resolved))
    if (viaRedirect && viaRedirect.adapter.id !== 'generic') return viaRedirect
  }
  return direct
}

/** Adapters that can serve cross-retailer search (browse + matching). */
export function searchableAdapters(): RetailerAdapter[] {
  return FIRST_CLASS.filter(a => a.supportsSearch)
}

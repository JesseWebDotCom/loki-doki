// Generic any-URL adapter (the PriceBuddy idea): track a product on a store we have no
// first-class adapter for. Extraction runs a strategy ladder — schema.org JSON-LD →
// CSS selector (user-supplied or auto-candidates) → local-LLM read of the page text —
// and the winning strategy is persisted per host in shopping_host_strategies so each
// site pays the discovery cost once, not on every poll. Two consecutive failures of a
// stored strategy send the host back through the full ladder (sites redesign).

import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { shoppingHostStrategies } from '@/db/schema'
import { extractJsonLd } from '@/lib/scrape'
import { extractWatchText } from '@/lib/bookmarks/watch'
import { decodeTitle, extractJsonLdRatingAndDescription, fetchWithLadder, normalizeGtin, parseMoney } from '@/lib/shopping/fetch'
import { llmExtractProduct } from '@/lib/shopping/selfHeal'
import type { ProductDetail, RetailerAdapter } from '@/lib/shopping/types'

type Strategy = 'jsonld' | 'selector' | 'llm'

interface Extracted {
  priceCents: number | null
  inStock: boolean
  title: string | null
  imageUrl: string | null
  brand: string | null
  gtin: string | null
  mpn: string | null
  strategy: Strategy
  priceSelector?: string | null
  description?: string | null
  rating?: { value: number; count: number } | null
}

// Hosts that are NEVER a single product page — deal aggregators, search engines, social,
// forums, video. Tracking/resolving one of these through the generic ladder produces a
// garbage "Web store" listing: e.g. a Slickdeals THREAD gets scraped for its og:title
// ("…Construction Jack - 2026-07-02"), its og:image, and a $-token the LLM lifts from the
// post body → a fake "$33 at Web store" product. The generic adapter refuses them outright
// at its single choke point (normalizeGenericUrl), so EVERY entry point that funnels through
// it — /resolve, POST /products (track), and the untracked product page — rejects uniformly.
const NON_PRODUCT_HOSTS = /(?:^|\.)(?:slickdeals\.net|dealnews\.com|dealmoon\.com|bradsdeals\.com|feedburner\.com|feedproxy\.google\.com|reddit\.com|google\.com|bing\.com|duckduckgo\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|youtube\.com|youtu\.be|tiktok\.com|pinterest\.com|wikipedia\.org)$/i

/** True if a host can't possibly be a single trackable product page (see NON_PRODUCT_HOSTS). */
export function isNonProductHost(host: string): boolean {
  return NON_PRODUCT_HOSTS.test(host)
}

/** Track-any-URL identity: the cleaned URL itself (tracking params stripped). Returns null for
 *  non-http(s) URLs and for hosts that are never products (aggregators/search/social/forums). */
export function normalizeGenericUrl(raw: string): string | null {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    if (isNonProductHost(u.hostname)) return null
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|ref|tag|linkCode)/i.test(p)) u.searchParams.delete(p)
    }
    u.hash = ''
    return u.toString()
  } catch {
    return null
  }
}

// ── individual strategies ────────────────────────────────────────────────────────

function firstString(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim()
  if (Array.isArray(v)) for (const x of v) { const s = firstString(x); if (s) return s }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return firstString(o.name ?? o['@id'] ?? o.url)
  }
  return null
}

export function extractFromJsonLd(html: string): Omit<Extracted, 'strategy'> | null {
  const nodes = extractJsonLd(html)
  for (const node of nodes) {
    const type = node['@type']
    const types = Array.isArray(type) ? type : [type]
    if (!types.some(t => typeof t === 'string' && /product/i.test(t))) continue

    const offersRaw = node.offers
    const offers = (Array.isArray(offersRaw) ? offersRaw : [offersRaw]).filter(
      (o): o is Record<string, unknown> => !!o && typeof o === 'object',
    )
    let priceCents: number | null = null
    let inStock = false
    for (const offer of offers) {
      const spec = offer.priceSpecification as Record<string, unknown> | undefined
      const cents = parseMoney((offer.price ?? spec?.price) as string | number | undefined ?? null)
      if (cents != null && (priceCents == null || cents < priceCents)) priceCents = cents
      const avail = String(offer.availability ?? '')
      if (/InStock|LimitedAvailability|OnlineOnly|PreOrder/i.test(avail)) inStock = true
    }
    if (priceCents == null && offers.length === 0) continue
    if (priceCents != null && offers.every(o => !o.availability)) inStock = true

    const { description, rating } = extractJsonLdRatingAndDescription(node)

    return {
      priceCents,
      inStock: priceCents != null ? inStock : false,
      title: firstString(node.name),
      imageUrl: firstString(node.image),
      brand: firstString(node.brand),
      gtin: normalizeGtin(firstString(node.gtin13) ?? firstString(node.gtin12) ?? firstString(node.gtin) ?? null),
      mpn: firstString(node.mpn),
      priceSelector: null,
      description,
      rating,
    }
  }
  return null
}

/** Selector candidates tried when the user didn't supply one. Order matters: itemprop
 *  microdata is near-certain, bare .price-ish classes are last-resort. */
const AUTO_SELECTORS = ['[itemprop=price]', '.price', '.product-price', '[class*=price]']

async function extractBySelector(html: string, selector: string): Promise<number | null> {
  const text = await extractWatchText(html, selector, '')
  if (!text) return null
  // Take the first money-looking token; selectors often match "$79.99 $99.99 Save $20".
  const m = text.match(/\$?\s?\d[\d,]*(?:\.\d{2})?/)
  return m ? parseMoney(m[0]) : null
}

// The LLM extraction strategy is shared with the self-heal layer (lib/shopping/selfHeal).
const extractByLlm = llmExtractProduct

function ogFallbacks(html: string): { title: string | null; imageUrl: string | null } {
  const title = html.match(/property="og:title"[^>]*content="([^"]+)"/)?.[1]
    ?? html.match(/<title[^>]*>([^<]+)/)?.[1]
    ?? null
  const imageUrl = html.match(/property="og:image"[^>]*content="([^"]+)"/)?.[1] ?? null
  return { title: title ? decodeTitle(title) : null, imageUrl }
}

// ── the ladder ───────────────────────────────────────────────────────────────────

async function runLadder(html: string, opts: { only?: Strategy; selector?: string | null }): Promise<Extracted | null> {
  const og = ogFallbacks(html)

  if (!opts.only || opts.only === 'jsonld') {
    const ld = extractFromJsonLd(html)
    if (ld && ld.priceCents != null) {
      return { ...ld, title: ld.title ?? og.title, imageUrl: ld.imageUrl ?? og.imageUrl, strategy: 'jsonld' }
    }
    if (opts.only === 'jsonld') return null
  }

  if (!opts.only || opts.only === 'selector') {
    const candidates = opts.selector ? [opts.selector] : AUTO_SELECTORS
    for (const sel of candidates) {
      const cents = await extractBySelector(html, sel)
      if (cents != null) {
        return {
          priceCents: cents, inStock: true, title: og.title, imageUrl: og.imageUrl,
          brand: null, gtin: null, mpn: null, strategy: 'selector', priceSelector: sel,
        }
      }
    }
    if (opts.only === 'selector') return null
  }

  if (!opts.only || opts.only === 'llm') {
    const llm = await extractByLlm(html)
    if (llm && llm.priceCents != null) {
      return {
        priceCents: llm.priceCents, inStock: llm.inStock, title: llm.title ?? og.title,
        imageUrl: og.imageUrl, brand: null, gtin: null, mpn: null, strategy: 'llm', priceSelector: null,
      }
    }
  }
  return null
}

async function rememberStrategy(host: string, e: Extracted): Promise<void> {
  const now = new Date()
  await db.insert(shoppingHostStrategies)
    .values({
      host, strategy: e.strategy, priceSelector: e.priceSelector ?? null, titleSelector: null,
      lastSuccessAt: now, failCount: 0, updatedAt: now,
    })
    .onConflictDoUpdate({
      target: shoppingHostStrategies.host,
      set: { strategy: e.strategy, priceSelector: e.priceSelector ?? null, lastSuccessAt: now, failCount: 0, updatedAt: now },
    })
}

async function bumpFailure(host: string): Promise<number> {
  const [row] = await db.select().from(shoppingHostStrategies).where(eq(shoppingHostStrategies.host, host)).limit(1)
  if (!row) return 0
  const failCount = row.failCount + 1
  await db.update(shoppingHostStrategies)
    .set({ failCount, updatedAt: new Date() })
    .where(eq(shoppingHostStrategies.host, host))
  return failCount
}

/** Core extraction used by getProduct and (with an explicit selector) the resolve route. */
export async function extractGenericProduct(url: string, userSelector?: string | null): Promise<ProductDetail | null> {
  const normalized = normalizeGenericUrl(url)
  if (!normalized) return null
  const host = new URL(normalized).hostname

  // Generic stores are unknown quantity — allow the free reader-proxy fallback so a store
  // that UA-blocks our home IP can still be tracked.
  const page = await fetchWithLadder(normalized, { isValid: h => h.length > 500, tryReaderProxy: true })
  if (!page) return null

  let extracted: Extracted | null = null

  if (userSelector) {
    extracted = await runLadder(page.html, { only: 'selector', selector: userSelector })
  } else {
    const [stored] = await db.select().from(shoppingHostStrategies).where(eq(shoppingHostStrategies.host, host)).limit(1)
    if (stored && stored.failCount < 2) {
      extracted = await runLadder(page.html, { only: stored.strategy, selector: stored.priceSelector })
      if (!extracted) await bumpFailure(host)
    }
    if (!extracted) extracted = await runLadder(page.html, {})
  }

  if (!extracted) {
    // A loaded page with no extractable price could still be a real (sold-out) product
    // page — but we can't tell it apart from a non-product page, so report failure.
    return null
  }
  await rememberStrategy(host, extracted)

  return {
    retailer: 'generic',
    externalId: normalized,
    url: normalized,
    title: extracted.title ?? host,
    imageUrl: extracted.imageUrl,
    priceCents: extracted.inStock ? extracted.priceCents : null,
    currency: 'USD',
    brand: extracted.brand,
    wasPriceCents: null,
    inStock: extracted.inStock,
    gtin: extracted.gtin,
    mpn: extracted.mpn,
    sku: null,
    description: extracted.description ?? null,
    rating: extracted.rating ?? null,
  }
}

export const genericAdapter: RetailerAdapter = {
  id: 'generic',
  label: 'Web store',
  hosts: [],
  needsBrowser: false, // the internal ladder escalates to the browser on its own
  supportsSearch: false,

  parseUrl(url) {
    const normalized = normalizeGenericUrl(url)
    return normalized ? { externalId: normalized, url: normalized } : null
  },

  async search() {
    return []
  },

  async getProduct(externalId) {
    return extractGenericProduct(externalId)
  },
}

/** Short stable id for a generic listing (used in dedupe keys, not identity). */
export function genericUrlHash(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 16)
}

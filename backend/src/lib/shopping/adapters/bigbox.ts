// Home Depot & Lowe's adapters. Both sit behind Akamai, which denies bare fetches AND
// headless Chromium from a residential IP ("Access Denied" / an error shell), so there is
// no reliable keyless price source for them from home — verified 2026-07. We still register
// them so a pasted URL is recognized and canonicalized, and we make a best-effort render +
// JSON-LD parse (some product pages do occasionally slip through, and the setup works
// unchanged from a datacenter IP / VPN). When the render is blocked, getProduct returns
// null and the tracker records a graceful failure rather than inventing a price.

import { extractJsonLd } from '@/lib/scrape'
import { extractJsonLdRatingAndDescription, fetchWithLadder, decodeTitle, normalizeGtin, parseMoney } from '@/lib/shopping/fetch'
import { parseWithHeal } from '@/lib/shopping/selfHeal'
import type { ProductDetail, ProductSummary, RetailerAdapter, RetailerId } from '@/lib/shopping/types'

function pickString(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim()
  if (Array.isArray(v)) for (const x of v) { const s = pickString(x); if (s) return s }
  if (v && typeof v === 'object') return pickString((v as Record<string, unknown>).name ?? (v as Record<string, unknown>).url)
  return null
}

/** Parse a schema.org Product node out of rendered HTML — the shared shape HD & Lowe's use. */
export function parseProductJsonLd(retailer: RetailerId, externalId: string, url: string, html: string): ProductDetail | null {
  const nodes = extractJsonLd(html)
  const product = nodes.find(n => {
    const t = n['@type']
    const types = Array.isArray(t) ? t : [t]
    return types.some(x => typeof x === 'string' && /product/i.test(x))
  })
  if (!product) return null

  const name = pickString(product.name)
  if (!name) return null

  const offersRaw = product.offers
  const offers = (Array.isArray(offersRaw) ? offersRaw : [offersRaw]).filter(
    (o): o is Record<string, unknown> => !!o && typeof o === 'object',
  )
  let priceCents: number | null = null
  let inStock = false
  for (const offer of offers) {
    const spec = offer.priceSpecification as Record<string, unknown> | undefined
    const cents = parseMoney((offer.price ?? spec?.price) as string | number | undefined ?? null)
    if (cents != null && (priceCents == null || cents < priceCents)) priceCents = cents
    if (/InStock|LimitedAvailability|OnlineOnly/i.test(String(offer.availability ?? ''))) inStock = true
  }
  if (priceCents != null && offers.every(o => !o.availability)) inStock = true

  const { description, rating } = extractJsonLdRatingAndDescription(product)

  return {
    retailer,
    externalId,
    url,
    title: decodeTitle(name),
    imageUrl: pickString(product.image),
    priceCents: inStock ? priceCents : null,
    currency: 'USD',
    brand: pickString(product.brand),
    wasPriceCents: null,
    inStock: priceCents != null ? inStock : false,
    gtin: normalizeGtin(pickString(product.gtin13) ?? pickString(product.gtin12) ?? pickString(product.gtin)),
    mpn: pickString(product.mpn) ?? pickString(product.model),
    sku: pickString(product.sku) ?? externalId,
    description,
    rating,
  }
}

function makeAdapter(cfg: {
  id: RetailerId
  label: string
  hosts: string[]
  productUrl: (id: string) => string
  parse: (url: string) => string | null
}): RetailerAdapter {
  return {
    id: cfg.id,
    label: cfg.label,
    hosts: cfg.hosts,
    needsBrowser: true,
    supportsSearch: false, // Akamai blocks search too; discovery is via paste-a-URL
    parseUrl(url) {
      const id = cfg.parse(url)
      return id ? { externalId: id, url: cfg.productUrl(id) } : null
    },
    async search(): Promise<ProductSummary[]> {
      return []
    },
    async getProduct(externalId) {
      const url = cfg.productUrl(externalId)
      const page = await fetchWithLadder(url, {
        forceBrowser: true,
        isValid: html => html.length > 5_000 && !/Access Denied|Error Page/i.test(html),
      })
      if (!page) return null
      // JSON-LD first, LLM self-heal if the store drops or changes its structured data.
      return parseWithHeal(page.html, { retailer: cfg.id, externalId, url }, h => parseProductJsonLd(cfg.id, externalId, url, h))
    },
  }
}

export const homedepotAdapter = makeAdapter({
  id: 'homedepot',
  label: 'Home Depot',
  hosts: ['homedepot.com', 'www.homedepot.com'],
  productUrl: id => `https://www.homedepot.com/p/${id}`,
  parse: url => url.match(/\/p\/(?:[^/]+\/)*(\d{9,})/)?.[1] ?? null,
})

export const lowesAdapter = makeAdapter({
  id: 'lowes',
  label: "Lowe's",
  hosts: ['lowes.com', 'www.lowes.com'],
  productUrl: id => `https://www.lowes.com/pd/${id}`,
  parse: url => url.match(/\/pd\/(?:[^/]+\/)?(\d+)/)?.[1] ?? null,
})

// Apple, Costco, and BJ's — all anti-bot storefronts, tracked via the render + JSON-LD
// path (best-effort like HD/Lowe's). externalId is the canonicalized URL since these
// don't expose a clean numeric id we can rebuild a URL from, so productUrl echoes it back.
export const appleAdapter = makeAdapter({
  id: 'apple',
  label: 'Apple',
  hosts: ['apple.com', 'www.apple.com'],
  productUrl: id => (id.startsWith('http') ? id : `https://www.apple.com${id}`),
  parse: url => /apple\.com\/shop\//.test(url) ? url.split(/[?#]/)[0]! : null,
})

export const costcoAdapter = makeAdapter({
  id: 'costco',
  label: 'Costco',
  hosts: ['costco.com', 'www.costco.com'],
  productUrl: id => (id.startsWith('http') ? id : `https://www.costco.com${id}`),
  parse: url => /costco\.com\/.*\.product\.\d+\.html/.test(url) ? url.split(/[?#]/)[0]! : null,
})

export const bjsAdapter = makeAdapter({
  id: 'bjs',
  label: "BJ's",
  hosts: ['bjs.com', 'www.bjs.com'],
  productUrl: id => (id.startsWith('http') ? id : `https://www.bjs.com${id}`),
  parse: url => /bjs\.com\/product\//.test(url) ? url.split(/[?#]/)[0]! : null,
})

// Temu & Woot — same best-effort render+JSON-LD(+self-heal) treatment. Neither exposes a
// stable public search we can scrape reliably, so like the adapters above they're paste-a-URL
// only; cross-retailer discovery (Bing compare, deals.ts) still finds and tracks them fine.
export const temuAdapter = makeAdapter({
  id: 'temu',
  label: 'Temu',
  hosts: ['temu.com', 'www.temu.com'],
  // Temu uses two URL shapes in the wild: the SEO slug (`/<name>-g-<id>.html`) and the
  // share/redirect form (`/goods.html?goods_id=<id>`, or `_x_...` variants that still carry
  // goods_id). Neither pattern needs guessing at a short externalId scheme — the whole
  // canonicalized URL doubles as the id, same as the Apple/Costco/BJ's adapters above.
  productUrl: id => id,
  parse: url => {
    if (/-g-\d+\.html/i.test(url)) return url.split(/[?#]/)[0]!
    const goodsId = (() => { try { return new URL(url).searchParams.get('goods_id') } catch { return null } })()
    return goodsId ? `https://www.temu.com/goods.html?goods_id=${goodsId}` : null
  },
})

export const wootAdapter = makeAdapter({
  id: 'woot',
  label: 'Woot!',
  hosts: ['woot.com', 'www.woot.com'],
  productUrl: id => `https://www.woot.com/offers/${id}`,
  parse: url => url.match(/woot\.com\/offers\/([a-z0-9-]+)/i)?.[1] ?? null,
})

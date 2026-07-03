// Walmart adapter. Product pages embed everything in a Next.js <script id="__NEXT_DATA__">
// JSON blob, so a plain fetch (which works from a residential IP) yields clean structured
// data — no HTML scraping. Search pages, however, are PerimeterX-gated ("Robot or human?"),
// so search escalates through the browser ladder and still often comes back empty; the
// cross-retailer matcher leans on GTIN/model from the product blob instead.

import { decodeTitle, fetchWithLadder, normalizeGtin, parseMoney } from '@/lib/shopping/fetch'
import { parseWithHeal } from '@/lib/shopping/selfHeal'
import type { ProductDetail, ProductSummary, RetailerAdapter } from '@/lib/shopping/types'

const PRODUCT_URL = (id: string) => `https://www.walmart.com/ip/${id}`

function nextData(html: string): Record<string, unknown> | null {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  if (!m) return null
  try {
    return JSON.parse(m[1]!) as Record<string, unknown>
  } catch {
    return null
  }
}

function dig(obj: unknown, ...path: string[]): unknown {
  let cur: unknown = obj
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

export function parseProductHtml(itemId: string, html: string): ProductDetail | null {
  const data = nextData(html)
  if (!data) return null
  const product = dig(data, 'props', 'pageProps', 'initialData', 'data', 'product') as Record<string, unknown> | undefined
  if (!product || typeof product !== 'object') return null

  const name = typeof product.name === 'string' ? decodeTitle(product.name) : null
  if (!name) return null

  const priceInfo = product.priceInfo as Record<string, unknown> | undefined
  const priceCents = parseMoney(dig(priceInfo, 'currentPrice', 'price') as number | undefined ?? null)
  const wasPriceCents = parseMoney(dig(priceInfo, 'wasPrice', 'price') as number | undefined ?? null)
  const availability = String(product.availabilityStatus ?? '')
  const inStock = availability === 'IN_STOCK'

  const imageUrl =
    (dig(product, 'imageInfo', 'thumbnailUrl') as string | undefined) ??
    (dig(product, 'imageInfo', 'allImages', '0', 'url') as string | undefined) ??
    null

  return {
    retailer: 'walmart',
    externalId: itemId,
    url: PRODUCT_URL(itemId),
    title: name,
    imageUrl,
    priceCents: inStock ? priceCents : null,
    currency: 'USD',
    brand: typeof product.brand === 'string' ? product.brand : null,
    wasPriceCents,
    inStock,
    gtin: normalizeGtin(typeof product.upc === 'string' ? product.upc : null),
    mpn: typeof product.model === 'string' ? product.model : null,
    sku: itemId,
  }
}

export function parseSearchHtml(html: string, limit = 12): ProductSummary[] {
  const data = nextData(html)
  if (!data) return []
  const stacks = dig(data, 'props', 'pageProps', 'initialData', 'searchResult', 'itemStacks') as unknown
  const items = Array.isArray(stacks) ? (dig(stacks[0], 'items') as unknown) : null
  if (!Array.isArray(items)) return []
  const out: ProductSummary[] = []
  for (const it of items) {
    if (!it || typeof it !== 'object') continue
    const item = it as Record<string, unknown>
    const id = String(item.usItemId ?? item.id ?? '')
    const name = typeof item.name === 'string' ? item.name : null
    if (!id || !name) continue
    out.push({
      retailer: 'walmart',
      externalId: id,
      url: PRODUCT_URL(id),
      title: decodeTitle(name),
      imageUrl: (item.imageUrl as string | undefined) ?? (dig(item, 'imageInfo', 'thumbnailUrl') as string | undefined) ?? null,
      priceCents: parseMoney(dig(item, 'priceInfo', 'currentPrice', 'price') as number | undefined ?? (item.price as number | undefined) ?? null),
      currency: 'USD',
    })
    if (out.length >= limit) break
  }
  return out
}

export const walmartAdapter: RetailerAdapter = {
  id: 'walmart',
  label: 'Walmart',
  hosts: ['walmart.com', 'www.walmart.com'],
  needsBrowser: false,
  supportsSearch: true,

  parseUrl(url) {
    const m = url.match(/\/ip\/(?:[^/]+\/)?(\d+)/)
    if (!m) return null
    return { externalId: m[1]!, url: PRODUCT_URL(m[1]!) }
  },

  async search(query) {
    const page = await fetchWithLadder(`https://www.walmart.com/search?q=${encodeURIComponent(query)}`, {
      isValid: html => html.includes('__NEXT_DATA__') && !/Robot or human/i.test(html),
    })
    return page ? parseSearchHtml(page.html) : []
  },

  async getProduct(itemId) {
    const page = await fetchWithLadder(PRODUCT_URL(itemId), {
      isValid: html => html.includes('__NEXT_DATA__'),
    })
    if (!page) return null
    return parseWithHeal(page.html, { retailer: 'walmart', externalId: itemId, url: PRODUCT_URL(itemId) }, h => parseProductHtml(itemId, h))
  },
}

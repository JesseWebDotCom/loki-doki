// Target adapter. Target's price is fetched client-side from redsky.target.com, and that
// endpoint is captcha-gated to bare requests from a residential IP (the page's public
// apiKey doesn't help — redsky returns a captcha challenge). So we render the product
// page in a real browser and read the resolved DOM: the price sits in
// [data-test="product-price"] and the title in [data-test="product-title"]. needsBrowser
// is true so the poller runs Target in its serialized render lane.

import { fetchWithLadder, decodeTitle, parseMoney } from '@/lib/shopping/fetch'
import { parseWithHeal } from '@/lib/shopping/selfHeal'
import type { ProductDetail, ProductSummary, RetailerAdapter } from '@/lib/shopping/types'

const PRODUCT_URL = (tcin: string) => `https://www.target.com/p/-/A-${tcin}`

function firstMatch(html: string, ...res: RegExp[]): string | null {
  for (const re of res) {
    const m = html.match(re)
    if (m?.[1]) return m[1]
  }
  return null
}

export function parseProductHtml(tcin: string, html: string): ProductDetail | null {
  const priceStr = firstMatch(html, /data-test="product-price"[^>]*>\s*(\$[\d,]+\.\d{2})/)
  const priceCents = parseMoney(priceStr)

  const rawTitle = firstMatch(
    html,
    /data-test="product-title"[^>]*>\s*([^<]{4,200})/,
    /<h1[^>]*>\s*([^<]{4,200})/,
    /property="og:title"[^>]*content="([^"]+)"/,
    /<title>([^<|]+)/,
  )
  const title = rawTitle ? decodeTitle(rawTitle) : null
  if (!title) return null

  const imageUrl = firstMatch(
    html,
    /property="og:image"[^>]*content="([^"]+)"/,
    /content="([^"]+)"[^>]*property="og:image"/,
    /(https:\/\/target\.scene7\.com\/is\/image\/Target\/[^"'\s]+)/,
  )

  // Target renders the price only when purchasable, so a rendered page with no price is
  // effectively out of stock (or a variant picker). Treat missing price as OOS, not failure,
  // since the title parsed fine (we did reach a real product page).
  const inStock = priceCents != null

  return {
    retailer: 'target',
    externalId: tcin,
    url: PRODUCT_URL(tcin),
    title,
    imageUrl: imageUrl ?? null,
    priceCents,
    currency: 'USD',
    brand: null,
    wasPriceCents: null,
    inStock,
    gtin: null,
    mpn: null,
    sku: tcin,
  }
}

export const targetAdapter: RetailerAdapter = {
  id: 'target',
  label: 'Target',
  hosts: ['target.com', 'www.target.com'],
  needsBrowser: true,
  supportsSearch: false, // redsky search is captcha-gated; discovery is via paste-a-URL

  parseUrl(url) {
    const m = url.match(/\/p\/[^/]*\/-\/A-(\d+)/) ?? url.match(/\/A-(\d+)/)
    if (!m) return null
    return { externalId: m[1]!, url: PRODUCT_URL(m[1]!) }
  },

  async search(): Promise<ProductSummary[]> {
    return []
  },

  async getProduct(tcin) {
    // forceBrowser: the plain fetch returns the shell without a price, so skip straight
    // to the render (its DOM carries the resolved price).
    const page = await fetchWithLadder(PRODUCT_URL(tcin), {
      forceBrowser: true,
      isValid: html => /data-test="product-title"/.test(html) || /data-test="product-price"/.test(html),
    })
    if (!page) return null
    return parseWithHeal(page.html, { retailer: 'target', externalId: tcin, url: PRODUCT_URL(tcin) }, h => parseProductHtml(tcin, h))
  },
}

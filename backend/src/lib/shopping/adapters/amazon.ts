// Amazon adapter. Plain fetch works from a residential IP (verified: product pages and
// /s search both return full HTML, no captcha). Parsing is regex over known stable ids —
// parseProductHtml/parseSearchHtml are pure and exported so fixtures can drive them
// without any network. Price markup gotcha (2026): the buybox a-offscreen span is now
// literally " " — the real value lives in a-price-whole/-fraction and in the
// apex-pricetopay-value block, so we try those in order.

import { fetchHtml, parseLabelValueTable } from '@/lib/scrape'
import { decodeTitle, parseMoney } from '@/lib/shopping/fetch'
import { parseWithHeal } from '@/lib/shopping/selfHeal'
import type { ProductDetail, ProductSummary, RetailerAdapter } from '@/lib/shopping/types'

const PRODUCT_URL = (asin: string) => `https://www.amazon.com/dp/${asin}`

function isValidProductPage(html: string): boolean {
  return html.includes('id="productTitle"') && !html.includes('validateCaptcha')
}

/** The buybox/core-price region; price regexes only run inside it to avoid picking up
 *  carousel or "frequently bought together" prices elsewhere on the page. */
function coreSegment(html: string): string | null {
  const m = html.match(/id="corePriceDisplay_desktop_feature_div"([\s\S]{0,8000})/)
  return m ? m[1]! : null
}

export function parseProductHtml(asin: string, html: string): ProductDetail | null {
  if (!isValidProductPage(html)) return null

  const titleM = html.match(/id="productTitle"[^>]*>\s*([^<]+)/)
  if (!titleM) return null
  const title = decodeTitle(titleM[1]!)

  let priceCents: number | null = null
  const seg = coreSegment(html)
  if (seg) {
    const whole = seg.match(/a-price-whole">([\d,]+)/)
    const fraction = seg.match(/a-price-fraction">(\d{2})/)
    if (whole) {
      priceCents = Number(whole[1]!.replace(/,/g, '')) * 100 + (fraction ? Number(fraction[1]) : 0)
    } else {
      const off = seg.match(/class="a-offscreen">(\$[\d,.]+)/)
      if (off) priceCents = parseMoney(off[1])
    }
  }
  if (priceCents == null) {
    const apex = html.match(/apex-pricetopay-value"[\s\S]{0,200}?class="a-offscreen">(\$[\d,.]+)/)
    if (apex) priceCents = parseMoney(apex[1])
  }

  // Strikethrough list price sits in an a-text-price block near the buybox.
  let wasPriceCents: number | null = null
  const basis = (seg ?? html).match(/a-text-price[\s\S]{0,150}?class="a-offscreen">(\$[\d,.]+)/)
  if (basis) wasPriceCents = parseMoney(basis[1])

  // Stock state must come from the availability block only — "Currently unavailable"
  // also lives in the page's JS message catalog, so a whole-page test false-positives.
  const availSeg = html.match(/id="availability"([\s\S]{0,600})/)?.[1] ?? ''
  const availText = availSeg.replace(/<[^>]+>/g, ' ').replace(/\{[\s\S]*/, '').replace(/\s+/g, ' ').trim()
  const unavailable = /currently unavailable|out of stock/i.test(availText)
  const inStock = !unavailable && (priceCents != null || /in stock|only \d+ left|available/i.test(availText))

  // A page with a title but neither a price nor any availability signal is more likely a
  // partial/blocked render than a real observation — treat as parse failure.
  if (priceCents == null && !unavailable && !availText) return null

  let imageUrl: string | null = null
  const dyn = html.match(/data-a-dynamic-image="([^"]+)"/)
  if (dyn) {
    try {
      const parsed = JSON.parse(dyn[1]!.replace(/&quot;/g, '"')) as Record<string, unknown>
      imageUrl = Object.keys(parsed)[0] ?? null
    } catch { /* fall through to landingImage */ }
  }
  if (!imageUrl) {
    const landing = html.match(/id="landingImage"[^>]*\ssrc="([^"]+)"/)
    if (landing) imageUrl = landing[1]!
  }

  const table = parseLabelValueTable(html)
  const mpn = table.get('item model number') ?? null
  let brand = table.get('brand') ?? table.get('brand name') ?? null
  if (!brand) {
    const byline = html.match(/id="bylineInfo"[^>]*>\s*(?:Visit the |Brand: )?([A-Za-z0-9][^<]*?)(?: Store)?\s*</)
    if (byline) brand = decodeTitle(byline[1]!)
  }
  if (!brand) brand = null

  // Star rating + review count (near #acrPopover/#acrCustomerReviewText) and a short
  // description from the feature bullets — best-effort, never blocks the price parse.
  let rating: { value: number; count: number } | null = null
  const ratingSeg = html.match(/acrPopover[\s\S]{0,300}/)?.[0]
  const ratingM = ratingSeg?.match(/([\d.]+) out of 5 stars/)
  const countM = html.match(/id="acrCustomerReviewText"\s+aria-label="([\d,]+)\s*Reviews"/)
  if (ratingM) {
    rating = { value: Number(ratingM[1]), count: countM ? Number(countM[1]!.replace(/,/g, '')) : 0 }
  }

  const bulletsSeg = html.match(/feature-bullets"[\s\S]{0,3000}/)?.[0]
  const bullets = bulletsSeg
    ? [...bulletsSeg.matchAll(/<span class="a-list-item">\s*([^<]{10,200})/g)].slice(0, 3).map(m => decodeTitle(m[1]!))
    : []
  const description = bullets.length ? bullets.join(' • ') : null

  return {
    retailer: 'amazon',
    externalId: asin,
    url: PRODUCT_URL(asin),
    title,
    imageUrl,
    priceCents: inStock ? priceCents : null,
    currency: 'USD',
    brand,
    wasPriceCents,
    inStock,
    gtin: null, // Amazon pages don't expose UPC/GTIN
    mpn,
    sku: asin,
    description,
    rating,
  }
}

export function parseSearchHtml(html: string, limit = 12): ProductSummary[] {
  const out: ProductSummary[] = []
  const blocks = html.split(/data-component-type="s-search-result"/).slice(1)
  for (const block of blocks) {
    const asin = block.match(/data-asin="([A-Z0-9]{10})"/)?.[1]
      // The asin attribute usually precedes the split marker; recover it from the tail
      // of the previous chunk via the csa-c-item-id that repeats inside each card.
      ?? block.match(/csa-c-item-id="[^"]*\.([A-Z0-9]{10})[^"]*"/)?.[1]
    if (!asin) continue
    const titleM = block.match(/<h2[^>]*aria-label="([^"]{10,})"/)
      ?? block.match(/s-line-clamp-\d[^>]*>[\s\S]{0,100}?<span[^>]*>([^<]{10,})<\/span>/)
    if (!titleM) continue
    const price = block.match(/class="a-offscreen">(\$[\d,.]+)/)
    // The strikethrough list price sits in an a-text-price span after the current price.
    const was = block.match(/a-text-price"[^>]*>\s*<span class="a-offscreen">(\$[\d,.]+)/)
    const img = block.match(/class="s-image"[^>]*\ssrc="([^"]+)"/) ?? block.match(/\ssrc="(https:\/\/m\.media-amazon\.com\/images\/[^"]+)"/)
    out.push({
      retailer: 'amazon',
      externalId: asin,
      url: PRODUCT_URL(asin),
      title: decodeTitle(titleM[1]!),
      imageUrl: img ? img[1]! : null,
      priceCents: price ? parseMoney(price[1]) : null,
      wasPriceCents: was ? parseMoney(was[1]) : null,
      currency: 'USD',
    })
    if (out.length >= limit) break
  }
  return out
}

export const amazonAdapter: RetailerAdapter = {
  id: 'amazon',
  label: 'Amazon',
  hosts: ['amazon.com', 'www.amazon.com', 'smile.amazon.com', 'a.co'],
  needsBrowser: false,
  supportsSearch: true,

  parseUrl(url) {
    const m = url.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?#]|$)/)
    if (!m) return null
    return { externalId: m[1]!, url: PRODUCT_URL(m[1]!) }
  },

  async search(query) {
    const html = await fetchHtml(`https://www.amazon.com/s?k=${encodeURIComponent(query)}`, { timeoutMs: 15_000 })
    if (!html || !html.includes('s-search-result')) return []
    return parseSearchHtml(html)
  },

  async getProduct(asin) {
    const html = await fetchHtml(PRODUCT_URL(asin), { timeoutMs: 15_000 })
    if (!html) return null
    // Fast regex parse, with an LLM self-heal if Amazon has changed its markup.
    return parseWithHeal(html, { retailer: 'amazon', externalId: asin, url: PRODUCT_URL(asin) }, h => parseProductHtml(asin, h))
  },
}

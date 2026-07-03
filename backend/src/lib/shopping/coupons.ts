// Per-retailer coupon/promo lookup. RetailMeNot and most coupon aggregators are
// Cloudflare-gated, but CouponFollow serves its per-store pages plainly (verified 2026-07),
// listing the active offer descriptions ("40% Off Your Order", "$5 off $50"). We surface
// those descriptions next to each retailer in a product's offer table, with a link to the
// coupon page where the actual code is revealed (codes are behind a click-through redirect,
// so we intentionally don't scrape them — we point the user at them). Cached 6h.

import { cachedLookup } from '@/lib/lookupCache'
import { fetchHtml } from '@/lib/scrape'
import { decodeTitle } from '@/lib/shopping/fetch'
import type { RetailerId } from '@/lib/shopping/types'

const TTL_MS = 6 * 60 * 60 * 1000

// Retailer id → the domain CouponFollow keys its store pages by.
const COUPON_SITES: Partial<Record<RetailerId, string>> = {
  amazon: 'amazon.com',
  walmart: 'walmart.com',
  target: 'target.com',
  homedepot: 'homedepot.com',
  lowes: 'lowes.com',
  bestbuy: 'bestbuy.com',
  ebay: 'ebay.com',
}

export interface Coupon {
  title: string
  url: string       // coupon page — user reveals the code there
}

export function couponsSupported(retailer: string): boolean {
  return retailer in COUPON_SITES
}

function parseCoupons(html: string, pageUrl: string, limit: number): Coupon[] {
  const out: Coupon[] = []
  const seen = new Set<string>()
  const re = /class="[^"]*offer-title[^"]*"[^>]*>\s*([^<]{4,120})/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) && out.length < limit) {
    const title = decodeTitle(m[1]!)
    // Skip the boilerplate summary headline CouponFollow leads every page with.
    if (/Promo Codes\s*(&|and)\s*Coupons/i.test(title)) continue
    const key = title.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ title, url: pageUrl })
  }
  return out
}

export async function getCoupons(retailer: string, limit = 6): Promise<Coupon[]> {
  const site = COUPON_SITES[retailer as RetailerId]
  if (!site) return []
  return cachedLookup('shopping:coupons', site, TTL_MS, async () => {
    const url = `https://couponfollow.com/site/${site}`
    const html = await fetchHtml(url, { timeoutMs: 12_000 })
    if (!html) return []
    return parseCoupons(html, url, limit)
  })
}

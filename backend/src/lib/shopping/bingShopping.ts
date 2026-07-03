// Bing Shopping "across the web" price check. Google Shopping blocks keyless requests, but
// Bing's shopping vertical serves parseable HTML to a plain fetch from a residential IP and
// aggregates offers across many sellers. We use it NOT for tracking (its outbound links are
// Bing aclick redirects and it mixes in noisy marketplace sellers) but to answer "is the
// price I'm looking at good vs the wider market?" — a lowest/typical range across sellers.

import { cachedLookup } from '@/lib/lookupCache'
import { fetchHtml } from '@/lib/scrape'
import { decodeTitle, parseMoney } from '@/lib/shopping/fetch'
import { sameVariant } from '@/lib/shopping/variantMatch'

const TTL_MS = 6 * 60 * 60 * 1000

export type OfferCondition = 'new' | 'used' | 'refurbished' | 'unknown'

export interface MarketOffer {
  seller: string
  priceCents: number
  major: boolean            // a recognized national retailer (vs a marketplace reseller)
  url: string | null        // Bing aclick redirect → the merchant's product listing
  title: string             // the offer's own product title — used to confirm it's the SAME item
  condition: OfferCondition // see conditionOf — 'unknown' for unverifiable marketplace offers
}

// Bing Shopping cards carry no structured condition field, and eBay itself hard-blocks direct
// scraping from a residential IP (verified), so we read condition off the offer TITLE only.
// eBay/marketplace titles routinely say "Used"/"Pre-Owned"/"Refurbished"/"Renewed"/"Open Box",
// but many OMIT it (eBay shows condition as a structured badge we can't see here). So: a major
// national retailer is new retail stock; an explicit keyword wins; a marketplace offer with NO
// signal is 'unknown' — we honestly can't tell rather than pretend it's new. Bing's /shop
// vertical lists FIXED-PRICE offers only (no auctions — verified: no auction/bidding markup),
// so "exclude auctions" is satisfied by the data source; JUNK drops the scrap listings.
const REFURB = /\b(refurb(?:ished)?|renewed|recertified|re-?certified|open[ -]?box)\b/i
const USED = /\b(used|pre-?owned|preowned|second[ -]?hand)\b/i
const JUNK = /\b(for parts|not working|doesn'?t work|broken|as-?is|salvage|damaged|read (?:the )?description|cracked|repair only|spares? or repair)\b/i

function conditionOf(title: string, major: boolean): OfferCondition {
  if (REFURB.test(title)) return 'refurbished'
  if (USED.test(title)) return 'used'
  if (major) return 'new'
  return 'unknown' // marketplace w/ no stated condition — can't verify (eBay blocks scraping)
}

export interface MarketSummary {
  offers: MarketOffer[]        // major sellers first, then by price, capped
  typicalCents: number | null  // median — robust to knockoff/used outliers
  lowestMajorCents: number | null // lowest at a recognized retailer (the trustworthy floor)
  count: number
}

// Bing Shopping mixes national retailers with long-tail marketplace resellers (used units,
// knockoffs, accessories priced far below the real product). We flag the recognized ones so
// the UI can lead with trustworthy prices and the summary can ignore junk outliers.
// Recognized national retailers with consistent new-item pricing. eBay and other
// marketplaces are deliberately EXCLUDED — their used/renewed/knockoff listings swing wildly
// and would poison a "typical price" signal.
const MAJOR_SELLERS = /amazon|walmart|target|best ?buy|home ?depot|lowe|costco|bj'?s|newegg|staples|micro ?center|apple|samsung|dell|adorama|b&h|chewy|wayfair/i

/** Bing wraps each offer in an `aclick` tracker whose `u` param is the base64 destination.
 *  When that decodes to a direct merchant URL we return it (cleanest — no ad interstitial);
 *  for affiliate-redirector destinations we keep the aclick URL (redirects fine in-browser). */
function resolveOfferUrl(aclick: string): string {
  try {
    const u = new URL(aclick).searchParams.get('u')
    if (u) {
      for (const cand of [u, u.slice(2)]) {
        try {
          const decoded = decodeURIComponent(Buffer.from(cand, 'base64').toString('utf8'))
          if (/^https?:\/\//i.test(decoded)) {
            const host = new URL(decoded).hostname
            if (!/isaveit|buycheapr|clickserve|dpbolvw|anrdoezrs|prf\.hn|shareasale/i.test(host)) return decoded
          }
        } catch { /* try next candidate */ }
      }
    }
  } catch { /* fall through */ }
  return aclick
}

function parseOffers(html: string): MarketOffer[] {
  // Each offer card is wrapped in a Bing `aclick` anchor (a tracking redirect that lands on
  // the merchant's product page) and contains a price then a seller. We pair price→seller by
  // proximity (resilient to Bing's shifting markup), then attach the nearest preceding aclick
  // link so each row is clickable through to the real listing.
  const linkPositions: { pos: number; url: string }[] = []
  const linkRe = /href="(https:\/\/www\.bing\.com\/aclick[^"]+)"/g
  let lm: RegExpExecArray | null
  while ((lm = linkRe.exec(html))) linkPositions.push({ pos: lm.index, url: lm[1]!.replace(/&amp;/g, '&') })

  function nearestLink(pos: number): string | null {
    let lo = 0, hi = linkPositions.length - 1, best: string | null = null
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (linkPositions[mid]!.pos <= pos) { best = linkPositions[mid]!.url; lo = mid + 1 } else hi = mid - 1
    }
    return best
  }

  // Each offer card = a product title (full text in the span's `title=` attr) → price → seller.
  // Capturing the title lets the caller confirm each offer is the SAME product, not a variant.
  const re = /br-offTtl[^>]*">\s*<span title="([^"]{4,220})"[\s\S]{0,700}?br-price"[^>]*>\s*(\$[\d,]+(?:\.\d{2})?)[\s\S]{0,300}?br-offSlrTxt"[^>]*>\s*([^<]{2,40})/g
  const seen = new Set<string>()
  const offers: MarketOffer[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const title = decodeTitle(m[1]!)
    const priceCents = parseMoney(m[2])
    if (priceCents == null || priceCents < 100) continue
    if (JUNK.test(title)) continue // scrap/for-parts/broken listings — never a real price comp
    const seller = decodeTitle(m[3]!).replace(/\.com$/i, '').trim()
    if (!seller) continue
    const key = `${seller.toLowerCase()}:${priceCents}`
    if (seen.has(key)) continue
    seen.add(key)
    const major = MAJOR_SELLERS.test(seller)
    const aclick = nearestLink(m.index)
    offers.push({ title, seller, priceCents, major, url: aclick ? resolveOfferUrl(aclick) : null, condition: conditionOf(title, major) })
  }
  return offers
}

// ── same-product matching ──────────────────────────────────────────────────────────
// Bing returns a grid of similar products; naively taking every price mixes variants (a
// 20,100mAh at a lower price) and accessories (a $32 silicone case) into "the same product".
// We keep only offers that share the reference product's distinguishing capacity AND enough
// title tokens, and aren't an accessory the reference isn't.

const STOP = new Set(['the', 'a', 'an', 'and', 'with', 'for', 'of', 'in', 'to', 'new', 'max', 'pro', 'plus', 'series'])
const ACCESSORY = /\b(case|cover|sleeve|pouch|skin|silicone|screen protector|tempered glass|lanyard|sticker|decal|holster|mount only|adapter only|cable only)\b/i

function sigTokens(t: string): Set<string> {
  return new Set(
    t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)),
  )
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

/** Keep only offers that are plausibly the SAME product as the reference title. */
function sameProduct(offers: MarketOffer[], refTitle: string): MarketOffer[] {
  const refTokens = sigTokens(refTitle)
  const refIsAccessory = ACCESSORY.test(refTitle)
  if (refTokens.size === 0) return offers
  return offers.filter(o => {
    if (!sameVariant(refTitle, o.title)) return false // different (or unstated) size/capacity/res/storage/pack → reject
    if (!refIsAccessory && ACCESSORY.test(o.title)) return false // a case/cover when we want the device
    return jaccard(sigTokens(o.title), refTokens) >= 0.3
  })
}

function median(nums: number[]): number | null {
  if (!nums.length) return null
  const s = [...nums].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

function summarize(offers: MarketOffer[]): MarketSummary {
  // Typical price should reflect a NEW unit. Prefer majors (all new retailers); else fall back
  // to explicitly-new offers; only as a last resort use everything (which may include used).
  const majors = offers.filter(o => o.major)
  const newOffers = offers.filter(o => o.condition === 'new')
  const basis = majors.length >= 3 ? majors : (newOffers.length ? newOffers : offers)
  // Sorted cheapest-first for the full "everywhere this sells" list; callers that only want
  // trustworthy prices filter on `.major` themselves.
  const sorted = [...offers].sort((a, b) => a.priceCents - b.priceCents)
  return {
    offers: sorted.slice(0, 16),
    typicalCents: median(basis.map(o => o.priceCents)),
    lowestMajorCents: majors.length ? Math.min(...majors.map(o => o.priceCents)) : null,
    count: offers.length,
  }
}

/** Offers for a product query across the web via Bing Shopping. Best-effort, cached. */
export async function getMarketOffers(query: string): Promise<MarketSummary> {
  const q = query.trim()
  if (q.length < 3) return { offers: [], typicalCents: null, lowestMajorCents: null, count: 0 }
  return cachedLookup('shopping:market', q.toLowerCase(), TTL_MS, async () => {
    const html = await fetchHtml(`https://www.bing.com/shop?q=${encodeURIComponent(q)}`, { timeoutMs: 15_000 })
    if (!html || !html.includes('br-price')) return { offers: [], typicalCents: null, lowestMajorCents: null, count: 0 }
    // Filter Bing's mixed grid down to offers that are the SAME product as the query.
    return summarize(sameProduct(parseOffers(html), q))
  })
}

// Cross-retailer matching: given a tracked product, find the same item at other stores so
// their prices can be compared. Amazon has a working native search; the other priceable
// retailers (Walmart, Target) don't, so we discover their product pages through the local
// metasearch engine (lib/shopping/discover) and resolve each to a real price. Candidates
// carry an actual price and a confidence, and are surfaced as suggestions the user confirms
// — a wrong auto-link would corrupt the comparison and the price history under it.

import { and, eq, ne } from 'drizzle-orm'
import { db } from '@/db'
import { shoppingListings } from '@/db/schema'
import { adapterFor, adapterForUrl, searchableAdapters } from '@/lib/shopping/adapters'
import { COMPARABLE_RETAILERS, discoverProductUrls } from '@/lib/shopping/discover'
import { normalizeGtin } from '@/lib/shopping/fetch'
import { sameVariant } from '@/lib/shopping/variantMatch'
import type { ProductDetail, ProductSummary } from '@/lib/shopping/types'

export interface MatchCandidate {
  summary: ProductSummary
  score: number
  matchType: 'gtin' | 'model' | 'fuzzy'
}

const STOP = new Set(['the', 'a', 'an', 'with', 'for', 'and', 'of', 'in', 'new', 'inch', 'in.', 'ct', 'pack'])

function tokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(t => t.length > 1 && !STOP.has(t)),
  )
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

function normModel(s: string | null | undefined): string | null {
  if (!s) return null
  const n = s.toLowerCase().replace(/[^a-z0-9]/g, '')
  return n.length >= 3 ? n : null
}

export interface MatchQuery {
  title: string
  brand: string | null
  model: string | null
  gtin: string | null
  /** Retailers already linked to the product — excluded from suggestions. */
  existingRetailers: Set<string>
}

function scoreAgainst(q: MatchQuery, cand: ProductDetail | ProductSummary): { score: number; matchType: MatchCandidate['matchType'] } {
  const wantTokens = tokens(`${q.brand ?? ''} ${q.title}`)
  const wantModel = normModel(q.model)
  const wantGtin = normalizeGtin(q.gtin)
  const candGtin = 'gtin' in cand ? normalizeGtin(cand.gtin) : null
  const candMpn = 'mpn' in cand ? normModel(cand.mpn) : null

  if (wantGtin && candGtin && wantGtin === candGtin) return { score: 1, matchType: 'gtin' }
  if (wantModel && (candMpn === wantModel || normModel(cand.title)?.includes(wantModel))) return { score: 0.85, matchType: 'model' }
  // Fuzzy fallback has no exact identifier to lean on, so title tokens alone can't tell a
  // 24" monitor from a 27" one in the same series — reject anything whose stated
  // size/capacity/resolution/storage/pack conflicts with (or omits) the tracked product's own.
  if (!sameVariant(q.title, cand.title)) return { score: 0, matchType: 'fuzzy' }
  return { score: jaccard(wantTokens, tokens(`${cand.brand ?? ''} ${cand.title}`)), matchType: 'fuzzy' }
}

/**
 * Find the same product at other retailers, with real prices. Amazon via native search;
 * Walmart/Target via metasearch discovery + adapter resolve. Concurrency-bounded and
 * best-effort — a store that can't be reached simply contributes nothing.
 */
export async function findOfferCandidates(q: MatchQuery): Promise<MatchCandidate[]> {
  const query = [q.brand, q.model || q.title.split(/\s+/).slice(0, 8).join(' ')].filter(Boolean).join(' ')
  const candidates: MatchCandidate[] = []

  // 1. Amazon (and any other natively-searchable retailer) via adapter search.
  const nativeAdapters = searchableAdapters().filter(a => !q.existingRetailers.has(a.id))
  const nativeResults = await Promise.allSettled(nativeAdapters.map(a => a.search(query)))
  for (const settled of nativeResults) {
    if (settled.status !== 'fulfilled') continue
    for (const summary of settled.value.slice(0, 6)) {
      const { score, matchType } = scoreAgainst(q, summary)
      if (score >= 0.35) candidates.push({ summary, score, matchType })
    }
  }

  // 2. Walmart/Target via metasearch discovery → resolve each to a real price.
  const discoverRetailers = COMPARABLE_RETAILERS.filter(r => !q.existingRetailers.has(r))
  await Promise.all(discoverRetailers.map(async retailer => {
    const urls = await discoverProductUrls(query, retailer, 3)
    for (const url of urls.slice(0, 2)) {
      const routed = adapterForUrl(url)
      if (!routed) continue
      const detail = await adapterFor(routed.adapter.id)?.getProduct(routed.externalId)
      if (!detail || detail.priceCents == null) continue
      const { score, matchType } = scoreAgainst(q, detail)
      if (score >= 0.35) candidates.push({ summary: detail, score: matchType === 'fuzzy' ? score : Math.max(score, 0.8), matchType })
    }
  }))

  // Best candidate per retailer, capped.
  candidates.sort((a, b) => b.score - a.score)
  const seen = new Set<string>()
  const out: MatchCandidate[] = []
  for (const c of candidates) {
    if (seen.has(c.summary.retailer)) continue
    seen.add(c.summary.retailer)
    out.push(c)
    if (out.length >= 6) break
  }
  return out
}

/** Retailers already linked to a product (to exclude from suggestions). */
export async function linkedRetailers(productId: string): Promise<Set<string>> {
  const rows = await db.select({ retailer: shoppingListings.retailer })
    .from(shoppingListings)
    .where(and(eq(shoppingListings.productId, productId), ne(shoppingListings.retailer, 'generic')))
  return new Set(rows.map(r => r.retailer))
}

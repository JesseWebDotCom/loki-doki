// Shopping / price-tracker core types. A RetailerAdapter knows how to resolve, search,
// and price-check one store; a PriceProvider is an external service consulted BEFORE the
// adapter (services-first sourcing — the adapter is always the 'direct' fallback).

export type RetailerId =
  | 'amazon'
  | 'walmart'
  | 'target'
  | 'homedepot'
  | 'lowes'
  | 'bestbuy'
  | 'ebay'
  | 'apple'
  | 'costco'
  | 'bjs'
  | 'temu'
  | 'woot'
  | 'generic'

export interface ProductSummary {
  retailer: RetailerId
  /** ASIN / Walmart itemId / Target TCIN / HD OMSID / Lowe's item# / normalized URL for generic. */
  externalId: string
  url: string
  title: string
  imageUrl: string | null
  /** Integer cents — never floats. Null = unknown. */
  priceCents: number | null
  /** List/strikethrough price when the listing shows one — drives the "% off" deal cue. */
  wasPriceCents?: number | null
  currency: string
  brand?: string | null
}

export interface ProductDetail extends ProductSummary {
  /** Strikethrough / list price when the page shows one. */
  wasPriceCents: number | null
  /** Out of stock is a VALID observation: inStock false + priceCents null. */
  inStock: boolean
  /** Normalized GTIN-13 (UPC-A padded with a leading zero). */
  gtin: string | null
  mpn: string | null
  sku: string | null
  /** Best-effort — a short description (feature bullets / JSON-LD description). Null when
   *  the store doesn't surface one; never required for a listing to be valid. */
  description?: string | null
  /** Best-effort star rating summary. Never fabricated — omitted when the source has none. */
  rating?: { value: number; count: number } | null
}

export interface RetailerAdapter {
  id: RetailerId
  label: string
  /** Hostnames this adapter claims for paste-a-URL routing (lowercase, no port). */
  hosts: string[]
  /** True → the poller schedules this store through the serialized Playwright lane. */
  needsBrowser: boolean
  supportsSearch: boolean
  /** Canonicalize a product URL; null = not a product page on this store. */
  parseUrl(url: string): { externalId: string; url: string } | null
  /** Best-effort search; [] on any failure, never throws. */
  search(query: string): Promise<ProductSummary[]>
  /** Null = could not determine (fetch/parse failed) — NOT the same as out of stock. */
  getProduct(externalId: string): Promise<ProductDetail | null>
}

/** One price/stock reading, however it was obtained. */
export interface PriceObservation {
  priceCents: number | null
  wasPriceCents: number | null
  inStock: boolean
  via: 'direct' | 'pricewatchpro'
  /** Fresh title/image when the source provides them (keeps listings self-healing). */
  title?: string | null
  imageUrl?: string | null
  /** Best-effort product detail-page enrichment (see ProductDetail) — carried through so
   *  it lands on shoppingListings without a separate fetch. */
  description?: string | null
  rating?: { value: number; count: number } | null
}

/** External service consulted before the direct adapter in the poller's provider chain. */
export interface PriceProvider {
  id: 'pricewatchpro'
  supports(retailer: RetailerId): boolean
  /** Null = this provider can't answer for this listing → next in chain. */
  getPrice(listing: { retailer: RetailerId; externalId: string; url: string; title: string | null }): Promise<PriceObservation | null>
  /** Optional deep-history backfill used once when a listing is first tracked. */
  getHistory?(listing: { retailer: RetailerId; externalId: string; url: string; title: string | null }): Promise<{ priceCents: number; observedAt: Date }[] | null>
}

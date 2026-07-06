// The ONE product page every click in Shop lands on — search result, favorite, history
// item, tracked product, or a deal. Built as a real storefront buy-box (image + price +
// CTA up top, everything else visible via scroll below) rather than a tabbed media-library
// page — a shopper wants to see price, retailers, and history at a glance, not click through
// tabs to find them. Works identically whether the product is already tracked or not — the
// backend's unified GET /product/:retailer/:externalId shapes both cases the same way, so
// this component barely branches on `isTracked`.

import { useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft, BellRing, CheckCircle2, ChevronDown, ExternalLink, Flame, Link2, Loader2,
  Plus, RefreshCw, ScanSearch, Star, Store, Tag, Ticket, Trash2, X, XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/cn'
import { proxyImg } from '@/lib/img'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { VideoThumb } from '@/components/youtube/media'
import { useYoutubePlayback } from '@/context/YoutubePlaybackContext'
import { PriceChart, RETAILER_COLORS, type ChartSeries } from './PriceChart'
import { useFavorites, useRecentlyViewed, itemKey } from './useShoppingLocal'
import { ShopLayout, type ProductPreview } from './ShopLayout'
import type { ShoppingWatch, EffectivePrice } from './ShoppingPage'

// ── types ────────────────────────────────────────────────────────────────────────

interface DetailListing {
  id: string | null
  productId: string | null
  retailer: string
  retailerLabel: string
  externalId: string
  url: string
  title: string | null
  imageUrl: string | null
  priceCents: number | null
  wasPriceCents: number | null
  inStock: boolean | null
  failCount: number
  lastCheckedAt: string | null
  lastChangedAt: string | null
  effective: EffectivePrice | null
  sparkline: { t: number; p: number | null }[]
  keepaGraphUrl: string | null
  description?: string | null
  ratingValue?: number | null
  ratingCount?: number | null
}

interface DetailResponse {
  isTracked: boolean
  productId: string | null
  title: string
  brand: string | null
  model: string | null
  imageUrl: string | null
  description: string | null
  rating: { value: number; count: number } | null
  listings: DetailListing[]
  watches: ShoppingWatch[]
  coupons: Record<string, { title: string; url: string }[]>
}

type OfferCondition = 'new' | 'used' | 'refurbished' | 'unknown'
interface MarketOffer { seller: string; priceCents: number; major: boolean; url: string | null; condition: OfferCondition }
interface MarketData { offers: MarketOffer[]; typicalCents: number | null; lowestMajorCents: number | null; count: number }
interface OfferCandidate {
  summary: { retailer: string; title: string; url: string; imageUrl: string | null; priceCents: number | null }
  score: number
  matchType: 'gtin' | 'model' | 'fuzzy'
}
interface VideoResult {
  videoId: string; title: string; author?: string; channelThumb?: string | null
  durationSec?: number | null; thumbnailUrl?: string | null
}

function fmt(cents: number | null | undefined): string {
  return cents == null ? '—' : `$${(cents / 100).toFixed(2)}`
}

/** Builds a stand-in DetailResponse from whatever the click source already knew (title/image/
 *  price), so the buy box can render instantly instead of waiting on the full fetch — which,
 *  for an untracked product, is a live scrape and can take a few seconds. Every field this
 *  can't know yet (description, rating, watches, coupons, isTracked) gets an honest empty
 *  value; `isPlaceholderData` on the query result is what tells the page not to trust those
 *  yet and show a lightweight "loading" state for the sections that need them. */
function placeholderFrom(preview: ProductPreview, retailer: string, externalId: string): DetailResponse {
  return {
    isTracked: false,
    productId: null,
    title: preview.title,
    brand: null,
    model: null,
    imageUrl: preview.imageUrl,
    description: null,
    rating: null,
    listings: [{
      id: null, productId: null, retailer,
      // For a deal (retailer sentinel 'deal') use the retailer identified from the post; for a
      // real product the placeholder retailer is just the URL segment, title-cased.
      retailerLabel: preview.retailerLabel || (retailer.charAt(0).toUpperCase() + retailer.slice(1)),
      externalId,
      url: preview.url, title: preview.title, imageUrl: preview.imageUrl,
      priceCents: preview.priceCents, wasPriceCents: preview.wasPriceCents ?? null, inStock: null,
      failCount: 0, lastCheckedAt: null, lastChangedAt: null, effective: null, sparkline: [], keepaGraphUrl: null,
    }],
    watches: [],
    coupons: {},
  }
}

// ── shared bits ──────────────────────────────────────────────────────────────────

// Product image that degrades gracefully: no URL → placeholder icon; a URL that fails to load
// (dead CDN link, hotlink-blocked, 401) → the same placeholder instead of a broken-image glyph.
// This is why the image "sometimes" vanished — a scrape that returned no image, or an image the
// browser couldn't load, left an empty frame; now it always shows something sensible.
function ProductImage({ src, alt, className, iconClass }: { src: string | null; alt: string; className?: string; iconClass?: string }) {
  const [failed, setFailed] = useState(false)
  if (!src || failed) return <Tag className={cn('text-zinc-300', iconClass)} />
  return <img src={proxyImg(src)} alt={alt} className={className} onError={() => setFailed(true)} />
}

function StarRow({ value, size = 'size-4' }: { value: number; size?: string }) {
  const filled = Math.round(value)
  return (
    <span className="inline-flex items-center gap-0.5 text-amber-400">
      {Array.from({ length: 5 }, (_, i) => (
        <Star key={i} className={cn(size, i < filled ? 'fill-current' : 'fill-none text-muted-foreground/30')} />
      ))}
    </span>
  )
}

// Bold, high-contrast section header — deliberately not the subdued media-library style, so
// the page reads as a storefront (Amazon/Target-style section titles) rather than a wiki page.
function SectionTitle({ icon: Icon, children }: { icon: typeof Tag; children: React.ReactNode }) {
  return (
    <h2 className="mb-3 inline-flex items-center gap-2 text-lg font-bold">
      <Icon className="size-5 text-brand" />
      {children}
    </h2>
  )
}

// ── Buy box (image + price + CTA) ───────────────────────────────────────────────────

function BuyBox({
  data, best, deal, favKey, tracking, refreshing, onTrack, onRefresh, dealOnly = false,
}: {
  data: DetailResponse
  best: DetailListing | null
  deal: { title: string; url: string } | null
  favKey: string
  tracking: boolean
  refreshing: boolean
  onTrack: () => void
  onRefresh: () => void
  /** Deal with no resolvable product — replace Track (nothing to track) with a "view the deal"
   *  CTA; the price shown is the deal's own, and "where to buy" comes from the market lookup. */
  dealOnly?: boolean
}) {
  const favorites = useFavorites()
  const isFav = favorites.isFavorite(favKey)
  const off = best?.wasPriceCents && best.priceCents && best.wasPriceCents > best.priceCents
    ? Math.round((1 - best.priceCents / best.wasPriceCents) * 100)
    : null
  const priceCents = best?.effective?.effectiveCents ?? best?.priceCents ?? null
  const savedCents = best?.effective ? best.effective.applied.reduce((s, a) => s + a.savedCents, 0) : 0

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="grid gap-6 p-6 sm:grid-cols-[minmax(0,280px)_1fr] sm:p-8">
        <div className="relative flex aspect-square items-center justify-center rounded-xl bg-white p-6 shadow-inner ring-1 ring-border/40">
          {deal && (
            <span className="absolute left-3 top-3 inline-flex items-center gap-1 rounded-full bg-amber-500 px-2.5 py-1 text-[11px] font-bold text-white shadow-sm">
              <Flame className="size-3" /> Today's Deal
            </span>
          )}
          {off != null && off >= 5 && (
            <span className="absolute right-3 top-3 inline-flex items-center rounded-full bg-red-600 px-2.5 py-1 text-[11px] font-bold text-white shadow-sm">
              {off}% off
            </span>
          )}
          <ProductImage src={data.imageUrl} alt={data.title} className="max-h-full max-w-full object-contain" iconClass="size-16" />
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <div>
            {/* design-ok(raw-h1-in-pages): storefront buy-box hero */}
            <h1 className="text-2xl font-bold leading-snug sm:text-[28px]">{data.title}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{[data.brand, data.model].filter(Boolean).join(' · ')}</p>
          </div>

          {data.rating && (
            <div className="flex items-center gap-2">
              <StarRow value={data.rating.value} />
              <span className="text-sm font-semibold">{data.rating.value.toFixed(1)}</span>
              <span className="text-sm text-muted-foreground">({data.rating.count.toLocaleString()} ratings)</span>
            </div>
          )}

          <div className="h-px bg-border" />

          {best ? (
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-4xl font-extrabold tabular-nums text-foreground">{fmt(priceCents)}</span>
                {off != null && <span className="text-base text-muted-foreground line-through tabular-nums">{fmt(best.wasPriceCents)}</span>}
              </div>
              {savedCents > 0 && (
                <span className="inline-flex w-fit items-center rounded-md bg-red-600/10 px-2 py-0.5 text-xs font-bold text-red-600 dark:text-red-400">
                  You save {fmt(savedCents)} with {best.effective!.applied.map(a => a.label).join(' + ')}
                </span>
              )}
              {dealOnly ? (
                // Deal price at the retailer identified from the post (link / store-name / LLM).
                // No stock line — a deal's live availability isn't something we've checked.
                best.retailerLabel
                  ? <span className="text-sm text-muted-foreground">deal price at <span className="font-medium text-foreground">{best.retailerLabel}</span></span>
                  : <span className="text-sm text-muted-foreground">deal price — see where to buy below</span>
              ) : (
                <>
                  <span className="text-sm text-muted-foreground">at <span className="font-medium text-foreground">{best.retailerLabel}</span></span>
                  <span className={cn('inline-flex w-fit items-center gap-1 text-xs font-medium', best.inStock === false ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400')}>
                    {best.inStock === false ? <><XCircle className="size-3.5" />Out of stock</> : <><CheckCircle2 className="size-3.5" />In stock</>}
                  </span>
                </>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No live price available right now.</p>
          )}

          <div className="h-px bg-border" />

          <div className="flex flex-col gap-2 sm:max-w-xs">
            {dealOnly ? (
              <a
                href={deal?.url ?? '#'}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-amber-500 px-5 py-3 text-base font-semibold text-white shadow-sm transition-colors hover:bg-amber-600"
              >
                <Flame className="size-5" /> View this deal
              </a>
            ) : (
              <button
                onClick={onTrack}
                disabled={tracking}
                className={cn(
                  'inline-flex items-center justify-center gap-2 rounded-lg px-5 py-3 text-base font-semibold text-white shadow-sm transition-colors disabled:opacity-60',
                  data.isTracked ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-amber-500 hover:bg-amber-600',
                )}
              >
                {tracking ? <Loader2 className="size-5 animate-spin" /> : data.isTracked ? <BellRing className="size-5" /> : <Plus className="size-5" />}
                {tracking ? 'Tracking…' : data.isTracked ? 'Tracking ✓' : 'Track this product'}
              </button>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => favorites.toggle({ retailer: best?.retailer ?? data.listings[0]?.retailer ?? '', externalId: data.listings[0]?.externalId ?? '', title: data.title, imageUrl: data.imageUrl, url: data.listings[0]?.url ?? '', priceCents: priceCents })}
                className={cn('inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors', isFav ? 'border-amber-400 bg-amber-400/10 text-amber-600 dark:text-amber-400' : 'border-border hover:bg-muted')}
              >
                <Star className={cn('size-4', isFav && 'fill-current')} />
                {isFav ? 'Favorited' : 'Favorite'}
              </button>
              {data.isTracked && (
                <button onClick={onRefresh} disabled={refreshing} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-60">
                  <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
                </button>
              )}
              {!dealOnly && best && (
                <a href={best.url} target="_blank" rel="noreferrer" className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium transition-colors hover:bg-muted" title={`View on ${best.retailerLabel}`}>
                  <ExternalLink className="size-4" />
                </a>
              )}
            </div>
            {!dealOnly && deal && (
              <a href={deal.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:underline">
                <Flame className="size-3" /> View the original deal post
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// Slim identity bar that sticks to the top once you scroll past the full buy box above —
// same `sticky` mechanism as the rail and the "Compare prices" column, no JS involved. Keeps
// the product (and a quick Track action) in view while you're reading through the sections
// below instead of losing context of what you're even looking at.
function StickyMiniHeader({
  data, best, tracking, onTrack, dealUrl,
}: {
  data: DetailResponse
  best: DetailListing | null
  tracking: boolean
  onTrack: () => void
  /** Deal with no trackable product → the quick action is "View deal" (to the post), not Track. */
  dealUrl?: string | null
}) {
  const priceCents = best?.effective?.effectiveCents ?? best?.priceCents ?? null
  return (
    <div className="sticky top-0 z-20 -mx-5 mt-8 mb-6 flex items-center gap-3 border-b border-border/50 bg-background/90 px-5 py-2 backdrop-blur">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-white p-1 ring-1 ring-border/40">
        <ProductImage src={data.imageUrl} alt="" className="max-h-full max-w-full object-contain" iconClass="size-4" />
      </div>
      <p className="min-w-0 flex-1 truncate text-sm font-medium">{data.title}</p>
      {priceCents != null && <span className="shrink-0 text-sm font-bold tabular-nums">{fmt(priceCents)}</span>}
      {dealUrl ? (
        <a href={dealUrl} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-amber-600">
          <Flame className="size-3.5" /> View deal
        </a>
      ) : (
        <button
          onClick={onTrack}
          disabled={tracking}
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold text-white transition-colors disabled:opacity-60',
            data.isTracked ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-amber-500 hover:bg-amber-600',
          )}
        >
          {tracking ? <Loader2 className="size-3.5 animate-spin" /> : data.isTracked ? 'Tracking ✓' : 'Track'}
        </button>
      )}
    </div>
  )
}

// ── About this item ──────────────────────────────────────────────────────────────

function AboutSection({ data }: { data: DetailResponse }) {
  const supportQuery = data.brand ? `${data.brand} ${data.model ?? ''} manual support`.trim() : null
  if (!data.description && !supportQuery) return null
  return (
    <section>
      <SectionTitle icon={Tag}>About this item</SectionTitle>
      {data.description ? (
        <p className="text-sm leading-relaxed text-foreground/90">{data.description}</p>
      ) : (
        <p className="text-sm text-muted-foreground">No description available for this product.</p>
      )}
      {supportQuery && (
        <a
          href={`https://www.google.com/search?q=${encodeURIComponent(supportQuery)}`}
          target="_blank" rel="noreferrer"
          className="mt-3 inline-flex items-center gap-1.5 text-sm text-brand hover:underline"
        >
          <ExternalLink className="size-3.5" /> Search for manuals & support
        </a>
      )}
    </section>
  )
}

// ── Compare prices (cheapest-first, same for tracked & untracked) ───────────────────

function MarketCompare({ query, listings }: { query: string; listings: DetailListing[] }) {
  const { data: market, isLoading } = useQuery({
    queryKey: ['shop-market', query],
    queryFn: () => fetch(`/api/shopping/market?q=${encodeURIComponent(query.slice(0, 90))}`, { credentials: 'include' }).then(r => r.json() as Promise<MarketData>),
    staleTime: 30 * 60_000,
  })

  const rows = useMemo(() => {
    const seen = new Set<string>()
    const out: { seller: string; priceCents: number; major: boolean; url: string | null; isOurs: boolean; retailer?: string; condition: OfferCondition }[] = []
    for (const l of listings) {
      if (l.priceCents == null) continue
      // Our own tracked listings are real retailer product pages — always new.
      out.push({ seller: l.retailerLabel, priceCents: l.effective?.effectiveCents ?? l.priceCents, major: true, url: l.url, isOurs: true, retailer: l.retailer, condition: 'new' })
      seen.add(`${l.retailerLabel.toLowerCase()}:${l.priceCents}`)
    }
    for (const o of market?.offers ?? []) {
      const key = `${o.seller.toLowerCase()}:${o.priceCents}`
      if (seen.has(key)) continue
      out.push({ ...o, isOurs: false })
    }
    return out.sort((a, b) => a.priceCents - b.priceCents)
  }, [listings, market])
  const lowest = rows[0]?.priceCents ?? null

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-muted-foreground">Where else to buy</h3>
        {market && market.count > 0 && <span className="text-[10px] text-muted-foreground/60">via Bing Shopping</span>}
      </div>
      {isLoading ? (
        <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground"><Loader2 className="size-4 animate-spin" />Finding every place this sells…</div>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No price found for this item right now.</p>
      ) : (
        <div className="flex flex-col divide-y divide-border/40 overflow-hidden rounded-lg border">
          {rows.map((o, i) => {
            const Row = o.url ? 'a' : 'div'
            return (
              <Row
                key={i}
                {...(o.url ? { href: o.url, target: '_blank', rel: 'noreferrer' } : {})}
                className={cn('flex items-center gap-3 px-3 py-2.5 transition-colors', o.priceCents === lowest && 'bg-emerald-500/5', o.url && 'cursor-pointer hover:bg-muted/40')}
              >
                <span className="w-4 shrink-0 text-center text-[11px] font-semibold text-muted-foreground">{i + 1}</span>
                <span className="size-2 shrink-0 rounded-full" style={{ background: (o.retailer && RETAILER_COLORS[o.retailer]) ?? (o.major ? '#64748b' : '#a1a1aa') }} />
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-medium">{o.seller}</span>
                  {o.isOurs && <span className="ml-1.5 text-[10px] text-muted-foreground">(tracked)</span>}
                  {!o.major && <span className="ml-1.5 rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">marketplace</span>}
                  {o.condition === 'used' && <span className="ml-1.5 rounded bg-amber-500/15 px-1 py-0.5 text-[9px] font-medium text-amber-600 dark:text-amber-400">Used</span>}
                  {o.condition === 'refurbished' && <span className="ml-1.5 rounded bg-amber-500/15 px-1 py-0.5 text-[9px] font-medium text-amber-600 dark:text-amber-400">Refurbished</span>}
                  {o.condition === 'unknown' && <span className="ml-1.5 rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground" title="This marketplace listing may be new, used, or refurbished — check the listing.">Condition varies</span>}
                </div>
                {o.priceCents === lowest && <span className="rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-bold text-white">Lowest</span>}
                <span className="shrink-0 text-sm font-semibold tabular-nums">{fmt(o.priceCents)}</span>
                {o.url && <ExternalLink className="size-3.5 shrink-0 text-muted-foreground/50" />}
              </Row>
            )
          })}
        </div>
      )}
      {rows.some(o => !o.major) && (
        <p className="text-[10px] text-muted-foreground/60">"Marketplace" prices (eBay etc.) may be used, renewed, or knockoffs — check the listing.</p>
      )}
    </div>
  )
}

function RetailersSection({ data, productId, onChanged }: { data: DetailResponse; productId: string | null; onChanged: () => void }) {
  const [linkUrl, setLinkUrl] = useState('')
  const [linking, setLinking] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<OfferCandidate[] | null>(null)
  const [findingOffers, setFindingOffers] = useState(false)
  const [unlinkId, setUnlinkId] = useState<string | null>(null)

  async function linkListing(url: string, matchConfidence?: string) {
    if (!productId || !url.trim()) return
    setLinking(true); setLinkError(null)
    const res = await fetch(`/api/shopping/products/${productId}/listings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ url: url.trim(), matchConfidence }),
    })
    if (res.ok) {
      setLinkUrl('')
      setSuggestions(prev => prev?.filter(s => s.summary.url !== url) ?? null)
      onChanged()
    } else {
      const d = await res.json().catch(() => ({})) as { error?: string }
      setLinkError(d.error ?? 'Could not link that URL')
    }
    setLinking(false)
  }

  async function findOffers() {
    if (!productId) return
    setFindingOffers(true)
    const res = await fetch(`/api/shopping/products/${productId}/find-offers`, { method: 'POST', credentials: 'include' })
    if (res.ok) setSuggestions(((await res.json()) as { candidates: OfferCandidate[] }).candidates)
    setFindingOffers(false)
  }

  async function unlink(listingId: string) {
    await fetch(`/api/shopping/listings/${listingId}`, { method: 'DELETE', credentials: 'include' })
    setUnlinkId(null)
    onChanged()
  }

  const priced = data.listings.filter(l => l.priceCents != null)
  const bestId = priced.length
    ? priced.reduce((a, b) => (a.effective?.effectiveCents ?? a.priceCents!) <= (b.effective?.effectiveCents ?? b.priceCents!) ? a : b).id
    : null

  return (
    <section className="flex flex-col gap-5">
      <SectionTitle icon={Store}>Compare prices</SectionTitle>

      <div className="flex flex-col gap-2">
        {data.listings.map(l => (
          <div key={l.id ?? l.url} className={cn('flex items-center gap-3 rounded-lg border p-3', l.id === bestId && 'border-emerald-500/50 bg-emerald-500/5')}>
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: RETAILER_COLORS[l.retailer] ?? '#10b981' }} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-medium">{l.retailerLabel}</span>
                {l.id === bestId && <Badge className="bg-emerald-600 text-[10px] hover:bg-emerald-600">Best</Badge>}
                {l.inStock === false && <Badge variant="secondary" className="text-[10px]">Out of stock</Badge>}
                {l.failCount >= 3 && <Badge variant="destructive" className="text-[10px]">Check failing</Badge>}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {l.lastCheckedAt ? `Checked ${new Date(l.lastCheckedAt).toLocaleString()}` : 'Not checked yet'}
              </p>
            </div>
            <div className="text-right">
              {l.effective ? (
                <>
                  <div className="text-[11px] text-muted-foreground line-through">{fmt(l.priceCents)}</div>
                  <div className="text-sm font-semibold text-emerald-600 dark:text-emerald-400" title={l.effective.applied.map(a => a.label).join(' + ')}>{fmt(l.effective.effectiveCents)}</div>
                </>
              ) : (
                <div className="text-sm font-semibold">{fmt(l.priceCents)}</div>
              )}
            </div>
            <div className="flex shrink-0 flex-col gap-1">
              <a href={l.url} target="_blank" rel="noreferrer" className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" title="Open on retailer site">
                <ExternalLink className="size-3.5" />
              </a>
              {l.id && data.listings.length > 1 && (
                <button onClick={() => setUnlinkId(l.id)} className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive" title="Unlink this retailer">
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {Object.keys(data.coupons).length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5">
          <span className="inline-flex items-center gap-1.5 px-1 text-[11px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
            <Ticket className="size-3" /> Coupons you might stack
          </span>
          {Object.entries(data.coupons).map(([retailer, list]) => (
            <div key={retailer} className="flex flex-col gap-0.5">
              <span className="px-1 text-[10px] font-semibold text-muted-foreground">{data.listings.find(l => l.retailer === retailer)?.retailerLabel ?? retailer}</span>
              {list.slice(0, 3).map((cp, i) => (
                <a key={i} href={cp.url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 rounded px-1 py-0.5 text-xs text-foreground/90 transition-colors hover:bg-amber-500/10">
                  <span className="flex-1 truncate">{cp.title}</span>
                  <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
                </a>
              ))}
            </div>
          ))}
        </div>
      )}

      {productId && (
        <>
          {suggestions && suggestions.length > 0 && (
            <div className="flex flex-col gap-1.5 rounded-lg border border-dashed p-2">
              <span className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Possible matches elsewhere</span>
              {suggestions.map(s => (
                <div key={s.summary.url} className="flex items-center gap-2 rounded-md px-1 py-1">
                  <span className="size-2 shrink-0 rounded-full" style={{ background: RETAILER_COLORS[s.summary.retailer] ?? '#10b981' }} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs">{s.summary.title}</p>
                    <p className="text-[10px] text-muted-foreground">{fmt(s.summary.priceCents)} · {s.matchType === 'fuzzy' ? 'similar' : s.matchType} match</p>
                  </div>
                  <button onClick={() => void linkListing(s.summary.url, s.matchType === 'fuzzy' ? 'fuzzy' : 'manual')} className="rounded-md px-2 py-1 text-[11px] font-medium text-emerald-600 transition-colors hover:bg-emerald-500/10 dark:text-emerald-400">Link</button>
                  <button onClick={() => setSuggestions(prev => prev?.filter(x => x.summary.url !== s.summary.url) ?? null)} className="rounded-md p-1 text-muted-foreground hover:text-foreground"><X className="size-3" /></button>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <Input value={linkUrl} onChange={e => setLinkUrl(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void linkListing(linkUrl) }} placeholder="Paste the same product's URL at another store…" className="h-8 text-xs" />
            <Button size="sm" variant="outline" onClick={() => void linkListing(linkUrl)} disabled={linking || !linkUrl.trim()}>
              {linking ? <Loader2 className="size-3.5 animate-spin" /> : <Link2 className="size-3.5" />}
            </Button>
          </div>
          <Button size="sm" variant="ghost" className="self-start" onClick={findOffers} disabled={findingOffers}>
            {findingOffers ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <ScanSearch className="mr-1.5 size-3.5" />}
            Find at other stores
          </Button>
          {linkError && <p className="text-xs text-destructive">{linkError}</p>}
        </>
      )}

      <MarketCompare query={[data.brand, data.title].filter(Boolean).join(' ')} listings={data.listings} />

      <ConfirmDialog
        open={unlinkId != null}
        onOpenChange={open => { if (!open) setUnlinkId(null) }}
        title="Unlink this retailer?"
        description="Its price history for this product will be deleted."
        confirmLabel="Unlink"
        destructive
        onConfirm={() => { if (unlinkId) void unlink(unlinkId) }}
      />
    </section>
  )
}

// ── Price History ────────────────────────────────────────────────────────────────

function PriceHistorySection({ productId, listings }: { productId: string | null; listings: DetailListing[] }) {
  const [showKeepa, setShowKeepa] = useState(false)
  const amazonListing = listings.find(l => l.retailer === 'amazon')
  const { data } = useQuery({
    queryKey: ['shop-history', productId],
    queryFn: () => fetch(`/api/shopping/products/${productId}/history?days=365`, { credentials: 'include' }).then(r => r.json() as Promise<{ series: ChartSeries[] }>),
    enabled: !!productId,
    staleTime: 60_000,
  })

  return (
    <section>
      <SectionTitle icon={Tag}>Price history</SectionTitle>
      <div className="flex flex-col gap-4">
        {productId ? (
          <PriceChart series={data?.series ?? []} targetCents={null} />
        ) : (
          <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            Track this product to start building price history.
          </p>
        )}
        {amazonListing?.keepaGraphUrl && (
          <div className="flex flex-col gap-2">
            <button onClick={() => setShowKeepa(v => !v)} className="inline-flex items-center gap-1 self-start text-xs text-muted-foreground transition-colors hover:text-foreground">
              <ChevronDown className={cn('size-3.5 transition-transform', showKeepa && 'rotate-180')} />
              Long-term Amazon history (Keepa)
            </button>
            {showKeepa && <img src={proxyImg(amazonListing.keepaGraphUrl)} alt="Keepa long-term price history" className="w-full rounded-lg border bg-white" loading="lazy" />}
          </div>
        )}
      </div>
    </section>
  )
}

// ── Videos ───────────────────────────────────────────────────────────────────────

function VideosSection({ title, brand }: { title: string; brand: string | null }) {
  const { playExpanded } = useYoutubePlayback()
  const query = `${brand ?? ''} ${title} review`.trim()
  const { data, isLoading } = useQuery({
    queryKey: ['shop-videos', query],
    queryFn: () => fetch(`/api/youtube/search?q=${encodeURIComponent(query)}&n=12`, { credentials: 'include' }).then(r => r.json() as Promise<{ results: VideoResult[] }>),
    staleTime: 10 * 60_000,
  })
  const videos = data?.results ?? []

  if (!isLoading && !videos.length) return null

  return (
    <section>
      <SectionTitle icon={Star}>Videos</SectionTitle>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Finding videos…</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {videos.map(v => (
            <button
              key={v.videoId}
              type="button"
              onClick={() => playExpanded({ videoId: v.videoId, title: v.title, author: v.author ?? null, channelThumb: v.channelThumb, durationSec: v.durationSec, thumbnail: v.thumbnailUrl ?? undefined })}
              className="group text-left"
            >
              <div className="overflow-hidden rounded-card ring-1 ring-border/40">
                <VideoThumb videoId={v.videoId} title={v.title} quality="mq" className="aspect-video w-full object-cover transition-transform group-hover:scale-105" />
              </div>
              <p className="mt-1.5 line-clamp-2 text-xs font-medium leading-snug">{v.title}</p>
              {v.author && <p className="text-[10px] text-muted-foreground">{v.author}</p>}
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

// ── Price Alerts ─────────────────────────────────────────────────────────────────

const WATCH_KINDS = [
  { value: 'target_price', label: 'Below a price' },
  { value: 'any_drop', label: 'Any drop' },
  { value: 'percent_drop', label: '% drop' },
  { value: 'back_in_stock', label: 'Back in stock' },
] as const

function watchSummary(w: ShoppingWatch): string {
  switch (w.kind) {
    case 'target_price': return `Below ${fmt(w.targetPriceCents)}${w.useEffectivePrice ? ' (your price)' : ''}`
    case 'percent_drop': return `Drops ${w.percentDrop}%+`
    case 'any_drop': return 'Any price drop'
    case 'back_in_stock': return 'Back in stock'
  }
}

function AlertsSection({ productId, watches, onChanged }: { productId: string | null; watches: ShoppingWatch[]; onChanged: () => void }) {
  const [adding, setAdding] = useState(false)
  const [kind, setKind] = useState<(typeof WATCH_KINDS)[number]['value']>('target_price')
  const [target, setTarget] = useState('')
  const [percent, setPercent] = useState('10')
  const [useEffective, setUseEffective] = useState(true)

  async function addWatch() {
    const body: Record<string, unknown> = { kind, useEffectivePrice: useEffective }
    if (kind === 'target_price') {
      const dollars = Number(target)
      if (!(dollars > 0)) return
      body.targetPriceCents = Math.round(dollars * 100)
    }
    if (kind === 'percent_drop') {
      const pct = Number(percent)
      if (!(pct > 0)) return
      body.percentDrop = pct
    }
    const res = await fetch(`/api/shopping/products/${productId}/watches`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body),
    })
    if (res.ok) { setAdding(false); setTarget(''); onChanged() }
  }

  async function removeWatch(id: string) {
    await fetch(`/api/shopping/watches/${id}`, { method: 'DELETE', credentials: 'include' })
    onChanged()
  }

  return (
    <section>
      <SectionTitle icon={BellRing}>Price alerts</SectionTitle>
      {!productId ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">Track this product to set price alerts.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {!adding && (
            <Button size="sm" variant="outline" className="self-start" onClick={() => setAdding(true)}><Plus className="mr-1 size-3.5" />Add alert</Button>
          )}
          {watches.length === 0 && !adding && <p className="text-sm text-muted-foreground">No alerts yet — add one to get notified on drops.</p>}
          {watches.map(w => (
            <div key={w.id} className="flex items-center gap-2 rounded-lg border px-3 py-2">
              <BellRing className="size-3.5 text-emerald-500" />
              <span className="flex-1 text-sm">{watchSummary(w)}</span>
              {w.lastFiredAt && <span className="text-[10px] text-muted-foreground">fired {new Date(w.lastFiredAt).toLocaleDateString()}</span>}
              <button onClick={() => void removeWatch(w.id)} className="rounded-md p-1 text-muted-foreground transition-colors hover:text-destructive"><Trash2 className="size-3.5" /></button>
            </div>
          ))}
          {adding && (
            <div className="flex flex-col gap-3 rounded-lg border p-3">
              <div className="flex flex-wrap gap-1.5">
                {WATCH_KINDS.map(k => (
                  <button key={k.value} onClick={() => setKind(k.value)} className={cn('rounded-full border px-3 py-1 text-xs font-medium transition-colors', kind === k.value ? 'border-primary bg-primary text-primary-foreground' : 'border-transparent bg-muted/50 text-muted-foreground hover:border-border hover:text-foreground')}>{k.label}</button>
                ))}
              </div>
              {kind === 'target_price' && (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">$</span>
                  <Input value={target} onChange={e => setTarget(e.target.value)} placeholder="Target price" inputMode="decimal" className="h-8 w-32 text-sm" />
                </div>
              )}
              {kind === 'percent_drop' && (
                <div className="flex items-center gap-2">
                  <Input value={percent} onChange={e => setPercent(e.target.value)} inputMode="numeric" className="h-8 w-20 text-sm" />
                  <span className="text-sm text-muted-foreground">% below the last price</span>
                </div>
              )}
              {kind !== 'back_in_stock' && (
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" checked={useEffective} onChange={e => setUseEffective(e.target.checked)} className="accent-primary" />
                  Compare using my price (with my discounts applied)
                </label>
              )}
              <div className="flex gap-2">
                <Button size="sm" onClick={addWatch}>Create alert</Button>
                <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

// ── page ─────────────────────────────────────────────────────────────────────────

export function ProductDetailPage() {
  const { retailer = '', encodedId = '' } = useParams<{ retailer: string; encodedId: string }>()
  const externalId = decodeURIComponent(encodedId)
  const [params] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const recentlyViewed = useRecentlyViewed()
  const [tracking, setTracking] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  // Whatever the click source already knew (search result, favorite, history item, deal,
  // tracked product) — seeds an instant placeholder render instead of a blank spinner while
  // the full fetch (a live scrape, for an untracked product) is still in flight. Absent on a
  // cold/direct load (typed URL, bookmark, refresh), which falls back to the normal spinner.
  const preview = (location.state as { preview?: ProductPreview } | null)?.preview

  // A deal with no resolvable product (retailer sentinel 'deal') is rendered entirely from the
  // deal data passed in router state — we deliberately do NOT hit the backend, because the
  // externalId is a Slickdeals thread URL and scraping it would fabricate a fake "Web store"
  // product (the whole bug we're avoiding). The market "where to buy" lookup by title still runs.
  const isDealOnly = retailer === 'deal'

  const queryKey = ['shop-product', retailer, externalId]
  const { data: fetchedData, isLoading, isError, isPlaceholderData } = useQuery({
    queryKey,
    queryFn: () => fetch(`/api/shopping/product/${retailer}/${encodeURIComponent(externalId)}`, { credentials: 'include' })
      .then(r => r.ok ? r.json() as Promise<DetailResponse> : Promise.reject(new Error('not found'))),
    placeholderData: preview ? placeholderFrom(preview, retailer, externalId) : undefined,
    staleTime: 60_000,
    retry: false,
    enabled: !isDealOnly,
  })

  const dealData = useMemo(
    () => (isDealOnly && preview ? placeholderFrom(preview, retailer, externalId) : null),
    [isDealOnly, preview, retailer, externalId],
  )
  const data = isDealOnly ? dealData : fetchedData

  // Record to history once the REAL data lands — not the instant placeholder, which may still
  // carry a stale price from wherever the click came from.
  const historyKey = `${retailer}:${externalId}`
  useMemo(() => {
    if (data && !isPlaceholderData) {
      recentlyViewed.record({ retailer, externalId, title: data.title, imageUrl: data.imageUrl, url: data.listings[0]?.url ?? '', priceCents: data.listings[0]?.priceCents ?? null })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyKey, !!data, isPlaceholderData])

  const dealParam = params.get('deal') === '1'
  // In deal-mode the externalId IS the original Slickdeals post URL, so even without the query
  // params (e.g. reopened from a favorited deal) we can still link back to the post.
  const deal = dealParam && params.get('dealUrl')
    ? { title: params.get('dealTitle') ?? '', url: params.get('dealUrl')! }
    : (isDealOnly ? { title: '', url: externalId } : null)

  // Keep showing the image the click came in with when the live fetch didn't get one — a scrape
  // that fails to extract a product image shouldn't blank out an image we already had in hand.
  const displayData = useMemo(() => {
    if (!data) return data
    if (data.imageUrl || !preview?.imageUrl) return data
    return { ...data, imageUrl: preview.imageUrl }
  }, [data, preview])

  const best = useMemo(() => {
    if (!data) return null
    const priced = data.listings.filter(l => l.priceCents != null)
    if (!priced.length) return null
    return priced.reduce((a, b) => (a.effective?.effectiveCents ?? a.priceCents!) <= (b.effective?.effectiveCents ?? b.priceCents!) ? a : b)
  }, [data])

  async function track() {
    if (!data || tracking) return
    setTracking(true)
    const url = data.listings[0]?.url
    if (url) {
      await fetch('/api/shopping/products', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ url }),
      })
    }
    await qc.invalidateQueries({ queryKey })
    setTracking(false)
  }

  async function refresh() {
    if (!data?.productId || refreshing) return
    setRefreshing(true)
    await fetch(`/api/shopping/products/${data.productId}/refresh`, { method: 'POST', credentials: 'include' })
    await qc.invalidateQueries({ queryKey })
    setRefreshing(false)
  }

  // Deal-mode page opened without its router state (cold link / refresh) — the deal data is
  // gone, but externalId is the original post URL, so send the user there.
  if (isDealOnly && !data) {
    return (
      <ShopLayout activeView={null}>
        <div className="mx-auto max-w-6xl px-5 pb-16 pt-4">
          <button type="button" onClick={() => navigate('/shopping?view=deals')} className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-4" /> Back to deals
          </button>
          <div className="flex flex-col items-center gap-3 py-24 text-center text-muted-foreground">
            <Flame className="size-10 opacity-20" />
            <p className="text-sm">This deal's details are no longer loaded.</p>
            <a href={externalId} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600">
              <Flame className="size-4" /> View the deal on Slickdeals
            </a>
          </div>
        </div>
      </ShopLayout>
    )
  }
  if (!isDealOnly && isLoading) {
    return (
      <ShopLayout activeView={null}>
        <div className="flex items-center justify-center py-32"><Loader2 className="size-8 animate-spin text-muted-foreground" /></div>
      </ShopLayout>
    )
  }
  if (!isDealOnly && (isError || !data)) {
    return (
      <ShopLayout activeView={null}>
        <div className="flex flex-col items-center gap-2 py-32 text-center text-muted-foreground">
          <Tag className="size-10 opacity-20" />
          <p className="text-sm">Couldn't load this product.</p>
          <Button size="sm" variant="ghost" onClick={() => navigate('/shopping')}>Back to Shop</Button>
        </div>
      </ShopLayout>
    )
  }
  // Past the guards above, data is always present.
  const ready = (displayData ?? data)!

  const favKey = itemKey({ retailer, externalId })

  return (
    <ShopLayout activeView={null} onDiscountsChanged={() => void qc.invalidateQueries({ queryKey })}>
      <div className="mx-auto max-w-6xl px-5 pb-16 pt-4">
        <button
          type="button"
          onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/shopping'))}
          className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Back
        </button>

        <BuyBox
          data={ready}
          best={best}
          deal={deal}
          favKey={favKey}
          tracking={tracking}
          refreshing={refreshing}
          onTrack={() => void track()}
          onRefresh={() => void refresh()}
          dealOnly={isDealOnly}
        />

        <StickyMiniHeader data={ready} best={best} tracking={tracking} onTrack={() => void track()} dealUrl={isDealOnly ? deal?.url : undefined} />

        {/* ONE product-detail format for everything (products AND deals). A deal just omits the
            two sections that require a tracked product (price history + alerts) — the layout,
            components, and headings are otherwise identical, so there's no second format.
            Sections render immediately from the click's placeholder and progressively enhance as
            the full fetch lands — never a hard "Loading full details…" gate that leaves the page
            blank (and stuck, if that one fetch is slow); each section shows its own loading state
            (Videos, "where to buy") and About/rating just fill in when the real data arrives. */}
        {isPlaceholderData && !isDealOnly && (
          <p className="mb-4 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> Fetching the latest details…
          </p>
        )}
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_360px] lg:items-start">
          <div className="flex min-w-0 flex-col gap-8">
            <AboutSection data={ready} />
            {!isDealOnly && <PriceHistorySection productId={ready.productId} listings={ready.listings} />}
            <VideosSection title={ready.title} brand={ready.brand} />
            {!isDealOnly && <AlertsSection productId={ready.productId} watches={ready.watches} onChanged={() => void qc.invalidateQueries({ queryKey })} />}
          </div>
          <aside className="min-w-0 lg:sticky lg:top-4 lg:self-start">
            <RetailersSection data={ready} productId={ready.productId} onChanged={() => void qc.invalidateQueries({ queryKey })} />
          </aside>
        </div>
      </div>
    </ShopLayout>
  )
}

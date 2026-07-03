// Price Tracker: one omnibox drives everything — paste a product URL to track it
// (Amazon/first-class retailers or ANY store via the generic extractor), or type text to
// search across retailers. Tracked products are household-wide; prices display in the
// caller's effective terms (their standing discounts applied).

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  ArrowDownRight, BadgePercent, BellRing, ExternalLink, Flame, History, Loader2, Plus,
  Search as SearchIcon, ShoppingCart, Star, Store, Tag, TrendingDown, X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/cn'
import { proxyImg } from '@/lib/img'
import { toast } from '@/lib/toast'
import { EmptyAppState } from '@/components/shared/EmptyAppState'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'
import { ShopLayout, productPath, type ShopView } from './ShopLayout'
import { Sparkline, RETAILER_COLORS } from './PriceChart'
import { useRecentlyViewed, useFavorites, itemKey, type ShopItem } from './useShoppingLocal'

interface Deal {
  title: string
  url: string
  dealPostUrl: string
  priceCents: number | null
  retailer: string | null
  retailerLabel: string | null
  category: string | null
  categoryLabel: string | null
  imageUrl: string | null
  publishedAt: number | null
}

export interface EffectivePrice {
  effectiveCents: number
  applied: { label: string; savedCents: number }[]
}

export interface ShoppingListing {
  id: string
  productId: string
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
}

export interface ShoppingProduct {
  id: string
  title: string
  brand: string | null
  model: string | null
  imageUrl: string | null
  listings: ShoppingListing[]
  best: ShoppingListing | null
  lastChangedAt: number | null
  myWatchCount: number
}

export interface ShoppingWatch {
  id: string
  productId: string
  listingId: string | null
  kind: 'target_price' | 'percent_drop' | 'any_drop' | 'back_in_stock'
  targetPriceCents: number | null
  percentDrop: number | null
  useEffectivePrice: boolean
  active: boolean
  lastFiredAt: string | null
}

interface SearchResult {
  retailer: string
  externalId: string
  url: string
  title: string
  imageUrl: string | null
  priceCents: number | null
  wasPriceCents?: number | null
  trackedProductId?: string
}

function fmt(cents: number | null | undefined): string {
  return cents == null ? '—' : `$${(cents / 100).toFixed(2)}`
}

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim())
}

// ── search result card ─────────────────────────────────────────────────────────

function SearchResultCard({
  result, retailerLabel, tracking, onTrack, onOpen,
}: {
  result: SearchResult
  retailerLabel: string
  tracking: boolean
  onTrack: () => void
  onOpen: () => void
}) {
  // Immediate deal cue: how far below the retailer's own list price is it.
  const off = result.wasPriceCents && result.priceCents && result.wasPriceCents > result.priceCents
    ? Math.round((1 - result.priceCents / result.wasPriceCents) * 100)
    : null

  return (
    <div className="group flex flex-col overflow-hidden rounded-2xl border border-border/50 bg-card shadow-sm transition-all hover:border-border hover:shadow-md">
      {/* Image band — clicking opens the compare preview (all vendors, cheapest first). */}
      <button onClick={onOpen} className="relative flex h-36 items-center justify-center bg-white p-3">
        {result.imageUrl ? (
          <img src={proxyImg(result.imageUrl)} alt="" className="max-h-full max-w-full object-contain" />
        ) : (
          <Tag className="size-8 text-zinc-300" />
        )}
        {off != null && off >= 5 && (
          <span className="absolute left-2 top-2 rounded-full bg-emerald-600 px-2 py-0.5 text-[11px] font-bold text-white shadow-sm">{off}% off</span>
        )}
        <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/5 px-2 py-0.5 text-[10px] font-medium text-zinc-600 backdrop-blur">
          <span className="size-1.5 rounded-full" style={{ background: RETAILER_COLORS[result.retailer] ?? '#10b981' }} />
          {retailerLabel}
        </span>
      </button>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <button onClick={onOpen} className="line-clamp-2 min-h-[2.5rem] text-left text-[13px] font-medium leading-snug hover:underline">
          {result.title}
        </button>
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-bold tabular-nums">{fmt(result.priceCents)}</span>
          {off != null && <span className="text-xs text-muted-foreground line-through tabular-nums">{fmt(result.wasPriceCents)}</span>}
        </div>

        <div className="mt-auto flex items-center gap-2 pt-1">
          <button onClick={onOpen} className="inline-flex items-center gap-1 rounded-md py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground">
            <Store className="size-3.5" />
            Compare prices
          </button>
          <div className="flex-1" />
          <button
            onClick={onTrack}
            disabled={tracking}
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50',
              result.trackedProductId ? 'bg-muted text-foreground hover:bg-muted/70' : 'bg-emerald-600 text-white hover:bg-emerald-500',
            )}
          >
            {tracking ? <Loader2 className="size-3.5 animate-spin" /> : result.trackedProductId ? 'Tracking ✓' : <><Plus className="size-3.5" />Track</>}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── deal card ────────────────────────────────────────────────────────────────────

function DealCard({
  deal, opening, tracking, onOpen, onTrack,
}: {
  deal: Deal
  opening: boolean
  tracking: boolean
  onOpen: () => void
  onTrack: () => void
}) {
  // `deal.url === deal.dealPostUrl` means the backend already looked for a real outbound
  // merchant link and found none — tracking would just add the Slickdeals thread itself as
  // a fake "Web store" product, not the item the deal is actually for.
  const trackable = deal.retailer != null && deal.url !== deal.dealPostUrl && /^https?:\/\//.test(deal.url)
  return (
    <div className="group flex flex-col overflow-hidden rounded-2xl border border-border/50 bg-card shadow-sm transition-all hover:border-border hover:shadow-md">
      <button onClick={onOpen} disabled={opening} className="relative flex h-36 items-center justify-center bg-white p-3">
        {deal.imageUrl ? (
          <img src={proxyImg(deal.imageUrl)} alt="" className="max-h-full max-w-full object-contain" />
        ) : (
          <Flame className="size-8 text-zinc-300" />
        )}
        <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-amber-500 px-2 py-0.5 text-[11px] font-bold text-white shadow-sm">
          <Flame className="size-3" />Deal
        </span>
        {deal.retailerLabel && (
          <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/5 px-2 py-0.5 text-[10px] font-medium text-zinc-600 backdrop-blur">
            <span className="size-1.5 rounded-full" style={{ background: RETAILER_COLORS[deal.retailer ?? ''] ?? '#f59e0b' }} />
            {deal.retailerLabel}
          </span>
        )}
        {opening && (
          <span className="absolute inset-0 flex items-center justify-center bg-white/70">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </span>
        )}
      </button>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <button onClick={onOpen} disabled={opening} className="line-clamp-2 min-h-[2.5rem] text-left text-[13px] font-medium leading-snug hover:underline">
          {deal.title}
        </button>
        {deal.priceCents != null && <span className="text-lg font-bold tabular-nums">{fmt(deal.priceCents)}</span>}

        <div className="mt-auto flex items-center gap-2 pt-1">
          <a href={deal.dealPostUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground" title="Open original deal post">
            <ExternalLink className="size-3.5" />
            View post
          </a>
          <div className="flex-1" />
          {trackable && (
            <button
              onClick={onTrack}
              disabled={tracking}
              className="inline-flex items-center gap-1 rounded-full bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
            >
              {tracking ? <Loader2 className="size-3.5 animate-spin" /> : <><Plus className="size-3.5" />Track</>}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── tracked product card ─────────────────────────────────────────────────────────

function ProductCard({ product, onClick }: { product: ShoppingProduct; onClick: () => void }) {
  const best = product.best
  const recentDrop = product.lastChangedAt != null && Date.now() - product.lastChangedAt < 48 * 3600_000
  return (
    <button
      onClick={onClick}
      className="group flex flex-col gap-3 rounded-xl border bg-card p-4 text-left transition-colors hover:border-border/80 hover:bg-muted/50"
    >
      <div className="flex items-start gap-3">
        {product.imageUrl ? (
          <img src={proxyImg(product.imageUrl)} alt="" className="size-14 shrink-0 rounded-lg bg-muted object-contain" />
        ) : (
          <div className="flex size-14 shrink-0 items-center justify-center rounded-lg bg-muted">
            <ShoppingCart className="size-6 text-muted-foreground/60" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <span className="line-clamp-2 text-sm font-medium leading-snug">{product.title}</span>
          <div className="mt-1 flex items-center gap-1.5">
            {product.listings.map(l => (
              <span key={l.id} className="size-2 rounded-full" title={l.retailerLabel} style={{ background: RETAILER_COLORS[l.retailer] ?? '#10b981' }} />
            ))}
            {product.myWatchCount > 0 && (
              <Badge variant="secondary" className="text-[10px]">{product.myWatchCount} alert{product.myWatchCount > 1 ? 's' : ''}</Badge>
            )}
          </div>
        </div>
        <div className="shrink-0 text-right">
          {best ? (
            best.effective ? (
              <>
                <div className="text-[11px] text-muted-foreground line-through">{fmt(best.priceCents)}</div>
                <div className="text-base font-semibold text-emerald-600 dark:text-emerald-400">{fmt(best.effective.effectiveCents)}</div>
              </>
            ) : (
              <div className="text-base font-semibold">{fmt(best.priceCents)}</div>
            )
          ) : (
            <div className="text-xs text-muted-foreground">no price</div>
          )}
          {best && <div className="text-[10px] text-muted-foreground">{best.retailerLabel}</div>}
        </div>
      </div>
      <div className="flex items-center justify-between">
        {best && <Sparkline points={best.sparkline} color={RETAILER_COLORS[best.retailer] ?? '#10b981'} />}
        {recentDrop && (
          <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
            <ArrowDownRight className="size-3" />
            changed recently
          </span>
        )}
      </div>
    </button>
  )
}

// ── landing: horizontal strip of saved/viewed items ────────────────────────────────

function ItemStrip({ title, icon: Icon, items, onOpen, onClear }: {
  title: string
  icon: typeof Tag
  items: ShopItem[]
  onOpen: (i: ShopItem) => void
  onClear?: () => void
}) {
  if (items.length === 0) return null
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="inline-flex items-center gap-1.5 text-sm font-semibold"><Icon className="size-4" />{title}</h3>
        {onClear && <button onClick={onClear} className="text-[11px] text-muted-foreground/60 hover:text-foreground">Clear</button>}
      </div>
      <div className="flex gap-3 overflow-x-auto pb-1">
        {items.map(i => (
          <button
            key={itemKey(i)}
            onClick={() => onOpen(i)}
            className="flex w-40 shrink-0 flex-col gap-2 rounded-xl border border-border/50 bg-card p-2.5 text-left transition-colors hover:border-border"
          >
            <div className="flex h-24 items-center justify-center rounded-lg bg-white p-1">
              {i.imageUrl ? <img src={proxyImg(i.imageUrl)} alt="" className="max-h-full max-w-full object-contain" /> : <Tag className="size-6 text-zinc-300" />}
            </div>
            <p className="line-clamp-2 text-[11px] font-medium leading-snug">{i.title}</p>
            <span className="text-xs font-bold tabular-nums">{fmt(i.priceCents)}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

// A full grid of saved/viewed items with per-item remove (favorites & history views).
function RemovableItemGrid({ items, onOpen, onRemove, emptyText }: {
  items: ShopItem[]
  onOpen: (i: ShopItem) => void
  onRemove: (key: string) => void
  emptyText: string
}) {
  if (items.length === 0) {
    return <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">{emptyText}</p>
  }
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {items.map(i => (
        <div key={itemKey(i)} className="group relative flex flex-col gap-2 rounded-xl border border-border/50 bg-card p-2.5">
          <button
            onClick={e => { e.stopPropagation(); onRemove(itemKey(i)) }}
            className="absolute right-1.5 top-1.5 z-10 rounded-full bg-background/80 p-1 text-muted-foreground opacity-0 shadow-sm backdrop-blur transition-opacity hover:text-destructive group-hover:opacity-100"
            aria-label="Remove"
          >
            <X className="size-3.5" />
          </button>
          <button onClick={() => onOpen(i)} className="flex flex-col gap-2 text-left">
            <div className="flex h-28 items-center justify-center rounded-lg bg-white p-2">
              {i.imageUrl ? <img src={proxyImg(i.imageUrl)} alt="" className="max-h-full max-w-full object-contain" /> : <Tag className="size-6 text-zinc-300" />}
            </div>
            <p className="line-clamp-2 text-[12px] font-medium leading-snug">{i.title}</p>
            <span className="text-sm font-bold tabular-nums">{fmt(i.priceCents)}</span>
          </button>
        </div>
      ))}
    </div>
  )
}

// ── page ─────────────────────────────────────────────────────────────────────────

export function ShoppingPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const [products, setProducts] = useState<ShoppingProduct[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')

  const [searchResults, setSearchResults] = useState<Record<string, SearchResult[]> | null>(null)
  const [retailerLabels, setRetailerLabels] = useState<Record<string, string>>({})
  const [searching, setSearching] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [resolveError, setResolveError] = useState<string | null>(null)
  const [trackingKey, setTrackingKey] = useState<string | null>(null)
  const recentlyViewed = useRecentlyViewed()
  const favorites = useFavorites()
  const view = (searchParams.get('view') as ShopView | null) ?? 'home'

  // Opening a product records it to history (the detail page itself also records on load —
  // this covers the instant before navigation completes) and navigates to the shared page.
  const openProduct = useCallback((r: { retailer: string; externalId: string; url: string; title: string; imageUrl: string | null; priceCents: number | null; wasPriceCents?: number | null }) => {
    recentlyViewed.record({ retailer: r.retailer, externalId: r.externalId, title: r.title, imageUrl: r.imageUrl, url: r.url, priceCents: r.priceCents, wasPriceCents: r.wasPriceCents })
    navigate(productPath(r.retailer, r.externalId), { state: { preview: { title: r.title, imageUrl: r.imageUrl, priceCents: r.priceCents, wasPriceCents: r.wasPriceCents, url: r.url } } })
  }, [recentlyViewed, navigate])
  const [deals, setDeals] = useState<Deal[] | null>(null)
  const [dealsLoading, setDealsLoading] = useState(false)
  const [openingDeal, setOpeningDeal] = useState<string | null>(null)
  const [dealCategory, setDealCategory] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await fetch('/api/shopping/products?sort=recentDrop', { credentials: 'include' })
    if (res.ok) {
      const data = await res.json() as { products: ShoppingProduct[] }
      setProducts(data.products)
    }
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  const loadDeals = useCallback(async () => {
    if (deals) return
    setDealsLoading(true)
    const res = await fetch('/api/shopping/deals', { credentials: 'include' })
    if (res.ok) {
      const data = await res.json() as { deals: Deal[] }
      setDeals(data.deals)
    }
    setDealsLoading(false)
  }, [deals])

  useEffect(() => { if (view === 'deals' || view === 'home') void loadDeals() }, [view, loadDeals])

  async function trackDeal(d: Deal, key: string) {
    setTrackingKey(key)
    const res = await fetch('/api/shopping/products', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ url: d.url }),
    })
    const data = await res.json().catch(() => ({})) as { productId?: string; error?: string }
    setTrackingKey(null)
    if (res.ok) {
      await load()
      const detail = await resolveDetail(d.url)
      if (detail) navigate(dealPath(detail.retailer, detail.externalId, d), { state: { preview: { title: d.title, imageUrl: d.imageUrl, priceCents: d.priceCents, url: d.url } } })
    } else {
      toast.error(data.error ?? 'Could not track that deal')
    }
  }

  /** Read-only preview of a URL — used to find where a deal (or any link) leads before
   *  navigating, without side effects. Null on anything we can't resolve. Carries title/image/
   *  price too (the backend already read the live page) so the caller can seed the detail
   *  page's instant-render placeholder instead of it starting from a blank slate. */
  async function resolveDetail(url: string): Promise<{ retailer: string; externalId: string; preview: import('./ShopLayout').ProductPreview } | null> {
    const res = await fetch('/api/shopping/resolve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ url }),
    })
    if (!res.ok) return null
    const data = await res.json().catch(() => null) as { detail?: { retailer: string; externalId: string; url: string; title: string; imageUrl: string | null; priceCents: number | null; wasPriceCents: number | null } } | null
    if (!data?.detail) return null
    const { retailer, externalId, url: resolvedUrl, title, imageUrl, priceCents, wasPriceCents } = data.detail
    return { retailer, externalId, preview: { title, imageUrl, priceCents, wasPriceCents, url: resolvedUrl } }
  }

  function dealPath(retailer: string, externalId: string, d: Deal): string {
    const params = new URLSearchParams({ deal: '1', dealUrl: d.dealPostUrl, dealTitle: d.title })
    return `${productPath(retailer, externalId)}?${params.toString()}`
  }

  /** Clicking a deal always lands on an in-app details page — never an unexpected jump to the
   *  Slickdeals post. When the deal resolves to a real merchant product we open the full product
   *  page; when it doesn't (a "select stores / see price in cart" deal, a whole-category sale, a
   *  store we don't adapt) we open a lean DEAL-mode details page seeded from the deal itself
   *  (no Slickdeals scrape → no fake "Web store" product), which still runs a market "where to
   *  buy" lookup by title and links prominently to the original post. */
  async function openDeal(d: Deal) {
    const preview = { title: d.title, imageUrl: d.imageUrl, priceCents: d.priceCents, url: d.url, retailerLabel: d.retailerLabel }
    // No resolvable merchant (deals.ts left url === the Slickdeals thread) → deal-mode page.
    if (d.url === d.dealPostUrl) {
      navigate(dealPath('deal', d.dealPostUrl, d), { state: { preview } })
      return
    }
    setOpeningDeal(d.url)
    const detail = await resolveDetail(d.url)
    setOpeningDeal(null)
    if (detail) {
      navigate(dealPath(detail.retailer, detail.externalId, d), { state: { preview } })
    } else {
      // Merchant link existed but couldn't be read as a product — still keep it in-app as a
      // deal-mode page rather than bouncing the user out to Slickdeals unexpectedly.
      navigate(dealPath('deal', d.dealPostUrl, d), { state: { preview } })
    }
  }

  const runOmnibox = useCallback(async (value: string) => {
    const v = value.trim()
    if (!v) { setSearchResults(null); setResolveError(null); return }

    if (isUrl(v)) {
      // Paste-a-URL: resolve + track in one step (camelcamelcamel muscle memory).
      setResolving(true)
      setResolveError(null)
      const res = await fetch('/api/shopping/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ url: v }),
      })
      const data = await res.json().catch(() => ({})) as { productId?: string; error?: string }
      setResolving(false)
      if (res.ok) {
        setQuery('')
        await load()
        const detail = await resolveDetail(v)
        if (detail) navigate(productPath(detail.retailer, detail.externalId), { state: { preview: detail.preview } })
      } else {
        setResolveError(data.error ?? 'Could not track that URL')
      }
      return
    }

    if (v.length < 2) return
    setSearching(true)
    const res = await fetch(`/api/shopping/search?q=${encodeURIComponent(v)}`, { credentials: 'include' })
    if (res.ok) {
      const data = await res.json() as { results: Record<string, SearchResult[]>; labels: Record<string, string> }
      setSearchResults(data.results)
      setRetailerLabels(prev => ({ ...prev, ...data.labels }))
    }
    setSearching(false)
  }, [load, navigate])

  useAppHeader({
    query,
    setQuery: (v: string) => { setQuery(v); if (!v.trim()) { setSearchResults(null); setResolveError(null) } },
    placeholder: 'Search products, or paste a product URL to track it…',
    onSubmit: () => void runOmnibox(query),
  })

  async function trackResult(r: SearchResult) {
    const preview = { title: r.title, imageUrl: r.imageUrl, priceCents: r.priceCents, wasPriceCents: r.wasPriceCents, url: r.url }
    if (r.trackedProductId) { navigate(productPath(r.retailer, r.externalId), { state: { preview } }); return }
    const key = `${r.retailer}:${r.externalId}`
    setTrackingKey(key)
    const res = await fetch('/api/shopping/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ url: r.url }),
    })
    setTrackingKey(null)
    if (res.ok) {
      await load()
      navigate(productPath(r.retailer, r.externalId), { state: { preview } })
    }
  }

  const flatResults = useMemo(() => {
    if (!searchResults) return null
    return Object.entries(searchResults).flatMap(([retailer, items]) =>
      items.map(item => ({ ...item, retailer })),
    )
  }, [searchResults])

  const showingSearch = flatResults != null || searching || resolving || resolveError != null

  const openItem = (i: ShopItem) => openProduct({ retailer: i.retailer, externalId: i.externalId, url: i.url, title: i.title, imageUrl: i.imageUrl, priceCents: i.priceCents, wasPriceCents: i.wasPriceCents })
  const openTrackedProduct = (p: ShoppingProduct) => {
    const l = p.best ?? p.listings[0]
    if (l) navigate(productPath(l.retailer, l.externalId), { state: { preview: { title: p.title, imageUrl: p.imageUrl, priceCents: l.priceCents, wasPriceCents: l.wasPriceCents, url: l.url } } })
  }
  const clearSearch = () => { setQuery(''); setSearchResults(null); setResolveError(null) }
  const goTo = (v: ShopView) => { setSearchParams({ view: v }); clearSearch() }
  // The left rail (in ShopLayout) also navigates via the `view` query param directly — catch
  // that path too so switching sections from the rail clears any in-progress search.
  useEffect(() => { clearSearch() }, [searchParams.get('view')]) // eslint-disable-line react-hooks/exhaustive-deps

  const trackedGrid = (
    products.length > 0 ? (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {products.map(p => <ProductCard key={p.id} product={p} onClick={() => openTrackedProduct(p)} />)}
      </div>
    ) : (
      <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
        Nothing tracked yet — open a product and hit <b>Track</b> to watch its price and get drop alerts.
      </p>
    )
  )

  const dealCategories = useMemo(() => {
    const seen = new Map<string, string>()
    for (const d of deals ?? []) if (d.category && d.categoryLabel) seen.set(d.category, d.categoryLabel)
    return [...seen.entries()]
  }, [deals])
  const filteredDeals = useMemo(
    () => dealCategory ? (deals ?? []).filter(d => d.category === dealCategory) : (deals ?? []),
    [deals, dealCategory],
  )

  const dealsView = dealsLoading ? (
    <div className="flex h-40 items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
  ) : (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">Community-vetted deals from Slickdeals. Track one to watch its price after the deal ends.</p>
      {dealCategories.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setDealCategory(null)}
            className={cn('rounded-full border px-3 py-1 text-xs font-medium transition-colors', dealCategory === null ? 'border-primary bg-primary text-primary-foreground' : 'border-transparent bg-muted/50 text-muted-foreground hover:border-border hover:text-foreground')}
          >
            All
          </button>
          {dealCategories.map(([key, label]) => (
            <button
              key={key}
              onClick={() => setDealCategory(key)}
              className={cn('rounded-full border px-3 py-1 text-xs font-medium transition-colors', dealCategory === key ? 'border-primary bg-primary text-primary-foreground' : 'border-transparent bg-muted/50 text-muted-foreground hover:border-border hover:text-foreground')}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {filteredDeals.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">No deals in this category right now.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {filteredDeals.map(d => {
            const key = `deal-${d.dealPostUrl}`
            return (
              <DealCard
                key={key}
                deal={d}
                opening={openingDeal === d.url}
                tracking={trackingKey === key}
                onOpen={() => void openDeal(d)}
                onTrack={() => void trackDeal(d, key)}
              />
            )
          })}
        </div>
      )}
    </div>
  )

  const totallyEmpty = products.length === 0 && favorites.items.length === 0 && recentlyViewed.items.length === 0

  return (
    <ShopLayout activeView={showingSearch ? null : view} onDiscountsChanged={load}>
      <div className="px-6 py-4">
        {resolveError && (
          <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">{resolveError}</div>
        )}
        {(searching || resolving) && (
          <div className="flex h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {resolving ? 'Reading the product page…' : 'Searching retailers…'}
          </div>
        )}

        {/* Search results override the selected view */}
        {!searching && !resolving && flatResults && (
          flatResults.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">Nothing found — try different words, or paste a product URL directly.</div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {flatResults.map(r => {
                const key = `${r.retailer}:${r.externalId}`
                return <SearchResultCard key={key} result={r} retailerLabel={retailerLabels[r.retailer] ?? r.retailer} tracking={trackingKey === key} onTrack={() => void trackResult(r)} onOpen={() => openProduct(r)} />
              })}
            </div>
          )
        )}

        {!showingSearch && view === 'home' && (
          <div className="flex flex-col gap-6">
            {(dealsLoading || (deals && deals.length > 0)) && (
              <section className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <h3 className="inline-flex items-center gap-1.5 text-sm font-semibold"><Flame className="size-4" />Today's Deals</h3>
                  <button onClick={() => goTo('deals')} className="text-[11px] text-muted-foreground/60 hover:text-foreground">See all</button>
                </div>
                {dealsLoading && !deals ? (
                  <div className="flex h-36 items-center justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
                ) : (
                  <div className="flex gap-3 overflow-x-auto pb-1">
                    {(deals ?? []).slice(0, 10).map(d => {
                      const key = `deal-${d.dealPostUrl}`
                      return (
                        <div key={key} className="w-40 shrink-0">
                          <DealCard deal={d} opening={openingDeal === d.url} tracking={trackingKey === key} onOpen={() => void openDeal(d)} onTrack={() => void trackDeal(d, key)} />
                        </div>
                      )
                    })}
                  </div>
                )}
              </section>
            )}

            {totallyEmpty ? (
              <EmptyAppState
                icon={Tag}
                gradient="linear-gradient(135deg,#14532d,#0d9488)"
                title="Never overpay again"
                tagline="Search for a product or paste any store URL — this compares prices across the web, charts the history, and alerts you when it drops."
                features={[
                  { icon: SearchIcon, title: 'Compare stores', desc: 'See every vendor selling an item, sorted cheapest-first.' },
                  { icon: BadgePercent, title: 'Your real price', desc: 'RedCard, Prime — effective prices, not just stickers.' },
                  { icon: TrendingDown, title: 'Price history', desc: 'Charts build automatically, plus long-term Amazon history.' },
                  { icon: ShoppingCart, title: 'Drop alerts', desc: 'Set a target price and get pinged the moment it hits.' },
                ]}
              />
            ) : (
              <>
                <ItemStrip title="Favorites" icon={Star} items={favorites.items.slice(0, 8)} onOpen={openItem} />
                {products.length > 0 && (
                  <section className="flex flex-col gap-2">
                    <h3 className="inline-flex items-center gap-1.5 text-sm font-semibold"><BellRing className="size-4" />Tracking & alerts</h3>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {products.slice(0, 6).map(p => <ProductCard key={p.id} product={p} onClick={() => openTrackedProduct(p)} />)}
                    </div>
                  </section>
                )}
                <ItemStrip title="Recently viewed" icon={History} items={recentlyViewed.items.slice(0, 8)} onOpen={openItem} onClear={recentlyViewed.clear} />
              </>
            )}
          </div>
        )}

        {!showingSearch && view === 'tracked' && (
          loading && products.length === 0
            ? <div className="flex h-40 items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
            : trackedGrid
        )}

        {!showingSearch && view === 'favorites' && (
          <div className="flex flex-col gap-3">
            {favorites.items.length > 0 && (
              <div className="flex justify-end"><button onClick={favorites.clear} className="text-[11px] text-muted-foreground/60 hover:text-destructive">Clear all</button></div>
            )}
            <RemovableItemGrid items={favorites.items} onOpen={openItem} onRemove={favorites.remove} emptyText="No favorites yet — tap the ☆ on any product to save it here." />
          </div>
        )}

        {!showingSearch && view === 'history' && (
          <div className="flex flex-col gap-3">
            {recentlyViewed.items.length > 0 && (
              <div className="flex justify-end"><button onClick={recentlyViewed.clear} className="text-[11px] text-muted-foreground/60 hover:text-destructive">Clear all history</button></div>
            )}
            <RemovableItemGrid items={recentlyViewed.items} onOpen={openItem} onRemove={recentlyViewed.remove} emptyText="Nothing viewed yet — open a product and it'll show up here." />
          </div>
        )}

        {!showingSearch && view === 'deals' && dealsView}
      </div>
    </ShopLayout>
  )
}

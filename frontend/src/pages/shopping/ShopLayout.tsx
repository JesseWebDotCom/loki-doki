// Shared chrome for every Shop page — the left rail (Home/Tracking/Favorites/History/Deals +
// Scan/Discounts) persists across both the landing page and product detail pages, so you can
// jump to Favorites or back to Deals without navigating away from whatever you're looking at.
// Self-contained: owns its own tracked-count fetch and the Scan/Discounts sheets, so any page
// can drop it in with just an `activeView` (which rail item to highlight, if any).

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  BadgePercent, BellRing, Flame, History, LayoutGrid, ScanBarcode, Star, type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { PageShell } from '@/components/shared/PageShell'
import { DiscountsSheet } from './DiscountsSheet'
import { PhotoLookupSheet } from './PhotoLookupSheet'
import { useFavorites, useRecentlyViewed } from './useShoppingLocal'

export type ShopView = 'home' | 'tracked' | 'favorites' | 'history' | 'deals'

/** Every clickable product in Shop resolves through this one path — search result,
 *  favorite, history item, tracked product, or (after resolving) a deal. */
export function productPath(retailer: string, externalId: string): string {
  return `/shopping/product/${retailer}/${encodeURIComponent(externalId)}`
}

/** Whatever the click source already knew about a product — a search result, favorite,
 *  history entry, or deal card all carry title/image/price before the detail page has fetched
 *  anything. Passed as router state so the detail page can render instantly instead of showing
 *  a blank spinner for however long the full fetch (a live scrape, for an untracked product)
 *  takes — see ProductDetailPage's `placeholderData`. */
export interface ProductPreview {
  title: string
  imageUrl: string | null
  priceCents: number | null
  wasPriceCents?: number | null
  /** So the Track button still works if clicked during the placeholder window, before the
   *  real fetch (which would otherwise be the only source of a trackable URL) resolves. */
  url: string
  /** For a deal with no resolvable product page — the retailer identified from the deal (link /
   *  store-name match / LLM on the post), so deal-mode shows "at Tractor Supply", not "at Deal". */
  retailerLabel?: string | null
}

const DEFAULT_RETAILER_LABELS: Record<string, string> = {
  amazon: 'Amazon', target: 'Target', lowes: "Lowe's", homedepot: 'Home Depot',
  walmart: 'Walmart', costco: 'Costco', bjs: "BJ's", apple: 'Apple', bestbuy: 'Best Buy',
  temu: 'Temu', woot: 'Woot!',
}

function RailLink({ icon: Icon, label, count, active, onClick }: {
  icon: LucideIcon; label: string; count?: number; active: boolean; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
        active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}
    >
      <Icon className="size-[18px] shrink-0" />
      <span className="flex-1 text-left">{label}</span>
      {count != null && count > 0 && <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">{count}</span>}
    </button>
  )
}

export function ShopLayout({
  activeView, onDiscountsChanged, children,
}: {
  /** Which rail item to highlight — null when the current page (e.g. a product detail page)
   *  isn't one of the rail's own sections. */
  activeView: ShopView | null
  /** Fired after a discount is added/edited/removed — the caller's own effective-price data
   *  (product list, or a single product query) needs to refetch to reflect it. */
  onDiscountsChanged?: () => void
  children: React.ReactNode
}) {
  const navigate = useNavigate()
  const favorites = useFavorites()
  const recentlyViewed = useRecentlyViewed()
  const [trackedCount, setTrackedCount] = useState(0)
  const [showDiscounts, setShowDiscounts] = useState(false)
  const [showPhoto, setShowPhoto] = useState(false)

  useEffect(() => {
    fetch('/api/shopping/products?sort=recentDrop', { credentials: 'include' })
      .then(r => r.ok ? r.json() as Promise<{ products: unknown[] }> : null)
      .then(data => { if (data) setTrackedCount(data.products.length) })
  }, [])

  const goTo = (v: ShopView) => navigate(`/shopping?view=${v}`)

  const RAIL: { view: ShopView; icon: LucideIcon; label: string; count?: number }[] = [
    { view: 'home', icon: LayoutGrid, label: 'Home' },
    { view: 'tracked', icon: BellRing, label: 'Tracking & alerts', count: trackedCount },
    { view: 'favorites', icon: Star, label: 'Favorites', count: favorites.items.length },
    { view: 'history', icon: History, label: 'Recently viewed', count: recentlyViewed.items.length },
    { view: 'deals', icon: Flame, label: "Today's deals" },
  ]

  return (
    <PageShell>
      <div className="flex min-h-full bg-background">
        <nav className="sticky top-0 hidden h-fit w-56 shrink-0 flex-col gap-0.5 self-start border-r border-border/40 px-3 py-4 lg:flex">
          {RAIL.map(r => (
            <RailLink key={r.view} icon={r.icon} label={r.label} count={r.count} active={activeView === r.view} onClick={() => goTo(r.view)} />
          ))}
          <div className="flex-1" />
          <RailLink icon={ScanBarcode} label="Scan a product" active={false} onClick={() => setShowPhoto(true)} />
          <RailLink icon={BadgePercent} label="My discounts" active={false} onClick={() => setShowDiscounts(true)} />
        </nav>

        <div className="min-w-0 flex-1">
          <div className="flex gap-1.5 overflow-x-auto px-5 pt-4 lg:hidden">
            {RAIL.map(r => (
              <button key={r.view} onClick={() => goTo(r.view)} className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium', activeView === r.view ? 'border-primary bg-primary text-primary-foreground' : 'border-transparent bg-muted/50 text-muted-foreground')}>
                {r.label}{r.count ? ` ${r.count}` : ''}
              </button>
            ))}
          </div>
          {children}
        </div>
      </div>

      <DiscountsSheet
        open={showDiscounts}
        onOpenChange={setShowDiscounts}
        retailerLabels={DEFAULT_RETAILER_LABELS}
        onChanged={() => onDiscountsChanged?.()}
      />

      <PhotoLookupSheet
        open={showPhoto}
        onOpenChange={setShowPhoto}
        onTracked={(retailer, externalId, preview) => navigate(productPath(retailer, externalId), { state: { preview } })}
      />
    </PageShell>
  )
}

// Tracking core shared by the poller and the manual-refresh/track routes: run a price
// check for a listing, persist the observation (denormalized latest + append-only
// history), and evaluate every user's watches edge-triggered against the previous state.

import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, or, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { shoppingListings, shoppingPricePoints, shoppingProducts, shoppingWatches } from '@/db/schema'
import { emitNotification } from '@/lib/notify'
import { adapterFor, RETAILER_LABELS } from '@/lib/shopping/adapters'
import { effectivePrice, loadDiscounts } from '@/lib/shopping/discounts'
import type { PriceObservation } from '@/lib/shopping/types'

export type ListingRow = typeof shoppingListings.$inferSelect
export type WatchRow = typeof shoppingWatches.$inferSelect

const DAY_MS = 24 * 60 * 60 * 1000

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

/** Providers-first observation for a listing. Phase 1 = direct adapter only; the
 *  provider chain (PriceWatchPro before direct) slots in here in phase 2. */
export async function observeListing(listing: ListingRow): Promise<PriceObservation | null> {
  const adapter = adapterFor(listing.retailer)
  if (!adapter) return null
  const detail = await adapter.getProduct(listing.externalId)
  if (!detail) return null
  return {
    priceCents: detail.priceCents,
    wasPriceCents: detail.wasPriceCents,
    inStock: detail.inStock,
    via: 'direct',
    title: detail.title,
    imageUrl: detail.imageUrl,
    description: detail.description,
    rating: detail.rating,
  }
}

/**
 * Persist one observation and fire alerts. Returns whether price/stock changed.
 * History write policy: a point is appended only when the price or stock state changed,
 * or the newest point is >24h old — a stable listing costs ~1 row per day.
 */
export async function recordObservation(listing: ListingRow, obs: PriceObservation): Promise<{ changed: boolean }> {
  const now = new Date()
  const prevPrice = listing.priceCents
  const prevInStock = listing.inStock
  const changed = obs.priceCents !== prevPrice || obs.inStock !== (prevInStock ?? false)

  await db.update(shoppingListings)
    .set({
      priceCents: obs.priceCents,
      wasPriceCents: obs.wasPriceCents,
      inStock: obs.inStock,
      title: obs.title ?? listing.title,
      imageUrl: obs.imageUrl ?? listing.imageUrl,
      // Fresh value when this check found one, otherwise keep whatever we already had —
      // same "self-healing, never regress to null" pattern as title/imageUrl above.
      description: obs.description ?? listing.description,
      ratingValue: obs.rating?.value ?? listing.ratingValue,
      ratingCount: obs.rating?.count ?? listing.ratingCount,
      lastCheckedAt: now,
      lastChangedAt: changed ? now : listing.lastChangedAt,
      lastError: null,
      failCount: 0,
    })
    .where(eq(shoppingListings.id, listing.id))

  const [latest] = await db.select()
    .from(shoppingPricePoints)
    .where(eq(shoppingPricePoints.listingId, listing.id))
    .orderBy(desc(shoppingPricePoints.observedAt))
    .limit(1)
  const stale = !latest || now.getTime() - latest.observedAt.getTime() > DAY_MS
  if (changed || stale) {
    await db.insert(shoppingPricePoints).values({
      id: randomUUID(),
      listingId: listing.id,
      priceCents: obs.priceCents,
      inStock: obs.inStock,
      via: obs.via,
      observedAt: now,
    })
  }

  if (changed) {
    await evaluateWatches(listing, { priceCents: prevPrice, inStock: prevInStock ?? false }, obs)
  }
  return { changed }
}

export async function recordFailure(listing: ListingRow, error: string): Promise<number> {
  const failCount = listing.failCount + 1
  await db.update(shoppingListings)
    .set({ failCount, lastError: error.slice(0, 300), lastCheckedAt: new Date() })
    .where(eq(shoppingListings.id, listing.id))
  return failCount
}

// ── alert evaluation ─────────────────────────────────────────────────────────────
// Edge-triggered: a watch fires on the transition into its condition, never on staying
// there. The dedupeKey additionally embeds the observed price, so re-emitting the same
// state while the notification sits unread is a no-op, but a further drop re-fires.

interface PrevState {
  priceCents: number | null
  inStock: boolean
}

async function evaluateWatches(listing: ListingRow, prev: PrevState, next: PriceObservation): Promise<void> {
  const watches = await db.select()
    .from(shoppingWatches)
    .where(and(
      eq(shoppingWatches.productId, listing.productId),
      eq(shoppingWatches.active, true),
      or(eq(shoppingWatches.listingId, listing.id), isNull(shoppingWatches.listingId)),
    ))
  if (!watches.length) return

  const [product] = await db.select().from(shoppingProducts).where(eq(shoppingProducts.id, listing.productId)).limit(1)
  const title = listing.title ?? product?.title ?? 'Tracked product'
  const retailerLabel = RETAILER_LABELS[listing.retailer] ?? listing.retailer

  for (const watch of watches) {
    // Per-user effective terms: the user's discounts apply to both sides of every
    // comparison so a target of $90 means "$90 out of my pocket".
    const discounts = watch.useEffectivePrice ? await loadDiscounts(watch.userId) : null
    const rows = discounts?.get(listing.retailer) ?? []
    const toUser = (cents: number | null) =>
      cents == null ? null : rows.length ? effectivePrice(cents, rows).effectiveCents : cents

    const prevP = toUser(prev.priceCents)
    const nextP = toUser(next.priceCents)

    let fired: { title: string; body: string } | null = null
    switch (watch.kind) {
      case 'target_price': {
        if (watch.targetPriceCents == null || nextP == null) break
        if (nextP <= watch.targetPriceCents && (prevP == null || prevP > watch.targetPriceCents)) {
          fired = {
            title: `${title} hit your target — ${formatCents(nextP)} at ${retailerLabel}`,
            body: rows.length
              ? `Sticker ${formatCents(next.priceCents!)}, ${formatCents(nextP)} with ${rows.map(r => r.label).join(' + ')}. Target ${formatCents(watch.targetPriceCents)}.`
              : `Target ${formatCents(watch.targetPriceCents)}.`,
          }
        }
        break
      }
      case 'percent_drop': {
        if (watch.percentDrop == null || prevP == null || nextP == null || nextP >= prevP) break
        const pct = ((prevP - nextP) / prevP) * 100
        if (pct >= watch.percentDrop) {
          fired = {
            title: `${title} dropped ${Math.round(pct)}% — ${formatCents(nextP)} at ${retailerLabel}`,
            body: `Was ${formatCents(prevP)}.`,
          }
        }
        break
      }
      case 'any_drop': {
        if (prevP == null || nextP == null || nextP >= prevP) break
        fired = {
          title: `${title} — ${formatCents(nextP)} at ${retailerLabel}`,
          body: `Down from ${formatCents(prevP)}.`,
        }
        break
      }
      case 'back_in_stock': {
        if (prev.inStock || !next.inStock) break
        fired = {
          title: `${title} is back in stock at ${retailerLabel}`,
          body: nextP != null ? `Current price ${formatCents(nextP)}.` : '',
        }
        break
      }
    }

    if (!fired) continue
    await emitNotification({
      type: 'price_alert',
      userId: watch.userId,
      title: fired.title,
      body: fired.body || undefined,
      url: `/shopping/products/${listing.productId}`,
      dedupeKey: `price_alert:${watch.id}:${next.priceCents ?? 'oos'}`,
      payload: {
        // `message` feeds deriveMessage() fallbacks and the screen-Pod overlay bridge.
        message: fired.title,
        productId: listing.productId,
        listingId: listing.id,
        retailer: listing.retailer,
        priceCents: next.priceCents,
        effectiveCents: toUser(next.priceCents),
        watchKind: watch.kind,
      },
    })
    await db.update(shoppingWatches).set({ lastFiredAt: new Date() }).where(eq(shoppingWatches.id, watch.id))
  }
}

// ── manual refresh ───────────────────────────────────────────────────────────────

const refreshGuard = new Map<string, number>()

/** Re-check every active listing of a product now. Guarded to once/min per product so
 *  a hammered refresh button can't turn into a scrape burst. */
export async function refreshProduct(productId: string): Promise<{ refreshed: number; failed: number } | { throttled: true }> {
  const last = refreshGuard.get(productId) ?? 0
  if (Date.now() - last < 60_000) return { throttled: true }
  refreshGuard.set(productId, Date.now())

  const listings = await db.select()
    .from(shoppingListings)
    .where(and(eq(shoppingListings.productId, productId), eq(shoppingListings.active, true)))

  let refreshed = 0
  let failed = 0
  for (const listing of listings) {
    const obs = await observeListing(listing)
    if (obs) {
      await recordObservation(listing, obs)
      refreshed++
    } else {
      await recordFailure(listing, 'refresh failed')
      failed++
    }
  }
  return { refreshed, failed }
}

/** Latest price points for a set of listings, oldest→newest, capped per listing. */
export async function historyFor(listingIds: string[], sinceMs: number, capPerListing = 400) {
  if (!listingIds.length) return []
  const rows = await db.select()
    .from(shoppingPricePoints)
    .where(inArray(shoppingPricePoints.listingId, listingIds))
    .orderBy(desc(shoppingPricePoints.observedAt))
    .limit(capPerListing * listingIds.length)
  return rows
    .filter(r => r.observedAt.getTime() >= sinceMs)
    .reverse()
}

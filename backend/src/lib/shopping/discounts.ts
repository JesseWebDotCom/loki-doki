// Per-user effective-price math. Discounts ("Military 10%", "RedCard 5%") are standing
// per-retailer percentages that compound in creation order — matching how they stack at
// a register (a card discount applies to the already-discounted subtotal). Effective
// prices are always computed at read/alert time, never stored, so editing a discount
// instantly re-prices everything.

import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { shoppingDiscounts } from '@/db/schema'

export type DiscountRow = typeof shoppingDiscounts.$inferSelect

export interface EffectivePrice {
  effectiveCents: number
  applied: { label: string; savedCents: number }[]
}

export function effectivePrice(priceCents: number, discounts: DiscountRow[]): EffectivePrice {
  let remaining = priceCents
  const applied: { label: string; savedCents: number }[] = []
  for (const d of discounts) {
    if (!d.active || d.percentOff <= 0) continue
    let saved = Math.round((remaining * d.percentOff) / 100)
    if (d.maxDiscountCents != null) saved = Math.min(saved, d.maxDiscountCents)
    if (saved <= 0) continue
    remaining -= saved
    applied.push({ label: d.label, savedCents: saved })
  }
  return { effectiveCents: remaining, applied }
}

/** All active discounts for a user, grouped by retailer, in creation (application) order. */
export async function loadDiscounts(userId: string): Promise<Map<string, DiscountRow[]>> {
  const rows = await db
    .select()
    .from(shoppingDiscounts)
    .where(and(eq(shoppingDiscounts.userId, userId), eq(shoppingDiscounts.active, true)))
    .orderBy(shoppingDiscounts.createdAt)
  const byRetailer = new Map<string, DiscountRow[]>()
  for (const row of rows) {
    const list = byRetailer.get(row.retailer) ?? []
    list.push(row)
    byRetailer.set(row.retailer, list)
  }
  return byRetailer
}

/** Convenience: sticker → {effectiveCents, applied} for one retailer, or null when no discounts. */
export function effectiveFor(
  priceCents: number | null,
  retailer: string,
  discounts: Map<string, DiscountRow[]>,
): EffectivePrice | null {
  if (priceCents == null) return null
  const rows = discounts.get(retailer)
  if (!rows?.length) return null
  const result = effectivePrice(priceCents, rows)
  return result.applied.length ? result : null
}

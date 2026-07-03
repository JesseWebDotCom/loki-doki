// Companion shopping tool: track a product by URL, list tracked items and recent drops,
// or check a specific product's best price. Products/history are household-wide; when a
// userId is available (config._userId) effective prices use that user's discounts.

import type { Tool, ToolResult } from './index'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { shoppingListings, shoppingProducts } from '@/db/schema'
import { adapterForUrl, RETAILER_LABELS } from '@/lib/shopping/adapters'
import { extractGenericProduct } from '@/lib/shopping/adapters/generic'
import { effectiveFor, loadDiscounts } from '@/lib/shopping/discounts'
import { refreshProduct } from '@/lib/shopping/tracker'

interface ShoppingArgs {
  action?: 'track' | 'deals' | 'check'
  url?: string
  query?: string
}

function dollars(cents: number | null | undefined): string {
  return cents == null ? 'no price' : `$${(cents / 100).toFixed(2)}`
}

async function execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
  const { action = 'deals', url, query } = (args ?? {}) as ShoppingArgs
  const userId = config?._userId as string | undefined
  const discounts = userId ? await loadDiscounts(userId) : new Map()

  // Track a pasted/mentioned product URL.
  if (action === 'track' || (url && /^https?:\/\//.test(url))) {
    if (!url) return { success: false, error: 'I need a product link to track.' }
    const routed = adapterForUrl(url)
    if (!routed) return { success: false, error: "That doesn't look like a product page I can read." }
    const [existing] = await db.select({ productId: shoppingListings.productId })
      .from(shoppingListings)
      .where(and(eq(shoppingListings.retailer, routed.adapter.id), eq(shoppingListings.externalId, routed.externalId)))
      .limit(1)
    if (existing) return { success: true, data: { alreadyTracked: true, productId: existing.productId }, directReply: "You're already tracking that one." }

    const detail = routed.adapter.id === 'generic'
      ? await extractGenericProduct(routed.externalId, null)
      : await routed.adapter.getProduct(routed.externalId)
    if (!detail) return { success: false, error: "I couldn't read the price from that page." }

    const now = new Date()
    const productId = crypto.randomUUID()
    await db.insert(shoppingProducts).values({
      id: productId, title: detail.title, brand: detail.brand ?? null, model: detail.mpn,
      gtin: detail.gtin, imageUrl: detail.imageUrl, createdBy: userId ?? null, createdAt: now, updatedAt: now,
    })
    await db.insert(shoppingListings).values({
      id: crypto.randomUUID(), productId, retailer: detail.retailer, externalId: detail.externalId,
      url: detail.url, title: detail.title, imageUrl: detail.imageUrl,
      priceCents: detail.inStock ? detail.priceCents : null, wasPriceCents: detail.wasPriceCents,
      currency: detail.currency, inStock: detail.inStock, matchConfidence: 'manual',
      lastCheckedAt: now, lastChangedAt: now, createdAt: now,
    })
    return {
      success: true,
      data: { productId, title: detail.title, price: dollars(detail.priceCents) },
      directReply: `Now tracking ${detail.title} at ${dollars(detail.priceCents)}. I'll alert you when the price drops.`,
    }
  }

  // Check a specific tracked product by name.
  if (action === 'check' && query) {
    const products = await db.select().from(shoppingProducts)
    const match = products.find(p => p.title.toLowerCase().includes(query.toLowerCase()))
    if (!match) return { success: true, directReply: `I'm not tracking anything matching "${query}".` }
    await refreshProduct(match.id).catch(() => {})
    const listings = await db.select().from(shoppingListings)
      .where(and(eq(shoppingListings.productId, match.id), eq(shoppingListings.active, true)))
    const priced = listings.filter(l => l.priceCents != null)
    const best = priced.length
      ? priced.reduce((a, b) => {
          const ea = effectiveFor(a.priceCents, a.retailer, discounts)?.effectiveCents ?? a.priceCents!
          const eb = effectiveFor(b.priceCents, b.retailer, discounts)?.effectiveCents ?? b.priceCents!
          return ea <= eb ? a : b
        })
      : null
    if (!best) return { success: true, directReply: `${match.title} has no current price — it may be out of stock.` }
    const eff = effectiveFor(best.priceCents, best.retailer, discounts)
    const label = RETAILER_LABELS[best.retailer] ?? best.retailer
    const priceText = eff ? `${dollars(eff.effectiveCents)} at ${label} (${dollars(best.priceCents)} before your discount)` : `${dollars(best.priceCents)} at ${label}`
    return { success: true, data: { productId: match.id }, directReply: `${match.title} is ${priceText}.` }
  }

  // Default: recent drops / tracked summary (household-wide).
  const products = await db.select().from(shoppingProducts).orderBy(desc(shoppingProducts.createdAt)).limit(50)
  if (!products.length) return { success: true, directReply: "You're not tracking any products yet. Paste a product link and I'll watch its price." }
  const listings = await db.select().from(shoppingListings)
    .where(and(inArray(shoppingListings.productId, products.map(p => p.id)), eq(shoppingListings.active, true)))
  const byProduct = new Map<string, typeof listings>()
  for (const l of listings) { const a = byProduct.get(l.productId) ?? []; a.push(l); byProduct.set(l.productId, a) }

  const dayAgo = Date.now() - 48 * 3600_000
  const recentDrops = products
    .map(p => {
      const ls = byProduct.get(p.id) ?? []
      const dropped = ls.some(l => l.lastChangedAt && l.lastChangedAt.getTime() > dayAgo)
      const priced = ls.filter(l => l.priceCents != null)
      const best = priced.length ? Math.min(...priced.map(l => effectiveFor(l.priceCents, l.retailer, discounts)?.effectiveCents ?? l.priceCents!)) : null
      return { title: p.title, dropped, best }
    })
    .filter(x => x.dropped)

  if (!recentDrops.length) {
    return { success: true, data: { trackedCount: products.length }, directReply: `No recent price drops on your ${products.length} tracked ${products.length === 1 ? 'product' : 'products'}.` }
  }
  const list = recentDrops.slice(0, 5).map(d => `${d.title} — ${dollars(d.best)}`).join('; ')
  return { success: true, data: { drops: recentDrops.length }, directReply: `Recent price changes: ${list}.` }
}

export const shoppingTool: Tool = {
  id: 'shopping',
  name: 'Shop',
  description: 'Track product prices, list tracked items and recent drops, or check the best price for a tracked product.',
  examples: [
    'track this product',
    'track this air fryer for me',
    'any price drops on my tracked items?',
    "what's the cheapest price for the drill I'm tracking?",
    'watch the price of this',
    'is anything I track on sale?',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'shopping',
      description: 'Track a product price by URL, report tracked products and recent price drops, or check a tracked product\'s best price.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['track', 'deals', 'check'], description: "'track' a product URL, 'deals' for recent drops across tracked items, 'check' a specific tracked product by name" },
          url: { type: 'string', description: 'Product URL to track (for action=track)' },
          query: { type: 'string', description: 'Product name to check (for action=check)' },
        },
        required: [],
      },
    },
  },
  offline: false,
  dataSources: [
    { name: 'Amazon', domain: 'amazon.com', purpose: 'Product prices', type: 'web' },
    { name: 'Walmart', domain: 'walmart.com', purpose: 'Product prices', type: 'web' },
    { name: 'Target', domain: 'target.com', purpose: 'Product prices', type: 'web' },
    { name: 'Home Depot', domain: 'homedepot.com', purpose: 'Product prices', type: 'web' },
    { name: "Lowe's", domain: 'lowes.com', purpose: 'Product prices', type: 'web' },
  ],
  execute,
}

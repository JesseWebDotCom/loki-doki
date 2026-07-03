// Self-healing extraction. Our per-retailer parsers are fast and cheap but brittle: when a
// store changes its HTML, a regex silently returns nothing. Rather than run a maintained
// scraping engine (all of which need Docker), we heal in place — if the fast parser fails on
// a page that clearly loaded, we fall back to a local-LLM read of the page text (Ollama, no
// Docker) so the user's tracking keeps working, AND we count the failure so that when a
// store's parser is systematically broken we notify an admin to update the regex.
//
// Net effect: the native adapters stay lightweight, breakage degrades to "slower but still
// works" instead of "silently wrong", and we get told which parser needs maintenance.

import { stripTags } from '@/lib/htmlText'
import { ollamaChat } from '@/llm/ollama'
import { emitNotification } from '@/lib/notify'
import { decodeTitle } from '@/lib/shopping/fetch'
import type { ProductDetail, RetailerId } from '@/lib/shopping/types'
import { logger } from '@/lib/logger'

// Dynamic import (not a static one): '@/lib/models' pulls in the LLM router, which loads the
// full companion tool registry — including the Shop chat tool, which imports the retailer
// adapters (this module's own callers) back. A static import here would create a load-order-
// dependent circular-import crash; deferring the import until the function actually runs
// breaks the cycle without touching the router/tools graph.
async function getFastModel(): Promise<string> {
  return (await import('@/lib/models')).getFastModel()
}

// ── local-LLM extraction (shared with the generic adapter's LLM strategy) ──────────

export interface LlmProduct {
  priceCents: number | null
  title: string | null
  inStock: boolean
}

/** Read {price, title, inStock} from raw page text with the fast local model. Null on failure. */
export async function llmExtractProduct(html: string): Promise<LlmProduct | null> {
  const text = stripTags(html).replace(/\s+/g, ' ')
  const at = text.indexOf('$')
  const excerpt = at >= 0 ? text.slice(Math.max(0, at - 1_000), at + 5_000) : text.slice(0, 6_000)
  try {
    const res = await ollamaChat(
      await getFastModel(),
      [
        { role: 'system', content: 'You extract the main product listing from raw shop-page text. Answer only from the text given; if there is no clear single product price, use null.' },
        { role: 'user', content: `Page text:\n${excerpt}\n\nReturn the main product's current price in US dollars (number, null if none), its title, and whether it appears in stock.` },
      ],
      undefined,
      { temperature: 0 },
      {
        type: 'object',
        properties: {
          price: { type: ['number', 'null'] },
          title: { type: ['string', 'null'] },
          inStock: { type: 'boolean' },
        },
        required: ['price', 'title', 'inStock'],
      },
      45_000,
    )
    const parsed = JSON.parse(res.message.content) as { price: number | null; title: string | null; inStock: boolean }
    return {
      priceCents: parsed.price == null ? null : Math.round(parsed.price * 100),
      title: parsed.title,
      inStock: !!parsed.inStock,
    }
  } catch {
    return null
  }
}

// ── parser health monitoring ───────────────────────────────────────────────────────
// Consecutive fast-parse failures per retailer, in memory. A single odd page shouldn't
// cry wolf, so we only alert after several in a row — the signature of a real HTML change,
// not a one-off variant page. The counter resets the moment the fast parser succeeds again.

const HEAL_ALERT_THRESHOLD = 4
const consecutiveHeals = new Map<RetailerId, number>()
const alerted = new Set<RetailerId>()

function noteFastSuccess(retailer: RetailerId): void {
  consecutiveHeals.set(retailer, 0)
  alerted.delete(retailer)
}

async function noteFastFailure(retailer: RetailerId, healed: boolean): Promise<void> {
  const n = (consecutiveHeals.get(retailer) ?? 0) + 1
  consecutiveHeals.set(retailer, n)
  if (n >= HEAL_ALERT_THRESHOLD && !alerted.has(retailer)) {
    alerted.add(retailer)
    logger.warn(`[shopping/selfHeal] ${retailer} fast parser failing (${n}×) — ${healed ? 'LLM is covering' : 'even LLM failed'}`)
    await emitNotification({
      type: 'system',
      userId: null,
      title: `Shop: ${retailer} price parser may need updating`,
      body: `The built-in ${retailer} parser has failed ${n} checks in a row. ${healed ? 'The AI fallback is keeping prices flowing, but the fast parser should be refreshed.' : 'Prices for this store may be unavailable.'}`,
      dedupeKey: `shopping-parser-broken:${retailer}`,
    }).catch(() => {})
  }
}

// ── the heal wrapper ────────────────────────────────────────────────────────────────

/** OG-tag fallbacks so an LLM-healed result still carries a title/image. */
function ogFallbacks(html: string): { title: string | null; imageUrl: string | null } {
  const title = html.match(/property="og:title"[^>]*content="([^"]+)"/)?.[1] ?? html.match(/<title[^>]*>([^<]+)/)?.[1] ?? null
  const imageUrl = html.match(/property="og:image"[^>]*content="([^"]+)"/)?.[1] ?? null
  return { title: title ? decodeTitle(title) : null, imageUrl }
}

/**
 * Run a retailer's fast parser; if it can't extract a product from a page that clearly
 * loaded, heal with the local LLM and flag the parser as degraded. `pageLooksReal` guards
 * against wasting an LLM call on a block/challenge page (those aren't parser breakage).
 */
export async function parseWithHeal(
  html: string,
  ctx: { retailer: RetailerId; externalId: string; url: string },
  fastParse: (html: string) => ProductDetail | null,
): Promise<ProductDetail | null> {
  const fast = fastParse(html)
  if (fast && (fast.priceCents != null || fast.inStock === false)) {
    noteFastSuccess(ctx.retailer)
    return fast
  }

  // Only heal when the page looks like a real product page (has a price somewhere), so a
  // genuine block/empty response doesn't count as parser breakage or burn an LLM call.
  const pageLooksReal = /\$\s?\d[\d,]*(?:\.\d{2})?/.test(html) && html.length > 5_000
  if (!pageLooksReal) {
    return fast // null / OOS — a real fetch failure or block, not our parser's fault
  }

  const healed = await llmExtractProduct(html)
  const ok = !!healed && healed.priceCents != null
  await noteFastFailure(ctx.retailer, ok)
  if (!ok) return fast

  const og = ogFallbacks(html)
  return {
    retailer: ctx.retailer,
    externalId: ctx.externalId,
    url: ctx.url,
    title: healed!.title ?? og.title ?? ctx.url,
    imageUrl: og.imageUrl,
    priceCents: healed!.inStock ? healed!.priceCents : null,
    currency: 'USD',
    brand: null,
    wasPriceCents: null,
    inStock: healed!.inStock,
    gtin: null,
    mpn: null,
    sku: null,
  }
}

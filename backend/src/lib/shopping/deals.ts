// Deals discovery feed. Slickdeals publishes a keyless RSS feed of community-vetted deals
// (frontpage, and per-search-term); we parse it with the shared feed parser and surface it
// as a browse tab. Each item carries a title, the deal price when present in the title, a
// best-effort retailer guess from the text, and a link — and if that link resolves to a
// retailer we support, the UI offers a one-tap "track".

import { cachedLookup } from '@/lib/lookupCache'
import { fetchHtml } from '@/lib/scrape'
import { parseFeedXml, type ParsedFeed } from '@/lib/feeds/parse'
import { parseMoney } from '@/lib/shopping/fetch'
import { decodeEntities, stripTags } from '@/lib/htmlText'
import { resolveTrackableUrl, RETAILER_LABELS } from '@/lib/shopping/adapters'

const FEED_TTL_MS = 30 * 60 * 1000

// Three DISJOINT Slickdeals feeds (frontpage / popular / trending) — each caps at 25 items but
// they don't overlap, so merging + de-duping yields ~75 deals instead of 25. Verified live.
const FRONTPAGE_FEEDS = [
  'https://feeds.feedburner.com/SlickdealsnetFP',
  'https://slickdeals.net/newsearch.php?mode=popdeals&searcharea=deals&searchin=first&rss=1',
  'https://slickdeals.net/newsearch.php?mode=trending&searcharea=deals&searchin=first&rss=1',
]
const FRONTPAGE_ALT = 'https://slickdeals.net/newsearch.php?mode=frontpage&searcharea=deals&searchin=first&rss=1'
const SEARCH = (q: string) => `https://slickdeals.net/newsearch.php?q=${encodeURIComponent(q)}&searcharea=deals&searchin=first&rss=1`

// Cap LLM retailer lookups per refresh so a 75-deal list doesn't fire dozens of serial Ollama
// calls. The cheap rungs (merchant link / store-name / URL slug) label most deals; the LLM only
// mops up stragglers, and any beyond the budget simply render without a store label (still fine —
// their detail page's "where to buy" market lookup shows real stores).
const LLM_RETAILER_BUDGET = 18

// First group = stores we have adapters for (key drives adapter routing when a deal resolves).
// The rest are LABEL-ONLY: a deal at Tractor Supply/Sam's Club/etc. can't be tracked (no
// adapter), but we can still name the retailer on the deal page instead of showing "at Deal".
// The `key` for label-only stores is never used for routing (those deals render in deal-mode).
const RETAILERS: { key: string; label: string; re: RegExp }[] = [
  { key: 'amazon', label: 'Amazon', re: /\bamazon\b/i },
  { key: 'walmart', label: 'Walmart', re: /\bwalmart\b/i },
  { key: 'target', label: 'Target', re: /\btarget\b/i },
  { key: 'homedepot', label: 'Home Depot', re: /\bhome\s?depot\b/i },
  { key: 'lowes', label: "Lowe's", re: /\blowe'?s\b/i },
  { key: 'bestbuy', label: 'Best Buy', re: /\bbest\s?buy\b/i },
  { key: 'costco', label: 'Costco', re: /\bcostco\b/i },
  { key: 'ebay', label: 'eBay', re: /\bebay\b/i },
  { key: 'temu', label: 'Temu', re: /\btemu\b/i },
  { key: 'woot', label: 'Woot!', re: /\bwoot\b/i },
  // label-only (no adapter)
  { key: 'tractorsupply', label: 'Tractor Supply', re: /\btractor\s?supply\b/i },
  { key: 'samsclub', label: "Sam's Club", re: /\bsam'?s\s?club\b/i },
  { key: 'newegg', label: 'Newegg', re: /\bnewegg\b/i },
  { key: 'bhphoto', label: 'B&H Photo', re: /\bb&h\b|\bbhphoto\b|\bb and h\b/i },
  { key: 'microcenter', label: 'Micro Center', re: /\bmicro\s?center\b/i },
  { key: 'gamestop', label: 'GameStop', re: /\bgamestop\b/i },
  { key: 'kohls', label: "Kohl's", re: /\bkohl'?s\b/i },
  { key: 'macys', label: "Macy's", re: /\bmacy'?s\b/i },
  { key: 'chewy', label: 'Chewy', re: /\bchewy\b/i },
  { key: 'wayfair', label: 'Wayfair', re: /\bwayfair\b/i },
  { key: 'staples', label: 'Staples', re: /\bstaples\b/i },
  { key: 'nike', label: 'Nike', re: /\bnike\b/i },
  { key: 'adidas', label: 'Adidas', re: /\badidas\b/i },
  { key: 'dell', label: 'Dell', re: /\bdell\b/i },
  { key: 'apple', label: 'Apple', re: /\bapple\.com\b|\bapple store\b/i },
]

// Slickdeals' RSS <category> tag is constant ("Frontpage Deals") across every item on the
// frontpage feed — not usable as a real per-deal category. We derive one from the title/summary
// instead, same best-effort keyword-match approach already used for `retailerFrom` above.
// First match wins, ordered narrowest/most-specific first to avoid a generic word in a later
// bucket stealing an item that a more specific earlier bucket already owns.
const CATEGORIES: { key: string; label: string; re: RegExp }[] = [
  { key: 'electronics', label: 'Electronics', re: /\b(laptop|monitor|\btv\b|television|headphone|earbud|camera|webcam|tablet|ipad|\bssd\b|hard drive|router|speaker|soundbar|gaming|console|xbox|playstation|nintendo|switch|charger|usb|cable|keyboard|mouse|smartwatch|phone|projector|drone)\b/i },
  { key: 'home', label: 'Home & Kitchen', re: /\b(kitchen|cookware|vacuum|mattress|furniture|decor|bedding|sheets|pillow|appliance|blender|air fryer|coffee maker|instant pot|toaster|knife set|cutlery)\b/i },
  { key: 'tools-outdoor', label: 'Tools & Outdoor', re: /\b(tool|drill|saw|grill|patio|garden|outdoor|generator|pressure washer|lawn|mower|hose)\b/i },
  { key: 'automotive', label: 'Automotive', re: /\b(car|tire|automotive|dash cam|motor oil|jump starter)\b/i },
  { key: 'toys-games', label: 'Toys & Games', re: /\b(toy|lego|board game|puzzle|action figure|plush|nerf)\b/i },
  { key: 'health-fitness', label: 'Health & Fitness', re: /\b(fitness|treadmill|dumbbell|yoga|protein|vitamin|supplement|massage|resistance band)\b/i },
  { key: 'apparel-beauty', label: 'Apparel & Beauty', re: /\b(shoes|sneaker|jacket|shirt|jeans|boots|cosmetic|skincare|makeup|fragrance|perfume|cologne)\b/i },
  { key: 'grocery', label: 'Grocery & Household', re: /\b(water|snack|coffee|tea|cleaning|detergent|paper towel|toilet paper|grocery|pack of)\b/i },
]

export interface Deal {
  title: string
  /** Best-known TRACKABLE url — the real merchant product page when resolvable, else the
   *  Slickdeals thread as a last resort (still fine for the generic "any URL" adapter). */
  url: string
  /** Always the Slickdeals discussion thread — for "view the original deal post", distinct
   *  from `url` once that's been resolved to the merchant page (otherwise they're the same
   *  link and "view original post" would just reopen the product page you're already on). */
  dealPostUrl: string
  priceCents: number | null
  retailer: string | null
  retailerLabel: string | null
  category: string | null
  categoryLabel: string | null
  imageUrl: string | null
  publishedAt: number | null
}

function retailerFrom(text: string): { key: string; label: string } | null {
  for (const r of RETAILERS) if (r.re.test(text)) return { key: r.key, label: r.label }
  return null
}

// Slickdeals slugs very often name the store at the end: ".../f/19714461-…-12-pack-at-amazon",
// ".../f/…-at-home-depot". Cheap to parse and doesn't need the LLM — try it before falling back.
function retailerFromUrl(postUrl: string): { key: string; label: string } | null {
  try {
    const path = new URL(postUrl).pathname.toLowerCase()
    const m = path.match(/-at-([a-z0-9-]+?)(?:\?|#|\/|$)/)
    if (!m) return null
    return retailerFrom(m[1]!.replace(/-/g, ' '))  // "home-depot" → "home depot" so regexes match
  } catch {
    return null
  }
}

// Last-resort retailer identification: when neither an outbound merchant link nor the store-name
// regex above pins the retailer, ask the local LLM to read the deal post and name the store.
// Dynamic imports keep '@/lib/models' (→ LLM router → tool registry → shopping adapters) out of
// this module's static graph, same circular-import guard as selfHeal.ts. Best-effort + fast-fail.
async function retailerFromLLM(title: string, body: string): Promise<{ key: string; label: string } | null> {
  try {
    const { getFastModel } = await import('@/lib/models')
    const { ollamaChat } = await import('@/llm/ollama')
    const res = await ollamaChat(
      await getFastModel(),
      [
        { role: 'system', content: 'You identify which single retailer/store a shopping deal is from. Answer only from the given text.' },
        { role: 'user', content: `Deal title: ${title}\nDeal details: ${body.slice(0, 600)}\n\nWhich store sells this? Give the store's common name (e.g. "Amazon", "Tractor Supply", "Costco"), or null if the text doesn't clearly name one.` },
      ],
      undefined,
      { temperature: 0 },
      { type: 'object', properties: { store: { type: ['string', 'null'] } }, required: ['store'] },
      20_000,
    )
    const parsed = JSON.parse(res.message.content) as { store: string | null }
    const label = parsed.store?.trim().replace(/^["']|["'.]+$/g, '').trim()
    if (!label || label.length > 40 || /^(unknown|n\/?a|none|null|various|multiple|select)/i.test(label)) return null
    // Reuse a known key if the LLM named an adapter store; else a slug for label-only display.
    const known = retailerFrom(label)
    return known ?? { key: label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), label }
  } catch {
    return null
  }
}

function categoryFrom(text: string): { key: string; label: string } | null {
  for (const c of CATEGORIES) if (c.re.test(text)) return { key: c.key, label: c.label }
  return null
}

function priceFrom(title: string): number | null {
  // Slickdeals titles usually lead with the deal price, e.g. "Anker … $23.99".
  const m = title.match(/\$\s?\d[\d,]*(?:\.\d{2})?/)
  return m ? parseMoney(m[0]) : null
}

// `e.url` (the RSS <link>) is the Slickdeals FORUM THREAD, never the actual retailer page —
// tracking/resolving it lands on slickdeals.net itself via the generic adapter ("Web store",
// wrong title, no real price history, no rating). The real outbound link lives in
// <content:encoded>, tagged `data-cta="outclick"` (Slickdeals' own "leaves the site" marker,
// present on every outbound link regardless of which store it's for).
//
// Resolution is URL-FIRST, not text-first: earlier this only looked for a merchant link when
// the title/summary text happened to name a store we recognize — a genuinely generic-sounding
// deal title ("Today's hot deal: $19.99") with a perfectly trackable Amazon/Target link behind
// it would never even attempt resolution. Instead: grab whichever outbound link is actually
// there, resolve it to a real URL, and let THAT URL's own host name the retailer — text
// matching is now only a fallback for a *label* when no outbound link resolves to anything.
function firstOutclickHref(contentHtml: string | null): string | null {
  if (!contentHtml) return null
  for (const m of contentHtml.matchAll(/<a\s+([^>]*)>/gi)) {
    const attrs = m[1]!
    if (!/data-cta=["']outclick["']/i.test(attrs)) continue
    const href = attrs.match(/href=["']([^"']+)["']/i)?.[1]
    if (href) return decodeEntities(href)
  }
  return null
}

/** Resolves the deal's real outbound link to a trackable merchant URL + the retailer that URL
 *  actually belongs to. Amazon gets a zero-network shortcut (the ASIN is right on the anchor
 *  via `data-aps-asin`); everything else goes through `resolveTrackableUrl`, which follows the
 *  `slickdeals.net/click` affiliate redirect (2-4 hops through ad networks) to the real page
 *  and unwraps Walmart's bot-check `/blocked` interstitial along the way. Null when there's no
 *  outbound link, or it doesn't resolve to a retailer we have an adapter for. */
async function resolveDealMerchant(contentHtml: string | null): Promise<{ key: string; label: string; url: string } | null> {
  for (const m of contentHtml?.matchAll(/<a\s+([^>]*)>/gi) ?? []) {
    const attrs = m[1]!
    if (!/data-cta=["']outclick["']/i.test(attrs)) continue
    const asin = attrs.match(/data-aps-asin=["']([A-Z0-9]{10})["']/i)?.[1]
    if (asin) return { key: 'amazon', label: 'Amazon', url: `https://www.amazon.com/dp/${asin.toUpperCase()}` }
    break // first outclick anchor only — later ones (e.g. a secondary "Target" mention) aren't the primary offer
  }
  const outclick = firstOutclickHref(contentHtml)
  if (!outclick) return null
  const routed = await resolveTrackableUrl(outclick)
  if (!routed || routed.adapter.id === 'generic') return null
  return { key: routed.adapter.id, label: RETAILER_LABELS[routed.adapter.id] ?? routed.adapter.id, url: routed.url }
}

type FeedEntry = ParsedFeed['entries'][number]

async function feedEntries(url: string): Promise<FeedEntry[]> {
  const xml = await fetchHtml(url, { timeoutMs: 12_000 })
  return xml ? parseFeedXml(xml).entries : []
}

async function resolveDeal(e: FeedEntry, llmBudget: { n: number }): Promise<Deal> {
  // <link> (unlike <title>/<description>) isn't entity-decoded by the shared feed parser —
  // it commonly carries a literal "&amp;" in its query string that would corrupt the URL once
  // actually used as a real href/query param rather than just displayed as text.
  const postUrl = decodeEntities(e.url)
  const text = `${e.title} ${e.summary ?? ''}`
  const merchant = await resolveDealMerchant(e.contentHtml)
  // Retailer ladder, most→least trustworthy: outbound merchant link → store name in the deal
  // text → store named in the Slickdeals slug (…-at-amazon) → LLM reading the whole post (only
  // when the cheap rungs miss AND there's budget left this refresh).
  let textRetailer = merchant ? null : (retailerFrom(text) ?? retailerFromUrl(postUrl))
  if (!merchant && !textRetailer && llmBudget.n > 0) {
    const body = `${e.summary ?? ''} ${stripTags(e.contentHtml ?? '')}`.trim()
    if (body.length > 20) {
      llmBudget.n--
      textRetailer = await retailerFromLLM(e.title, body)
    }
  }
  const category = categoryFrom(text)
  return {
    title: e.title,
    url: merchant?.url ?? postUrl,
    dealPostUrl: postUrl,
    priceCents: priceFrom(e.title),
    retailer: merchant?.key ?? textRetailer?.key ?? null,
    retailerLabel: merchant?.label ?? textRetailer?.label ?? null,
    category: category?.key ?? null,
    categoryLabel: category?.label ?? null,
    imageUrl: e.imageUrl,
    publishedAt: e.publishedAt,
  }
}

/** Fetch one or more feeds, de-dupe entries by guid (thread id), and resolve each to a Deal. */
async function fetchDeals(urls: string[]): Promise<Deal[]> {
  const lists = await Promise.all(urls.map(u => feedEntries(u).catch(() => [])))
  const seen = new Set<string>()
  const entries: FeedEntry[] = []
  for (const list of lists) {
    for (const e of list) {
      if (seen.has(e.guid)) continue
      seen.add(e.guid)
      entries.push(e)
    }
  }
  const llmBudget = { n: LLM_RETAILER_BUDGET }
  const deals = await Promise.all(entries.map(e => resolveDeal(e, llmBudget)))
  // Newest first — merged feeds arrive in each feed's own order, not globally sorted.
  return deals.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
}

export async function getDeals(query?: string): Promise<Deal[]> {
  if (query && query.trim().length >= 2) {
    return cachedLookup('shopping:deals:q', query.toLowerCase(), FEED_TTL_MS, () => fetchDeals([SEARCH(query)]))
  }
  return cachedLookup('shopping:deals', 'frontpage', FEED_TTL_MS, async () => {
    const merged = await fetchDeals(FRONTPAGE_FEEDS)
    return merged.length ? merged : fetchDeals([FRONTPAGE_ALT])
  })
}

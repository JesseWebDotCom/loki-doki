// Patch hyperlocal news + events. Patch has NO official API, so this is a tolerant
// HTML/JSON-LD scrape with a web-search fallback. ALL the fragility lives here: if the
// markup shifts, scraping yields 0 items and we fall through to web search; if that also
// fails, the caller marks the source degraded and drops the section. Isolated on purpose.

import type { BriefingItem } from '../types'
import { webSearch } from '@/lib/webSearch'

const UA = 'Mozilla/5.0 (compatible; LokiDoki/1.0)'

export interface PatchResult {
  news: BriefingItem[]
  events: BriefingItem[]
  usedFallback: boolean
}

function patchUrl(slug: string): string {
  return `https://patch.com/${slug.replace(/^\/+|\/+$/g, '')}`
}

// Patch's newsfeed canonicalUrl is a site-relative path ("/connecticut/milford/…").
// Make it absolute so links work outside patch.com (already-absolute URLs pass through).
function absolutePatchUrl(url: unknown): string | undefined {
  if (typeof url !== 'string' || !url) return undefined
  if (/^https?:\/\//i.test(url)) return url
  return `https://patch.com/${url.replace(/^\/+/, '')}`
}

// Patch is a Next.js app — its content lives in the __NEXT_DATA__ JSON blob, NOT in
// server-rendered article markup or JSON-LD. News sits at
// props.pageProps.mainContent.newsfeed[]; events sit in a rightRail items array whose
// entries carry an `eventType`. We navigate those paths, with deep-search fallbacks so a
// path rename only degrades (→ web search) rather than throws.

function extractNextData(html: string): Record<string, unknown> | null {
  const m = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)
  if (!m) return null
  try {
    return JSON.parse(m[1]!.trim()) as Record<string, unknown>
  } catch {
    return null
  }
}

// Patch newsfeed items carry an `imageThumbnail` (string URL) and/or an `images` array
// whose first entry is `{ url }`. Return the first usable image URL.
function patchImageUrl(it: Record<string, unknown>): string | undefined {
  const thumb = it['imageThumbnail']
  if (typeof thumb === 'string' && thumb) return thumb
  const imgs = it['images']
  if (Array.isArray(imgs) && imgs[0] && typeof imgs[0] === 'object') {
    const url = (imgs[0] as Record<string, unknown>)['url']
    if (typeof url === 'string' && url) return url
  }
  return undefined
}

function fmtEventDate(start: unknown): string | undefined {
  if (typeof start !== 'string') return undefined
  const d = new Date(start)
  if (isNaN(d.getTime())) return undefined
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// Best-effort deep getter for a nested path; returns undefined if any hop is missing.
function dig(root: unknown, path: string[]): unknown {
  let cur = root
  for (const k of path) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

// Find the first array whose first object element has the given key (e.g. 'eventType').
function findArrayWithKey(root: unknown, key: string): Record<string, unknown>[] | null {
  const stack: unknown[] = [root]
  let guard = 0
  while (stack.length && guard < 20000) {
    guard++
    const node = stack.pop()
    if (Array.isArray(node)) {
      if (node.length && node[0] && typeof node[0] === 'object' && key in (node[0] as object)) {
        return node as Record<string, unknown>[]
      }
      for (const v of node) stack.push(v)
    } else if (node && typeof node === 'object') {
      for (const v of Object.values(node as Record<string, unknown>)) stack.push(v)
    }
  }
  return null
}

async function scrapePatch(slug: string, limit: number, timeoutMs: number): Promise<{ news: BriefingItem[]; events: BriefingItem[] }> {
  const res = await fetch(patchUrl(slug), {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`patch: ${res.status}`)
  const data = extractNextData(await res.text())
  if (!data) throw new Error('patch: no __NEXT_DATA__')

  const news: BriefingItem[] = []
  const events: BriefingItem[] = []
  const seen = new Set<string>()

  // News: the main newsfeed (filter out null spacer/ad slots — real items have a title).
  let feed = dig(data, ['props', 'pageProps', 'mainContent', 'newsfeed']) as Record<string, unknown>[] | undefined
  if (!Array.isArray(feed)) feed = findArrayWithKey(data, 'canonicalUrl') ?? undefined
  for (const it of feed ?? []) {
    if (news.length >= limit) break
    const title = typeof it?.['title'] === 'string' ? (it['title'] as string).trim() : ''
    if (!title || seen.has(title)) continue
    seen.add(title)
    const ts = typeof it['created'] === 'string' ? Date.parse(it['created'] as string) : NaN
    news.push({
      title,
      url: absolutePatchUrl(it['canonicalUrl']),
      summary: typeof it['summary'] === 'string' ? (it['summary'] as string).trim() || undefined : undefined,
      imageUrl: patchImageUrl(it),
      publishedAt: Number.isNaN(ts) ? undefined : ts,
    })
  }

  // Events: the rightRail block whose items carry an eventType.
  const evItems = findArrayWithKey(data, 'eventType') ?? []
  for (const ev of evItems) {
    if (events.length >= limit) break
    const title = typeof ev['title'] === 'string' ? (ev['title'] as string).trim() : ''
    if (!title || seen.has(title)) continue
    seen.add(title)
    events.push({ title, detail: fmtEventDate(ev['displayDate'] ?? ev['startDate']) })
  }

  return { news, events }
}

/**
 * True if `slug` resolves to a real Patch town page with at least one news item.
 * Used by the slug resolver to validate a derived/AI-suggested slug before trusting it.
 */
export async function patchSlugHasNews(slug: string, timeoutMs = 6000): Promise<boolean> {
  try {
    const { news } = await scrapePatch(slug, 1, timeoutMs)
    return news.length > 0
  } catch {
    return false
  }
}

function cleanSearchTitle(title: string): string {
  // Strip common "Page Title | Site Name" and "Page Title - Site Name" suffixes
  return title
    .replace(/\s*[|—]\s*[^|—]+$/, '')
    .replace(/\s+-\s+[A-Z][^\s-].*$/, '')
    .trim()
}

function domainLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

async function searchFallback(townLabel: string, limit: number): Promise<{ news: BriefingItem[]; events: BriefingItem[] }> {
  const [newsRes, eventRes] = await Promise.all([
    webSearch(`${townLabel} local news today`, limit).catch(() => []),
    webSearch(`${townLabel} events this weekend`, limit * 2).catch(() => []),
  ])

  const toItems = (rs: { title: string; snippet: string; url: string }[]): BriefingItem[] => {
    const seenDomains = new Set<string>()
    const out: BriefingItem[] = []
    for (const r of rs) {
      if (!r.title || !r.url || out.length >= limit) break
      const domain = domainLabel(r.url)
      if (domain && seenDomains.has(domain)) continue
      if (domain) seenDomains.add(domain)
      const title = cleanSearchTitle(r.title) || r.title
      // Show domain as the detail so users know it's a discovery link, not a specific event
      out.push({ title, detail: domain || undefined, url: r.url })
    }
    return out
  }

  return { news: toItems(newsRes), events: toItems(eventRes) }
}

/**
 * Patch local news + events for a town. `slug` is the Patch path ("connecticut/milford");
 * `townLabel` (e.g. "Milford, CT") is used for the web-search fallback. Returns empty
 * arrays rather than throwing when everything fails (caller decides if that's "degraded").
 */
export async function patchLocal(
  opts: { slug: string | null; townLabel: string; limit?: number },
  timeoutMs = 6000,
): Promise<PatchResult> {
  const limit = opts.limit ?? 5
  if (opts.slug) {
    try {
      const scraped = await scrapePatch(opts.slug, limit, timeoutMs)
      if (scraped.news.length || scraped.events.length) return { ...scraped, usedFallback: false }
    } catch {
      /* fall through to web search */
    }
  }
  const fb = await searchFallback(opts.townLabel, limit)
  return { ...fb, usedFallback: true }
}

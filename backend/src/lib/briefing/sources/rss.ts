// Shared Google News RSS fetch + parse for briefing sources (world news, notable deaths)
// and the reactive tools. Mirrors the lightweight regex parser in tools/news.ts.

import type { BriefingItem } from '../types'

const BASE = 'https://news.google.com/rss'
const LOCALE = 'hl=en-US&gl=US&ceid=US:en'

function extractXml(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  if (!m) return ''
  return m[1]!.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()
}

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, '')
    .replace(/&quot;/g, '"')
    .trim()
}

export interface RssItem extends BriefingItem {
  source: string
}

function parseRss(xml: string, limit: number): RssItem[] {
  const items: RssItem[] = []
  const itemRe = /<item>([\s\S]*?)<\/item>/gi
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(xml)) !== null && items.length < limit) {
    const block = m[1]!
    const title = stripHtml(extractXml(block, 'title'))
    if (!title) continue
    const url = extractXml(block, 'link')
    const sourceMatch = block.match(/<source[^>]*>([^<]*)<\/source>/)
    const source = sourceMatch ? sourceMatch[1]!.trim() : ''
    const pub = extractXml(block, 'pubDate')
    const ts = pub ? Date.parse(pub) : NaN
    items.push({
      title,
      url,
      source,
      detail: source || undefined,
      publishedAt: Number.isNaN(ts) ? undefined : ts,
    })
  }
  return items
}

async function fetchRss(url: string, limit: number, timeoutMs: number): Promise<RssItem[]> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'LokiDoki/1.0', Accept: 'application/rss+xml, application/xml, text/xml' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`RSS ${res.status}`)
  return parseRss(await res.text(), limit)
}

/** Top headlines for a Google News topic section (e.g. "WORLD"). */
export function googleNewsTopic(topic: string, limit = 3, timeoutMs = 5000): Promise<RssItem[]> {
  return fetchRss(`${BASE}/headlines/section/topic/${topic}?${LOCALE}`, limit, timeoutMs)
}

/** Keyword search against Google News RSS. */
export function googleNewsSearch(query: string, limit = 3, timeoutMs = 5000): Promise<RssItem[]> {
  return fetchRss(`${BASE}/search?q=${encodeURIComponent(query)}&${LOCALE}`, limit, timeoutMs)
}

// ── Rich publisher feeds (real per-article images + summaries) ───────────────────
// Google News RSS gives diverse headlines but NO usable image (every article page serves
// the same generic og:image) and a junk description. For the news UI we instead aggregate
// a few major world feeds that carry media:* images and real descriptions.

export const WORLD_FEEDS: { url: string; source: string }[] = [
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', source: 'The New York Times' },
  { url: 'https://www.theguardian.com/world/rss', source: 'The Guardian' },
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', source: 'BBC News' },
]

// BBC's feed thumbnails are tiny (…/ace/standard/240/…); bump the width for crisper cards.
function upscaleImage(url: string): string {
  return url.replace(/(ichef\.bbci\.co\.uk\/(?:ace\/standard|news\/[a-z]+)\/)\d+(\/)/i, '$1800$2')
}

// Pick the largest media:content/media:thumbnail (by width attr), else an image enclosure.
function extractFeedImage(block: string): string | undefined {
  let best: string | undefined
  let bestW = -1
  for (const tag of block.match(/<media:(?:content|thumbnail)\b[^>]*>/gi) ?? []) {
    const url = tag.match(/\burl=["']([^"']+)["']/i)?.[1]
    if (!url || !/^https?:/i.test(url)) continue
    const w = Number(tag.match(/\bwidth=["'](\d+)["']/i)?.[1] ?? '0')
    if (w >= bestW) { best = url; bestW = w }
  }
  if (!best) best = block.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]*type=["']image/i)?.[1]
  return best ? upscaleImage(best) : undefined
}

function parsePublisherRss(xml: string, source: string, limit: number): RssItem[] {
  const items: RssItem[] = []
  const itemRe = /<item>([\s\S]*?)<\/item>/gi
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(xml)) !== null && items.length < limit) {
    const block = m[1]!
    const title = stripHtml(extractXml(block, 'title'))
    if (!title) continue
    // descriptions are often double-encoded HTML (e.g. "&lt;p&gt;…") — strip twice.
    const summary = stripHtml(stripHtml(extractXml(block, 'description'))).slice(0, 220) || undefined
    const pub = extractXml(block, 'pubDate')
    const ts = pub ? Date.parse(pub) : NaN
    items.push({
      title,
      url: extractXml(block, 'link'),
      source,
      detail: source,
      summary,
      imageUrl: extractFeedImage(block),
      publishedAt: Number.isNaN(ts) ? undefined : ts,
    })
  }
  return items
}

/**
 * Aggregated world headlines from major publisher feeds, round-robined across sources for
 * diversity and deduped by title. Each item carries a real image + summary where the feed
 * provides them. Resilient: a feed that fails is skipped.
 */
export async function worldHeadlines(limit = 12, timeoutMs = 6000): Promise<RssItem[]> {
  const lists = await Promise.all(
    WORLD_FEEDS.map((f) =>
      fetch(f.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LokiDoki/1.0)', Accept: 'application/rss+xml, application/xml, text/xml' },
        signal: AbortSignal.timeout(timeoutMs),
      })
        .then((r) => (r.ok ? r.text() : ''))
        .then((xml) => (xml ? parsePublisherRss(xml, f.source, limit) : []))
        .catch(() => [] as RssItem[]),
    ),
  )
  // Round-robin across feeds so the top of the list isn't dominated by one source.
  const merged: RssItem[] = []
  const seen = new Set<string>()
  for (let i = 0; merged.length < limit; i++) {
    let added = false
    for (const list of lists) {
      const it = list[i]
      if (!it) continue
      added = true
      const key = it.title.toLowerCase().slice(0, 60)
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(it)
      if (merged.length >= limit) break
    }
    if (!added) break // every feed exhausted
  }
  return merged
}

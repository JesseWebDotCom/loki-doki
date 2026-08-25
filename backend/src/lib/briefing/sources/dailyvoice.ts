// Daily Voice hyperlocal news — a Patch-alike network (CT/NY/NJ/PA/MA town pages) that,
// unlike Patch, publishes a real public RSS feed per town: dailyvoice.com/<state>/<town>/rss/.
// A town Daily Voice doesn't cover just 404s, so "no results" and "not covered" collapse into
// the same empty-array return — no separate slug-validation step needed like Patch's.

import type { BriefingItem } from '../types'
import { stripTags as stripHtml, decodeEntities } from '@/lib/htmlText'

const UA = 'Mozilla/5.0 (compatible; MaiPaiHome/1.0)'

function extractXml(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  if (!m) return ''
  return m[1]!.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()
}

function extractImage(block: string): string | undefined {
  const m = block.match(/<img[^>]+src=["']([^"']+)["']/i)
  return m ? decodeEntities(m[1]!) : undefined
}

function parseFeed(xml: string, limit: number): BriefingItem[] {
  const items: BriefingItem[] = []
  const itemRe = /<item>([\s\S]*?)<\/item>/gi
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(xml)) !== null && items.length < limit) {
    const block = m[1]!
    const title = stripHtml(extractXml(block, 'title'))
    if (!title) continue
    const encoded = extractXml(block, 'content:encoded')
    const description = extractXml(block, 'description')
    const pub = extractXml(block, 'pubDate')
    const ts = pub ? Date.parse(pub) : NaN
    items.push({
      title,
      url: extractXml(block, 'link') || undefined,
      summary: stripHtml(description).slice(0, 220) || undefined,
      imageUrl: extractImage(encoded) ?? extractImage(description),
      publishedAt: Number.isNaN(ts) ? undefined : ts,
    })
  }
  return items
}

function feedUrl(slug: string): string {
  return `https://dailyvoice.com/${slug.replace(/^\/+|\/+$/g, '')}/rss/`
}

/**
 * Daily Voice local news for a town slug ("ct/milford"). Never throws — returns an empty
 * array if the town isn't covered (outside CT/NY/NJ/PA/MA) or the fetch fails.
 */
export async function dailyVoiceLocal(slug: string, limit: number, timeoutMs = 6000): Promise<BriefingItem[]> {
  try {
    const res = await fetch(feedUrl(slug), {
      headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return []
    return parseFeed(await res.text(), limit)
  } catch {
    return []
  }
}

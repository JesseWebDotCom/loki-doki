// Feed autodiscovery: given a site or feed URL, return candidate RSS/Atom feeds.
// If the URL is already a feed, return it; otherwise scan the HTML <head> for
// <link rel="alternate" type="application/rss+xml|atom+xml">.

import { safeFetch } from '@/lib/ssrfGuard'

export interface FeedCandidate { url: string; title: string | null; kind: 'rss' | 'atom' }

const UA = 'Mozilla/5.0 (compatible; MaiPaiHome/1.0)'

export async function discoverFeeds(input: string, timeoutMs = 6000): Promise<FeedCandidate[]> {
  let res: Response
  try {
    res = await safeFetch(input, { headers: { 'User-Agent': UA, Accept: 'text/html,application/rss+xml,application/atom+xml,application/xml' } }, { timeoutMs })
  } catch {
    return []
  }
  if (!res.ok) return []

  const ct = res.headers.get('content-type') ?? ''
  const body = await res.text()

  // Already a feed?
  if (/(application\/(rss|atom)\+xml|text\/xml|application\/xml)/i.test(ct) || /^\s*<\?xml|<rss[\s>]|<feed[\s>]/i.test(body)) {
    const kind: 'rss' | 'atom' = /<feed[\s>]/i.test(body) && !/<rss[\s>]/i.test(body) ? 'atom' : 'rss'
    const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() ?? null
    return [{ url: input, title, kind }]
  }

  // Scan HTML for feed <link> tags.
  const out: FeedCandidate[] = []
  const seen = new Set<string>()
  for (const linkTag of body.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/rel=["']alternate["']/i.test(linkTag)) continue
    const type = linkTag.match(/type=["']([^"']+)["']/i)?.[1] ?? ''
    if (!/(rss|atom)\+xml/i.test(type)) continue
    const href = linkTag.match(/href=["']([^"']+)["']/i)?.[1]
    if (!href) continue
    let abs: string
    try { abs = new URL(href, input).toString() } catch { continue }
    if (seen.has(abs)) continue
    seen.add(abs)
    out.push({
      url: abs,
      title: linkTag.match(/title=["']([^"']+)["']/i)?.[1] ?? null,
      kind: /atom/i.test(type) ? 'atom' : 'rss',
    })
  }
  return out
}

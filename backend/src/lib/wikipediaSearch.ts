// Live Wikipedia search via the MediaWiki API — the online counterpart to the
// offline ZIM archive (lib/zimSearch.ts). Free, keyless, reliable from any IP, and
// current (covers events the ZIM snapshot predates). Used as the encyclopedic
// fallback in the `search` tool when the general web engines come up empty.
//
// Two calls: list=search for ranked hits + snippets, then the REST summary endpoint
// to replace the top hit's fragmentary snippet with a clean lead paragraph (a far
// better gist for LLM synthesis). The summary fetch is best-effort.

import { stripTags } from '@/lib/htmlText'

export interface WikiResult {
  title: string
  snippet: string
  url: string
}

const UA = 'Mozilla/5.0 (compatible; MaiPaiHome/1.0)'
const API = 'https://en.wikipedia.org/w/api.php'
const REST = 'https://en.wikipedia.org/api/rest_v1/page/summary'

function pageUrl(title: string): string {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`
}

async function leadExtract(title: string, timeoutMs: number): Promise<string> {
  try {
    const res = await fetch(`${REST}/${encodeURIComponent(title.replace(/ /g, '_'))}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return ''
    const data = (await res.json()) as { extract?: string }
    return (data.extract ?? '').trim()
  } catch { return '' }
}

/** Live Wikipedia full-text search; up to `limit` results, or [] on any failure (never throws). */
export async function wikipediaSearch(query: string, limit = 5, timeoutMs = 6000): Promise<WikiResult[]> {
  const q = query.trim()
  if (!q) return []

  const params = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: q,
    srlimit: String(limit),
    srprop: 'snippet',
    format: 'json',
    origin: '*',
  })

  let res: Response
  try {
    res = await fetch(`${API}?${params}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch { return [] }
  if (!res.ok) return []

  let data: { query?: { search?: Array<{ title: string; snippet: string }> } }
  try { data = await res.json() } catch { return [] }

  const results: WikiResult[] = (data.query?.search ?? []).map(s => ({
    title: s.title,
    snippet: stripTags(s.snippet),
    url: pageUrl(s.title),
  }))
  if (!results.length) return []

  // Enrich the top hit with a clean lead paragraph for a better answer gist.
  const top = results[0]!
  const lead = await leadExtract(top.title, timeoutMs)
  if (lead) top.snippet = lead

  return results
}

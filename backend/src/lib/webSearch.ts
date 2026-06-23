// Lightweight DuckDuckGo web search helper, shared by the briefing source fetchers
// (Patch fallback, "events near {city}") and any caller that just wants raw results.
// Uses the official DDG JSON API only — no HTML scraping.

import { stripTags } from '@/lib/htmlText'

const DDG_API = 'https://api.duckduckgo.com/'
const USER_AGENT = 'Mozilla/5.0 (compatible; LokiDoki/1.0)'

export interface WebResult {
  title: string
  snippet: string
  url: string
}

async function ddgApi(query: string, timeoutMs: number): Promise<WebResult[]> {
  const params = new URLSearchParams({ q: query, format: 'json', no_html: '1', skip_disambig: '1' })
  let res: Response
  try {
    res = await fetch(`${DDG_API}?${params}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    return []
  }
  if (!res.ok) return []
  let data: Record<string, unknown>
  try {
    data = (await res.json()) as Record<string, unknown>
  } catch {
    return []
  }
  const results: WebResult[] = []
  const abstract = String(data.AbstractText ?? '')
  if (abstract) {
    results.push({ title: String(data.Heading ?? query), snippet: abstract, url: String(data.AbstractURL ?? '') })
  }
  const related = Array.isArray(data.RelatedTopics) ? (data.RelatedTopics as unknown[]) : []
  for (const topic of related) {
    if (!topic || typeof topic !== 'object') continue
    const t = topic as Record<string, unknown>
    const text = String(t.Text ?? '')
    if (!text) continue
    const dash = text.indexOf(' - ')
    results.push({
      title: dash !== -1 ? text.slice(0, dash) : text,
      snippet: dash !== -1 ? text.slice(dash + 3) : text,
      url: String(t.FirstURL ?? ''),
    })
  }
  return results
}

/** Run a web search via the DDG JSON API; returns up to `limit` results, or [] on any failure (never throws). */
export async function webSearch(query: string, limit = 5, timeoutMs = 6000): Promise<WebResult[]> {
  const results = await ddgApi(query, timeoutMs)
  return results.slice(0, limit)
}

// Shared "raw search hits → LLM/UI-ready answer" formatting. Originally lived inside
// the `search` tool (tools/search.ts); extracted so the direct web-search route can
// produce the same gist/highlights/sources shape without duplicating the logic.

const SNIPPET_LIMIT = 200
const HIGHLIGHT_LIMIT = 4

export interface SearchResult {
  title: string
  snippet: string
  url: string
}

export interface AnswerPayload {
  gist: string
  highlights: string[]
  sources: Array<{ url: string; title: string }>
  depth_available: boolean
}

function trimSnippet(text: string): string {
  const t = text.trim()
  return t.length <= SNIPPET_LIMIT ? t : t.slice(0, SNIPPET_LIMIT - 1).trimEnd() + '…'
}

// Function words that carry no topical signal — excluded from relevance matching so a
// stray "the"/"was"/"who" can't make an off-topic page look on-topic.
const STOPWORDS = new Set([
  'was', 'why', 'did', 'does', 'who', 'what', 'whats', 'when', 'where', 'how', 'out',
  'for', 'and', 'his', 'her', 'are', 'were', 'that', 'this', 'with', 'about', 'from',
  'have', 'has', 'had', 'you', 'your', 'their', 'they', 'there', 'into', 'than', 'them',
])

/** Distinct topical tokens in a string: lowercased, ≥3 chars, stopwords removed. */
export function contentTokens(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter(t => t.length >= 3 && !STOPWORDS.has(t)))]
}

/**
 * Drop results that don't actually relate to the query. The keyless indie engines
 * (esp. Marginalia, the last engine standing when DuckDuckGo/Mojeek are bot-blocked)
 * happily return high-confidence garbage — unrelated bios, guestbooks — for pop-culture
 * or current queries. A result survives if its title+snippet shares enough topical
 * tokens with the query.
 */
export function filterRelevant(query: string, items: SearchResult[]): SearchResult[] {
  const qTokens = contentTokens(query)
  if (qTokens.length === 0) return items // no signal to gate on — keep everything
  const need = qTokens.length >= 3 ? 2 : 1
  return items.filter(item => {
    const hay = `${item.title} ${item.snippet}`.toLowerCase()
    const hits = qTokens.reduce((n, t) => (hay.includes(t) ? n + 1 : n), 0)
    return hits >= need
  })
}

export function deriveAnswerPayload(query: string, items: SearchResult[]): AnswerPayload {
  if (!items.length) return { gist: '', highlights: [], sources: [], depth_available: false }

  const lead = items[0]!
  const leadTitle = lead.title.trim()
  const leadSnippet = trimSnippet(lead.snippet)
  let gist: string
  if (leadTitle && leadSnippet) gist = `${leadTitle}: ${leadSnippet}`
  else gist = leadSnippet || leadTitle || `Web results for ${query}.`

  const highlights = items
    .slice(1, 1 + HIGHLIGHT_LIMIT)
    .flatMap(item => {
      const t = item.title.trim()
      const s = trimSnippet(item.snippet)
      if (t && s) return [`${t}: ${s}`]
      return [t || s].filter(Boolean)
    })

  const sources = items
    .filter(r => r.url)
    .map(r => ({ url: r.url, title: r.title.slice(0, 200) || r.url }))

  return { gist, highlights, sources, depth_available: items.length > 1 + HIGHLIGHT_LIMIT }
}

import type { Tool, ToolResult } from './index'
import { webSearch } from '@/lib/webSearch'
import { wikipediaSearch } from '@/lib/wikipediaSearch'
import { searchCachedNews } from '@/lib/cachedNews'
import { zimSearch } from '@/lib/zimSearch'
import { isOffline } from '@/lib/connectivity'

const SNIPPET_LIMIT = 200
const HIGHLIGHT_LIMIT = 4

interface SearchResult {
  title: string
  snippet: string
  url: string
}

interface AnswerPayload {
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
function contentTokens(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter(t => t.length >= 3 && !STOPWORDS.has(t)))]
}

/**
 * Drop results that don't actually relate to the query. The keyless indie engines
 * (esp. Marginalia, the last engine standing when DuckDuckGo/Mojeek are bot-blocked)
 * happily return high-confidence garbage — unrelated bios, guestbooks — for pop-culture
 * or current queries. Those junk results used to count as "web results found," which
 * suppressed the live-Wikipedia fallback and left the LLM grounding its answer on noise.
 * A result survives if its title+snippet shares enough topical tokens with the query.
 */
function filterRelevant(query: string, items: SearchResult[]): SearchResult[] {
  const qTokens = contentTokens(query)
  if (qTokens.length === 0) return items // no signal to gate on — keep everything
  const need = qTokens.length >= 3 ? 2 : 1
  return items.filter(item => {
    const hay = `${item.title} ${item.snippet}`.toLowerCase()
    const hits = qTokens.reduce((n, t) => (hay.includes(t) ? n + 1 : n), 0)
    return hits >= need
  })
}

function deriveAnswerPayload(query: string, items: SearchResult[]): AnswerPayload {
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

export const searchTool: Tool = {
  id: 'search',
  name: 'Web Search',
  description:
    'Search the web for current events, news, prices, reviews, and open-web information',
  // Stays runnable in offline mode: the tool degrades gracefully to cached news and
  // the offline Wikipedia archive when the network (or the offline toggle) rules out
  // live engines — so it should never be hard-blocked upstream.
  offline: true,
  dataSources: [
    { name: 'DuckDuckGo', domain: 'duckduckgo.com', purpose: 'Primary web search results', type: 'web' },
    { name: 'Mojeek', domain: 'mojeek.com', purpose: 'Independent web search (keyless fallback)', type: 'web' },
    { name: 'Marginalia', domain: 'marginalia-search.com', purpose: 'Independent indie web index (keyless fallback)', type: 'api' },
    { name: 'Wikipedia', domain: 'wikipedia.org', purpose: 'Live encyclopedic fallback (MediaWiki API)', type: 'api' },
  ],
  passMessage: 'query',
  examples: [
    'find information about any topic, person, company, or concept online',
    'look up what something is or who someone is',
    'search the web for facts or background on any named subject',
    'get current information about a product, event, or technology',
    'research anything by name — show, movie, tool, brand, person, or idea',
    'find how something works or what happened to it',
    'look up prices, reviews, specs, or news about something',
    'search for any topic I bring up that you might not know about',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'search',
      description:
        'Search the web for current events, news, prices, reviews, and open-web information. Not for subjective pick-one suggestions.',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: {
            type: 'string',
            description: 'Search query phrased as a web search',
          },
          max_results: {
            type: 'number',
            description: 'Max results to return (1–10, default 5)',
          },
        },
      },
    },
  },

  async execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
    const { query, max_results = 5 } = args as { query: string; max_results?: number }
    if (!query?.trim()) return { success: false, error: 'Query is required' }

    const limit = Math.min(Math.max(1, max_results), 10)
    const q = query.trim()
    const userId = config?._userId as string | undefined
    const offline = userId ? await isOffline(userId).catch(() => false) : false

    // ── Tier 1: cached news (local, zero-network) ────────────────────────────
    // "Do we already have this?" — token-matched over feed items already on disk.
    // Surfaced first so a recent, on-topic headline leads the answer.
    const cached = await searchCachedNews(q, userId, 4)
    const cachedResults: SearchResult[] = cached.map(c => ({
      title: c.title,
      snippet: c.snippet,
      url: c.url,
    }))

    // ── Tier 2: live web (primary) → live Wikipedia (fallback) ───────────────
    // Skipped entirely when offline mode is on; we go straight to the local archive.
    // The general web is where current events, news, prices, and brand-new topics
    // live. Live Wikipedia backs it up for encyclopedic queries the web engines miss
    // or that are blocked. Both swallow their own network errors and return [].
    let webResults: SearchResult[] = []
    let source = 'web'
    if (!offline) {
      const web = await webSearch(q, limit)
      // Gate on relevance, not just presence: junk results from a blocked-engine
      // fallback must not pre-empt the Wikipedia backstop below.
      const relevant = filterRelevant(q, web.map(r => ({ title: r.title, snippet: r.snippet, url: r.url })))
      if (relevant.length > 0) {
        webResults = relevant
      } else {
        // Encyclopedic backstop. Search the topical tokens, not the raw string: a
        // natural-language question ("why was X kicked out of Y") wrecks MediaWiki's
        // full-text ranking and buries the obvious entity page under noise. Gate the
        // hits on relevance too, so a thin token query can't pass junk through.
        const wikiQuery = contentTokens(q).join(' ') || q
        const wiki = await wikipediaSearch(wikiQuery, limit)
        const wikiRelevant = filterRelevant(q, wiki.map(r => ({ title: r.title, snippet: r.snippet, url: r.url })))
        if (wikiRelevant.length > 0) {
          webResults = wikiRelevant
          source = 'Wikipedia (online)'
        }
      }
    }

    // ── Tier 3: offline Wikipedia archive (network down / offline mode) ───────
    if (webResults.length === 0) {
      try {
        const zim = await zimSearch(['wikipedia'], q, limit)
        if (zim.length > 0) {
          webResults = zim.map(r => ({
            title: r.title,
            snippet: r.snippet,
            url: `/api/archives/view/${r.sourceId}/${r.path}`,
          }))
          source = 'Wikipedia (offline)'
        }
      } catch { /* no offline archive either */ }
    }

    // Merge: cached news leads (deduped), then the live/archive results, capped at limit.
    const seen = new Set<string>()
    const merged: SearchResult[] = []
    for (const r of [...cachedResults, ...webResults]) {
      const key = r.url.replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase()
      if (!key || seen.has(key)) continue
      seen.add(key)
      merged.push(r)
      if (merged.length >= limit) break
    }

    return {
      success: true,
      data: { source, results: merged, answer_payload: deriveAnswerPayload(q, merged) },
    }
  },
}

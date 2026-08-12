import type { Tool, ToolResult } from './index'
import { webSearch } from '@/lib/webSearch'
import { wikipediaSearch } from '@/lib/wikipediaSearch'
import { searchCachedNews } from '@/lib/cachedNews'
import { zimSearch } from '@/lib/zimSearch'
import { isOffline } from '@/lib/connectivity'
import { contentTokens, filterRelevant, deriveAnswerPayload, type SearchResult } from '@/lib/searchAnswer'

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
    // Surfaced first so a recent, on-topic headline leads the answer. Each item
    // carries its publication date so freshness is visible to the model and UI.
    const dateLabel = (ms: number | null): string | null => {
      if (!ms) return null
      const days = Math.floor((Date.now() - ms) / 86_400_000)
      if (days <= 0) return 'today'
      if (days === 1) return 'yesterday'
      if (days < 7) return `${days} days ago`
      return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    }
    const cached = await searchCachedNews(q, userId, 4)
    const cachedResults: SearchResult[] = cached.map(c => ({
      title: c.title,
      snippet: c.snippet,
      url: c.url,
      date: dateLabel(c.publishedAt),
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

import type { Tool, ToolResult } from './index'
import { zimSearch, deriveZimAnswerPayload } from '@/lib/zimSearch'

const DDG_API = 'https://api.duckduckgo.com/'
const USER_AGENT = 'Mozilla/5.0 (compatible; LokiDoki/1.0)'
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

interface SearchData {
  results: SearchResult[]
  answer_payload: AnswerPayload
}

// Remove DDG self-referential snippets that pollute LLM synthesis
const BRAND_LEAK_RE = /duckduckgo[^.]*(?:search engine|privacy|internet)[^.]*\./gi

function stripBrand(text: string): string {
  return text.replace(BRAND_LEAK_RE, '').trim()
}

function decodeEntities(html: string): string {
  return html
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(parseInt(code, 10)))
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).trim()
}

function trimSnippet(text: string): string {
  const t = text.trim()
  return t.length <= SNIPPET_LIMIT ? t : t.slice(0, SNIPPET_LIMIT - 1).trimEnd() + '…'
}

async function ddgApi(query: string): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query, format: 'json', no_html: '1', skip_disambig: '1' })
  let res: Response
  try {
    res = await fetch(`${DDG_API}?${params}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(5000),
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

  const results: SearchResult[] = []

  const abstract = stripBrand(String(data.AbstractText ?? ''))
  const heading = stripBrand(String(data.Heading ?? ''))
  const sourceUrl = String(data.AbstractURL ?? '')
  if (abstract) {
    results.push({ title: heading || query, snippet: abstract, url: sourceUrl })
  }

  const relatedTopics = Array.isArray(data.RelatedTopics) ? (data.RelatedTopics as unknown[]) : []
  for (const topic of relatedTopics) {
    if (!topic || typeof topic !== 'object') continue
    const t = topic as Record<string, unknown>
    const text = stripBrand(String(t.Text ?? ''))
    const url = String(t.FirstURL ?? '')
    if (!text) continue
    const dashIdx = text.indexOf(' - ')
    const title = dashIdx !== -1 ? text.slice(0, dashIdx) : text
    const snippet = dashIdx !== -1 ? text.slice(dashIdx + 3) : text
    results.push({ title: title || text, snippet, url })
  }

  return results
}


function deriveAnswerPayload(query: string, items: SearchResult[]): AnswerPayload {
  if (!items.length) return { gist: '', highlights: [], sources: [], depth_available: false }

  const lead = items[0]
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
    'Search the web for current events, news, prices, reviews, and open-web information via DuckDuckGo',
  offline: true,
  dataSources: [
    { name: 'DuckDuckGo', domain: 'duckduckgo.com', purpose: 'Web search results (falls back to offline library when unavailable)', type: 'api' },
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

  async execute(args: unknown): Promise<ToolResult> {
    const { query, max_results = 5 } = args as { query: string; max_results?: number }
    if (!query?.trim()) return { success: false, error: 'Query is required' }

    const limit = Math.min(Math.max(1, max_results), 10)
    const q = query.trim()

    // ── Live web first ───────────────────────────────────────────────────────
    // Current events, news, prices, and brand-new topics only exist on the open
    // web. Offline Wikipedia's full-text search returns stale — and often
    // irrelevant — matches for anything current (e.g. "claude mythos" → "List of
    // MSX games"), so it is a fallback for when the network is down, not a
    // substitute. ddgApi swallows its own network errors and returns [], so an
    // empty result here means "no web answer" (offline or genuinely nothing)
    // and we fall through to the offline archive.
    const results = await ddgApi(q)
    if (results.length > 0) {
      const trimmed = results.slice(0, limit)
      const data: SearchData = {
        results: trimmed,
        answer_payload: deriveAnswerPayload(q, trimmed),
      }
      return { success: true, data }
    }

    // ── Offline Wikipedia fallback (no web answer / network unavailable) ──────
    try {
      const zimResults = await zimSearch(['wikipedia'], q, limit)
      if (zimResults.length > 0) {
        return {
          success: true,
          data: {
            source: 'Wikipedia (offline)',
            results: zimResults,
            answer_payload: deriveZimAnswerPayload(zimResults, q),
          },
        }
      }
    } catch { /* no offline archive either */ }

    // Neither web nor offline produced anything.
    return { success: true, data: { results: [], answer_payload: deriveAnswerPayload(q, []) } }
  },
}

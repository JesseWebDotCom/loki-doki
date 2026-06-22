import type { Tool, ToolResult } from './index'

const BASE = 'https://news.google.com/rss'

const CATEGORY_MAP: Record<string, string> = {
  tech: 'TECHNOLOGY', technology: 'TECHNOLOGY',
  sports: 'SPORTS', sport: 'SPORTS',
  business: 'BUSINESS', finance: 'BUSINESS', economy: 'BUSINESS',
  world: 'WORLD', international: 'WORLD',
  us: 'NATION', 'united states': 'NATION', national: 'NATION', america: 'NATION',
  science: 'SCIENCE',
  health: 'HEALTH', medical: 'HEALTH',
  entertainment: 'ENTERTAINMENT', celebrity: 'ENTERTAINMENT',
}

interface NewsItem {
  title: string
  url: string
  source: string
  published: string
  snippet: string
}

function detectCategory(query: string): string | undefined {
  const low = query.toLowerCase()
  for (const [kw, topic] of Object.entries(CATEGORY_MAP)) {
    if (low.includes(kw)) return topic
  }
  return undefined
}

function buildUrl(query: string): string {
  const locale = 'hl=en-US&gl=US&ceid=US:en'
  const category = detectCategory(query)
  if (category) return `${BASE}/headlines/section/topic/${category}?${locale}`
  const isGeneric = !query || /^(news|headlines|what'?s in the news)$/i.test(query.trim())
  if (isGeneric) return `${BASE}?${locale}`
  return `${BASE}/search?q=${encodeURIComponent(query)}&${locale}`
}

function extractXml(block: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')
  const m = block.match(re)
  if (!m) return ''
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()
}

function stripHtml(html: string): string {
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

function parseRss(xml: string): NewsItem[] {
  const items: NewsItem[] = []
  const itemRe = /<item>([\s\S]*?)<\/item>/gi
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(xml)) !== null && items.length < 8) {
    const block = m[1]
    const title = stripHtml(extractXml(block, 'title'))
    if (!title) continue
    const url = extractXml(block, 'link')
    const published = extractXml(block, 'pubDate')
    const sourceMatch = block.match(/<source[^>]*>([^<]*)<\/source>/)
    const source = sourceMatch ? sourceMatch[1].trim() : ''
    const snippet = stripHtml(extractXml(block, 'description')).slice(0, 400)
    items.push({ title, url, source, published, snippet })
  }
  return items
}

function deriveAnswerPayload(items: NewsItem[], category: string | undefined) {
  if (!items.length) return { gist: '', highlights: [], sources: [], depth_available: false }
  const label = category ? category.toLowerCase() : 'top'
  const lead = items[0]
  const gist = lead.source
    ? `Top ${label} headline: ${lead.title} (${lead.source}).`
    : `Top ${label} headline: ${lead.title}.`
  const highlights = items.slice(1, 6).map(it =>
    it.source ? `${it.title} — ${it.source}` : it.title
  )
  const sources = items.slice(0, 5).filter(it => it.url).map(it => ({ url: it.url, title: it.title.slice(0, 200) || it.url }))
  return { gist, highlights, sources, depth_available: items.length > 6 }
}

export const newsTool: Tool = {
  id: 'news',
  name: 'News',
  description: 'Get current headlines from Google News by category or keyword search',
  offline: false,
  dataSources: [
    { name: 'Google News', domain: 'news.google.com', purpose: 'News headlines by category or keyword', type: 'rss' },
  ],
  passMessage: 'query',
  examples: [
    'current news headlines and top stories today',
    'latest news about a specific topic or category',
    'what is happening in the world right now',
    'catch up on recent events and breaking news',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'news',
      description: 'Fetch current news headlines by topic or keyword',
      parameters: {
        type: 'object',
        required: [],
        properties: {
          query: {
            type: 'string',
            description: 'Topic or keywords (e.g. "technology", "sports", "climate change"). Omit for top headlines.',
          },
        },
      },
    },
  },

  async execute(args: unknown): Promise<ToolResult> {
    const { query = '' } = (args ?? {}) as { query?: string }
    const url = buildUrl(query.trim())
    const category = detectCategory(query.trim())

    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'LokiDoki/1.0', Accept: 'application/rss+xml, application/xml, text/xml' },
        signal: AbortSignal.timeout(6000),
      })
      if (!res.ok) return { success: false, error: `News fetch failed: ${res.status}` }
      const xml = await res.text()
      const items = parseRss(xml)
      if (!items.length) return { success: true, data: { category, items: [], answer_payload: { gist: 'No headlines found.' } } }
      return {
        success: true,
        data: { category, items, answer_payload: deriveAnswerPayload(items, category) },
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        return { success: false, offline: true, error: 'Network unavailable' }
      }
      return { success: false, error: String(err) }
    }
  },
}

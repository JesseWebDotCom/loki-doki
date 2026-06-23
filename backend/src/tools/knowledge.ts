import type { Tool, ToolResult } from './index'
import { zimSearch } from '@/lib/zimSearch'
import { kiwixContentBase } from '@/lib/kiwix'
import { stripHtml } from '@/lib/htmlText'
import { wikipediaSearch } from '@/lib/wikipediaSearch'

// Companion tool: encyclopedic knowledge lookup. Ported from v2 lokidoki/plugins/knowledge.
// Prefers the offline ZIM archives (Wikipedia and friends); falls back to the live
// MediaWiki API when those aren't installed. Returns a clean extract plus related titles.

const MAX_CHARS = 5000

// Default encyclopedic sources, in priority order. A knowledge_source hint narrows to one.
const DEFAULT_SOURCES = ['wikipedia', 'wikisource', 'wiktionary', 'wikiquote']
const KNOWN_SOURCES = new Set([
  'wikipedia', 'wikisource', 'wiktionary', 'wikiquote',
  'stackexchange', 'archlinux', 'python_docs',
])

// Section headings that are navigation/citation boilerplate, not content.
const SKIP_SECTION = /^(references|see also|notes|external links|further reading|bibliography|citations|sources)$/i

interface KnowledgeData {
  title: string
  extract: string
  url: string | null
  related: Array<{ title: string; url: string }>
  source_id: string
  offline: boolean
}

/** Split cleaned article text into sections, dropping boilerplate ones; cap total length. */
function trimSections(text: string): string {
  const parts = text.split(/\n(?=[A-Z][^\n]{0,60}\n)/)
  const kept: string[] = []
  let len = 0
  for (const part of parts) {
    const heading = part.split('\n', 1)[0]?.trim() ?? ''
    if (SKIP_SECTION.test(heading)) continue
    kept.push(part)
    len += part.length
    if (len >= MAX_CHARS) break
  }
  return (kept.join('\n').trim() || text).slice(0, MAX_CHARS)
}

async function fromZim(query: string, sources: string[]): Promise<KnowledgeData | null> {
  const hits = await zimSearch(sources, query, 5)
  const top = hits[0]
  if (!top) return null
  try {
    const res = await fetch(`${kiwixContentBase(top.bookName)}/${top.path}`, {
      signal: AbortSignal.timeout(4_000),
    })
    if (!res.ok) return null
    const extract = trimSections(stripHtml(await res.text()))
    return {
      title: top.title,
      extract,
      url: `/api/archives/view/${top.sourceId}/${top.path}`,
      related: hits.slice(1).map((h) => ({ title: h.title, url: `/api/archives/view/${h.sourceId}/${h.path}` })),
      source_id: top.sourceId,
      offline: true,
    }
  } catch {
    return null
  }
}

async function fromWikipedia(query: string): Promise<KnowledgeData | null> {
  const hits = await wikipediaSearch(query, 5)
  const top = hits[0]
  if (!top) return null
  return {
    title: top.title,
    extract: top.snippet.slice(0, MAX_CHARS),
    url: top.url,
    related: hits.slice(1).map((h) => ({ title: h.title, url: h.url })),
    source_id: 'wikipedia',
    offline: false,
  }
}

export const knowledgeTool: Tool = {
  id: 'knowledge',
  name: 'Knowledge',
  description:
    'Look up encyclopedic facts, definitions, history, science, and general knowledge. Uses the offline Wikipedia library, or Wikipedia.org when online.',
  offline: true,
  dataSources: [
    { name: 'Wikipedia', domain: 'wikipedia.org', purpose: 'Encyclopedic articles (online fallback)', type: 'api' },
  ],
  examples: [
    'what is / who is / tell me about a topic',
    'explain a concept, person, place, or event',
    'history or background of something',
    'encyclopedia lookup for general knowledge',
    'define a term or explain how something works',
    'facts about a country, animal, or invention',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'knowledge',
      description: 'Encyclopedic lookup of a topic, person, place, event, or concept.',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'The topic to look up, e.g. "photosynthesis" or "Marie Curie".' },
          knowledge_source: {
            type: 'string',
            description: 'Optional hint for which library to search (e.g. "wikipedia", "wiktionary", "archlinux").',
          },
        },
      },
    },
  },

  async execute(args: unknown): Promise<ToolResult> {
    const { query, knowledge_source } = args as { query?: string; knowledge_source?: string }
    const q = query?.trim()
    if (!q) return { success: false, error: 'A topic to look up is required' }

    const hint = knowledge_source?.trim().toLowerCase()
    const sources = hint && KNOWN_SOURCES.has(hint) ? [hint] : DEFAULT_SOURCES

    try {
      const zim = await fromZim(q, sources)
      if (zim) return { success: true, data: zim }

      const wiki = await fromWikipedia(q)
      if (wiki) return { success: true, data: wiki }

      return { success: false, error: `No knowledge article found for "${q}"` }
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        return { success: false, offline: true, error: 'Offline library not installed and Wikipedia is unreachable' }
      }
      return { success: false, error: String(err) }
    }
  },
}

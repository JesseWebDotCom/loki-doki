import { safeFetch } from '@/lib/ssrfGuard'
import type { BookSearchResult } from './types'
import type { LibrivoxSearchResult } from './librivox'

interface OpenLibraryDoc {
  title?: string
  author_name?: string[]
  language?: string[]
  cover_i?: number
  first_publish_year?: number
  first_sentence?: string | string[]
}

function words(value: string): Set<string> {
  return new Set(value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((word) => word.length > 1))
}

function titleScore(a: string, b: string): number {
  const left = words(a)
  const right = words(b)
  if (!left.size || !right.size) return 0
  let common = 0
  for (const word of left) if (right.has(word)) common++
  return common / Math.min(left.size, right.size)
}

function sentence(value: string | string[] | undefined): string | null {
  if (!value) return null
  const text = Array.isArray(value) ? value[0] : value
  return text?.replace(/\s+/g, ' ').trim().slice(0, 600) || null
}

type Enrichable = BookSearchResult | LibrivoxSearchResult

function enrich<T extends Enrichable>(item: T, docs: OpenLibraryDoc[]): T {
  const match = docs
    .map((doc) => ({ doc, score: doc.title ? titleScore(item.title, doc.title) : 0 }))
    .sort((a, b) => b.score - a.score)[0]
  if (!match || match.score < 0.6) return item
  const doc = match.doc
  return {
    ...item,
    author: item.author ?? doc.author_name?.[0] ?? null,
    language: item.language ?? doc.language?.[0] ?? null,
    coverUrl: item.coverUrl ?? (doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : null),
    description: item.description && !/^\(not listed in table of contents/i.test(item.description)
      ? item.description
      : sentence(doc.first_sentence),
    publishedYear: item.publishedYear ?? doc.first_publish_year ?? null,
  }
}

/** Fill sparse source records from Open Library's low-volume search API. Source
 * metadata remains authoritative; Open Library only supplies missing fields. */
export async function enrichCatalogMetadata<T extends Enrichable>(query: string, items: T[]): Promise<T[]> {
  if (!items.length) return items
  const params = new URLSearchParams({
    q: query, limit: '20',
    fields: 'title,author_name,language,cover_i,first_publish_year,first_sentence',
  })
  try {
    const response = await safeFetch(`https://openlibrary.org/search.json?${params.toString()}`, {}, { timeoutMs: 8_000 })
    if (!response.ok) return items
    const data = await response.json() as { docs?: OpenLibraryDoc[] }
    const docs = data.docs ?? []
    return items.map((item) => enrich(item, docs))
  } catch {
    return items
  }
}

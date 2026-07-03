import { safeFetch } from '@/lib/ssrfGuard'
import type { BookSearchResult, ResolvedDownload } from './types'

interface WikiSearchPage {
  pageid: number
  ns: number
  title: string
  index?: number
  extract?: string
  fullurl?: string
  length?: number
}

interface WikiSearchResponse {
  query?: { pages?: Record<string, WikiSearchPage> }
}

function cleanText(value: string | undefined): string | null {
  const text = value?.replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, 600) : null
}

function likelyWholeWork(page: WikiSearchPage): boolean {
  if (page.ns !== 0 || page.title.includes('/') || (page.length ?? 0) < 800) return false
  return !/^(author|portal|category|index|page|help|template):/i.test(page.title)
}

function exportUrl(title: string): string {
  const params = new URLSearchParams({ lang: 'en', page: title, format: 'epub' })
  return `https://ws-export.wmcloud.org/?${params.toString()}`
}

export async function searchWikisource(query: string): Promise<BookSearchResult[]> {
  const params = new URLSearchParams({
    action: 'query', generator: 'search', gsrsearch: query, gsrnamespace: '0', gsrlimit: '12',
    prop: 'extracts|info', exintro: '1', explaintext: '1', inprop: 'url', format: 'json', origin: '*',
  })
  try {
    const response = await safeFetch(`https://en.wikisource.org/w/api.php?${params.toString()}`, {}, { timeoutMs: 10_000 })
    if (!response.ok) return []
    const data = await response.json() as WikiSearchResponse
    return Object.values(data.query?.pages ?? {})
      .filter(likelyWholeWork)
      .sort((a, b) => (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER))
      .map((page) => ({
        source: 'wikisource' as const,
        sourceRef: page.title,
        title: page.title
          .replace(/\s*\(\d{4}\)\s*/g, ' ')
          .replace(/\s+(?:US|UK) edition$/i, '')
          .replace(/\s*\([^)]*(?:edition|translation)[^)]*\)\s*/gi, '')
          .trim(),
        author: null,
        language: 'en',
        coverUrl: null,
        description: cleanText(page.extract),
        mediaType: 'ebook' as const,
        formats: ['EPUB'],
        sizeBytes: null,
      }))
  } catch {
    return []
  }
}

export async function resolveWikisourceDownload(title: string): Promise<ResolvedDownload> {
  if (!title.trim() || title.includes('/')) throw new Error('Invalid Wikisource work')
  return { url: exportUrl(title), format: 'epub' }
}

import { safeFetch } from '@/lib/ssrfGuard'
import type { BookContentType, BookSearchResult } from './types'
import { getGoogleBooksApiKey } from './sourceToggles'

interface GoogleVolume {
  id: string
  volumeInfo?: {
    title?: string; subtitle?: string; authors?: string[]; publishedDate?: string
    description?: string; pageCount?: number; categories?: string[]; language?: string
    imageLinks?: { thumbnail?: string }
  }
  accessInfo?: { viewability?: string; embeddable?: boolean }
}

const SECTION_QUERY: Record<Exclude<BookContentType, 'book'>, string> = {
  magazine: 'subject:magazines OR subject:periodicals OR intitle:magazine',
  comic: 'subject:comics graphic novels', manga: 'subject:manga',
  coloring_book: 'intitle:coloring book', children: 'subject:juvenile fiction children',
}

function toResult(volume: GoogleVolume, contentType: BookContentType): BookSearchResult | null {
  const info = volume.volumeInfo
  if (!info?.title || !info.imageLinks?.thumbnail || !volume.accessInfo?.embeddable) return null
  if (!['PARTIAL', 'ALL_PAGES'].includes(volume.accessInfo.viewability ?? '')) return null
  const classification = `${info.title} ${(info.categories ?? []).join(' ')}`
  if (contentType === 'magazine' && !/magazine|magazines|periodical|journal/i.test(classification)) return null
  if (contentType === 'comic' && !/comic|graphic novel/i.test(classification)) return null
  if (contentType === 'manga' && !/manga/i.test(classification)) return null
  if (contentType === 'coloring_book' && !/colou?ring/i.test(classification)) return null
  if (contentType === 'children' && !/juvenile|children/i.test(classification)) return null
  const year = Number.parseInt(info.publishedDate?.slice(0, 4) ?? '', 10)
  return {
    source: 'googlebooks', sourceRef: volume.id, previewId: volume.id, previewAvailable: true,
    title: info.subtitle ? `${info.title}: ${info.subtitle}` : info.title,
    author: info.authors?.join(', ') ?? null, language: info.language ?? null,
    coverUrl: info.imageLinks.thumbnail.replace(/^http:/, 'https:'),
    description: info.description?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000) ?? null,
    subjects: info.categories?.slice(0, 4), mediaType: 'ebook', formats: ['Preview'], sizeBytes: null,
    publishedYear: Number.isFinite(year) ? year : null, publishedDate: info.publishedDate ?? null,
    pageCount: info.pageCount ?? null, contentType,
  }
}

async function queryGoogleBooks(query: string, contentType: BookContentType, orderBy: 'relevance' | 'newest'): Promise<BookSearchResult[]> {
  const params = new URLSearchParams({ q: query, maxResults: '24', printType: 'books', orderBy })
  const apiKey = await getGoogleBooksApiKey()
  if (apiKey) params.set('key', apiKey)
  try {
    const response = await safeFetch(`https://www.googleapis.com/books/v1/volumes?${params.toString()}`, {}, { timeoutMs: 10_000 })
    if (!response.ok) return []
    const data = await response.json() as { items?: GoogleVolume[] }
    return (data.items ?? []).flatMap((item) => {
      const result = toResult(item, contentType)
      return result ? [result] : []
    }).slice(0, 12)
  } catch { return [] }
}

export function searchGoogleBooks(query: string, contentType: BookContentType = 'book'): Promise<BookSearchResult[]> {
  return queryGoogleBooks(query, contentType, 'relevance')
}

export function browseGoogleBooks(type: Exclude<BookContentType, 'book'>): Promise<BookSearchResult[]> {
  return queryGoogleBooks(SECTION_QUERY[type], type, 'newest')
}

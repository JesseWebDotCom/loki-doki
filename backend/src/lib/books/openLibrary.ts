import { safeFetch } from '@/lib/ssrfGuard'
import type { BookContentType, BookSearchResult } from './types'

interface OpenLibraryDoc {
  key?: string; title?: string; author_name?: string[]; cover_i?: number
  first_publish_year?: number; publish_date?: string[]; first_sentence?: string | string[]
  subject?: string[]; ebook_access?: string; ia?: string[]; number_of_pages_median?: number
}

const SECTION_SUBJECT: Record<Exclude<BookContentType, 'book'>, string> = {
  magazine: 'magazines',
  comic: 'graphic novels', manga: 'manga', coloring_book: 'coloring books', children: 'juvenile fiction',
}

function matchesType(doc: OpenLibraryDoc, contentType: BookContentType): boolean {
  if (contentType === 'book') return true
  const text = `${doc.title ?? ''} ${(doc.subject ?? []).join(' ')}`
  if (contentType === 'magazine') return /magazine|magazines|periodical|journal/i.test(text)
  if (contentType === 'comic') return /comic book|graphic novel/i.test(text)
  if (contentType === 'manga') return /manga/i.test(text)
  if (contentType === 'coloring_book') return /colou?ring book/i.test(text)
  return /juvenile|children|middle grade|young readers/i.test(text)
}

function firstSentence(value: string | string[] | undefined): string | null {
  if (!value) return null
  return (Array.isArray(value) ? value[0] : value)?.slice(0, 700) ?? null
}

function toResult(doc: OpenLibraryDoc, contentType: BookContentType): BookSearchResult | null {
  if (!doc.key || !doc.title) return null
  const previewId = doc.ia?.[0]
  if (!previewId) return null
  return {
    source: 'openlibrary', sourceRef: doc.key, title: doc.title,
    author: doc.author_name?.join(', ') ?? null, language: null,
    coverUrl: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : null,
    description: firstSentence(doc.first_sentence), subjects: doc.subject?.slice(0, 4),
    mediaType: 'ebook', formats: ['Preview'], sizeBytes: null,
    contentType, previewId, previewAvailable: Boolean(previewId),
    pageCount: doc.number_of_pages_median ?? null, publishedYear: doc.first_publish_year ?? null,
    publishedDate: doc.publish_date?.[0] ?? null,
    externalUrl: `https://openlibrary.org${doc.key}`,
  }
}

async function queryOpenLibrary(params: URLSearchParams, contentType: BookContentType): Promise<BookSearchResult[]> {
  params.set('limit', '30')
  params.set('fields', 'key,title,author_name,cover_i,first_publish_year,publish_date,first_sentence,subject,ebook_access,ia,number_of_pages_median')
  try {
    const response = await safeFetch(`https://openlibrary.org/search.json?${params.toString()}`, {}, { timeoutMs: 10_000 })
    if (!response.ok) return []
    const data = await response.json() as { docs?: OpenLibraryDoc[] }
    return (data.docs ?? []).filter((doc) => matchesType(doc, contentType)).flatMap((doc) => {
      const result = toResult(doc, contentType)
      return result ? [result] : []
    }).sort((a, b) => Number(Boolean(b.coverUrl)) - Number(Boolean(a.coverUrl)))
  } catch { return [] }
}

export function searchOpenLibrary(query: string, contentType: BookContentType = 'book'): Promise<BookSearchResult[]> {
  return queryOpenLibrary(new URLSearchParams({ q: query }), contentType)
}

export function browseOpenLibrary(type: Exclude<BookContentType, 'book'>): Promise<BookSearchResult[]> {
  return queryOpenLibrary(new URLSearchParams({ subject: SECTION_SUBJECT[type], sort: 'new' }), type)
}

// Project Gutenberg, via the free public Gutendex JSON API (gutendex.com) — no key,
// no scraping. Verified live: `formats` maps MIME types straight to download URLs,
// so resolveDownload needs no second request. Also verified live: Gutendex returns
// genuinely useful catalog data beyond title/author — `summaries` (real AI-generated
// blurbs), `bookshelves` (curated genre groupings like "Category: Classics of
// Literature", "Horror", "Mystery Fiction"), and `download_count` (a real popularity
// signal, used as the "length"/prominence stand-in since Gutendex has no page count).
// `topic=` on the list endpoint substring-matches subjects+bookshelves, which is
// what powers the Book Store's genre shelves.

import { safeFetch } from '@/lib/ssrfGuard'
import { createTtlCache } from '@/lib/ttlCache'
import type { BookSearchResult, ResolvedDownload } from './types'
import { GUTENBERG_CATEGORIES, type GutenbergCategory } from './types'

interface GutendexBook {
  id: number
  title: string
  authors: { name: string }[]
  languages: string[]
  formats: Record<string, string>
  summaries?: string[]
  bookshelves?: string[]
  download_count?: number
}

function cleanBookshelf(s: string): string {
  return s.replace(/^Category:\s*/i, '')
}

function toResult(b: GutendexBook): BookSearchResult {
  return {
    source: 'gutenberg' as const,
    sourceRef: String(b.id),
    title: b.title,
    author: b.authors[0]?.name ?? null,
    language: b.languages[0] ?? null,
    coverUrl: b.formats['image/jpeg'] ?? null,
    description: b.summaries?.[0]?.replace(/\s*\(This is an automatically generated summary\.\)\s*$/i, '') ?? null,
    subjects: [...new Set((b.bookshelves ?? []).map(cleanBookshelf))].slice(0, 4),
    downloadCount: b.download_count ?? null,
  }
}

export async function searchGutenberg(query: string): Promise<BookSearchResult[]> {
  try {
    const res = await safeFetch(`https://gutendex.com/books/?search=${encodeURIComponent(query)}`, {}, { timeoutMs: 10_000 })
    if (!res.ok) return []
    const data = (await res.json()) as { results: GutendexBook[] }
    return data.results
      .filter((b) => Object.keys(b.formats).some((f) => f.includes('epub')))
      .slice(0, 20)
      .map(toResult)
  } catch {
    return []
  }
}

// Book Store landing shelves are the hottest path in the app (every visit re-renders
// all 10 genre rows) and Gutendex has no reason to change minute-to-minute, so cache
// each topic's result for a while — the first visit after boot/expiry pays the live
// fetch, everything after is instant.
const CATEGORY_TTL_MS = 30 * 60 * 1000
const categoryCache = createTtlCache<BookSearchResult[]>(CATEGORY_TTL_MS)

/** Genre-shelf browse for the Book Store landing page — sorted by popularity so
 *  each shelf leads with recognizable titles. Cached per topic (see CATEGORY_TTL_MS). */
export async function browseGutenbergByTopic(topic: string, limit = 12): Promise<BookSearchResult[]> {
  return categoryCache.getOrCompute(topic, async () => {
    try {
      const res = await safeFetch(`https://gutendex.com/books/?topic=${encodeURIComponent(topic)}&sort=popular`, {}, { timeoutMs: 10_000 })
      if (!res.ok) return []
      const data = (await res.json()) as { results: GutendexBook[] }
      return data.results
        .filter((b) => Object.keys(b.formats).some((f) => f.includes('epub')))
        .slice(0, limit)
        .map(toResult)
    } catch {
      return []
    }
  })
}

/** All curated shelves in one round trip (fetched in parallel server-side) — what
 *  the Book Store landing page actually calls, instead of 10 separate requests. */
export async function browseAllGutenbergCategories(): Promise<{ category: GutenbergCategory; results: BookSearchResult[] }[]> {
  return Promise.all(
    GUTENBERG_CATEGORIES.map(async (category) => ({ category, results: await browseGutenbergByTopic(category.topic) })),
  )
}

/** The "view all" page behind a shelf's title: follows Gutendex's own pagination
 *  (`next` links) for a few pages instead of the shelf preview's single page, so a
 *  category page shows ~90 books instead of 12. Cached under a distinct key from
 *  the shelf preview since it's a different result set. */
export async function browseGutenbergByTopicFull(topic: string, maxPages = 3): Promise<BookSearchResult[]> {
  return categoryCache.getOrCompute(`${topic}::full`, async () => {
    const out: BookSearchResult[] = []
    let url: string | null = `https://gutendex.com/books/?topic=${encodeURIComponent(topic)}&sort=popular`
    for (let page = 0; page < maxPages && url; page++) {
      try {
        const res = await safeFetch(url, {}, { timeoutMs: 10_000 })
        if (!res.ok) break
        const data = (await res.json()) as { results: GutendexBook[]; next: string | null }
        out.push(...data.results.filter((b) => Object.keys(b.formats).some((f) => f.includes('epub'))).map(toResult))
        url = data.next
      } catch {
        break
      }
    }
    return out
  })
}

export async function resolveGutenbergDownload(sourceRef: string): Promise<ResolvedDownload> {
  const res = await safeFetch(`https://gutendex.com/books/${sourceRef}`, {}, { timeoutMs: 10_000 })
  if (!res.ok) throw new Error(`Gutenberg lookup failed (${res.status})`)
  const book = (await res.json()) as { formats: Record<string, string> }
  // Prefer the "images" epub3 variant (has a cover/illustrations); fall back to any epub entry.
  const url = book.formats['application/epub+zip']
    ?? Object.entries(book.formats).find(([mime]) => mime.includes('epub'))?.[1]
  if (!url) throw new Error('No EPUB format available for this book')
  return { url, format: 'epub' }
}

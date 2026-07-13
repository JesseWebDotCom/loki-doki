// Fans a Discover-tab query out to every enabled legitimate source in parallel.
// Standard Ebooks is deliberately NOT included: their OPDS catalog requires an
// authenticated account (verified live — even the public "new releases" feed
// 401s), so there's no keyless way to search it. A user who has their own
// Standard Ebooks (or any other OPDS) access can point a self-hosted indexer at
// it instead (Admin > Integrations > Books).

import { searchGutenberg } from './gutenberg'
import { searchArchiveOrg } from './archiveOrg'
import { searchIndexer } from './indexer'
import { getBuiltinSourceToggles } from './sourceToggles'
import type { BookSearchResult } from './types'
import { searchLibrivox, type LibrivoxSearchResult } from './librivox'
import { searchWebBooks, type WebBookSearchResult } from './web'
import { searchWikisource } from './wikisource'
import { enrichCatalogMetadata } from './metadata'
import { browseArchiveVisualBooks } from './archiveOrg'
import type { BookContentType } from './types'
import { searchGoogleBooks } from './googleBooks'
import { searchOpenLibrary } from './openLibrary'
import { createTtlCache } from '@/lib/ttlCache'

// Search results are the hot path (every submitted query pays the full remote
// fan-out) but the corpus doesn't change minute-to-minute, so memoize per
// normalized query for a short window. The first query after boot/expiry pays
// the live fetch; repeats (pagination, back-navigation, two users searching the
// same title) are instant.
const SEARCH_TTL_MS = 60 * 1000
const booksCache = createTtlCache<BookSearchResult[]>(SEARCH_TTL_MS)
const catalogCache = createTtlCache<BookCatalogSearch>(SEARCH_TTL_MS)
const normalizeKey = (q: string) => q.trim().toLowerCase().replace(/\s+/g, ' ')

// Open Library enrichment only fills sparse fields, so it must never dominate
// latency — cap it and fall back to the un-enriched results if it's slow.
const ENRICH_CAP_MS = 2500
function withCap<T>(promise: Promise<T>, fallback: T, capMs: number): Promise<T> {
  return Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), capMs))])
}

function visualTypeForQuery(query: string): Exclude<BookContentType, 'book'> | null {
  if (/\b(magazine|magazines|periodical|periodicals|journal|journals)\b/i.test(query)) return 'magazine'
  if (/\b(manga)\b/i.test(query)) return 'manga'
  if (/\b(comic|graphic novel)\b/i.test(query)) return 'comic'
  if (/\b(coloring|colouring)\b/i.test(query)) return 'coloring_book'
  if (/\b(children|childrens|kids|juvenile)\b/i.test(query)) return 'children'
  return null
}

function blendResults<T extends { source: string; sourceRef: string }>(groups: T[][], limit = 30): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  const maxLen = Math.max(0, ...groups.map((group) => group.length))

  for (let idx = 0; idx < maxLen && out.length < limit; idx++) {
    for (const group of groups) {
      const item = group[idx]
      if (!item) continue
      const key = `${item.source}:${item.sourceRef}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(item)
      if (out.length >= limit) return out
    }
  }

  return out
}

export async function searchBooks(query: string): Promise<BookSearchResult[]> {
  const q = query.trim()
  if (!q) return []
  return booksCache.getOrCompute(normalizeKey(q), () => searchBooksUncached(q))
}

async function searchBooksUncached(q: string): Promise<BookSearchResult[]> {
  const toggles = await getBuiltinSourceToggles()
  const [gutenberg, archiveOrg, wikisource, googleBooks, openLibrary, indexer] = await Promise.all([
    toggles.gutenberg ? searchGutenberg(q).catch(() => []) : Promise.resolve([]),
    toggles.archiveorg ? searchArchiveOrg(q).catch(() => []) : Promise.resolve([]),
    toggles.wikisource ? searchWikisource(q).catch(() => []) : Promise.resolve([]),
    toggles.googlebooks ? searchGoogleBooks(q).catch(() => []) : Promise.resolve([]),
    toggles.openlibrary ? searchOpenLibrary(q).catch(() => []) : Promise.resolve([]),
    searchIndexer(q).catch(() => []), // custom indexers have their own per-row enabled flag
  ])
  // Preview-first modern metadata (Google/Open Library) interleaves with
  // directly downloadable public-domain/open-license sources.
  return blendResults([googleBooks, openLibrary, gutenberg, archiveOrg, wikisource, indexer], 30)
}

export interface BookCatalogSearch {
  ebooks: BookSearchResult[]
  audiobooks: LibrivoxSearchResult[]
  web: WebBookSearchResult[]
}

export async function searchBookCatalog(query: string): Promise<BookCatalogSearch> {
  const q = query.trim()
  if (!q) return { ebooks: [], audiobooks: [], web: [] }
  return catalogCache.getOrCompute(normalizeKey(q), () => searchBookCatalogUncached(q))
}

async function searchBookCatalogUncached(q: string): Promise<BookCatalogSearch> {
  const toggles = await getBuiltinSourceToggles()
  const visualType = visualTypeForQuery(q)
  const [ebooks, visualBooks, audiobooks, web] = await Promise.all([
    searchBooks(q),
    visualType
      ? Promise.all([
          toggles.googlebooks ? searchGoogleBooks(q, visualType).catch(() => []) : Promise.resolve([]),
          toggles.openlibrary ? searchOpenLibrary(q, visualType).catch(() => []) : Promise.resolve([]),
          toggles.archiveorg
            ? browseArchiveVisualBooks(visualType, 12, q.replace(/\b(manga|comic|graphic novel|coloring|colouring|children|childrens|kids|juvenile)\b/gi, '').trim())
                .catch(() => [])
            : Promise.resolve([]),
        ]).then(([google, openLibrary, archive]) => blendResults([google, openLibrary, archive], 30))
      : Promise.resolve([]),
    toggles.librivox ? searchLibrivox(q).catch(() => []) : Promise.resolve([]),
    toggles.web ? searchWebBooks(q).catch(() => []) : Promise.resolve([]),
  ])
  const uniqueEbooks = [...new Map([...visualBooks, ...ebooks].map((item) => [`${item.source}:${item.sourceRef}`, item])).values()]
  // Best-effort: enrich if Open Library answers within the cap, else return base.
  const [enrichedEbooks, enrichedAudiobooks] = await Promise.all([
    withCap(enrichCatalogMetadata(q, uniqueEbooks), uniqueEbooks, ENRICH_CAP_MS),
    withCap(enrichCatalogMetadata(q, audiobooks), audiobooks, ENRICH_CAP_MS),
  ])
  return { ebooks: enrichedEbooks, audiobooks: enrichedAudiobooks, web }
}

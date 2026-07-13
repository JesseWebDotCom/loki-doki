// Internet Archive text search, restricted to items explicitly eligible for direct download.
//
// IMPORTANT (verified live against the real API before writing this): IA's search
// `format:EPUB` field is NOT a signal that a file is freely downloadable — most
// EPUB-tagged text items are lending-library books (`access-restricted-item: true`)
// whose "epub"/"pdf" files are actually DRM-wrapped (`_encrypted.pdf`, `_lcp.epub`)
// and will not open. The only reliable signal is a genuine `licenseurl` and the
// item not being access-restricted, both checked here and re-checked at
// download-resolve time.

import { safeFetch } from '@/lib/ssrfGuard'
import type { BookContentType, BookSearchResult, DownloadableBookFormat, ResolvedDownload } from './types'
import { createTtlCache } from '@/lib/ttlCache'
import { isIaLicenseCheckEnabled } from './sourceToggles'

interface IaSearchDoc {
  identifier: string
  title: string
  creator?: string | string[]
  language?: string | string[]
  licenseurl?: string
  'access-restricted-item'?: string | boolean
  description?: string | string[]
  subject?: string | string[]
  format?: string | string[]
  item_size?: number
  date?: string | string[]
}

const SUPPORTED_FORMATS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /epub/i, label: 'EPUB' },
  { pattern: /pdf/i, label: 'PDF' },
  { pattern: /comic book zip|\bcbz\b/i, label: 'CBZ' },
]

function supportedFormats(v: string | string[] | undefined): string[] {
  const values = Array.isArray(v) ? v : v ? [v] : []
  return SUPPORTED_FORMATS.filter(({ pattern }) => values.some((value) => pattern.test(value))).map(({ label }) => label)
}

function firstOf(v: string | string[] | undefined): string | null {
  if (!v) return null
  return Array.isArray(v) ? v[0] ?? null : v
}

// IA descriptions are free-text metadata some uploaders write with raw HTML.
function stripDescriptionHtml(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v.join(' ') : v
  if (!s) return null
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600) || null
}

function subjectsOf(v: string | string[] | undefined): string[] {
  if (!v) return []
  const list = Array.isArray(v) ? v : v.split(/[;,]/)
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))].slice(0, 4)
}

// IA's `date` is the item's publication date ("1994-05-01T00:00:00Z" or just a
// year), most useful for periodicals where the issue date matters.
function publishedOf(v: string | string[] | undefined): { publishedDate: string | null; publishedYear: number | null } {
  const raw = firstOf(v)
  if (!raw) return { publishedDate: null, publishedYear: null }
  const date = raw.slice(0, 10)
  const year = Number(date.slice(0, 4))
  return { publishedDate: date, publishedYear: Number.isFinite(year) && year > 0 ? year : null }
}

function generalFormat(formats: string[]): DownloadableBookFormat {
  if (formats.includes('EPUB')) return 'epub'
  if (formats.includes('PDF')) return 'pdf'
  return 'cbz'
}

export async function searchArchiveOrg(query: string, page = 1): Promise<BookSearchResult[]> {
  const q = `${query} AND mediatype:(texts) AND (format:(EPUB) OR format:(PDF) OR format:(CBZ)) AND NOT access-restricted-item:(true)`
  const params = new URLSearchParams({
    q, rows: '30', page: String(page), output: 'json', sort: 'date desc',
  })
  params.append('fl[]', 'identifier')
  params.append('fl[]', 'title')
  params.append('fl[]', 'creator')
  params.append('fl[]', 'language')
  params.append('fl[]', 'licenseurl')
  params.append('fl[]', 'access-restricted-item')
  params.append('fl[]', 'description')
  params.append('fl[]', 'subject')
  params.append('fl[]', 'format')
  params.append('fl[]', 'item_size')
  params.append('fl[]', 'date')

  try {
    const res = await safeFetch(`https://archive.org/advancedsearch.php?${params.toString()}`, {}, { timeoutMs: 10_000 })
    if (!res.ok) return []
    const data = (await res.json()) as { response?: { docs?: IaSearchDoc[] } }
    return (data.response?.docs ?? []).flatMap((d) => {
      const restricted = d['access-restricted-item']
      if (restricted === true || restricted === 'true') return []
      const formats = supportedFormats(d.format)
      if (!formats.length) return []
      const titleAndSubjects = `${d.title ?? ''} ${subjectsOf(d.subject).join(' ')}`
      const contentType = /magazine|periodical|journal/i.test(titleAndSubjects)
        ? 'magazine'
        : /comic|graphic novel/i.test(titleAndSubjects)
          ? 'comic'
          : /manga/i.test(titleAndSubjects)
            ? 'manga'
            : /colouring|coloring/i.test(titleAndSubjects)
              ? 'coloring_book'
              : /juvenile|children|kids|childrens/i.test(titleAndSubjects)
                ? 'children'
                : 'book'
      return [{
      source: 'archiveorg' as const,
      sourceRef: d.identifier,
      title: d.title,
      author: firstOf(d.creator),
      language: firstOf(d.language),
      coverUrl: `https://archive.org/services/img/${d.identifier}`,
      description: stripDescriptionHtml(d.description),
      subjects: subjectsOf(d.subject),
      mediaType: 'ebook' as const,
      formats,
      sizeBytes: typeof d.item_size === 'number' ? d.item_size : null,
      ...publishedOf(d.date),
      contentType,
      downloadFormat: generalFormat(formats),
      }]
    })
  } catch {
    return []
  }
}

interface IaFile { name: string; format?: string }
interface IaMetadata { metadata?: { 'access-restricted-item'?: string | boolean; licenseurl?: string }; files?: IaFile[] }

const RESTRICTED_MARKERS = ['_encrypted.', '_lcp.', 'daisy_encrypted']

const EXTENSION: Record<DownloadableBookFormat, string> = { epub: '.epub', pdf: '.pdf', cbz: '.cbz' }

export async function resolveArchiveOrgDownload(identifier: string, requestedFormat: DownloadableBookFormat = 'epub'): Promise<ResolvedDownload> {
  const res = await safeFetch(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, {}, { timeoutMs: 10_000 })
  if (!res.ok) throw new Error(`Internet Archive lookup failed (${res.status})`)
  const meta = (await res.json()) as IaMetadata

  const restricted = meta.metadata?.['access-restricted-item']
  if (restricted === true || restricted === 'true') throw new Error('This item is lending-restricted, not freely downloadable')
  if (await isIaLicenseCheckEnabled() && !meta.metadata?.licenseurl?.includes('publicdomain')) {
    throw new Error('This item is not eligible for direct download')
  }

  const extension = EXTENSION[requestedFormat]
  const file = (meta.files ?? []).find((f) =>
    f.name.toLowerCase().endsWith(extension) && !RESTRICTED_MARKERS.some((m) => f.name.toLowerCase().includes(m)))
  if (!file) throw new Error(`No freely-downloadable ${requestedFormat.toUpperCase()} file found for this item`)

  return { url: `https://archive.org/download/${identifier}/${encodeURIComponent(file.name)}`, format: requestedFormat }
}

export interface VisualBookSection { key: BookContentType; label: string }
export const VISUAL_BOOK_SECTIONS: VisualBookSection[] = [
  { key: 'magazine', label: 'Magazines' },
  { key: 'comic', label: 'Comics' },
  { key: 'manga', label: 'Manga' },
  { key: 'coloring_book', label: 'Coloring Books' },
  { key: 'children', label: "Children's Books" },
]

// Comic/manga lean on IA's curated subject facet: a bare keyword query matches
// "comic" mentions in computer-magazine descriptions and returns almost no actual
// comics (verified live — keyword-only pulled Compute!'s Gazette et al., the
// subject-faceted variant pulls real comics).
const VISUAL_QUERY: Record<Exclude<BookContentType, 'book'>, string> = {
  magazine: '(magazine OR magazines OR periodical OR periodicals OR journal OR journals)',
  comic: '("comic book" OR "graphic novel" OR comics) AND subject:(comics)',
  manga: 'manga AND subject:(manga)',
  coloring_book: '("coloring book" OR coloring) AND subject:("coloring books" OR coloring)',
  children: 'subject:("juvenile fiction" OR "juvenile literature" OR "children\'s books")',
}

// Sort choice matters as much as the query. Publication-date sort drowns comics in
// AI-generated spam uploads stamped with recent/future dates; upload-date surfaces
// real recently-added books (verified live). Popularity sort is NOT safe here — it
// ranks adult comics at the very top. Magazines keep publication date so current
// issues lead.
const VISUAL_SORT: Record<Exclude<BookContentType, 'book'>, string> = {
  magazine: 'date desc',
  comic: 'addeddate desc',
  manga: 'addeddate desc',
  coloring_book: 'addeddate desc',
  children: 'addeddate desc',
}

function bestFormat(type: Exclude<BookContentType, 'book'>, formats: string[]): DownloadableBookFormat | null {
  if (type === 'magazine') {
    if (formats.includes('PDF')) return 'pdf'
    if (formats.includes('CBZ')) return 'cbz'
    if (formats.includes('EPUB')) return 'epub'
    return null
  }
  if ((type === 'comic' || type === 'manga') && formats.includes('CBZ')) return 'cbz'
  if (formats.includes('PDF')) return 'pdf'
  if (formats.includes('EPUB')) return 'epub'
  return null
}

// Cache the landing-page browse (no titleQuery) — the search-scoped variant
// (titleQuery set, called from search.ts) is already covered by the query cache
// there, so it stays a live pass-through.
const BROWSE_TTL_MS = 30 * 60 * 1000
const browseCache = createTtlCache<BookSearchResult[]>(BROWSE_TTL_MS)

export function browseArchiveVisualBooks(type: Exclude<BookContentType, 'book'>, limit = 12, titleQuery?: string, page = 1): Promise<BookSearchResult[]> {
  if (titleQuery) return browseArchiveVisualBooksUncached(type, limit, titleQuery, page)
  return browseCache.getOrCompute(`${type}:${limit}:${page}`, () => browseArchiveVisualBooksUncached(type, limit, undefined, page))
}

async function browseArchiveVisualBooksUncached(type: Exclude<BookContentType, 'book'>, limit = 12, titleQuery?: string, page = 1): Promise<BookSearchResult[]> {
  const params = new URLSearchParams({
    q: `${titleQuery ? `${titleQuery} AND ` : ''}${VISUAL_QUERY[type]} AND mediatype:(texts) AND NOT access-restricted-item:(true)`,
    rows: String(limit * 2), page: String(page), output: 'json', sort: VISUAL_SORT[type],
  })
  for (const field of ['identifier', 'title', 'creator', 'language', 'description', 'subject', 'format', 'item_size', 'date']) {
    params.append('fl[]', field)
  }
  try {
    const response = await safeFetch(`https://archive.org/advancedsearch.php?${params.toString()}`, {}, { timeoutMs: 10_000 })
    if (!response.ok) return []
    const data = await response.json() as { response?: { docs?: IaSearchDoc[] } }
    return (data.response?.docs ?? []).flatMap((doc) => {
      const restricted = doc['access-restricted-item']
      if (restricted === true || restricted === 'true') return []
      const language = firstOf(doc.language)
      if (type === 'manga' && language && !/^(jpn|ja|eng|en)$/i.test(language)) return []
      const formats = supportedFormats(doc.format)
      const downloadFormat = bestFormat(type, formats)
      if (!downloadFormat) return []
      return [{
        source: 'archiveorg' as const, sourceRef: doc.identifier, title: doc.title,
        author: firstOf(doc.creator), language,
        coverUrl: `https://archive.org/services/img/${doc.identifier}`,
        description: stripDescriptionHtml(doc.description), subjects: subjectsOf(doc.subject),
        mediaType: 'ebook' as const, formats, sizeBytes: typeof doc.item_size === 'number' ? doc.item_size : null,
        ...publishedOf(doc.date),
        contentType: type, downloadFormat,
      }]
    }).slice(0, limit)
  } catch {
    return []
  }
}

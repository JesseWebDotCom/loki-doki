import { webSearch } from '@/lib/webSearch'

export interface WebBookSearchResult {
  source: 'web'
  sourceRef: string
  title: string
  author: null
  language: null
  coverUrl: null
  description: string | null
  mediaType: 'ebook' | 'audiobook'
  formats: string[]
  sizeBytes: number | null
  externalUrl: string
  siteName: string
}

const EBOOK_FORMATS = ['EPUB', 'PDF'] as const
const AUDIO_FORMATS = ['MP3', 'M4B', 'M4A', 'AAC'] as const
const TRUSTED_PUBLIC_BOOK_HOSTS = [
  'gutenberg.org',
  'standardebooks.org',
  'librivox.org',
  'archive.org',
  'openlibrary.org',
  'globalgreyebooks.com',
]

function hostname(rawUrl: string): string | null {
  try { return new URL(rawUrl).hostname.replace(/^www\./, '').toLowerCase() } catch { return null }
}

function formatsIn(text: string, formats: readonly string[]): string[] {
  return formats.filter((format) => new RegExp(`(?:\\.|\\b)${format}\\b`, 'i').test(text))
}

function isTrusted(host: string): boolean {
  return TRUSTED_PUBLIC_BOOK_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
}

/** Discover book pages through the app's normal web-search stack.
 * Results stay as external discovery links because a search snippet cannot prove
 * that an arbitrary file is licensed for local ingestion. */
export async function searchWebBooks(query: string): Promise<WebBookSearchResult[]> {
  const [ebooks, audiobooks] = await Promise.all([
    webSearch(`${query} ebook EPUB PDF download`, 10, 7_000),
    webSearch(`${query} audiobook MP3 M4B listen download`, 10, 7_000),
  ])

  const out: WebBookSearchResult[] = []
  const seen = new Set<string>()
  for (const [mediaType, rows, allowedFormats] of [
    ['ebook', ebooks, EBOOK_FORMATS],
    ['audiobook', audiobooks, AUDIO_FORMATS],
  ] as const) {
    for (const row of rows) {
      const host = hostname(row.url)
      if (!host || !isTrusted(host) || seen.has(row.url)) continue
      const formats = formatsIn(`${row.url} ${row.title} ${row.snippet}`, allowedFormats)
      if (!formats.length) continue
      seen.add(row.url)
      out.push({
        source: 'web', sourceRef: row.url, title: row.title, author: null, language: null,
        coverUrl: null, description: row.snippet || null, mediaType, formats,
        sizeBytes: null, externalUrl: row.url, siteName: host,
      })
    }
  }
  return out.slice(0, 12)
}

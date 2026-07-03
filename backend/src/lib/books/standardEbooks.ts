// Standard Ebooks: free, public-domain, meticulously typeset ebooks. Their full
// catalog OPDS feed (/opds/all) now requires an account/API key (confirmed by a
// live 401), so this only integrates their public "New Releases" Atom feed (the
// latest 15 titles, no auth needed) as a browse-only shelf, not a searchable
// catalog like Gutenberg/Archive.org. It uses rel="enclosure" links rather than
// OPDS's rel="...acquisition" convention, so it can't reuse opds.ts's parser
// wholesale, but reuses its low-level tag-walk helpers.
//
// This does NOT satisfy "modern books": a "new release" here means a public
// domain work that Standard Ebooks just finished re-transcribing/formatting, not
// a recently-published contemporary title. Their catalog is the same legal
// category as Gutenberg/Archive.org, just a different (higher-production-value)
// curation of it.

import { safeFetch } from '@/lib/ssrfGuard'
import { createTtlCache } from '@/lib/ttlCache'
import { findTags, attr, textOf, resolveUrl } from './opds'
import type { BookSearchResult } from './types'

const FEED_URL = 'https://standardebooks.org/feeds/atom/new-releases'
const NEW_RELEASES_TTL_MS = 60 * 60 * 1000
const cache = createTtlCache<BookSearchResult[]>(NEW_RELEASES_TTL_MS)

function parseNewReleases(xml: string, feedUrl: string): BookSearchResult[] {
  const results: BookSearchResult[] = []

  for (const entryBlock of findTags(xml, 'entry')) {
    const title = textOf(entryBlock, 'title')
    if (!title) continue

    const authorBlock = entryBlock.match(/<author[^>]*>([\s\S]*?)<\/author>/i)?.[1] ?? ''
    const author = textOf(authorBlock, 'name')
    const description = textOf(entryBlock, 'summary')

    // Prefer the "Recommended compatible epub" enclosure over the "Advanced"/kepub/azw3
    // variants also listed: first non-advanced .epub wins.
    let epubHref: string | null = null
    for (const link of findTags(entryBlock, 'link')) {
      const rel = (attr(link, 'rel') ?? '').toLowerCase()
      const type = (attr(link, 'type') ?? '').toLowerCase()
      const href = attr(link, 'href')
      if (!href || rel !== 'enclosure' || type !== 'application/epub+zip') continue
      if (!epubHref || !href.includes('_advanced')) { epubHref = href; if (!href.includes('_advanced')) break }
    }
    if (!epubHref) continue

    results.push({
      source: 'standardebooks',
      sourceRef: resolveUrl(epubHref, feedUrl),
      title,
      author,
      description,
      language: 'en',
      coverUrl: null,
    })
  }

  return results
}

/** The latest ~15 Standard Ebooks releases, cached for an hour. Browse-only:
 *  there's no public search endpoint (the full catalog feed requires auth). */
export async function getStandardEbooksNewReleases(): Promise<BookSearchResult[]> {
  return cache.getOrCompute('new-releases', async () => {
    const res = await safeFetch(FEED_URL, {}, { timeoutMs: 10_000 })
    if (!res.ok) return []
    return parseNewReleases(await res.text(), res.url)
  })
}

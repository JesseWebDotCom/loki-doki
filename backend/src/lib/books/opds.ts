// Generic OPDS (Atom-based) catalog feed parser — hand-rolled regex/tag-walk like
// backend/src/lib/epub/parse.ts's OPF parser, not a full XML-DOM dependency.
// Covers any self-hosted OPDS server (Calibre-Web, Kavita, COPS, etc.) since OPDS
// is a standard format, not source-specific like Gutenberg/Archive.org's own APIs.
//
// KNOWN LIMITATION (found by live-testing against a real OPDS server —
// gutenberg.org's own OPDS catalog): this parser only understands a SINGLE-LEVEL
// acquisition feed, i.e. one where each <entry> carries its own
// rel="http://opds-spec.org/acquisition" download link directly (confirmed
// working against gutenberg.org/ebooks/84.opds, a real per-book feed). Some OPDS
// catalogs (including Gutenberg's own *search* feed, as opposed to its per-book
// feed) return a NAVIGATION feed instead — entries link via rel="subsection" to a
// further feed that contains the real acquisition entry, one extra HTTP hop away.
// This parser deliberately returns nothing for such entries rather than guessing;
// Calibre-Web/Kavita/COPS-style personal library servers (the actual target of
// the self-hosted-indexer feature) return direct acquisition links in their
// search results, so this covers the intended use case. Gutenberg itself doesn't
// need this path — it already has a dedicated integration (gutenberg.ts).

import { stripHtml } from '@/lib/htmlText'
import type { BookSearchResult } from './types'

// Exported for other hand-rolled Atom/OPDS-shaped parsers (e.g. standardEbooks.ts's
// new-releases feed, which uses rel="enclosure" links instead of this module's
// rel="...acquisition" convention) so the regex/tag-walk logic isn't duplicated.
export function findTags(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>|<${tag}\\b[^>]*/>`, 'gi')
  return xml.match(re) ?? []
}

export function attr(tag: string, name: string): string | null {
  return tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'))?.[1] ?? null
}

export function textOf(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return m ? stripHtml(m[1]!).trim() || null : null
}

export function resolveUrl(href: string, baseUrl: string): string {
  try { return new URL(href, baseUrl).toString() } catch { return href }
}

/** Parse an OPDS acquisition feed into search results. `feedUrl` resolves any
 *  relative `href`s in the feed (common for self-hosted servers). Only entries
 *  with a usable EPUB acquisition link are returned — OPDS feeds routinely mix in
 *  PDF/MOBI/etc. formats this app doesn't ingest yet. */
export function parseOpdsFeed(xml: string, feedUrl: string): BookSearchResult[] {
  const results: BookSearchResult[] = []

  for (const entryBlock of findTags(xml, 'entry')) {
    const title = textOf(entryBlock, 'title')
    if (!title) continue

    const authorBlock = entryBlock.match(/<author[^>]*>([\s\S]*?)<\/author>/i)?.[1] ?? ''
    const author = textOf(authorBlock, 'name')
    const language = textOf(entryBlock, 'dc:language') ?? textOf(entryBlock, 'dcterms:language')

    let acquisitionHref: string | null = null
    let acquisitionIsEpub = false
    let coverHref: string | null = null

    for (const link of findTags(entryBlock, 'link')) {
      const rel = (attr(link, 'rel') ?? '').toLowerCase()
      const type = (attr(link, 'type') ?? '').toLowerCase()
      const href = attr(link, 'href')
      if (!href) continue

      if (rel.includes('acquisition')) {
        const isEpub = type.includes('epub')
        if (!acquisitionHref || (isEpub && !acquisitionIsEpub)) {
          acquisitionHref = href
          acquisitionIsEpub = isEpub
        }
      } else if (!coverHref && (rel.includes('image') || rel.includes('cover') || rel.includes('thumbnail'))) {
        coverHref = href
      }
    }

    // Skip entries whose only acquisition link isn't an EPUB — nothing downstream
    // (upload/download/reader) understands other ebook formats from this source yet.
    if (!acquisitionHref || !acquisitionIsEpub) continue

    results.push({
      source: 'indexer',
      sourceRef: resolveUrl(acquisitionHref, feedUrl), // the direct download URL — resolved once, at search time
      title,
      author,
      language,
      coverUrl: coverHref ? resolveUrl(coverHref, feedUrl) : null,
    })
  }

  return results.slice(0, 30)
}

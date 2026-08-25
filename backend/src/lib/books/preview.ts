// Reading samples for the storefront "Preview" step. Internet Archive / Google
// Books / Open Library each embed their own reader, but Gutenberg and Standard
// Ebooks don't (Standard Ebooks even sends X-Frame-Options: sameorigin, so their
// online reader can't be iframed). Both publish a clean full-text HTML/XHTML page,
// so we fetch it server-side, strip boilerplate, and hand back the opening
// paragraphs as plain text the client renders same-origin — enough to judge a book
// before saving/downloading it.

import { safeFetch } from '@/lib/ssrfGuard'
import { stripTags } from '@/lib/htmlText'

export interface BookSample {
  paragraphs: string[]
  sourceUrl: string
  truncated: boolean
}

const MAX_SAMPLE_CHARS = 4500

function htmlToParagraphs(html: string): string[] {
  const withBreaks = html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    // Turn block-level closers into hard breaks so paragraph structure survives.
    .replace(/<\/(p|div|h[1-6]|li|blockquote|section|article)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
  return stripTags(withBreaks)
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

// Project Gutenberg wraps the text in a long license header/footer marked by
// "*** START OF THE PROJECT GUTENBERG EBOOK … ***" / "*** END OF …". Trim to the body.
function trimGutenbergBoilerplate(paragraphs: string[]): string[] {
  const start = paragraphs.findIndex((p) => /START OF (THE|THIS) PROJECT GUTENBERG/i.test(p))
  const body = start >= 0 ? paragraphs.slice(start + 1) : paragraphs
  const end = body.findIndex((p) => /END OF (THE|THIS) PROJECT GUTENBERG/i.test(p))
  return end >= 0 ? body.slice(0, end) : body
}

function sampleFrom(paragraphs: string[], sourceUrl: string): BookSample {
  const out: string[] = []
  let chars = 0
  for (const p of paragraphs) {
    if (chars >= MAX_SAMPLE_CHARS) break
    out.push(p)
    chars += p.length
  }
  return { paragraphs: out, sourceUrl, truncated: out.length < paragraphs.length }
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await safeFetch(url, { headers: { 'User-Agent': 'MaiPaiHome/3.0 books' } }, { timeoutMs: 12_000, maxRedirects: 5 })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

// Standard Ebooks epub URL → its full-text single-page URL:
//   …/ebooks/<author>/<title>[/<translator>]/downloads/<slug>.epub?…  →  …/text/single-page
function standardEbooksSinglePageUrl(epubUrl: string): string | null {
  const m = epubUrl.match(/^(https:\/\/standardebooks\.org\/ebooks\/[^?#]+?)\/downloads\//)
  return m ? `${m[1]}/text/single-page` : null
}

/** A short reading sample for a Gutenberg or Standard Ebooks title, or null if the
 *  source has no fetchable full-text page (callers already have IA/Google/OL embeds). */
export async function getBookSample(source: string, ref: string): Promise<BookSample | null> {
  if (source === 'gutenberg') {
    const id = ref.replace(/\D/g, '')
    if (!id) return null
    const html = (await fetchText(`https://www.gutenberg.org/cache/epub/${id}/pg${id}-images.html`))
      ?? (await fetchText(`https://www.gutenberg.org/cache/epub/${id}/pg${id}.html`))
    if (!html) return null
    const paras = trimGutenbergBoilerplate(htmlToParagraphs(html))
    return paras.length ? sampleFrom(paras, `https://www.gutenberg.org/ebooks/${id}`) : null
  }

  if (source === 'standardebooks') {
    const url = standardEbooksSinglePageUrl(ref)
    if (!url) return null
    const html = await fetchText(url)
    if (!html) return null
    // Skip the site nav + title page / ToC / imprint front matter: start at the
    // first bodymatter <section> (the SE single-page marks it via epub:type).
    const bodyStart = html.search(/<section[^>]*epub:type="[^"]*bodymatter/i)
    const paras = htmlToParagraphs(bodyStart >= 0 ? html.slice(bodyStart) : html)
    return paras.length ? sampleFrom(paras, url) : null
  }

  return null
}

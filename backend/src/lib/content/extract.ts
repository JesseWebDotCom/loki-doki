// Zero-dep article extractor shared by Feeds (full-text) and Reader (offline save).
//
// No headless browser / Readability dependency (matches the codebase's zero-dep style):
// fetch the page via the SSRF-guarded safeFetch, pull metadata (title/byline/site/lead image)
// from <head>, isolate the main article block heuristically, then run the HTML through a
// conservative allowlist sanitizer so the stored contentHtml is safe to render directly
// (dangerouslySetInnerHTML) without a client-side sanitizer.

import { safeFetch } from '@/lib/ssrfGuard'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

export interface ExtractedArticle {
  title: string | null
  byline: string | null
  siteName: string | null
  excerpt: string | null
  contentHtml: string | null // sanitized
  contentText: string | null // plaintext, for FTS / RAG / reading-time
  imageUrl: string | null // lead image (og:image)
  wordCount: number
  readingMins: number
}

// ── metadata helpers ────────────────────────────────────────────────────────

function metaContent(html: string, names: string[]): string | null {
  for (const name of names) {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)["']`,
      'i',
    )
    const m = html.match(re) ||
      html.match(
        new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${name}["']`, 'i'),
      )
    if (m && m[1]) return decodeEntities(m[1].trim())
  }
  return null
}

function docTitle(html: string): string | null {
  const og = metaContent(html, ['og:title', 'twitter:title'])
  if (og) return og
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return m ? decodeEntities(stripHtml(m[1] ?? '')).trim() || null : null
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
}

export function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

// ── main-content isolation (heuristic) ────────────────────────────────────────

// Tags whose entire block (open→close) is dropped before content selection.
const STRIP_BLOCKS =
  /<(script|style|noscript|svg|template|nav|header|footer|aside|form|figure\b[^>]*role=["']?banner|iframe|object|embed)[\s\S]*?<\/\1>/gi

function preClean(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|nav|header|footer|aside|form|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
}

// Pick the densest content block: prefer <article>, then <main>, then the
// <div>/<section> containing the most paragraph text, else all <p>/heading tags.
function selectContent(html: string): string {
  const cleaned = preClean(html)

  const article = matchLargest(cleaned, /<article\b[^>]*>([\s\S]*?)<\/article>/gi)
  if (article && textLen(article) > 200) return article

  const main = matchLargest(cleaned, /<main\b[^>]*>([\s\S]*?)<\/main>/gi)
  if (main && textLen(main) > 200) return main

  const block = matchLargest(cleaned, /<(?:div|section)\b[^>]*>([\s\S]*?)<\/(?:div|section)>/gi)
  if (block && textLen(block) > 400) return block

  // Fallback: concatenate paragraphs + headings + lists in document order.
  const parts = cleaned.match(/<(p|h[1-4]|ul|ol|blockquote|pre)\b[^>]*>[\s\S]*?<\/\1>/gi)
  return parts ? parts.join('\n') : cleaned
}

function matchLargest(html: string, re: RegExp): string | null {
  let best: string | null = null
  let bestLen = 0
  for (const m of html.matchAll(re)) {
    const inner = m[1] ?? ''
    const len = textLen(inner)
    if (len > bestLen) {
      bestLen = len
      best = inner
    }
  }
  return best
}

function textLen(html: string): number {
  return stripHtml(html).length
}

// ── sanitizer (allowlist) ─────────────────────────────────────────────────────

const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'mark', 'small',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'blockquote', 'pre', 'code', 'figure', 'figcaption',
  'a', 'img', 'span', 'div', 'section',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
])
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title']),
  img: new Set(['src', 'alt', 'title']),
}

function sanitizeHtml(html: string): string {
  // Drop disallowed element blocks wholesale first (defense-in-depth over preClean).
  let out = html.replace(STRIP_BLOCKS, '')

  out = out.replace(/<(\/?)([a-zA-Z0-9]+)((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (full, slash, tagRaw, attrs) => {
    const tag = tagRaw.toLowerCase()
    if (!ALLOWED_TAGS.has(tag)) return '' // strip tag, keep inner text
    if (slash) return `</${tag}>`
    const allowed = ALLOWED_ATTRS[tag]
    if (!allowed) return `<${tag}>`
    const kept: string[] = []
    for (const a of attrs.matchAll(/([a-zA-Z0-9:_-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      const name = a[1].toLowerCase()
      const value = a[3] ?? a[4] ?? ''
      if (!allowed.has(name)) continue
      if ((name === 'href' || name === 'src') && /^\s*(javascript|data|vbscript):/i.test(value)) continue
      kept.push(`${name}="${value.replace(/"/g, '&quot;')}"`)
    }
    return `<${tag}${kept.length ? ' ' + kept.join(' ') : ''}>`
  })

  // Collapse runs of empty block tags left after stripping.
  out = out.replace(/(<(p|div|span|section)>\s*<\/\2>\s*)+/gi, '')
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

// ── public API ────────────────────────────────────────────────────────────────

export async function extractArticle(url: string, timeoutMs = 8000): Promise<ExtractedArticle> {
  const res = await safeFetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } }, { timeoutMs })
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`)
  const html = await res.text()

  const title = docTitle(html)
  const byline = metaContent(html, ['author', 'article:author', 'og:author'])
  const siteName = metaContent(html, ['og:site_name'])
  let imageUrl = metaContent(html, ['og:image', 'og:image:url', 'twitter:image'])
  if (imageUrl) {
    try {
      imageUrl = new URL(imageUrl, url).toString()
    } catch {
      imageUrl = null
    }
  }

  const rawContent = selectContent(html)
  const contentHtml = sanitizeHtml(absolutizeUrls(rawContent, url)) || null
  const contentText = contentHtml ? stripHtml(contentHtml) : null
  const wordCount = contentText ? contentText.split(/\s+/).filter(Boolean).length : 0
  const excerpt =
    metaContent(html, ['og:description', 'description', 'twitter:description']) ||
    (contentText ? contentText.slice(0, 280) : null)

  return {
    title,
    byline,
    siteName,
    excerpt,
    contentHtml,
    contentText,
    imageUrl,
    wordCount,
    readingMins: Math.max(1, Math.round(wordCount / 200)),
  }
}

// Resolve relative href/src against the page URL so links/images work offline.
function absolutizeUrls(html: string, base: string): string {
  return html.replace(/(\b(?:href|src)=)("([^"]*)"|'([^']*)')/gi, (full, attr, _q, dq, sq) => {
    const v = dq ?? sq ?? ''
    if (!v || /^(https?:|data:|#|mailto:)/i.test(v)) return full
    try {
      return `${attr}"${new URL(v, base).toString()}"`
    } catch {
      return full
    }
  })
}

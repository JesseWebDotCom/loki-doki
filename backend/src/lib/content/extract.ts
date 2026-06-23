// Zero-dep article extractor shared by Feeds (full-text) and Reader (offline save).
//
// No headless browser / Readability dependency (matches the codebase's zero-dep style):
// fetch the page via the SSRF-guarded safeFetch, pull metadata (title/byline/site/lead image)
// from <head> + JSON-LD, isolate the main article block heuristically, drop boilerplate/UI
// chrome, then run the HTML through a conservative allowlist sanitizer so the stored
// contentHtml is safe to render directly (dangerouslySetInnerHTML) without a client-side
// sanitizer.
//
// `extractFromHtml` is the reusable core (the full-page snapshotter already has the HTML in
// hand and passes it in, along with a `localizeImage` hook so reader images point at the
// locally-archived copies). `extractArticle` is the fetch-then-extract convenience used by
// Feeds.

import { safeFetch } from '@/lib/ssrfGuard'
import { decodeEntities, stripHtml } from '@/lib/htmlText'

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

export interface ExtractOpts {
  // Map an absolute image URL to a locally-served URL (offline archive). Return null to
  // keep the original remote URL.
  localizeImage?: (absUrl: string) => string | null
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

// Pull author / publisher from JSON-LD (schema.org Article), which most CMS-driven sites
// emit even when they omit <meta name="author">.
function jsonLd(html: string): { author: string | null; site: string | null } {
  let author: string | null = null
  let site: string | null = null
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown
    try {
      data = JSON.parse(decodeEntities(m[1] ?? '').trim())
    } catch {
      continue
    }
    const nodes: any[] = Array.isArray(data) ? data : (data as any)?.['@graph'] ?? [data]
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue
      if (!author) {
        const a = node.author
        const name = Array.isArray(a) ? a[0]?.name : typeof a === 'object' ? a?.name : typeof a === 'string' ? a : null
        if (name) author = decodeEntities(String(name)).trim()
      }
      if (!site) {
        const pub = node.publisher
        const name = typeof pub === 'object' ? pub?.name : typeof pub === 'string' ? pub : null
        if (name) site = decodeEntities(String(name)).trim()
      }
    }
    if (author && site) break
  }
  return { author, site }
}

// stripHtml is re-exported from the canonical helper so existing importers
// (reader.ts, etc.) keep working.
export { stripHtml }

// ── main-content isolation (heuristic) ────────────────────────────────────────

// Tags whose entire block (open→close) is dropped before content selection.
const STRIP_BLOCKS =
  /<(script|style|noscript|svg|template|nav|header|footer|aside|form|figure\b[^>]*role=["']?banner|iframe|object|embed)[\s\S]*?<\/\1>/gi

function preClean(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|nav|header|footer|aside|form|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    // Reference / edit chrome that pollutes reader text (Wikipedia & similar):
    .replace(/<sup\b[^>]*class=["'][^"']*\b(reference|cite_ref|noprint)\b[^"']*["'][\s\S]*?<\/sup>/gi, '')
    .replace(/<span\b[^>]*class=["'][^"']*\bmw-editsection\b[^"']*["'][\s\S]*?<\/span>/gi, '')
    .replace(/\[\s*edit\s*\]/gi, '')
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

// ── lazy-image resolution ─────────────────────────────────────────────────────

// Many sites ship a placeholder in src and the real image in data-src / srcset. Promote a
// real URL into src so the offline copy isn't a 1×1 spacer. Also drops obvious UI chrome
// (sprites, icons, tracking pixels, tiny thumbnails) so the reader view stays clean.
const CRUFT_IMG =
  /(sprite|spacer|pixel|1x1|blank\.|transparent\.|\/icons?\/|-icon\.|_icon\.|emoji|avatar|gravatar|semi-protection|ooui|oojs_ui_icon|\/\d{1,2}px-)/i

function resolveLazyImages(html: string): string {
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const get = (attr: string) => tag.match(new RegExp(`${attr}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'))
    const realFromSrcset = (raw?: string | null) => {
      if (!raw) return null
      // "url 320w, url2 640w" → pick the largest descriptor.
      let best: string | null = null
      let bestN = -1
      for (const cand of raw.split(',')) {
        const [u, d] = cand.trim().split(/\s+/)
        if (!u) continue
        const n = d ? parseInt(d) || 0 : 0
        if (n >= bestN) { bestN = n; best = u }
      }
      return best
    }
    const srcM = get('src')
    const src = srcM ? srcM[2] ?? srcM[3] ?? '' : ''
    const isPlaceholder = !src || /^data:/i.test(src) || /\.(gif)$/i.test(src) && /blank|spacer|pixel|placeholder/i.test(src)
    if (isPlaceholder) {
      const lazy =
        realFromSrcset(get('data-srcset')?.[2] ?? get('data-srcset')?.[3]) ||
        (get('data-src')?.[2] ?? get('data-src')?.[3]) ||
        (get('data-original')?.[2] ?? get('data-original')?.[3]) ||
        realFromSrcset(get('srcset')?.[2] ?? get('srcset')?.[3])
      if (lazy) {
        return srcM ? tag.replace(srcM[0], `src="${lazy}"`) : tag.replace(/<img/i, `<img src="${lazy}"`)
      }
    } else if (get('srcset')) {
      // Prefer the largest srcset candidate over a small default src.
      const big = realFromSrcset(get('srcset')?.[2] ?? get('srcset')?.[3])
      if (big && srcM) return tag.replace(srcM[0], `src="${big}"`)
    }
    return tag
  })
}

function dropCruftImages(html: string): string {
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = tag.match(/src\s*=\s*("([^"]*)"|'([^']*)')/i)
    const url = src ? src[2] ?? src[3] ?? '' : ''
    if (!url || CRUFT_IMG.test(url)) return ''
    const w = tag.match(/\bwidth\s*=\s*["']?(\d+)/i)
    const h = tag.match(/\bheight\s*=\s*["']?(\d+)/i)
    if ((w && Number(w[1]) <= 32) || (h && Number(h[1]) <= 32)) return ''
    return tag
  })
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

function sanitizeHtml(html: string, opts: ExtractOpts): string {
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
      let value = a[3] ?? a[4] ?? ''
      if (!allowed.has(name)) continue
      if ((name === 'href' || name === 'src') && /^\s*(javascript|data|vbscript):/i.test(value)) continue
      // Reader images → locally-archived copies when available.
      if (tag === 'img' && name === 'src' && opts.localizeImage) {
        value = opts.localizeImage(value) ?? value
      }
      kept.push(`${name}="${value.replace(/"/g, '&quot;')}"`)
    }
    return `<${tag}${kept.length ? ' ' + kept.join(' ') : ''}>`
  })

  // Collapse runs of empty block tags left after stripping.
  out = out.replace(/(<(p|div|span|section)>\s*<\/\2>\s*)+/gi, '')
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

// ── public API ────────────────────────────────────────────────────────────────

// Extract a readable article from already-fetched HTML. `url` is the canonical page URL
// (used to absolutize relative links/images). Never throws on thin content — returns
// whatever it could find so callers can still store an excerpt.
export function extractFromHtml(html: string, url: string, opts: ExtractOpts = {}): ExtractedArticle {
  const title = docTitle(html)
  const ld = jsonLd(html)
  const byline = metaContent(html, ['author', 'article:author', 'og:author']) || ld.author
  const siteName = metaContent(html, ['og:site_name']) || ld.site
  let imageUrl = metaContent(html, ['og:image', 'og:image:url', 'twitter:image'])
  if (imageUrl) {
    try {
      imageUrl = new URL(imageUrl, url).toString()
    } catch {
      imageUrl = null
    }
  }

  const rawContent = dropCruftImages(resolveLazyImages(selectContent(html)))
  const contentHtml = sanitizeHtml(absolutizeUrls(rawContent, url), opts) || null
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

export async function fetchPageHtml(url: string, timeoutMs = 8000): Promise<string> {
  const res = await safeFetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } }, { timeoutMs })
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`)
  return res.text()
}

export async function extractArticle(url: string, timeoutMs = 8000): Promise<ExtractedArticle> {
  return extractFromHtml(await fetchPageHtml(url, timeoutMs), url)
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

// Zero-dep article extractor shared by Feeds (full-text) and Reader (offline save).
//
// Fetch the page via the SSRF-guarded safeFetch, pull metadata (title/byline/site/lead image)
// from <head> + JSON-LD, isolate the main article block heuristically, drop boilerplate/UI
// chrome, then run the HTML through a conservative allowlist sanitizer so the stored
// contentHtml is safe to render directly (dangerouslySetInnerHTML) without a client-side
// sanitizer. When the static HTML is blocked or too thin, extractArticle can reuse the
// Bookmarks renderer to capture browser-rendered HTML before trying public archives.
//
// `extractFromHtml` is the reusable core (the full-page snapshotter already has the HTML in
// hand and passes it in, along with a `localizeImage` hook so reader images point at the
// locally-archived copies). `extractArticle` is the fetch-then-extract convenience used by
// Feeds.

import { assertPublicUrl, safeFetch } from '@/lib/ssrfGuard'
import { decodeEntities, stripHtml } from '@/lib/htmlText'
import { renderPage } from '@/lib/bookmarks/render'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

// URL path or publisher-supplied section is the reliable signal every obituary-hosting CMS
// emits (schema.org even has a dedicated Obituary type) - title/body wording is deliberately
// NOT used here (a hard news story like "John Smith Dies at 90" isn't an obituary). Exported so
// callers holding just a stored URL (no fresh extraction) can still check it - e.g. a feed
// item's cached row - without needing a dedicated DB column.
export const OBITUARY_RE = /obituar(?:y|ies)/i

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
  // URL path or publisher section metadata marks this as an obituary - callers use this to
  // suppress tone-deaf features (e.g. News' "Related videos" tab) that make sense for a news
  // story but not a death notice. Deliberately NOT inferred from title/body wording (a hard
  // news story like "John Smith Dies at 90" isn't an obituary) - only signals a CMS itself
  // attaches are reliable enough here.
  isObituary: boolean
  source: 'direct' | 'social' | 'subscriber' | 'browser' | 'ladder' | 'archive.is' | 'wayback'
  archiveUrl: string | null
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

// Pull author / publisher / section from JSON-LD (schema.org Article), which most CMS-driven
// sites emit even when they omit <meta name="author">. `section` folds in articleSection and
// @type since some publishers mark obituaries via either (schema.org has a dedicated Obituary
// type, a subtype of CreativeWork).
function jsonLd(html: string): { author: string | null; site: string | null; section: string | null } {
  let author: string | null = null
  let site: string | null = null
  let section: string | null = null
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
      if (!section) {
        const sec = node.articleSection
        const type = node['@type']
        const secText = Array.isArray(sec) ? sec.join(' ') : typeof sec === 'string' ? sec : null
        const typeText = typeof type === 'string' ? type : Array.isArray(type) ? type.join(' ') : null
        section = [secText, typeText].filter(Boolean).join(' ') || null
      }
    }
    if (author && site && section) break
  }
  return { author, site, section }
}

// stripHtml is re-exported from the canonical helper so existing importers
// (reader.ts, etc.) keep working.
export { stripHtml }

// ── main-content isolation (heuristic) ────────────────────────────────────────

// Tags whose entire block (open→close) is dropped before content selection. <button> and
// <label> are included because their text is always UI, not prose — lightbox triggers
// ("View image in fullscreen"), caption toggles, form controls — and the sanitizer alone
// would strip the tag but leak the text.
const STRIP_BLOCKS =
  /<(script|style|noscript|svg|template|nav|header|footer|aside|form|button|label|figure\b[^>]*role=["']?banner|iframe|object|embed)[\s\S]*?<\/\1>/gi

function preClean(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|nav|header|footer|aside|form|button|label|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
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

// ── boilerplate stripping ─────────────────────────────────────────────────────

// Many sites (local-news CMSes especially) nest a bunch of non-article chrome inside the same
// block our heuristic treats as "the article": a duplicate H1, an author byline card (avatar +
// role badge), a "Posted/Updated ..." timestamp line, and a newsletter-signup CTA. All of these
// are either already shown elsewhere (ArticleReader's own header repeats title/byline) or add
// no reading value, so strip them from the selected block before sanitizing.
const NEWSLETTER_CTA =
  /<p\b[^>]*>(?:(?!<\/p>)[\s\S])*?(sign up for (?:free\s+)?[\s\S]{0,40}?(newsletter|alert)|subscribe to (?:our|the) newsletter|delivered (?:straight )?to your inbox)[\s\S]*?<\/p>/gi
const POSTED_UPDATED_PARA = /<p\b[^>]*>\s*(posted|published|updated)\b(?:(?!<\/p>)[\s\S])*?\b(am|pm)\b(?:(?!<\/p>)[\s\S])*?<\/p>/gi
// A <p>/<figure> whose only real content is one image, where that image's alt text marks it as
// a byline avatar or a "verified"-style role badge rather than an inline content photo.
const BYLINE_IMAGE_PARA = /<(p|figure)\b[^>]*>\s*<img\b[^>]*\balt=(["'])(?:(?!\2)[\s\S])*?(profile picture|verified[\s\S]{0,20}badge|staff badge)(?:(?!\2)[\s\S])*?\2[^>]*>\s*<\/\1>/gi

// Remove every <TAG ...> element (through its properly-matched closing tag, at any nesting
// depth) whose OPENING tag's class attribute contains one of `keywords`. Needed because
// React/CSS-modules markup (Patch, and most modern site themes) wraps boilerplate like the
// byline card or dateline in semantically-named but arbitrarily-nested divs - a name like
// "styles-module-scss-module__cTcn5a__BylineSection" survives the hashed prefix, but the actual
// element can be nested several <div>s deep, which plain regex can't balance.
function removeElementsByClass(html: string, tag: string, keywords: string[]): string {
  return removeElementsMatching(html, tag, `\\bclass=["'][^"']*(?:${keywords.join('|')})[^"']*["']`)
}

// Same balanced removal, but matching any attribute pattern in the opening tag — for
// boilerplate marked by semantics rather than class names (aria-hidden, data-* flags).
function removeElementsMatching(html: string, tag: string, attrPattern: string): string {
  const openRe = new RegExp(`<${tag}\\b[^>]*${attrPattern}[^>]*>`, 'i')
  const nextTagRe = new RegExp(`<(${tag})\\b|<\\/${tag}>`, 'gi')
  let out = html
  for (let guard = 0; guard < 50; guard++) {
    const m = out.match(openRe)
    if (!m || m.index == null) break
    const start = m.index
    let depth = 1
    nextTagRe.lastIndex = start + m[0].length
    let end = out.length
    let next: RegExpExecArray | null
    while ((next = nextTagRe.exec(out))) {
      if (next[1]) depth++ // another opening <tag
      else { depth--; if (depth === 0) { end = next.index + next[0].length; break } }
    }
    out = out.slice(0, start) + out.slice(end)
  }
  return out
}

// Elements the publisher itself marks as not-content: aria-hidden (invisible to the
// accessibility tree — lightbox triggers, decorative duplicates), print-hidden chrome
// (share bars, "explore more" topic footers), skip-link note targets, and block elements
// a CMS types as promos rather than prose (the Guardian's spacefinder slots: rich "Read
// more" links, newsletter sign-ups, standalone CTA link buttons).
function stripMarkedNonContent(html: string): string {
  let out = html
  for (const tag of ['a', 'span', 'p', 'div', 'figure']) {
    out = removeElementsMatching(out, tag, `\\baria-hidden=["']true["']`)
  }
  for (const tag of ['div', 'span', 'section', 'p']) {
    out = removeElementsMatching(out, tag, `\\bdata-print-layout=["']hide["']`)
  }
  for (const tag of ['figure', 'div']) {
    out = removeElementsMatching(
      out, tag,
      `\\bdata-spacefinder-type=["'][^"']*\\.(?:RichLink|Link|NewsletterSignup|EmailSignup)BlockElement["']`,
    )
  }
  // CMSes that type their blocks via data-component (BBC and other React front-ends):
  // remove the components that are chrome, never prose. Matched as prefixes so
  // "tag-list" also catches "tag-list-block".
  for (const tag of ['div', 'section']) {
    out = removeElementsMatching(
      out, tag,
      `\\bdata-component=["'](?:ad-slot|advertisement|tag-list|topic-list|byline|related|share-tools|newsletter|promo)[^"']*["']`,
    )
  }
  out = removeElementsMatching(out, 'p', `\\brole=["']note["']`)
  // In-page accessibility skip links ("skip past newsletter promotion") — pure navigation.
  out = out.replace(/<a\b[^>]*href=["']#[^"']*["'][^>]*>\s*skip\s+(?:past|to)\b[\s\S]*?<\/a>/gi, '')
  return out
}

// A promo paragraph in the standfirst/body: short, link-heavy, and reading like "Get our
// breaking news email, free app or daily news podcast" or "Sign up for the X email". Text
// is checked via stripHtml in a callback so inline links don't hide the phrase from a
// plain regex, and the length cap keeps legitimate prose that merely starts with "Get"
// out of reach.
const PROMO_PARA_RE = /<(p|li)\b[^>]*>[\s\S]*?<\/\1>/gi
function stripPromoParas(html: string): string {
  return html.replace(PROMO_PARA_RE, (block) => {
    const text = stripHtml(block).trim()
    if (text.length > 180) return block
    if (/^(?:get|sign up for|subscribe to) (?:our|the|a) .{0,120}\b(?:email|newsletter|podcast|app|briefing)\b/i.test(text)) return ''
    if (/^(?:after|skip past) (?:the )?newsletter promotion$/i.test(text)) return ''
    return block
  })
}

// Publishers commonly render the same caption twice per figure (a hidden mobile/lightbox
// copy plus the visible one). Keep the first of any identically-worded run of figcaptions.
function dedupeFigcaptions(html: string): string {
  const seen = new Set<string>()
  return html.replace(/<figcaption\b[^>]*>[\s\S]*?<\/figcaption>/gi, (block) => {
    const key = stripHtml(block).replace(/\s+/g, ' ').trim().toLowerCase()
    if (!key) return ''
    if (seen.has(key)) return ''
    seen.add(key)
    return block
  })
}

function stripBoilerplate(html: string, title: string | null): string {
  let out = html.replace(NEWSLETTER_CTA, '').replace(POSTED_UPDATED_PARA, '').replace(BYLINE_IMAGE_PARA, '')
  out = stripMarkedNonContent(out)
  out = stripPromoParas(out)
  out = dedupeFigcaptions(out)
  out = removeElementsByClass(out, 'div', ['byline', 'dateline', 'newsletter', 'subscribe'])
  out = removeElementsByClass(out, 'section', ['subscribe'])
  out = removeElementsByClass(out, 'time', ['dateline'])
  // Photo/gallery credit tags (e.g. Engadget's <span class="gallery-image-credit">Apple</span>)
  // - a bare source name sitting right after an image, indistinguishable from real prose once
  // sanitized unless caught by its class name like this.
  out = removeElementsByClass(out, 'span', ['image-credit', 'photo-credit', 'creditstyled'])
  out = removeElementsByClass(out, 'p', ['image-credit', 'photo-credit'])
  // A leading heading that just repeats the page title (ArticleReader already renders the
  // title in its own header) - only the FIRST occurrence, so a legitimately repeated phrase
  // later in the body is left alone. Fuzzy, not exact: <title> commonly carries a " - SiteName"
  // / " | SiteName" suffix the in-body <h1> doesn't, so an exact-string match misses the very
  // case this is meant to catch (confirmed live: Engadget's <title> included "- Engadget", its
  // body h1 didn't, so `===` silently never fired). One side containing the other, with enough
  // overlap that it can't be two unrelated headings that happen to share a few words, is enough.
  if (title) {
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
    const targetNorm = norm(title)
    out = out.replace(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/i, (full, _level, inner) => {
      const headingNorm = norm(stripHtml(inner))
      if (!headingNorm) return full
      const overlaps = headingNorm === targetNorm || targetNorm.includes(headingNorm) || headingNorm.includes(targetNorm)
      const ratio = Math.min(headingNorm.length, targetNorm.length) / Math.max(headingNorm.length, targetNorm.length)
      return overlaps && ratio > 0.6 ? '' : full
    })
  }
  return out
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
      const raw = a[3] ?? a[4] ?? ''
      if (!allowed.has(name)) continue
      // Decode entities BEFORE the scheme check: an attacker can smuggle any character
      // of "javascript:" through a numeric entity (e.g. href="javascript&#58;alert(1)"),
      // which the raw string wouldn't match but the browser decodes and executes on click.
      let value = decodeEntities(raw)
      if ((name === 'href' || name === 'src') && /^\s*(javascript|data|vbscript):/i.test(value)) continue
      // Reader images → locally-archived copies when available.
      if (tag === 'img' && name === 'src' && opts.localizeImage) {
        value = opts.localizeImage(value) ?? value
      }
      kept.push(`${name}="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`)
    }
    return `<${tag}${kept.length ? ' ' + kept.join(' ') : ''}>`
  })

  // Collapse runs of empty block tags left after stripping.
  out = out.replace(/(<(p|div|span|section|figure|li)>\s*<\/\2>\s*)+/gi, '')
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

// ── public API ────────────────────────────────────────────────────────────────

// Extract a readable article from already-fetched HTML. `url` is the canonical page URL
// (used to absolutize relative links/images). Never throws on thin content, returns
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

  const rawContent = dropCruftImages(resolveLazyImages(stripBoilerplate(selectContent(html), title)))
  const contentHtml = sanitizeHtml(absolutizeUrls(rawContent, url), opts) || null
  const contentText = contentHtml ? stripHtml(contentHtml) : null
  const wordCount = contentText ? contentText.split(/\s+/).filter(Boolean).length : 0
  const excerpt =
    metaContent(html, ['og:description', 'description', 'twitter:description']) ||
    (contentText ? contentText.slice(0, 280) : null)
  const sectionSignal = metaContent(html, ['article:section']) ?? ld.section
  const isObituary = OBITUARY_RE.test(url) || (!!sectionSignal && OBITUARY_RE.test(sectionSignal))

  return {
    title,
    byline,
    siteName,
    excerpt,
    contentHtml,
    contentText,
    imageUrl,
    isObituary,
    source: 'direct',
    archiveUrl: null,
    wordCount,
    readingMins: Math.max(1, Math.round(wordCount / 200)),
  }
}

function htmlHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    ...extra,
  }
}

export async function fetchPageHtml(url: string, timeoutMs = 8000): Promise<string> {
  const res = await safeFetch(url, { headers: htmlHeaders() }, { timeoutMs })
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`)
  return res.text()
}

// If a direct fetch is blocked (bot-detection challenge, geo-fence, dead link, etc.), check
// whether the Wayback Machine already has an independently-crawled snapshot. This is a
// legitimate public-archive lookup, not a bypass: it only uses a copy that already exists,
// and never asks archive.org to freshly crawl a page on our behalf to dodge a live block.
// `id_` serves the raw archived HTML with no Wayback toolbar injected.
interface ArchivedHtml {
  html: string
  source: 'archive.is' | 'wayback'
  archiveUrl: string
}

interface FallbackHtml {
  html: string
  source: 'social' | 'subscriber' | 'ladder'
  archiveUrl: string | null
}

const MIN_USEFUL_ARTICLE_CHARS = 400

function isUsefulExtraction(article: ExtractedArticle | null): boolean {
  const text = article?.contentText ?? ''
  if (text.length < MIN_USEFUL_ARTICLE_CHARS) return false
  if (/Please enable JS and disable any ad blocker/i.test(text)) return false
  if (/Use of any device, tool, or process designed to data mine or scrape/i.test(text)) return false
  if (/complete the security check|One more step|CAPTCHA/i.test(text)) return false
  return true
}

async function fetchViaArchiveIs(url: string, timeoutMs: number): Promise<ArchivedHtml | null> {
  try {
    const candidates = [
      `https://archive.is/newest/${url}`,
      `https://archive.is/${url}`,
    ]
    for (const archiveUrl of candidates) {
      const res = await safeFetch(archiveUrl, { headers: { 'User-Agent': UA, Accept: 'text/html' } }, { timeoutMs: Math.min(timeoutMs, 8000) })
      if (!res.ok) continue
      const html = await res.text()
      if (isArchiveIsChallenge(html)) continue
      return { html, source: 'archive.is', archiveUrl: res.url || archiveUrl }
    }
    return null
  } catch {
    return null
  }
}

function hostEnvKeys(url: string): string[] {
  let host = ''
  try {
    host = new URL(url).hostname.toUpperCase().replace(/^WWW\./, '')
  } catch {
    return []
  }
  const normalized = host.replace(/[^A-Z0-9]+/g, '_')
  const compact = normalized.replace(/_COM$/, '')
  return [
    `READER_COOKIE_HEADER_${normalized}`,
    compact !== normalized ? `READER_COOKIE_HEADER_${compact}` : '',
  ].filter(Boolean)
}

function readerCookieHeader(url: string): string | null {
  for (const key of hostEnvKeys(url)) {
    const value = process.env[key]?.trim()
    if (value) return value
  }
  return null
}

async function fetchViaSocialPreview(url: string, timeoutMs: number): Promise<FallbackHtml | null> {
  const userAgents = ['Twitterbot/1.0', 'facebookexternalhit/1.1']
  for (const ua of userAgents) {
    try {
      const res = await safeFetch(url, { headers: htmlHeaders({ 'User-Agent': ua }) }, { timeoutMs: Math.min(timeoutMs, 12_000) })
      if (!res.ok) continue
      return { html: await res.text(), source: 'social', archiveUrl: null }
    } catch {
      continue
    }
  }
  return null
}

async function fetchViaSubscriberCookie(url: string, timeoutMs: number): Promise<FallbackHtml | null> {
  const cookie = readerCookieHeader(url)
  if (!cookie) return null
  try {
    const res = await safeFetch(url, { headers: htmlHeaders({ Cookie: cookie }) }, { timeoutMs: Math.min(timeoutMs, 12_000) })
    if (!res.ok) return null
    return { html: await res.text(), source: 'subscriber', archiveUrl: null }
  } catch {
    return null
  }
}

async function fetchViaLadder(url: string, timeoutMs: number): Promise<FallbackHtml | null> {
  const base = process.env.READER_LADDER_URL?.trim()?.replace(/\/+$/, '')
  if (!base) return null
  try {
    const proxyUrl = `${base}/raw/${url}`
    const res = await fetch(proxyUrl, { headers: htmlHeaders(), signal: AbortSignal.timeout(Math.min(timeoutMs, 20_000)) })
    if (!res.ok) return null
    return { html: await res.text(), source: 'ladder', archiveUrl: proxyUrl }
  } catch {
    return null
  }
}

function isArchiveIsChallenge(html: string): boolean {
  return /<title>\s*archive\.(?:is|ph|today|vn)\s*<\/title>/i.test(html) &&
    /One more step|complete the security check|CAPTCHA/i.test(html)
}

async function fetchViaBrowser(url: string, timeoutMs: number): Promise<string | null> {
  const rendered = await renderPage(url, { captureMedia: false, timeoutMs: Math.max(timeoutMs, 15_000) }).catch(() => null)
  return rendered?.html ?? null
}

async function fetchViaWayback(url: string, timeoutMs: number): Promise<ArchivedHtml | null> {
  try {
    const res = await safeFetch(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, {}, { timeoutMs: Math.min(timeoutMs, 6000) })
    if (!res.ok) return null
    const data = await res.json() as { archived_snapshots?: { closest?: { available?: boolean; url?: string } } }
    const snapshotUrl = data.archived_snapshots?.closest
    if (!snapshotUrl?.available || !snapshotUrl.url) return null
    const rawUrl = snapshotUrl.url.replace(/(\/web\/\d+)\//, '$1id_/')
    return { html: await fetchPageHtml(rawUrl, timeoutMs), source: 'wayback', archiveUrl: rawUrl }
  } catch {
    return null
  }
}

export async function extractArticle(url: string, timeoutMs = 8000): Promise<ExtractedArticle> {
  await assertPublicUrl(url)
  let direct: ExtractedArticle | null = null
  try {
    direct = extractFromHtml(await fetchPageHtml(url, timeoutMs), url)
    if (isUsefulExtraction(direct)) return direct
  } catch (err) {
    direct = null
  }
  const social = await fetchViaSocialPreview(url, timeoutMs)
  if (social) {
    const article = extractFromHtml(social.html, url)
    article.source = social.source
    if (isUsefulExtraction(article) &&
      (article.contentText?.length ?? 0) > (direct?.contentText?.length ?? 0)) return article
  }
  const credentialed = await fetchViaSubscriberCookie(url, timeoutMs)
  if (credentialed) {
    const article = extractFromHtml(credentialed.html, url)
    article.source = credentialed.source
    if (isUsefulExtraction(article) &&
      (article.contentText?.length ?? 0) > (direct?.contentText?.length ?? 0)) return article
  }
  const renderedHtml = await fetchViaBrowser(url, timeoutMs)
  if (renderedHtml) {
    const rendered = extractFromHtml(renderedHtml, url)
    rendered.source = 'browser'
    if (isUsefulExtraction(rendered) &&
      (rendered.contentText?.length ?? 0) > (direct?.contentText?.length ?? 0)) return rendered
  }
  const ladder = await fetchViaLadder(url, timeoutMs)
  if (ladder) {
    const article = extractFromHtml(ladder.html, url)
    article.source = ladder.source
    article.archiveUrl = ladder.archiveUrl
    if (isUsefulExtraction(article) &&
      (article.contentText?.length ?? 0) > (direct?.contentText?.length ?? 0)) return article
  }
  const archived = (await fetchViaArchiveIs(url, timeoutMs)) ?? (await fetchViaWayback(url, timeoutMs))
  if (archived) {
    const article = extractFromHtml(archived.html, url)
    article.source = archived.source
    article.archiveUrl = archived.archiveUrl
    if (isUsefulExtraction(article) && (article.contentText?.length ?? 0) > (direct?.contentText?.length ?? 0)) return article
  }
  if (isUsefulExtraction(direct)) return direct
  throw new Error(`fetch ${url} failed`)
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

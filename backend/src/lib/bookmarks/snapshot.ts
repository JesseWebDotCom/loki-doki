// Full-page offline snapshot: fetch a page, download every referenced asset (images, CSS,
// fonts, icons) to local disk, rewrite all URLs to point at the local copies, and write a
// self-contained index.html that renders the page faithfully while fully offline.
//
// Stored under data/bookmark-archive/<itemId>/:
//   index.html          — rewritten page (scripts stripped; sandboxed at render time)
//   assets/<hash>.<ext> — every downloaded asset, content-addressed
//
// Served (auth + ownership checked) from GET /api/bookmarks/:id/archive/* so the snapshot
// iframe and the reader view's <img> tags both resolve to local bytes.
//
// Zero-dep + regex-based to match the codebase style. The same downloaded-asset registry
// also localizes the cleaned reader view (extractFromHtml's localizeImage hook), so we
// fetch each image at most once for both views.

import { createHash } from 'node:crypto'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '@/lib/download'
import { safeFetch } from '@/lib/ssrfGuard'
import { extractFromHtml, fetchPageHtml, type ExtractedArticle } from '@/lib/content/extract'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

export const BOOKMARK_ARCHIVE_ROOT = 'bookmark-archive' // relative to dataDir

const MAX_ASSETS = 400
const MAX_ASSET_BYTES = 12 * 1024 * 1024 // 12 MB per asset
const MAX_TOTAL_BYTES = 120 * 1024 * 1024 // 120 MB per page
const ASSET_TIMEOUT_MS = 15_000
const CONCURRENCY = 6

const EXT_BY_CT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
  'text/css': 'css', 'font/woff2': 'woff2', 'font/woff': 'woff', 'font/ttf': 'ttf',
  'application/font-woff2': 'woff2', 'application/font-woff': 'woff', 'image/bmp': 'bmp',
}

interface Asset {
  url: string // absolute source URL
  localName: string // assets/<hash>.<ext>
  kind: 'css' | 'binary'
}

export interface SnapshotResult {
  reader: ExtractedArticle
  snapshotRelDir: string // e.g. 'bookmark-archive/<id>' (relative to dataDir)
  thumbRel: string | null // archive-relative path to the page thumbnail, e.g. 'assets/<hash>.jpg'
  faviconRel: string | null // archive-relative path to the locally-saved site favicon
  assetCount: number
  totalBytes: number
}

// Best site favicon from the page <head> (prefer larger / apple-touch / svg/png), falling
// back to /favicon.ico. Absolute URL, or null.
function findFavicon(html: string, baseUrl: string): string | null {
  let best: string | null = null
  let bestScore = -1
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0]
    const rel = (tag.match(/\brel\s*=\s*("([^"]*)"|'([^']*)')/i) ?? [])
    const relV = (rel[2] ?? rel[3] ?? '').toLowerCase()
    if (!/\bicon\b/.test(relV)) continue
    const href = tag.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)')/i)
    if (!href) continue
    let abs: string
    try { abs = new URL(decodeAmp(href[2] ?? href[3] ?? ''), baseUrl).toString() } catch { continue }
    const sizes = tag.match(/\bsizes\s*=\s*("([^"]*)"|'([^']*)')/i)
    let score = parseInt((sizes?.[2] ?? sizes?.[3] ?? '').split('x')[0] ?? '') || 16
    if (/apple-touch/.test(relV)) score += 20
    if (/\.svg(\?|$)/i.test(abs)) score += 8
    else if (/\.png(\?|$)/i.test(abs)) score += 5
    if (score > bestScore) { bestScore = score; best = abs }
  }
  if (best) return best
  try { return new URL('/favicon.ico', baseUrl).toString() } catch { return null }
}

// Local asset names of every <img> in the cleaned reader HTML, in document order —
// thumbnail fallbacks when og:image is absent or fails to download. Recovers the asset
// name from the localized /api/.../archive/<assets/..> URL.
function contentImageLocals(html: string | null): string[] {
  if (!html) return []
  const out: string[] = []
  for (const m of html.matchAll(/<img\b[^>]*\bsrc\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    const src = m[2] ?? m[3] ?? ''
    const a = src.match(/\/archive\/(assets\/[^"']+)$/)
    if (a && a[1]) out.push(a[1])
  }
  return out
}

export interface SnapshotProgress {
  note: string
  completed: number
  total: number
}

// Content-addressed local name. `forceExt` wins (CSS must end in .css so the serve route
// returns text/css — Wikipedia & co. serve stylesheets from extensionless/.php endpoints
// like load.php, and browsers refuse CSS with the wrong MIME). Otherwise derive a *known*
// media extension from the URL path; unknown/dynamic endpoints fall back to .bin and the
// serve route sniffs the real type from magic bytes.
const KNOWN_EXT = /^(jpe?g|png|gif|webp|avif|svg|ico|bmp|css|woff2?|ttf|otf|eot|mp4|webm|ogg|mp3)$/i
function localNameFor(absUrl: string, forceExt?: string): string {
  const hash = createHash('sha1').update(absUrl).digest('hex').slice(0, 20)
  let ext = 'bin'
  if (forceExt) {
    ext = forceExt
  } else {
    try {
      const m = new URL(absUrl).pathname.match(/\.([a-z0-9]{1,5})$/i)
      if (m && m[1] && KNOWN_EXT.test(m[1])) ext = m[1].toLowerCase()
    } catch { /* keep .bin */ }
  }
  return `assets/${hash}.${ext}`
}

export async function capturePage(
  url: string,
  itemId: string,
  onProgress: (p: SnapshotProgress) => void,
  opts: { renderedHtml?: string; screenshotPng?: Uint8Array } = {},
): Promise<SnapshotResult> {
  const snapshotRelDir = `${BOOKMARK_ARCHIVE_ROOT}/${itemId}`
  const absDir = join(dataDir, BOOKMARK_ARCHIVE_ROOT, itemId)
  const assetsDir = join(absDir, 'assets')

  // Fresh start, but PRESERVE a client-posted screenshot (thumb.png) which is captured in a
  // separate request: wipe only the asset dir + page, not the whole item dir.
  await rm(assetsDir, { recursive: true, force: true })
  await rm(join(absDir, 'index.html'), { force: true })
  await mkdir(assetsDir, { recursive: true })

  // A server-rendered screenshot (Playwright) becomes the thumbnail — the best source.
  if (opts.screenshotPng) await writeFile(join(absDir, 'thumb.png'), opts.screenshotPng)

  // `renderedHtml` (the user's browser rendered the page through our proxy, JS and all) beats
  // a static fetch — it carries the real, JS-injected CSS and content. Static is the fallback.
  onProgress({ note: opts.renderedHtml ? 'Archiving page…' : 'Fetching page…', completed: 0, total: 1 })
  const html = opts.renderedHtml ?? await fetchPageHtml(url, ASSET_TIMEOUT_MS)

  // Registry of assets to fetch. register() is synchronous + deterministic so rewriting can
  // run before downloads finish; a failed download just 404s like a missing remote image.
  const assets = new Map<string, Asset>()
  let capped = false
  function register(absUrl: string, kind: Asset['kind'] = 'binary'): string | null {
    if (!/^https?:\/\//i.test(absUrl)) return null
    const existing = assets.get(absUrl)
    if (existing) return existing.localName
    if (assets.size >= MAX_ASSETS) { capped = true; return null }
    const localName = localNameFor(absUrl, kind === 'css' ? 'css' : undefined)
    assets.set(absUrl, { url: absUrl, localName, kind })
    return localName
  }

  // 1) Rewrite the page HTML → local asset refs, strip scripts, neutralize handlers.
  const rewrittenHtml = rewriteHtml(html, url, register)

  // 2) Reader view shares the registry: localizeImage maps an absolute image URL to the
  //    public archive path so the cleaned reader view is offline too.
  const reader = extractFromHtml(html, url, {
    localizeImage: (absUrl) => {
      const local = register(absUrl, 'binary')
      return local ? `/api/bookmarks/${itemId}/archive/${local}` : null
    },
  })

  // 2b) Page thumbnail candidates: prefer the og:image (the site's own share-card preview),
  //     then article images in order. Registered here so the download pass fetches them; the
  //     actual pick happens after downloads, against whatever landed on disk.
  const ogLocal = reader.imageUrl ? register(reader.imageUrl, 'binary') : null
  const thumbCandidates = [ogLocal, ...contentImageLocals(reader.contentHtml)].filter(Boolean) as string[]

  // 2c) Site favicon — downloaded locally so it renders offline on cards + reader header.
  const faviconAbs = findFavicon(html, url)
  const faviconLocal = faviconAbs ? register(faviconAbs, 'binary') : null

  // 3) Download everything. CSS is fetched first so its url() references (fonts, bg images)
  //    join the work list before we finish.
  let totalBytes = 0
  let done = 0

  async function fetchAsset(a: Asset): Promise<void> {
    try {
      const res = await safeFetch(a.url, { headers: { 'User-Agent': UA } }, { timeoutMs: ASSET_TIMEOUT_MS })
      if (!res.ok) return
      const buf = new Uint8Array(await res.arrayBuffer())
      if (buf.byteLength > MAX_ASSET_BYTES) return
      if (totalBytes + buf.byteLength > MAX_TOTAL_BYTES) { capped = true; return }
      totalBytes += buf.byteLength

      if (a.kind === 'css') {
        // Rewrite url(...) inside the stylesheet → local, registering nested assets.
        const cssText = new TextDecoder().decode(buf)
        const rewritten = rewriteCss(cssText, a.url, register)
        await writeFile(join(absDir, a.localName), rewritten)
      } else {
        await writeFile(join(absDir, a.localName), buf)
      }
    } catch (err) {
      void err // swallow: a missing asset is non-fatal (SSRF-blocked, 404, timeout, …)
    }
  }

  // Drain the work list in rounds so CSS-discovered assets get picked up.
  const fetched = new Set<string>()
  for (let round = 0; round < 3; round++) {
    const batch = [...assets.values()].filter((a) => !fetched.has(a.url))
    if (batch.length === 0) break
    // CSS before binaries within a round.
    batch.sort((x, y) => (x.kind === 'css' ? -1 : 1) - (y.kind === 'css' ? -1 : 1))
    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      const slice = batch.slice(i, i + CONCURRENCY)
      await Promise.all(slice.map((a) => { fetched.add(a.url); return fetchAsset(a) }))
      done += slice.length
      onProgress({ note: `Saving assets… (${done})`, completed: done, total: assets.size })
    }
  }

  // 4) Write the page itself.
  await writeFile(join(absDir, 'index.html'), wrapSnapshot(rewrittenHtml, url, reader.title))

  if (capped) {
    // Non-fatal: we still produced a usable snapshot, just not exhaustive.
  }

  // Thumbnail precedence: a client-captured screenshot (thumb.png, posted separately and a
  // real render of the page) wins; else the first og:image/article image that downloaded
  // (og:image URLs sometimes 404, so we never point at bytes that aren't there).
  let thumbRel: string | null = null
  try {
    if (statSync(join(absDir, 'thumb.png')).size > 0) thumbRel = 'thumb.png'
  } catch { /* no client screenshot */ }
  if (!thumbRel) {
    for (const cand of thumbCandidates) {
      try {
        if (statSync(join(absDir, cand)).size > 0) { thumbRel = cand; break }
      } catch { /* not on disk — try next */ }
    }
  }

  let faviconRel: string | null = null
  if (faviconLocal) {
    try { if (statSync(join(absDir, faviconLocal)).size > 0) faviconRel = faviconLocal } catch { /* failed */ }
  }

  return { reader, snapshotRelDir, thumbRel, faviconRel, assetCount: fetched.size, totalBytes }
}

// ── HTML rewriting ─────────────────────────────────────────────────────────────

function rewriteHtml(html: string, base: string, register: (u: string, k?: Asset['kind']) => string | null): string {
  let out = html
    // Strip executable / dynamic content — the snapshot is static and sandboxed.
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<script\b[^>]*\/>/gi, '')
    .replace(/<noscript\b[^>]*>([\s\S]*?)<\/noscript>/gi, '$1') // reveal noscript fallbacks
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '') // inline event handlers
    // Lazy images → real src before we localize.
    .replace(/<img\b[^>]*>/gi, (tag) => promoteLazy(tag))

  // <link rel=stylesheet href> → local CSS
  out = out.replace(/<link\b[^>]*>/gi, (tag) => {
    const rel = tag.match(/\brel\s*=\s*("([^"]*)"|'([^']*)')/i)
    const relV = (rel ? rel[2] ?? rel[3] ?? '' : '').toLowerCase()
    const href = tag.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)')/i)
    if (!href) return tag
    const abs = toAbsUrl(href[2] ?? href[3] ?? '', base)
    if (!abs) return tag
    if (/stylesheet/.test(relV)) {
      const local = register(abs, 'css')
      return local ? tag.replace(href[0], `href="${local}"`) : ''
    }
    if (/\bicon\b|apple-touch-icon|mask-icon/.test(relV)) {
      const local = register(abs, 'binary')
      return local ? tag.replace(href[0], `href="${local}"`) : tag
    }
    // Drop preload/prefetch/dns-prefetch/preconnect — irrelevant offline.
    if (/preload|prefetch|preconnect|dns-prefetch|modulepreload/.test(relV)) return ''
    return tag
  })

  // <img src> / <source src|srcset> → local
  out = out
    .replace(/<img\b[^>]*>/gi, (tag) => rewriteSrc(tag, base, register, 'src'))
    .replace(/<source\b[^>]*>/gi, (tag) => {
      let t = rewriteSrc(tag, base, register, 'src')
      // collapse srcset → single largest local candidate
      const ss = t.match(/\bsrcset\s*=\s*("([^"]*)"|'([^']*)')/i)
      if (ss) {
        const big = largestSrcset(ss[2] ?? ss[3] ?? '')
        const abs = big ? toAbsUrl(big, base) : null
        const local = abs ? register(abs, 'binary') : null
        t = local ? t.replace(ss[0], `srcset="${local}"`) : t.replace(ss[0], '')
      }
      return t
    })
    // poster on <video>
    .replace(/<video\b[^>]*>/gi, (tag) => rewriteSrc(tag, base, register, 'poster'))

  // <a href> → absolute remote URL (clicking opens the live original)
  out = out.replace(/<a\b[^>]*>/gi, (tag) => {
    const href = tag.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)')/i)
    if (!href) return tag
    const v = href[2] ?? href[3] ?? ''
    if (/^(#|mailto:|tel:|javascript:)/i.test(v)) return tag
    const abs = toAbsUrl(v, base)
    return abs ? tag.replace(href[0], `href="${abs}" target="_blank" rel="noopener noreferrer"`) : tag
  })

  // <style> blocks (where JS-injected CSS lands) — rewrite url() to local. These live in
  // index.html at the archive root, so refs keep the `assets/` prefix (fromCss=false).
  out = out.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_full, open, css, close) =>
    open + rewriteCssUrls(css, base, register, false) + close)

  // inline style="...url(...)..." background images
  out = out.replace(/\bstyle\s*=\s*("([^"]*)"|'([^']*)')/gi, (full, _q, dq, sq) => {
    const css = dq ?? sq ?? ''
    const rew = rewriteCssUrls(css, base, register)
    return rew === css ? full : `style="${rew.replace(/"/g, '&quot;')}"`
  })

  return out
}

function promoteLazy(tag: string): string {
  const get = (a: string) => tag.match(new RegExp(`${a}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'))
  const srcM = get('src')
  const src = srcM ? srcM[2] ?? srcM[3] ?? '' : ''
  const placeholder = !src || /^data:/i.test(src)
  if (!placeholder && !get('data-src') && !get('srcset')) return tag
  const lazy =
    largestSrcset(get('data-srcset')?.[2] ?? get('data-srcset')?.[3] ?? '') ||
    (get('data-src')?.[2] ?? get('data-src')?.[3]) ||
    (get('data-original')?.[2] ?? get('data-original')?.[3]) ||
    largestSrcset(get('srcset')?.[2] ?? get('srcset')?.[3] ?? '')
  if (lazy && (placeholder || get('srcset'))) {
    return srcM ? tag.replace(srcM[0], `src="${lazy}"`) : tag.replace(/<img/i, `<img src="${lazy}"`)
  }
  return tag
}

function rewriteSrc(
  tag: string, base: string,
  register: (u: string, k?: Asset['kind']) => string | null,
  attr: string,
): string {
  const m = tag.match(new RegExp(`\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'))
  if (!m) return tag
  const abs = toAbsUrl(m[2] ?? m[3] ?? '', base)
  if (!abs) return tag
  const local = register(abs, 'binary')
  return local ? tag.replace(m[0], `${attr}="${local}"`) : tag
}

// ── CSS rewriting ───────────────────────────────────────────────────────────────

function rewriteCss(css: string, cssUrl: string, register: (u: string, k?: Asset['kind']) => string | null): string {
  // Inline @import targets are rewritten to local CSS; url(...) → local binary.
  let out = css.replace(/@import\s+(?:url\()?\s*("([^"]*)"|'([^']*)'|([^)\s;]+))\s*\)?/gi, (full, _g, dq, sq, bare) => {
    const v = dq ?? sq ?? bare ?? ''
    const abs = toAbsUrl(v, cssUrl)
    if (!abs) return full
    const local = register(abs, 'css')
    return local ? `@import "${rel('assets/', local)}"` : full
  })
  out = rewriteCssUrls(out, cssUrl, register, true)
  return out
}

// Rewrite every url(...) in a CSS fragment. `fromCss` controls the rel base (assets sit in
// the same dir as the stylesheet, so reference by bare filename).
function rewriteCssUrls(
  css: string, base: string,
  register: (u: string, k?: Asset['kind']) => string | null,
  fromCss = false,
): string {
  return css.replace(/url\(\s*("([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (full, _g, dq, sq, bare) => {
    const v = (dq ?? sq ?? bare ?? '').trim()
    if (!v || /^data:/i.test(v)) return full
    const abs = toAbsUrl(v, base)
    if (!abs) return full
    const local = register(abs, 'binary')
    if (!local) return full
    // Within a stylesheet, assets/<x> and the css live in the same dir → reference bare name.
    const ref = fromCss ? rel('assets/', local) : local
    return `url("${ref}")`
  })
}

// strip a leading dir prefix shared by css + assets (both under assets/)
function rel(prefix: string, local: string): string {
  return local.startsWith(prefix) ? local.slice(prefix.length) : local
}

// ── helpers ──────────────────────────────────────────────────────────────────

function toAbsUrl(v: string, base: string): string | null {
  if (!v || /^(#|mailto:|tel:|javascript:|data:)/i.test(v)) return null
  try { return new URL(decodeAmp(v), base).toString() } catch { return null }
}

// HTML attribute URLs carry entity-encoded ampersands (load.php?a=1&amp;modules=…). Fetching
// them literally hits the wrong query string (Wikipedia returns an empty stylesheet), so
// decode &amp; before building the URL.
function decodeAmp(v: string): string {
  return v.replace(/&amp;/g, '&').replace(/&#0*38;/g, '&').replace(/&#x0*26;/gi, '&')
}

function largestSrcset(raw: string): string | null {
  if (!raw) return null
  let best: string | null = null
  let bestN = -1
  for (const cand of raw.split(',')) {
    const [u, d] = cand.trim().split(/\s+/)
    if (!u) continue
    const n = d ? parseInt(d) || 1 : 1
    if (n >= bestN) { bestN = n; best = u }
  }
  return best
}

// Wrap the rewritten body so it renders standalone: meta charset, a marker banner, and a
// neutral background. Scripts already stripped; CSP blocks any that slipped through.
function wrapSnapshot(html: string, url: string, title: string | null): string {
  const banner =
    `<div style="position:sticky;top:0;z-index:2147483647;background:#1e1b2e;color:#cdb4ff;` +
    `font:12px/1.4 system-ui,sans-serif;padding:6px 12px;border-bottom:1px solid #3a2f5a">` +
    `Offline snapshot · <a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer" ` +
    `style="color:#cdb4ff;text-decoration:underline">Open original</a></div>`
  // If the doc has <body>, inject the banner right after it; else wrap.
  let doc = html
  if (/<body\b[^>]*>/i.test(doc)) {
    doc = doc.replace(/(<body\b[^>]*>)/i, `$1${banner}`)
  } else {
    doc = `<body>${banner}${doc}</body>`
  }
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; media-src 'self'">`
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${csp}<title>${escapeHtml(title ?? url)}</title>`
  if (/<head\b[^>]*>/i.test(doc)) {
    doc = doc.replace(/(<head\b[^>]*>)/i, `$1${csp}<meta charset="utf-8">`)
    return doc
  }
  return `<!doctype html><html><head>${head}</head>${/<body/i.test(doc) ? doc : `<body>${doc}</body>`}</html>`
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string))
}
function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;')
}
